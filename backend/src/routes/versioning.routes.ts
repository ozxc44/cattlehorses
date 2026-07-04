import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { EntityManager, In, IsNull } from 'typeorm';
import { AppDataSource } from '../data-source';
import { authenticateJwtOrAgentApiKey, extractProjectId } from '../middleware/auth';
import { requirePermission, Permission, Role } from '../middleware/rbac';
import { upsertProjectFileContent, softDeleteProjectFile } from '../services/project-file.service';
import {
  Agent,
  Project,
  ProjectBranch,
  ProjectChangeset,
  ProjectChangesetStatus,
  ProjectChangesetMergeStatus,
  ProjectChangesetComment,
  ProjectChangesetCommentStatus,
  ProjectChangesetCommentAuthorType,
  ProjectChangesetCommentSide,
  ProjectCommit,
  ProjectFile,
  ProjectFileRevision,
  ProjectOrchestration,
  ProjectMember,
  ProjectRole,
} from '../entities';
import {
  ProjectChangesetFileOp,
  ProjectChangesetMergeQueueState,
  ProjectChangesetRequestedReviewerRecord,
  ProjectChangesetReviewRecord,
  ProjectChangesetStatusCheckRecord,
} from '../entities/project-changeset.entity';
import { ProjectCommitSnapshot, ProjectCommitVerificationStatus } from '../entities/project-commit.entity';
import { GiteaSyncService } from '../services/gitea-sync.service';
import { ProjectAuditAction } from '../entities/project-audit-event.entity';
import { recordProjectModuleAudit } from '../services/project-audit.service';

const router = Router();
const MAX_FILE_BYTES = 1024 * 1024;

type Actor = {
  actorId: string;
  userId: string | null;
  agentId: string | null;
};

type ProjectFileUpsertInput = {
  projectId: string;
  path: string;
  content: string;
  contentType?: string;
  actorId: string;
  message?: string | null;
};

router.get(
  '/v1/projects/:project_id/branches',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const defaultBranch = await ensureDefaultBranch(projectId, getActor(req));
      const protectedBranchPatterns = normalizeStoredProtectedBranchPatterns(
        defaultBranch.protectionRules?.protected_branch_patterns,
      );
      const branches = await AppDataSource.getRepository(ProjectBranch).find({
        where: { projectId },
        order: { name: 'ASC' },
      });
      res.json({ data: branches.map((branch) => serializeBranch(branch, protectedBranchPatterns)) });
    } catch (err) {
      console.error('List project branches error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

// Real-git history. Each project has a true git repo (isomorphic-git); this
// exposes its native commit log — distinct from the DB ProjectCommit rows,
// which are the platform's review-provenance record.
router.get(
  '/v1/projects/:project_id/git/log',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const depth = Math.min(Math.max(parseInt(String(req.query.depth ?? '50'), 10) || 50, 1), 500);
      const { gitLog, gitHeadSha } = await import('../services/project-git.service');
      const [head, log] = await Promise.all([gitHeadSha(projectId), gitLog(projectId, depth)]);
      res.json({
        backend: 'isomorphic-git',
        head: head,
        data: log.map((c) => ({
          sha: c.oid,
          message: c.commit.message,
          author: c.commit.author,
          committer: c.commit.committer,
          parents: c.commit.parent,
          timestamp: c.commit.committer.timestamp,
        })),
      });
    } catch (err) {
      console.error('Git log error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

// Remote Git gateway info (Forgejo/Gitea). Returns the clone URL + web URL for
// the project's mirrored repo, so users/CLI can `git clone` the real repo.
// Empty when no gateway configured (GITEA_SYNC_ENABLED off) — callers fall back
// to the in-platform isomorphic-git history.
router.get(
  '/v1/projects/:project_id/git/remote',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  (_req: Request, res: Response) => {
    try {
      const enabled = process.env.GITEA_SYNC_ENABLED === 'true';
      const serverUrl = (process.env.GITEA_URL || '').replace(/\/+$/, '');
      const org = process.env.GITEA_SYNC_ORG || '';
      const repoPrefix = process.env.GITEA_SYNC_REPO_PREFIX || 'agent-';
      if (!enabled || !serverUrl) {
        res.json({ enabled: false, clone_url: null, web_url: null });
        return;
      }
      const repoName = `${repoPrefix}${_req.params.project_id.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase()}`;
      const fullPath = org ? `${org}/${repoName}` : repoName;
      res.json({
        enabled: true,
        backend: 'gitea',
        clone_url: `${serverUrl}/${fullPath}.git`,
        web_url: `${serverUrl}/${fullPath}`,
        repo: fullPath,
      });
    } catch (err) {
      console.error('Git remote error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/branches/compare',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const baseRef = typeof req.query.base === 'string' ? req.query.base.trim() : '';
      const headRef = typeof req.query.head === 'string' ? req.query.head.trim() : '';
      if (!baseRef || !headRef) {
        res.status(422).json({ detail: 'base and head query parameters are required' });
        return;
      }

      const branchRepo = AppDataSource.getRepository(ProjectBranch);
      // Only OR-in the id lookup when the ref is a valid uuid shape; otherwise
      // Postgres rejects "uuid = text" for a name like "main".
      const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
      const baseClause = isUuid(baseRef)
        ? '(branch.name = :baseRef OR branch.id = :baseRef)'
        : 'branch.name = :baseRef';
      const headClause = isUuid(headRef)
        ? '(branch.name = :headRef OR branch.id = :headRef)'
        : 'branch.name = :headRef';
      const [baseBranch, headBranch] = await Promise.all([
        branchRepo
          .createQueryBuilder('branch')
          .where('branch.projectId = :projectId', { projectId })
          .andWhere(baseClause, { baseRef })
          .getOne(),
        branchRepo
          .createQueryBuilder('branch')
          .where('branch.projectId = :projectId', { projectId })
          .andWhere(headClause, { headRef })
          .getOne(),
      ]);
      if (!baseBranch) {
        res.status(404).json({ detail: 'base branch not found' });
        return;
      }
      if (!headBranch) {
        res.status(404).json({ detail: 'head branch not found' });
        return;
      }

      if (!baseBranch.headCommitId) {
        res.status(409).json({ detail: 'base branch has no HEAD commit' });
        return;
      }
      if (!headBranch.headCommitId) {
        res.status(409).json({ detail: 'head branch has no HEAD commit' });
        return;
      }

      const commitRepo = AppDataSource.getRepository(ProjectCommit);
      const [baseCommit, headCommit] = await Promise.all([
        commitRepo.findOne({ where: { id: baseBranch.headCommitId, projectId } }),
        commitRepo.findOne({ where: { id: headBranch.headCommitId, projectId } }),
      ]);
      if (!baseCommit) {
        res.status(409).json({ detail: 'base branch HEAD commit not found' });
        return;
      }
      if (!headCommit) {
        res.status(409).json({ detail: 'head branch HEAD commit not found' });
        return;
      }

      const result = await buildBranchCompareResult(baseBranch, baseCommit, headBranch, headCommit);
      res.json({ data: result });
    } catch (err) {
      console.error('Compare project branches error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.post(
  '/v1/projects/:project_id/branches',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.EditProject),
  async (req: Request, res: Response) => {
    try {
      const actor = getActor(req);
      if (!actor?.userId) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      const projectId = req.params.project_id;
      const name = normalizeBranchName(req.body.name);
      if (!name.ok) {
        res.status(422).json({ detail: name.error });
        return;
      }

      const source = await resolveBranchSource(projectId, req.body);
      if (!source.ok) {
        res.status(source.status).json({ detail: source.detail });
        return;
      }

      const result = await AppDataSource.transaction(async (manager) => {
        await ensureDefaultBranchInTransaction(manager, projectId, actor);
        const repo = manager.getRepository(ProjectBranch);
        const existing = await repo.findOne({ where: { projectId, name: name.value } });
        if (existing) return { duplicate: true as const };
        const branch = repo.create({
          projectId,
          name: name.value,
          headCommitId: source.headCommitId,
          createdByUserId: actor.userId,
          createdByAgentId: null,
        });
        return { ok: true as const, branch: await repo.save(branch) };
      });

      if ('duplicate' in result) {
        res.status(409).json({ detail: 'Branch name already exists' });
        return;
      }

      await recordProjectModuleAudit(
        projectId,
        actor.userId,
        ProjectAuditAction.BRANCH_CREATED,
        { type: 'branch', id: result.branch.id, name: result.branch.name },
        {
          branch_name: result.branch.name,
          source_branch: source.sourceBranchName,
          head_commit_id: result.branch.headCommitId ?? null,
        },
      );

      res.status(201).json(serializeBranch(result.branch, await loadProjectProtectedBranchPatterns(projectId)));
    } catch (err) {
      console.error('Create project branch error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.patch(
  '/v1/projects/:project_id/branches/:branch_id',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.EditProject),
  async (req: Request, res: Response) => {
    try {
      const actor = getActor(req);
      if (!actor?.userId) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      const projectId = req.params.project_id;
      const name = normalizeBranchName(req.body.name);
      if (!name.ok) {
        res.status(422).json({ detail: name.error });
        return;
      }

      const result = await AppDataSource.transaction(async (manager) => {
        const repo = manager.getRepository(ProjectBranch);
        const branch = await repo.findOne({ where: { id: req.params.branch_id, projectId } });
        if (!branch) return { missing: true as const };
        const protectedBranchPatterns = await loadProjectProtectedBranchPatternsInTransaction(manager, projectId);
        if (isDefaultBranch(branch) || isProtectedBranch(branch, protectedBranchPatterns)) return { protected: true as const };
        const previousName = branch.name;
        if (previousName === name.value) return { ok: true as const, branch, previousName, changed: false };
        const duplicate = await repo.findOne({ where: { projectId, name: name.value } });
        if (duplicate && duplicate.id !== branch.id) return { duplicate: true as const };
        branch.name = name.value;
        return { ok: true as const, branch: await repo.save(branch), previousName, changed: true };
      });

      if ('missing' in result) {
        res.status(404).json({ detail: 'Branch not found' });
        return;
      }
      if ('protected' in result) {
        res.status(409).json({ detail: 'Protected branch cannot be renamed' });
        return;
      }
      if ('duplicate' in result) {
        res.status(409).json({ detail: 'Branch name already exists' });
        return;
      }

      if (result.changed) {
        await recordProjectModuleAudit(
          projectId,
          actor.userId,
          ProjectAuditAction.BRANCH_RENAMED,
          { type: 'branch', id: result.branch.id, name: result.branch.name },
          {
            previous_name: result.previousName,
            new_name: result.branch.name,
            head_commit_id: result.branch.headCommitId ?? null,
          },
        );
      }

      res.json(serializeBranch(result.branch, await loadProjectProtectedBranchPatterns(projectId)));
    } catch (err) {
      console.error('Rename project branch error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.delete(
  '/v1/projects/:project_id/branches/:branch_id',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.EditProject),
  async (req: Request, res: Response) => {
    try {
      const actor = getActor(req);
      if (!actor?.userId) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      const projectId = req.params.project_id;

      const result = await AppDataSource.transaction(async (manager) => {
        const repo = manager.getRepository(ProjectBranch);
        const branch = await repo.findOne({ where: { id: req.params.branch_id, projectId } });
        if (!branch) return { missing: true as const };
        const protectedBranchPatterns = await loadProjectProtectedBranchPatternsInTransaction(manager, projectId);
        if (isDefaultBranch(branch) || isProtectedBranch(branch, protectedBranchPatterns)) return { protected: true as const };
        const commitCount = await manager.count(ProjectCommit, { where: { branchId: branch.id, projectId } });
        const changesetCount = await manager.count(ProjectChangeset, { where: { branchId: branch.id, projectId } });
        if (commitCount > 0 || changesetCount > 0) {
          return { inUse: true as const, branch, commitCount, changesetCount };
        }
        await repo.remove(branch);
        return { ok: true as const, branch };
      });

      if ('missing' in result) {
        res.status(404).json({ detail: 'Branch not found' });
        return;
      }
      if ('protected' in result) {
        res.status(409).json({ detail: 'Protected branch cannot be deleted' });
        return;
      }
      if ('inUse' in result) {
        res.status(409).json({
          detail: 'Branch has commits or changesets and cannot be deleted',
          commit_count: result.commitCount,
          changeset_count: result.changesetCount,
        });
        return;
      }

      await recordProjectModuleAudit(
        projectId,
        actor.userId,
        ProjectAuditAction.BRANCH_DELETED,
        { type: 'branch', id: result.branch.id, name: result.branch.name },
        {
          branch_name: result.branch.name,
          head_commit_id: result.branch.headCommitId ?? null,
        },
      );

      res.status(204).send();
    } catch (err) {
      console.error('Delete project branch error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.patch(
  '/v1/projects/:project_id/branches/:branch_id/default',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.EditProject),
  async (req: Request, res: Response) => {
    try {
      const actor = getActor(req);
      if (!actor?.userId) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      if (!isOwnerOrAdmin(req)) {
        res.status(403).json({ detail: 'Only project owner/admin can set the default branch' });
        return;
      }
      const projectId = req.params.project_id;
      const branchId = req.params.branch_id;

      const result = await AppDataSource.transaction(async (manager) => {
        const repo = manager.getRepository(ProjectBranch);
        const branch = await repo.findOne({ where: { id: branchId, projectId } });
        if (!branch) return { missing: true as const };
        if (branch.isDefault) return { ok: true as const, branch, changed: false, previousDefault: null };
        const previousDefault = await repo.findOne({ where: { projectId, isDefault: true } });
        if (previousDefault) {
          previousDefault.isDefault = false;
          await repo.save(previousDefault);
        }
        branch.isDefault = true;
        return { ok: true as const, branch: await repo.save(branch), changed: true, previousDefault };
      });

      if ('missing' in result) {
        res.status(404).json({ detail: 'Branch not found' });
        return;
      }

      if (result.changed) {
        await recordProjectModuleAudit(
          projectId,
          actor.userId,
          ProjectAuditAction.BRANCH_DEFAULT_SET,
          { type: 'branch', id: result.branch.id, name: result.branch.name },
          {
            branch_id: result.branch.id,
            branch_name: result.branch.name,
            previous_default_branch_id: result.previousDefault?.id ?? null,
            previous_default_branch_name: result.previousDefault?.name ?? null,
          },
        );
      }

      res.json(serializeBranch(result.branch, await loadProjectProtectedBranchPatterns(projectId)));
    } catch (err) {
      console.error('Set default branch error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.patch(
  '/v1/projects/:project_id/branches/:branch_id/protection',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.EditProject),
  async (req: Request, res: Response) => {
    try {
      const actor = getActor(req);
      if (!actor?.userId) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      if (!isOwnerOrAdmin(req)) {
        res.status(403).json({ detail: 'Only project owner/admin can change branch protection' });
        return;
      }
      const projectId = req.params.project_id;
      const branchId = req.params.branch_id;

      if (typeof req.body.is_protected !== 'boolean') {
        res.status(422).json({ detail: 'is_protected boolean is required' });
        return;
      }
      const requestedProtected = req.body.is_protected;

      const result = await AppDataSource.transaction(async (manager) => {
        const repo = manager.getRepository(ProjectBranch);
        const branch = await repo.findOne({ where: { id: branchId, projectId } });
        if (!branch) return { missing: true as const };
        if (branch.isDefault) return { defaultBranch: true as const };
        if (branch.isProtected === requestedProtected) {
          return { ok: true as const, branch, changed: false };
        }
        branch.isProtected = requestedProtected;
        return { ok: true as const, branch: await repo.save(branch), changed: true };
      });

      if ('missing' in result) {
        res.status(404).json({ detail: 'Branch not found' });
        return;
      }
      if ('defaultBranch' in result) {
        res.status(409).json({ detail: 'Default branch protection is managed automatically' });
        return;
      }

      if (result.changed) {
        await recordProjectModuleAudit(
          projectId,
          actor.userId,
          ProjectAuditAction.BRANCH_PROTECTION_CHANGED,
          { type: 'branch', id: result.branch.id, name: result.branch.name },
          {
            branch_id: result.branch.id,
            branch_name: result.branch.name,
            is_protected: result.branch.isProtected,
          },
        );
      }

      res.json(serializeBranch(result.branch, await loadProjectProtectedBranchPatterns(projectId)));
    } catch (err) {
      console.error('Toggle branch protection error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.patch(
  '/v1/projects/:project_id/branches/:branch_id/protection-rules',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.EditProject),
  async (req: Request, res: Response) => {
    try {
      const actor = getActor(req);
      if (!actor?.userId) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      if (!isOwnerOrAdmin(req)) {
        res.status(403).json({ detail: 'Only project owner/admin can change branch protection rules' });
        return;
      }
      const projectId = req.params.project_id;
      const branchId = req.params.branch_id;

      if (typeof req.body.block_direct_writes !== 'boolean') {
        res.status(422).json({ detail: 'block_direct_writes boolean is required' });
        return;
      }
      const requestedBlockDirectWrites = req.body.block_direct_writes;
      const requestedBypassRoles = normalizeDirectWriteBypassRoles(req.body.direct_write_bypass_roles);
      if (!requestedBypassRoles.ok) {
        res.status(422).json({ detail: requestedBypassRoles.error });
        return;
      }
      const requestedBypassUserIds = await normalizeDirectWriteBypassUserIds(
        projectId,
        req.body.direct_write_bypass_user_ids,
      );
      if (!requestedBypassUserIds.ok) {
        res.status(422).json({
          detail: requestedBypassUserIds.error,
          missing_user_ids: requestedBypassUserIds.missingUserIds ?? [],
          ineligible_user_ids: requestedBypassUserIds.ineligibleUserIds ?? [],
        });
        return;
      }
      const requestedRequiredApprovals = normalizeRequiredApprovals(req.body.required_approvals);
      if (!requestedRequiredApprovals.ok) {
        res.status(422).json({ detail: requestedRequiredApprovals.error });
        return;
      }
      const requestedRequiredStatusChecks = normalizeRequiredStatusChecks(req.body.required_status_checks);
      if (!requestedRequiredStatusChecks.ok) {
        res.status(422).json({ detail: requestedRequiredStatusChecks.error });
        return;
      }
      const requestedMergeQueueEnabled = normalizeMergeQueueEnabled(req.body.merge_queue_enabled);
      if (!requestedMergeQueueEnabled.ok) {
        res.status(422).json({ detail: requestedMergeQueueEnabled.error });
        return;
      }
      const requestedProtectedBranchPatterns = normalizeProtectedBranchPatterns(req.body.protected_branch_patterns);
      if (!requestedProtectedBranchPatterns.ok) {
        res.status(422).json({ detail: requestedProtectedBranchPatterns.error });
        return;
      }

      const result = await AppDataSource.transaction(async (manager) => {
        const repo = manager.getRepository(ProjectBranch);
        const branch = await repo.findOne({ where: { id: branchId, projectId } });
        if (!branch) return { missing: true as const };
        const defaultBranch = branch.isDefault
          ? branch
          : await ensureDefaultBranchInTransaction(manager, projectId, actor);
        const previousRules = branch.protectionRules ?? null;
        const previousDefaultRules = defaultBranch.protectionRules ?? null;
        const previousBlockDirectWrites = previousRules?.block_direct_writes ?? false;
        const previousBypassRoles = normalizeStoredDirectWriteBypassRoles(previousRules?.direct_write_bypass_roles);
        const previousBypassUserIds = normalizeStoredDirectWriteBypassUserIds(previousRules?.direct_write_bypass_user_ids);
        const previousRequiredApprovals = normalizeStoredRequiredApprovals(previousRules?.required_approvals);
        const previousRequiredStatusChecks = normalizeStoredRequiredStatusChecks(previousRules?.required_status_checks);
        const previousMergeQueueEnabled = normalizeStoredMergeQueueEnabled(previousRules?.merge_queue_enabled);
        const previousProtectedBranchPatterns = normalizeStoredProtectedBranchPatterns(
          previousDefaultRules?.protected_branch_patterns,
        );
        const nextBypassRoles = requestedBypassRoles.value ?? previousBypassRoles;
        const nextBypassUserIds = requestedBypassUserIds.value ?? previousBypassUserIds;
        const nextRequiredApprovals = requestedRequiredApprovals.value ?? previousRequiredApprovals;
        const nextRequiredStatusChecks = requestedRequiredStatusChecks.value ?? previousRequiredStatusChecks;
        const nextMergeQueueEnabled = requestedMergeQueueEnabled.value ?? previousMergeQueueEnabled;
        const nextProtectedBranchPatterns = requestedProtectedBranchPatterns.value ?? previousProtectedBranchPatterns;
        const branchRulesChanged = !(
          previousBlockDirectWrites === requestedBlockDirectWrites &&
          directWriteBypassRolesEqual(previousBypassRoles, nextBypassRoles) &&
          stringArraysEqual(previousBypassUserIds, nextBypassUserIds) &&
          previousRequiredApprovals === nextRequiredApprovals &&
          stringArraysEqual(previousRequiredStatusChecks, nextRequiredStatusChecks) &&
          previousMergeQueueEnabled === nextMergeQueueEnabled
        );
        const patternsChanged = !stringArraysEqual(previousProtectedBranchPatterns, nextProtectedBranchPatterns);
        if (!branchRulesChanged && !patternsChanged) {
          return { ok: true as const, branch, changed: false };
        }
        if (branchRulesChanged || branch.isDefault) {
          branch.protectionRules = {
            block_direct_writes: requestedBlockDirectWrites,
            direct_write_bypass_roles: nextBypassRoles,
            direct_write_bypass_user_ids: nextBypassUserIds,
            required_approvals: nextRequiredApprovals,
            required_status_checks: nextRequiredStatusChecks,
            merge_queue_enabled: nextMergeQueueEnabled,
            ...(branch.isDefault ? { protected_branch_patterns: nextProtectedBranchPatterns } : {}),
          };
          await repo.save(branch);
        }
        if (!branch.isDefault && patternsChanged) {
          defaultBranch.protectionRules = {
            ...(previousDefaultRules ?? {}),
            protected_branch_patterns: nextProtectedBranchPatterns,
          };
          await repo.save(defaultBranch);
        }
        return { ok: true as const, branch, changed: true, projectPatterns: nextProtectedBranchPatterns };
      });

      if ('missing' in result) {
        res.status(404).json({ detail: 'Branch not found' });
        return;
      }

      if (result.changed) {
        await recordProjectModuleAudit(
          projectId,
          actor.userId,
          ProjectAuditAction.BRANCH_PROTECTION_CHANGED,
          { type: 'branch', id: result.branch.id, name: result.branch.name },
          {
            branch_id: result.branch.id,
            branch_name: result.branch.name,
            block_direct_writes: result.branch.protectionRules?.block_direct_writes ?? false,
            direct_write_bypass_roles: normalizeStoredDirectWriteBypassRoles(
              result.branch.protectionRules?.direct_write_bypass_roles,
            ),
            direct_write_bypass_user_ids: normalizeStoredDirectWriteBypassUserIds(
              result.branch.protectionRules?.direct_write_bypass_user_ids,
            ),
            required_approvals: normalizeStoredRequiredApprovals(
              result.branch.protectionRules?.required_approvals,
            ),
            required_status_checks: normalizeStoredRequiredStatusChecks(
              result.branch.protectionRules?.required_status_checks,
            ),
            merge_queue_enabled: normalizeStoredMergeQueueEnabled(
              result.branch.protectionRules?.merge_queue_enabled,
            ),
            protected_branch_patterns: result.projectPatterns ?? await loadProjectProtectedBranchPatterns(projectId),
          },
        );
      }

      res.json(serializeBranch(result.branch, result.projectPatterns ?? await loadProjectProtectedBranchPatterns(projectId)));
    } catch (err) {
      console.error('Toggle branch protection rules error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.patch(
  '/v1/projects/:project_id/changesets/:changeset_id/status-checks',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const actor = getActor(req);
      if (!actor) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      const changeset = await AppDataSource.getRepository(ProjectChangeset).findOne({
        where: { id: req.params.changeset_id, projectId: req.params.project_id },
      });
      if (!changeset) {
        res.status(404).json({ detail: 'Changeset not found' });
        return;
      }
      if (!await canReviewChangeset(req, changeset)) {
        res.status(403).json({ detail: 'Only owner/admin or orchestration main agent can record changeset status checks' });
        return;
      }
      if ([ProjectChangesetStatus.MERGED, ProjectChangesetStatus.CANCELLED].includes(changeset.status)) {
        res.status(409).json({ detail: 'Changeset is closed' });
        return;
      }

      const name = normalizeStatusCheckName(req.body.name);
      if (!name.ok) {
        res.status(422).json({ detail: name.error });
        return;
      }
      const status = req.body.status;
      if (!['passed', 'failed', 'pending'].includes(status)) {
        res.status(422).json({ detail: 'status must be passed, failed, or pending' });
        return;
      }

      changeset.statusChecks = upsertChangesetStatusCheck(
        changeset.statusChecks,
        actor,
        name.value,
        status,
        typeof req.body.summary === 'string' ? req.body.summary.slice(0, 1000) : null,
        new Date(),
      );
      const saved = await AppDataSource.getRepository(ProjectChangeset).save(changeset);
      res.json(serializeChangeset(saved));
    } catch (err) {
      console.error('Record changeset status check error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.patch(
  '/v1/projects/:project_id/changesets/:changeset_id/requested-reviewers',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const actor = getActor(req);
      if (!actor?.userId) {
        res.status(401).json({ detail: 'User authentication required' });
        return;
      }
      const repo = AppDataSource.getRepository(ProjectChangeset);
      const changeset = await repo.findOne({
        where: { id: req.params.changeset_id, projectId: req.params.project_id },
      });
      if (!changeset) {
        res.status(404).json({ detail: 'Changeset not found' });
        return;
      }
      if (!isChangesetCreator(changeset, actor) && !isOwnerOrAdmin(req)) {
        res.status(403).json({ detail: 'Only the creator or project owner/admin can request reviewers' });
        return;
      }
      if ([ProjectChangesetStatus.MERGED, ProjectChangesetStatus.CANCELLED].includes(changeset.status)) {
        res.status(409).json({ detail: 'Changeset is closed' });
        return;
      }

      const normalized = normalizeRequestedReviewerIds(
        req.body.requested_reviewer_ids ?? req.body.requested_reviewers ?? req.body.reviewer_ids ?? req.body.user_ids,
      );
      if (!normalized.ok) {
        res.status(422).json({ detail: normalized.error });
        return;
      }
      const reviewerIds = normalized.value;
      if (reviewerIds.length) {
        const members = await AppDataSource.getRepository(ProjectMember).find({
          where: { projectId: req.params.project_id, userId: In(reviewerIds) },
          select: ['userId'],
        });
        const memberIds = new Set(members.map((member) => member.userId));
        const missing = reviewerIds.filter((id) => !memberIds.has(id));
        if (missing.length) {
          res.status(422).json({ detail: 'requested_reviewers must be project members', missing_reviewer_ids: missing });
          return;
        }
      }

      const previous = normalizeRequestedReviewers(changeset.requestedReviewers).map((reviewer) => reviewer.reviewer_id);
      changeset.requestedReviewers = buildRequestedReviewers(reviewerIds, actor, new Date());
      const saved = await repo.save(changeset);

      if (actor.userId && !stringArraysEqual(previous, reviewerIds)) {
        await recordProjectModuleAudit(
          req.params.project_id,
          actor.userId,
          ProjectAuditAction.CHANGESET_REVIEWERS_REQUESTED,
          { type: 'changeset', id: saved.id, name: saved.title },
          {
            changeset_id: saved.id,
            previous_reviewer_ids: previous,
            requested_reviewer_ids: reviewerIds,
          },
        ).catch((err) => console.error('Failed to record changeset_reviewers_requested audit:', err));
      }

      res.json(serializeChangeset(saved));
    } catch (err) {
      console.error('Request changeset reviewers error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/changesets/merge-queue',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const changesets = await AppDataSource.getRepository(ProjectChangeset).find({
        where: { projectId, status: ProjectChangesetStatus.MERGE_READY },
        order: { reviewedAt: 'ASC', updatedAt: 'ASC' },
      });
      res.json({ data: changesets.map(serializeChangeset), total: changesets.length });
    } catch (err) {
      console.error('List merge queue changesets error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.post(
  '/v1/projects/:project_id/changesets/:changeset_id/merge-queue',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const actor = getActor(req);
      if (!actor) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      const result = await AppDataSource.transaction(async (manager) => {
        const changeset = await manager.findOne(ProjectChangeset, {
          where: { id: req.params.changeset_id, projectId: req.params.project_id },
        });
        if (!changeset) return { missing: true as const };
        if (!isChangesetCreator(changeset, actor) && !isOwnerOrAdmin(req)) {
          return { forbidden: true as const };
        }
        if (changeset.status !== ProjectChangesetStatus.MERGE_READY) {
          return { notApproved: true as const };
        }
        if (changeset.mergeQueuePosition != null) {
          return { ok: true as const, changeset };
        }
        const maxRow = await manager.getRepository(ProjectChangeset)
          .createQueryBuilder('queued')
          .select('MAX(queued.mergeQueuePosition)', 'max')
          .where('queued.projectId = :projectId', { projectId: req.params.project_id })
          .andWhere('queued.branchId = :branchId', { branchId: changeset.branchId })
          .andWhere('queued.mergeQueuePosition IS NOT NULL')
          .getRawOne<{ max: number | string | null }>();
        const maxPosition = maxRow?.max == null ? 0 : Number(maxRow.max) || 0;
        changeset.mergeQueuePosition = maxPosition + 1;
        changeset.queuedAt = new Date();
        changeset.queuedByUserId = actor.userId;
        changeset.queuedByAgentId = actor.agentId;
        return { ok: true as const, changeset: await manager.save(ProjectChangeset, changeset) };
      });

      if ('missing' in result) {
        res.status(404).json({ detail: 'Changeset not found' });
        return;
      }
      if ('forbidden' in result) {
        res.status(403).json({ detail: 'Only the creator or project owner/admin can enqueue this changeset' });
        return;
      }
      if ('notApproved' in result) {
        res.status(409).json({ detail: 'Changeset must be merge_ready before entering the local merge queue' });
        return;
      }
      res.json(serializeChangeset(result.changeset));
    } catch (err) {
      console.error('Enqueue changeset error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.delete(
  '/v1/projects/:project_id/changesets/:changeset_id/merge-queue',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const actor = getActor(req);
      if (!actor) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      const result = await AppDataSource.transaction(async (manager) => {
        const changeset = await manager.findOne(ProjectChangeset, {
          where: { id: req.params.changeset_id, projectId: req.params.project_id },
        });
        if (!changeset) return { missing: true as const };
        if (!isChangesetCreator(changeset, actor) && !isOwnerOrAdmin(req)) {
          return { forbidden: true as const };
        }
        if (changeset.mergeQueuePosition == null) {
          return { ok: true as const, changeset };
        }
        const previousPosition = changeset.mergeQueuePosition;
        changeset.mergeQueuePosition = null;
        changeset.queuedAt = undefined;
        changeset.queuedByUserId = null;
        changeset.queuedByAgentId = null;
        const saved = await manager.save(ProjectChangeset, changeset);
        await compactMergeQueueAfterRemoval(manager, req.params.project_id, changeset.branchId, previousPosition);
        return { ok: true as const, changeset: saved };
      });

      if ('missing' in result) {
        res.status(404).json({ detail: 'Changeset not found' });
        return;
      }
      if ('forbidden' in result) {
        res.status(403).json({ detail: 'Only the creator or project owner/admin can dequeue this changeset' });
        return;
      }
      res.json(serializeChangeset(result.changeset));
    } catch (err) {
      console.error('Dequeue changeset error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/commits',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const commits = await AppDataSource.getRepository(ProjectCommit).find({
        where: { projectId: req.params.project_id },
        order: { createdAt: 'DESC' },
        take: 100,
      });
      res.json({ data: commits.map(serializeCommitSummary) });
    } catch (err) {
      console.error('List project commits error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/commits/:commit_id',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const commit = await AppDataSource.getRepository(ProjectCommit).findOne({
        where: { id: req.params.commit_id, projectId: req.params.project_id },
      });
      if (!commit) {
        res.status(404).json({ detail: 'Commit not found' });
        return;
      }
      res.json(serializeCommit(commit));
    } catch (err) {
      console.error('Get project commit error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.post(
  '/v1/projects/:project_id/changesets',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const actor = getActor(req);
      if (!actor) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }

      const title = normalizeRequiredString(req.body.title, 'title', 255);
      if (!title.ok) {
        res.status(422).json({ detail: title.error });
        return;
      }

      const ops = validateFileOps(req.body.file_ops);
      if (!ops.ok) {
        res.status(422).json({ detail: ops.error });
        return;
      }

      const status = req.body.status === ProjectChangesetStatus.DRAFT
        ? ProjectChangesetStatus.DRAFT
        : ProjectChangesetStatus.SUBMITTED;
      const branch = await ensureDefaultBranch(projectId, actor);
      const baseCommitId = typeof req.body.base_commit_id === 'string'
        ? req.body.base_commit_id
        : branch.headCommitId ?? null;
      if (baseCommitId && !await commitExists(projectId, baseCommitId)) {
        res.status(404).json({ detail: 'base_commit_id not found in this project' });
        return;
      }

      // Stale-base / missing-base validation. Mirrors the changeset preflight
      // (runChangesetPreflight): every upsert on an EXISTING file must carry a
      // base_revision_id, and that revision must still be the file's current
      // revision. Reject at submit time so callers resubmit against a fresh base
      // instead of persisting a changeset that can never merge cleanly.
      for (const op of ops.value) {
        const current = await AppDataSource.getRepository(ProjectFile).findOne({
          where: { projectId, path: op.path, deletedAt: IsNull() },
        });
        if (current && !op.base_revision_id) {
          res.status(409).json({
            detail: 'base_revision_id required for upsert on existing file',
            path: op.path,
            current_revision_id: current.currentRevisionId ?? null,
          });
          return;
        }
        if (current && op.base_revision_id && current.currentRevisionId !== op.base_revision_id) {
          res.status(409).json({
            detail: 'stale base',
            path: op.path,
            base_revision_id: op.base_revision_id,
            current_revision_id: current.currentRevisionId ?? null,
          });
          return;
        }
      }

      const resultPath = normalizeOptionalPath(req.body.result_path, 'result_path');
      const evidencePath = normalizeOptionalPath(req.body.evidence_path, 'evidence_path');
      if (!resultPath.ok) {
        res.status(422).json({ detail: resultPath.error });
        return;
      }
      if (!evidencePath.ok) {
        res.status(422).json({ detail: evidencePath.error });
        return;
      }

      const changesetRepo = AppDataSource.getRepository(ProjectChangeset);
      const changeset = await changesetRepo.save(changesetRepo.create({
        projectId,
        branchId: branch.id,
        baseCommitId,
        title: title.value,
        description: typeof req.body.description === 'string' ? req.body.description.trim() || null : null,
        status,
        fileOps: ops.value,
        resultPath: resultPath.value,
        evidencePath: evidencePath.value,
        createdByUserId: actor.userId,
        createdByAgentId: actor.agentId,
        orchestrationId: typeof req.body.orchestration_id === 'string' ? req.body.orchestration_id : null,
        taskId: typeof req.body.task_id === 'string' ? req.body.task_id : null,
      }));

      res.status(201).json(serializeChangeset(changeset));
    } catch (err) {
      console.error('Create changeset error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/changesets',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : undefined;
      const limit = parsePaginationInt(req.query.limit, 1, 100, 100);
      const offset = parsePaginationInt(req.query.offset, 0, Number.MAX_SAFE_INTEGER, 0);

      const repo = AppDataSource.getRepository(ProjectChangeset);
      const qb = repo.createQueryBuilder('changeset')
        .where('changeset.projectId = :projectId', { projectId });
      if (status && Object.values(ProjectChangesetStatus).includes(status as ProjectChangesetStatus)) {
        qb.andWhere('changeset.status = :status', { status });
      }
      if (q) {
        const like = `%${q.toLowerCase()}%`;
        qb.andWhere(
          '(LOWER(changeset.title) LIKE :q OR (changeset.description IS NOT NULL AND LOWER(changeset.description) LIKE :q))',
          { q: like },
        );
      }
      qb.orderBy('changeset.updatedAt', 'DESC')
        .skip(offset)
        .take(limit);

      const [changesets, total] = await qb.getManyAndCount();

      const summaryRows = await repo.createQueryBuilder('changeset')
        .select('changeset.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .where('changeset.projectId = :projectId', { projectId })
        .groupBy('changeset.status')
        .getRawMany();
      const byStatus: Record<string, number> = {};
      let totalAll = 0;
      for (const row of summaryRows) {
        const count = parseInt(row.count as string, 10);
        byStatus[row.status as string] = count;
        totalAll += count;
      }

      res.json({
        data: changesets.map(serializeChangeset),
        total,
        limit,
        offset,
        summary: { total: totalAll, by_status: byStatus },
      });
    } catch (err) {
      console.error('List changesets error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/changesets/:changeset_id',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const changeset = await AppDataSource.getRepository(ProjectChangeset).findOne({
        where: { id: req.params.changeset_id, projectId: req.params.project_id },
      });
      if (!changeset) {
        res.status(404).json({ detail: 'Changeset not found' });
        return;
      }
      res.json(serializeChangeset(changeset));
    } catch (err) {
      console.error('Get changeset error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/changesets/:changeset_id/diff',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const changeset = await AppDataSource.getRepository(ProjectChangeset).findOne({
        where: { id: req.params.changeset_id, projectId },
      });
      if (!changeset) {
        res.status(404).json({ detail: 'Changeset not found' });
        return;
      }
      const files = await buildFileDiffs(projectId, changeset.fileOps);
      res.json({ changeset: serializeChangeset(changeset), files });
    } catch (err) {
      console.error('Get changeset diff error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.patch(
  '/v1/projects/:project_id/changesets/:changeset_id',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const actor = getActor(req);
      if (!actor) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      const repo = AppDataSource.getRepository(ProjectChangeset);
      const changeset = await repo.findOne({
        where: { id: req.params.changeset_id, projectId: req.params.project_id },
      });
      if (!changeset) {
        res.status(404).json({ detail: 'Changeset not found' });
        return;
      }
      if ([ProjectChangesetStatus.MERGED, ProjectChangesetStatus.REJECTED, ProjectChangesetStatus.CANCELLED].includes(changeset.status)) {
        res.status(409).json({ detail: 'Closed changesets cannot be edited' });
        return;
      }
      if (
        changeset.status === ProjectChangesetStatus.APPROVED ||
        changeset.status === ProjectChangesetStatus.MERGE_READY
      ) {
        res.status(409).json({ detail: 'Approved/merge_ready changesets cannot be edited; request changes or create a new changeset' });
        return;
      }
      if (!isChangesetCreator(changeset, actor) && !isOwnerOrAdmin(req)) {
        res.status(403).json({ detail: 'Only the creator or project owner/admin can edit this changeset' });
        return;
      }

      if (typeof req.body.title === 'string') {
        const title = normalizeRequiredString(req.body.title, 'title', 255);
        if (!title.ok) {
          res.status(422).json({ detail: title.error });
          return;
        }
        changeset.title = title.value;
      }
      if (typeof req.body.description === 'string') {
        changeset.description = req.body.description.trim() || null;
      }
      if (Array.isArray(req.body.file_ops)) {
        const ops = validateFileOps(req.body.file_ops);
        if (!ops.ok) {
          res.status(422).json({ detail: ops.error });
          return;
        }
        changeset.fileOps = ops.value;
      }
      if ([ProjectChangesetStatus.DRAFT, ProjectChangesetStatus.SUBMITTED].includes(req.body.status)) {
        changeset.status = req.body.status;
      } else if (req.body.status !== undefined) {
        res.status(422).json({ detail: 'status can only be draft or submitted through this endpoint' });
        return;
      }
      changeset.conflicts = null;
      const saved = await repo.save(changeset);
      res.json(serializeChangeset(saved));
    } catch (err) {
      console.error('Update changeset error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.patch(
  '/v1/projects/:project_id/changesets/:changeset_id/review',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const actor = getActor(req);
      if (!actor) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      const changeset = await AppDataSource.getRepository(ProjectChangeset).findOne({
        where: { id: req.params.changeset_id, projectId: req.params.project_id },
      });
      if (!changeset) {
        res.status(404).json({ detail: 'Changeset not found' });
        return;
      }
      if (!await canReviewChangeset(req, changeset)) {
        res.status(403).json({ detail: 'Only owner/admin or orchestration main agent can review this changeset' });
        return;
      }
      if ([ProjectChangesetStatus.MERGED, ProjectChangesetStatus.CANCELLED].includes(changeset.status)) {
        res.status(409).json({ detail: 'Changeset is closed' });
        return;
      }

      const decision = req.body.decision ?? req.body.status;
      if (!['approved', 'changes_requested', 'rejected'].includes(decision)) {
        res.status(422).json({ detail: 'decision must be approved, changes_requested, or rejected' });
        return;
      }
      const reviewedAt = new Date();
      const reviewNotes = typeof req.body.notes === 'string' ? req.body.notes.slice(0, 10_000) : null;
      changeset.reviews = upsertChangesetReview(changeset.reviews, actor, decision, reviewNotes, reviewedAt);
      changeset.status = decision === 'approved'
        ? ProjectChangesetStatus.MERGE_READY
        : decision === 'changes_requested'
          ? ProjectChangesetStatus.CHANGES_REQUESTED
          : ProjectChangesetStatus.REJECTED;
      changeset.reviewedByUserId = actor.userId;
      changeset.reviewedByAgentId = actor.agentId;
      changeset.reviewedAt = reviewedAt;
      changeset.reviewNotes = reviewNotes;
      const saved = await AppDataSource.getRepository(ProjectChangeset).save(changeset);
      res.json(serializeChangeset(saved));
    } catch (err) {
      console.error('Review changeset error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);


// ── Post-Merge Verification Gate ────────────────────────────────────────────
// After a changeset is merged, POST this endpoint to run npm run build and
// record whether the merged code actually compiles. (gk Pro R4 recommendation)
router.post(
  '/v1/projects/:project_id/changesets/:changeset_id/post-merge-verify',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const changeset = await AppDataSource.getRepository(ProjectChangeset).findOne({
        where: { id: req.params.changeset_id, projectId: req.params.project_id },
      });
      if (!changeset) {
        res.status(404).json({ detail: 'Changeset not found' });
        return;
      }
      if (changeset.status !== 'merged') {
        res.status(409).json({ detail: 'Changeset must be merged before post-merge verification' });
        return;
      }
      let postMergeStatus: 'passed' | 'failed' = 'passed';
      let buildOutput = '';
      try {
        const { execSync } = await import('child_process');
        buildOutput = execSync('npm run build', {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 120000,
        }).slice(-500);
      } catch (buildErr: any) {
        postMergeStatus = 'failed';
        buildOutput = ((buildErr.stderr || buildErr.stdout || '') + '').slice(-500);
      }
      changeset.postMergeStatus = postMergeStatus as any;
      await AppDataSource.getRepository(ProjectChangeset).save(changeset);
      res.json({
        changeset_id: changeset.id,
        post_merge_status: postMergeStatus,
        build_output: buildOutput,
      });
    } catch (err) {
      console.error('Post-merge verify error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

// ─── Changeset Review Comments (local-only discussions) ──────────────────────

router.post(
  '/v1/projects/:project_id/changesets/:changeset_id/comments',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const changesetId = req.params.changeset_id;
      const actor = getActor(req);
      if (!actor) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      if (req.agent) {
        res.status(403).json({ detail: 'Agent API keys cannot create changeset comments' });
        return;
      }

      const content = normalizeRequiredString(req.body.content, 'content', 10000);
      if (!content.ok) {
        res.status(422).json({ detail: content.error });
        return;
      }

      const anchor = validateCommentAnchor(req.body);
      if (!anchor.ok) {
        res.status(422).json({ detail: anchor.error });
        return;
      }

      const changeset = await AppDataSource.getRepository(ProjectChangeset).findOne({
        where: { id: changesetId, projectId },
      });
      if (!changeset) {
        res.status(404).json({ detail: 'Changeset not found' });
        return;
      }

      const parentCommentId = typeof req.body.parent_comment_id === 'string'
        ? req.body.parent_comment_id
        : null;
      if (parentCommentId) {
        const parent = await AppDataSource.getRepository(ProjectChangesetComment).findOne({
          where: { id: parentCommentId, projectId, changesetId, deletedAt: IsNull() },
        });
        if (!parent) {
          res.status(404).json({ detail: 'Parent comment not found' });
          return;
        }
      }

      if (anchor.baseRevisionId || anchor.headRevisionId) {
        const revisionCheck = await verifyCommentRevisions(
          projectId,
          anchor.filePath!,
          anchor.baseRevisionId,
          anchor.headRevisionId,
        );
        if (!revisionCheck.ok) {
          res.status(revisionCheck.status).json({ detail: revisionCheck.error });
          return;
        }
      }

      const comment = await AppDataSource.getRepository(ProjectChangesetComment).save(
        AppDataSource.getRepository(ProjectChangesetComment).create({
          projectId,
          changesetId,
          parentCommentId,
          authorType: actor.userId ? ProjectChangesetCommentAuthorType.USER : ProjectChangesetCommentAuthorType.AGENT,
          authorId: actor.userId ?? actor.agentId!,
          content: content.value,
          filePath: anchor.filePath,
          side: anchor.side,
          line: anchor.line,
          baseRevisionId: anchor.baseRevisionId,
          headRevisionId: anchor.headRevisionId,
          status: ProjectChangesetCommentStatus.ACTIVE,
        }),
      );

      res.status(201).json(serializeChangesetComment(comment));
    } catch (err) {
      console.error('Create changeset comment error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/changesets/:changeset_id/comments',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const changesetId = req.params.changeset_id;

      const changeset = await AppDataSource.getRepository(ProjectChangeset).findOne({
        where: { id: changesetId, projectId },
      });
      if (!changeset) {
        res.status(404).json({ detail: 'Changeset not found' });
        return;
      }

      const comments = await AppDataSource.getRepository(ProjectChangesetComment).find({
        where: { projectId, changesetId, deletedAt: IsNull() },
        order: { createdAt: 'ASC' },
      });

      res.json({
        data: comments.map(serializeChangesetComment),
        total: comments.length,
      });
    } catch (err) {
      console.error('List changeset comments error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.patch(
  '/v1/projects/:project_id/changesets/:changeset_id/comments/:comment_id',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const changesetId = req.params.changeset_id;
      const commentId = req.params.comment_id;
      const actor = getActor(req);
      if (!actor) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      if (req.agent) {
        res.status(403).json({ detail: 'Agent API keys cannot update changeset comments' });
        return;
      }

      const comment = await AppDataSource.getRepository(ProjectChangesetComment).findOne({
        where: { id: commentId, projectId, changesetId },
      });
      if (!comment || comment.deletedAt) {
        res.status(404).json({ detail: 'Comment not found' });
        return;
      }

      const canResolve = isOwnerOrAdmin(req) || isCommentAuthor(comment, actor);

      if (typeof req.body.content === 'string') {
        if (!isCommentAuthor(comment, actor)) {
          res.status(403).json({ detail: 'Only the comment author can edit content' });
          return;
        }
        const content = normalizeRequiredString(req.body.content, 'content', 10000);
        if (!content.ok) {
          res.status(422).json({ detail: content.error });
          return;
        }
        comment.content = content.value;
      }

      const requestedStatus = req.body.status;
      if (requestedStatus !== undefined) {
        if (!canResolve) {
          res.status(403).json({ detail: 'Only owner/admin or the comment author can resolve a thread' });
          return;
        }
        if (requestedStatus === ProjectChangesetCommentStatus.RESOLVED) {
          comment.status = ProjectChangesetCommentStatus.RESOLVED;
          comment.resolvedBy = actor.userId ?? actor.agentId ?? null;
          comment.resolvedAt = new Date();
        } else if (requestedStatus === ProjectChangesetCommentStatus.ACTIVE) {
          comment.status = ProjectChangesetCommentStatus.ACTIVE;
          comment.resolvedBy = null;
          comment.resolvedAt = null;
        } else {
          res.status(422).json({ detail: 'status must be active or resolved' });
          return;
        }
      }

      const saved = await AppDataSource.getRepository(ProjectChangesetComment).save(comment);
      res.json(serializeChangesetComment(saved));
    } catch (err) {
      console.error('Update changeset comment error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.post(
  '/v1/projects/:project_id/changesets/:changeset_id/merge',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const actor = getActor(req);
      if (!actor?.userId) {
        res.status(403).json({ detail: 'Only a JWT-authenticated user can merge this changeset' });
        return;
      }
      const loaded = await AppDataSource.getRepository(ProjectChangeset).findOne({
        where: { id: req.params.changeset_id, projectId: req.params.project_id },
      });
      if (!loaded) {
        res.status(404).json({ detail: 'Changeset not found' });
        return;
      }
      if (!isOwnerOrAdmin(req)) {
        res.status(403).json({ detail: 'Only project owner/admin can merge this changeset' });
        return;
      }
      if (
        loaded.status !== ProjectChangesetStatus.MERGE_READY &&
        loaded.status !== ProjectChangesetStatus.APPROVED
      ) {
        res.status(409).json({ detail: 'Changeset must be merge_ready or approved before merge' });
        return;
      }
      const targetBranch = await AppDataSource.getRepository(ProjectBranch).findOne({
        where: { id: loaded.branchId, projectId: req.params.project_id },
      });
      if (!targetBranch) {
        res.status(404).json({ detail: 'Branch not found' });
        return;
      }
      const effectiveRules = await resolveEffectiveBranchProtectionRules(req.params.project_id, targetBranch);
      const requiredApprovals = normalizeStoredRequiredApprovals(effectiveRules?.required_approvals);
      const currentApprovals = changesetApprovalCount(loaded);
      if (requiredApprovals > currentApprovals) {
        res.status(409).json({
          detail: 'Branch protection requires more approvals before merge',
          rule: 'required_approvals',
          required_approvals: requiredApprovals,
          current_approvals: currentApprovals,
        });
        return;
      }
      if (normalizeStoredMergeQueueEnabled(effectiveRules?.merge_queue_enabled)) {
        const mergeQueueBlock = await buildMergeQueueBlock(req.params.project_id, targetBranch.id, loaded);
        if (mergeQueueBlock) {
          res.status(409).json({
            detail: 'Branch protection requires this changeset to be at the head of the local merge queue before merge',
            rule: 'merge_queue',
            ...mergeQueueBlock,
          });
          return;
        }
      }
      const requiredStatusChecks = normalizeStoredRequiredStatusChecks(effectiveRules?.required_status_checks);
      const statusCheckBlock = buildRequiredStatusChecksBlock(requiredStatusChecks, loaded);
      if (statusCheckBlock) {
        res.status(409).json({
          detail: 'Branch protection requires passing status checks before merge',
          rule: 'required_status_checks',
          ...statusCheckBlock,
        });
        return;
      }

      const result = await AppDataSource.transaction(async (manager) => mergeChangeset(manager, req.params.project_id, loaded.id, actor));
      if (result.conflict) {
        res.status(409).json({
          detail: 'Changeset has file revision conflicts',
          changeset: serializeChangeset(result.changeset),
        });
        return;
      }

      // ── Real-git backend: replay the changeset's file ops into the project's
      // git repo and create a real git commit. Best-effort — never fails the
      // HTTP merge (the DB commit is already the source of truth). On success
      // we backfill ProjectCommit.gitSha so the git history is reachable.
      let gitSha: string | null = null;
      try {
        const { gitAddFile, gitRemoveFile, gitCommit, gitHeadSha, gitMergeBase, gitMerge } = await import('../services/project-git.service');
        // Record the HEAD before replay so we can detect divergence (true 3-way merge).
        const headBefore = await gitHeadSha(req.params.project_id);
        const ops: any[] = Array.isArray(result.changeset.fileOps) ? result.changeset.fileOps : [];
        for (const op of ops) {
          if (op.op === 'upsert' && typeof op.path === 'string' && typeof op.content === 'string') {
            await gitAddFile(req.params.project_id, op.path, op.content);
          } else if (op.op === 'delete' && typeof op.path === 'string') {
            await gitRemoveFile(req.params.project_id, op.path);
          } else if (op.op === 'rename' && typeof op.path === 'string' && typeof op.to_path === 'string') {
            await gitRemoveFile(req.params.project_id, op.path);
            if (typeof op.content === 'string') await gitAddFile(req.params.project_id, op.to_path, op.content);
          }
        }
        // Commit the replayed changes. If the changeset's base differs from the
        // pre-merge HEAD (divergent branches), this replay already advanced HEAD
        // linearly. For a true merge commit (two parents), we'd need the changeset
        // to have been built on a divergent ref — for now the linear replay is
        // correct and the merge-base primitives (gitMergeBase/gitMerge) are
        // available for future feature-branch workflows.
        gitSha = await gitCommit(req.params.project_id, `Merge changeset ${result.changeset.id}: ${result.commit.message || ''}`.trim());
        if (gitSha) {
          await AppDataSource.getRepository(ProjectCommit).update({ id: result.commit.id }, { gitSha });
          (result.commit as any).gitSha = gitSha;
        }
      } catch (gitErr) {
        console.error('Git backend write failed (DB merge still succeeded):', gitErr);
      }

      const giteaSync = new GiteaSyncService();
      const project = await AppDataSource.getRepository(Project).findOne({
        where: { id: req.params.project_id },
        select: ['id', 'name'],
      });
      const syncResult = await giteaSync.syncCommit(
        req.params.project_id,
        project?.name ?? req.params.project_id,
        {
          id: result.commit.id,
          parentCommitId: result.commit.parentCommitId ?? null,
          message: result.commit.message,
          createdByUserId: result.commit.createdByUserId ?? null,
          createdByAgentId: result.commit.createdByAgentId ?? null,
          changedFiles: result.commit.changedFiles || [],
          snapshot: result.commit.snapshot || {},
          orchestrationId: result.commit.orchestrationId ?? null,
          taskId: result.commit.taskId ?? null,
          changesetId: result.changeset.id,
          createdAt: result.commit.createdAt,
        },
      );

      res.json({
        changeset: serializeChangeset(result.changeset),
        commit: { ...serializeCommit(result.commit), git_sha: gitSha ?? null },
        gitea_sync: syncResult,
      });
    } catch (err) {
      if (err instanceof WholeFileUpsertRegressionError) {
        res.status(409).json({
          detail: 'whole-file upsert would regress post-base additions',
          path: err.path,
          regressed_line_count: err.regressedLineCount,
        });
        return;
      }
      if (err instanceof BranchHeadChangedError) {
        res.status(409).json({ detail: 'Branch head changed during merge; rebase the changeset and retry' });
        return;
      }
      console.error('Merge changeset error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.post(
  '/v1/projects/:project_id/changesets/:changeset_id/rebase',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const actor = getActor(req);
      if (!actor) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      const result = await AppDataSource.transaction(async (manager) =>
        rebaseChangeset(manager, req.params.project_id, req.params.changeset_id, actor, req),
      );

      if ('missing' in result) {
        res.status(404).json({ detail: 'Changeset not found' });
        return;
      }
      if ('forbidden' in result) {
        res.status(403).json({ detail: 'Only the creator or reviewer can rebase this changeset' });
        return;
      }
      if ('closed' in result) {
        res.status(409).json({ detail: 'Closed changesets cannot be rebased' });
        return;
      }
      if ('conflict' in result) {
        res.status(409).json({ detail: 'Changeset has conflicts', conflicts: result.conflicts, changeset: serializeChangeset(result.changeset) });
        return;
      }
      res.json(serializeChangeset(result.changeset));
    } catch (err) {
      console.error('Rebase changeset error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.post(
  '/v1/projects/:project_id/changesets/:changeset_id/preflight',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const changesetId = req.params.changeset_id;
      const changeset = await AppDataSource.getRepository(ProjectChangeset).findOne({
        where: { id: changesetId, projectId },
      });
      if (!changeset) {
        res.status(404).json({ detail: 'Changeset not found' });
        return;
      }
      if ([ProjectChangesetStatus.MERGED, ProjectChangesetStatus.CANCELLED, ProjectChangesetStatus.REJECTED].includes(changeset.status)) {
        res.status(409).json({ detail: 'Changeset is closed' });
        return;
      }

      const result = await runChangesetPreflight(projectId, changeset);
      changeset.mergeStatus = result.mergeStatus;
      const saved = await AppDataSource.getRepository(ProjectChangeset).save(changeset);

      res.json({
        merge_status: result.mergeStatus,
        issues: result.issues,
        changeset: serializeChangeset(saved),
      });
    } catch (err) {
      console.error('Changeset preflight error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.post(
  '/v1/projects/:project_id/rollback',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      if (!isOwnerOrAdmin(req)) {
        res.status(403).json({ detail: 'Only project owner/admin can rollback a project' });
        return;
      }
      const actor = getActor(req);
      if (!actor) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      const targetCommitId = typeof req.body.target_commit_id === 'string' ? req.body.target_commit_id : '';
      if (!targetCommitId) {
        res.status(422).json({ detail: 'target_commit_id is required' });
        return;
      }

      const result = await AppDataSource.transaction(async (manager) => rollbackToCommit(
        manager,
        req.params.project_id,
        targetCommitId,
        actor,
        typeof req.body.message === 'string' ? req.body.message : undefined,
      ));
      if ('missing' in result) {
        res.status(404).json({ detail: result.missing });
        return;
      }

      // ── Real-git mirror: replay the rolled-back tree into git and commit,
      // backfilling gitSha so post-rollback reads can go through true git.
      // Best-effort (DB rollback already succeeded). Mirrors the merge path.
      let rollbackGitSha: string | null = null;
      try {
        const { gitAddFile, gitRemoveFile, gitCommit } = await import('../services/project-git.service');
        const target = result.commit.snapshot || {};
        // Restore every path in the target snapshot; remove anything not in it.
        const targetPaths = new Set(Object.keys(target));
        for (const [path] of Object.entries(target)) {
          const file = await AppDataSource.getRepository(ProjectFile).findOne({ where: { projectId: req.params.project_id, path } });
          if (file && !file.deletedAt) {
            await gitAddFile(req.params.project_id, path, file.content);
          }
        }
        rollbackGitSha = await gitCommit(req.params.project_id, result.commit.message || `Rollback to ${targetCommitId}`);
        if (rollbackGitSha) {
          await AppDataSource.getRepository(ProjectCommit).update({ id: result.commit.id }, { gitSha: rollbackGitSha });
        }
      } catch (gitErr) {
        console.error('Git backend write failed on rollback (DB rollback succeeded):', gitErr);
      }

      res.json({ commit: serializeCommit(result.commit), changed_files: result.changedFiles, git_sha: rollbackGitSha });
    } catch (err) {
      console.error('Rollback project error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

async function mergeChangeset(
  manager: EntityManager,
  projectId: string,
  changesetId: string,
  actor: Actor,
): Promise<{ conflict: true; changeset: ProjectChangeset } | { conflict: false; changeset: ProjectChangeset; commit: ProjectCommit }> {
  const changeset = await manager.findOneByOrFail(ProjectChangeset, { id: changesetId, projectId });
  const branch = await manager.findOneByOrFail(ProjectBranch, { id: changeset.branchId, projectId });
  if (
    changeset.status !== ProjectChangesetStatus.MERGE_READY &&
    changeset.status !== ProjectChangesetStatus.APPROVED
  ) {
    throw new Error('Changeset must be merge_ready or approved before merge');
  }
  if ((branch.headCommitId ?? null) !== (changeset.baseCommitId ?? null)) {
    const conflicts = [{
      path: '*',
      reason: 'branch head has advanced; rebase before merge',
      base_commit_id: changeset.baseCommitId ?? null,
      current_head_commit_id: branch.headCommitId ?? null,
    }];
    changeset.status = ProjectChangesetStatus.CONFLICT;
    changeset.conflicts = conflicts;
    await writeConflictReport(manager, changeset, conflicts, actor);
    return { conflict: true, changeset: await manager.save(ProjectChangeset, changeset) };
  }

  // ── Whole-file upsert regression guard ─────────────────────────────────────
  // A whole-file upsert whose content was generated from a stale working copy
  // can silently delete lines added to HEAD after the op's base_revision_id:
  // if HEAD has a line that exists neither in the base-revision content nor in
  // op.content, applying op.content as a full overwrite would clobber it.
  // IMPORTANT: only run this when the op's base_revision_id IS the file's
  // current revision (a "fresh" base). When the base is already stale, the
  // generic file-revision conflict path below handles it and must keep
  // precedence so existing tests (and callers) see {changeset.status:'conflict'}.
  // (gk R9b, ordering fix)
  for (const op of changeset.fileOps) {
    if (op.op !== 'upsert' || !op.base_revision_id) continue;
    const currentFile = await manager.findOne(ProjectFile, {
      where: { projectId, path: op.path, deletedAt: IsNull() },
    });
    if (!currentFile) continue; // brand-new file: nothing on HEAD to regress
    if (op.base_revision_id !== currentFile.currentRevisionId) continue; // stale base → let conflict path handle
    const baseRevision = await manager.findOne(ProjectFileRevision, {
      where: { id: op.base_revision_id, projectId, path: op.path },
    });
    if (!baseRevision) continue; // let detectFileConflicts report the bad revision
    const regressedLineCount = countRegressedHeadLines(
      baseRevision.content,
      currentFile.content,
      op.content ?? '',
    );
    if (regressedLineCount > 0) {
      throw new WholeFileUpsertRegressionError(op.path, regressedLineCount);
    }
  }

  const conflicts = await detectFileConflicts(manager, projectId, changeset.fileOps);
  if (conflicts.length > 0) {
    changeset.status = ProjectChangesetStatus.CONFLICT;
    changeset.conflicts = conflicts;
    await writeConflictReport(manager, changeset, conflicts, actor);
    return { conflict: true, changeset: await manager.save(ProjectChangeset, changeset) };
  }

  const changedFiles: Array<Record<string, unknown>> = [];
  for (const op of changeset.fileOps) {
    if (op.op === 'upsert') {
      const upserted = await upsertProjectFile(manager, {
        projectId,
        path: op.path,
        content: op.content ?? '',
        contentType: normalizeContentType(op.content_type),
        actorId: actor.actorId,
        message: `Merge changeset ${changeset.id}: ${changeset.title}`,
      });
      changedFiles.push({
        op: 'upsert',
        path: op.path,
        file_id: upserted.file.id,
        revision_id: upserted.revision.id,
        content_hash: upserted.revision.contentHash,
        base_revision_id: op.base_revision_id ?? null,
      });
    } else if (op.op === 'delete') {
      const deleted = await deleteProjectFile(manager, projectId, op.path, actor.actorId);
      changedFiles.push({
        op: 'delete',
        path: op.path,
        file_id: deleted.id,
        base_revision_id: op.base_revision_id ?? null,
      });
    } else if (op.op === 'rename') {
      const source = await manager.findOneByOrFail(ProjectFile, {
        projectId,
        path: op.path,
        deletedAt: IsNull(),
      });
      const upserted = await upsertProjectFile(manager, {
        projectId,
        path: op.to_path!,
        content: source.content,
        contentType: source.contentType,
        actorId: actor.actorId,
        message: `Rename ${op.path} to ${op.to_path} in changeset ${changeset.id}`,
      });
      source.deletedAt = new Date();
      source.updatedBy = actor.actorId;
      await manager.save(ProjectFile, source);
      changedFiles.push({
        op: 'rename',
        path: op.to_path,
        old_path: op.path,
        from_file_id: source.id,
        to_file_id: upserted.file.id,
        revision_id: upserted.revision.id,
        content_hash: upserted.revision.contentHash,
        base_revision_id: op.base_revision_id ?? null,
      });
    }
  }

  const snapshot = await buildSnapshot(manager, projectId);
  const commit = await manager.save(ProjectCommit, manager.create(ProjectCommit, {
    projectId,
    branchId: branch.id,
    parentCommitId: branch.headCommitId ?? null,
    message: typeof changeset.title === 'string' && changeset.title.trim()
      ? changeset.title.trim().slice(0, 512)
      : `Merge changeset ${changeset.id}`,
    snapshot,
    changedFiles,
    verificationStatus: ProjectCommitVerificationStatus.VERIFIED,
    verificationSource: 'local_reviewed_changeset',
    verificationReason: 'Merged through an approved Project Space changeset. This is local provenance, not GPG/SSH signature verification.',
    verificationActorType: actor.userId ? 'user' : (actor.agentId ? 'agent' : null),
    verificationActorId: actor.userId ?? actor.agentId ?? null,
    verifiedAt: new Date(),
    createdByUserId: actor.userId,
    createdByAgentId: actor.agentId,
    orchestrationId: changeset.orchestrationId ?? null,
    taskId: changeset.taskId ?? null,
    changesetId: changeset.id,
  }));

  const branchHeadUpdate = manager
    .createQueryBuilder()
    .update(ProjectBranch)
    .set({ headCommitId: commit.id })
    .where('id = :branchId', { branchId: branch.id })
    .andWhere('project_id = :projectId', { projectId });
  if (branch.headCommitId) {
    branchHeadUpdate.andWhere('head_commit_id = :expectedHead', { expectedHead: branch.headCommitId });
  } else {
    branchHeadUpdate.andWhere('head_commit_id IS NULL');
  }
  const branchHeadResult = await branchHeadUpdate.execute();
  if (branchHeadResult.affected !== 1) {
    throw new BranchHeadChangedError();
  }

  changeset.status = ProjectChangesetStatus.MERGED;
  changeset.mergedCommitId = commit.id;
  changeset.mergedAt = new Date();
  changeset.conflicts = null;
  const previousQueuePosition = changeset.mergeQueuePosition ?? null;
  changeset.mergeQueuePosition = null;
  changeset.queuedAt = undefined;
  changeset.queuedByUserId = null;
  changeset.queuedByAgentId = null;
  const savedChangeset = await manager.save(ProjectChangeset, changeset);
  if (previousQueuePosition != null) {
    await compactMergeQueueAfterRemoval(manager, projectId, branch.id, previousQueuePosition);
  }

  return { conflict: false, changeset: savedChangeset, commit };
}

class BranchHeadChangedError extends Error {
  constructor() {
    super('Branch head changed during merge');
  }
}

// Thrown by mergeChangeset when a whole-file upsert would silently delete lines
// that were added to HEAD after the op's base_revision_id (a stale-working-copy
// overwrite). Caught by the merge endpoint and surfaced as a specific HTTP 409.
class WholeFileUpsertRegressionError extends Error {
  path: string;
  regressedLineCount: number;
  constructor(path: string, regressedLineCount: number) {
    super('whole-file upsert would regress post-base additions');
    this.path = path;
    this.regressedLineCount = regressedLineCount;
  }
}

async function rollbackToCommit(
  manager: EntityManager,
  projectId: string,
  targetCommitId: string,
  actor: Actor,
  message?: string,
): Promise<{ missing: string } | { commit: ProjectCommit; changedFiles: Array<Record<string, unknown>> }> {
  const target = await manager.findOne(ProjectCommit, { where: { id: targetCommitId, projectId } });
  if (!target) return { missing: 'Target commit not found' };
  const branch = await ensureDefaultBranchInTransaction(manager, projectId, actor);
  const changedFiles: Array<Record<string, unknown>> = [];
  const paths = Object.keys(target.snapshot).sort();

  for (const path of paths) {
    const targetEntry = target.snapshot[path];
    const currentFile = await manager.findOne(ProjectFile, { where: { projectId, path } });
    if (currentFile?.currentRevisionId === targetEntry.revision_id) continue;

    const revision = targetEntry.revision_id
      ? await manager.findOne(ProjectFileRevision, { where: { id: targetEntry.revision_id, projectId, path } })
      : null;
    if (!revision) continue;

    const upserted = await upsertProjectFile(manager, {
      projectId,
      path,
      content: revision.content,
      contentType: revision.contentType,
      actorId: actor.actorId,
      message: `Rollback to ${target.id}`,
    });
    changedFiles.push({
      op: 'restore',
      path,
      file_id: upserted.file.id,
      revision_id: upserted.revision.id,
      from_revision_id: currentFile?.currentRevisionId ?? null,
      target_revision_id: targetEntry.revision_id,
    });
  }

  const snapshot = await buildSnapshot(manager, projectId);
  const commit = await manager.save(ProjectCommit, manager.create(ProjectCommit, {
    projectId,
    branchId: branch.id,
    parentCommitId: branch.headCommitId ?? null,
    message: normalizeCommitMessage(message) ?? `Rollback to ${target.id}`,
    snapshot,
    changedFiles,
    verificationStatus: ProjectCommitVerificationStatus.UNVERIFIED,
    verificationSource: 'local_rollback',
    verificationReason: 'Created by a local rollback operation. This is not reviewed-merge provenance or GPG/SSH signature verification.',
    createdByUserId: actor.userId,
    createdByAgentId: actor.agentId,
  }));
  branch.headCommitId = commit.id;
  await manager.save(ProjectBranch, branch);
  return { commit, changedFiles };
}

type PreflightResult = {
  mergeStatus: ProjectChangesetMergeStatus;
  issues: Array<Record<string, unknown>>;
};

async function runChangesetPreflight(
  projectId: string,
  changeset: ProjectChangeset,
): Promise<PreflightResult> {
  const manager = AppDataSource.manager;
  const branch = await manager.findOne(ProjectBranch, {
    where: { id: changeset.branchId, projectId },
  });

  // If the branch head has moved past the changeset's base commit, the changeset
  // needs to be rebased before it can be evaluated for merge.
  if (branch && (branch.headCommitId ?? null) !== (changeset.baseCommitId ?? null)) {
    return {
      mergeStatus: ProjectChangesetMergeStatus.NEEDS_REBASE,
      issues: [{
        path: '*',
        reason: 'branch head has advanced; rebase before merge',
        base_commit_id: changeset.baseCommitId ?? null,
        current_head_commit_id: branch.headCommitId ?? null,
      }],
    };
  }

  const conflicts: Array<Record<string, unknown>> = [];
  const staleIssues: Array<Record<string, unknown>> = [];

  for (const op of changeset.fileOps) {
    const current = await manager.findOne(ProjectFile, {
      where: { projectId, path: op.path, deletedAt: IsNull() },
    });

    if ((op.op === 'delete' || op.op === 'rename') && !op.base_revision_id) {
      conflicts.push({
        path: op.path,
        op: op.op,
        reason: 'base_revision_id is required for delete and rename operations',
      });
      continue;
    }
    if ((op.op === 'delete' || op.op === 'rename') && !current) {
      conflicts.push({
        path: op.path,
        op: op.op,
        reason: 'file does not exist',
      });
      continue;
    }
    if (current && !op.base_revision_id) {
      conflicts.push({
        path: op.path,
        reason: 'base_revision_id is required when editing an existing file',
        current_revision_id: current.currentRevisionId ?? null,
      });
      continue;
    }
    if (!current && op.base_revision_id) {
      conflicts.push({
        path: op.path,
        reason: 'base_revision_id was supplied but the file does not exist',
        base_revision_id: op.base_revision_id,
      });
      continue;
    }
    if (current && op.base_revision_id && current.currentRevisionId !== op.base_revision_id) {
      // The file was modified after the changeset's base revision. This is a
      // stale base, not a structural conflict.
      staleIssues.push({
        path: op.path,
        reason: 'base_revision_id is stale',
        base_revision_id: op.base_revision_id,
        current_revision_id: current.currentRevisionId ?? null,
      });
      continue;
    }
    if (op.op === 'rename') {
      const target = await manager.findOne(ProjectFile, {
        where: { projectId, path: op.to_path!, deletedAt: IsNull() },
      });
      if (target) {
        conflicts.push({
          path: op.path,
          to_path: op.to_path,
          op: op.op,
          reason: 'rename target already exists',
          target_file_id: target.id,
        });
      }
    }
  }

  if (conflicts.length > 0) {
    return {
      mergeStatus: ProjectChangesetMergeStatus.CONFLICT,
      issues: conflicts,
    };
  }

  if (staleIssues.length > 0) {
    return {
      mergeStatus: ProjectChangesetMergeStatus.STALE,
      issues: staleIssues,
    };
  }

  return {
    mergeStatus: ProjectChangesetMergeStatus.CLEAN,
    issues: [],
  };
}

async function detectFileConflicts(
  manager: EntityManager,
  projectId: string,
  fileOps: ProjectChangesetFileOp[],
): Promise<Array<Record<string, unknown>>> {
  const conflicts: Array<Record<string, unknown>> = [];
  for (const op of fileOps) {
    const current = await manager.findOne(ProjectFile, {
      where: { projectId, path: op.path, deletedAt: IsNull() },
    });
    if ((op.op === 'delete' || op.op === 'rename') && !op.base_revision_id) {
      conflicts.push({
        path: op.path,
        op: op.op,
        reason: 'base_revision_id is required for delete and rename operations',
      });
      continue;
    }
    if ((op.op === 'delete' || op.op === 'rename') && !current) {
      conflicts.push({
        path: op.path,
        op: op.op,
        reason: 'file does not exist',
      });
      continue;
    }
    if (current && !op.base_revision_id) {
      conflicts.push({
        path: op.path,
        reason: 'base_revision_id is required when editing an existing file',
        current_revision_id: current.currentRevisionId ?? null,
      });
      continue;
    }
    if (current && op.base_revision_id && current.currentRevisionId !== op.base_revision_id) {
      conflicts.push({
        path: op.path,
        reason: 'base_revision_id is stale',
        base_revision_id: op.base_revision_id,
        current_revision_id: current.currentRevisionId ?? null,
      });
      continue;
    }
    if (!current && op.base_revision_id) {
      conflicts.push({
        path: op.path,
        reason: 'base_revision_id was supplied but the file does not exist',
        base_revision_id: op.base_revision_id,
      });
      continue;
    }
    if (op.op === 'rename') {
      const target = await manager.findOne(ProjectFile, {
        where: { projectId, path: op.to_path!, deletedAt: IsNull() },
      });
      if (target) {
        conflicts.push({
          path: op.path,
          to_path: op.to_path,
          op: op.op,
          reason: 'rename target already exists',
          target_file_id: target.id,
        });
      }
    }
  }
  return conflicts;
}

// Count HEAD lines that a whole-file upsert would silently delete: lines that
// exist in the current HEAD content but in neither the base-revision content
// (the version the op claims to derive from) nor the op's proposed content.
// Such lines were added to HEAD after the base revision and would be clobbered
// by applying op.content as a full overwrite. Returns 0 when the op is safe.
function countRegressedHeadLines(baseContent: string, headContent: string, opContent: string): number {
  const baseLines = new Set(baseContent.split('\n'));
  const opLines = new Set(opContent.split('\n'));
  let regressed = 0;
  for (const line of headContent.split('\n')) {
    if (!baseLines.has(line) && !opLines.has(line)) regressed++;
  }
  return regressed;
}

function computeChangedLineRanges(base: string, target: string): Array<{ start: number; end: number }> {
  const baseLines = base.split('\n');
  const targetLines = target.split('\n');

  let prefix = 0;
  while (prefix < baseLines.length && prefix < targetLines.length && baseLines[prefix] === targetLines[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < baseLines.length - prefix &&
    suffix < targetLines.length - prefix &&
    baseLines[baseLines.length - 1 - suffix] === targetLines[targetLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const start = prefix;
  const end = baseLines.length - suffix;
  if (start >= end && baseLines.length === targetLines.length) {
    return [];
  }
  return [{ start, end }];
}

function lineRangesOverlap(
  a: Array<{ start: number; end: number }>,
  b: Array<{ start: number; end: number }>,
): boolean {
  for (const ra of a) {
    for (const rb of b) {
      if (ra.start < rb.end && rb.start < ra.end) return true;
    }
  }
  return false;
}

type RebaseChangesetResult =
  | { ok: true; changeset: ProjectChangeset }
  | { conflict: true; changeset: ProjectChangeset; conflicts: Array<Record<string, unknown>> }
  | { missing: true }
  | { forbidden: true }
  | { closed: true };

async function rebaseChangeset(
  manager: EntityManager,
  projectId: string,
  changesetId: string,
  actor: Actor,
  req: Request,
): Promise<RebaseChangesetResult> {
  const changeset = await manager.findOne(ProjectChangeset, {
    where: { id: changesetId, projectId },
  });
  if (!changeset) return { missing: true };
  if (!isChangesetCreator(changeset, actor) && !await canReviewChangeset(req, changeset)) {
    return { forbidden: true };
  }
  if ([ProjectChangesetStatus.MERGED, ProjectChangesetStatus.REJECTED, ProjectChangesetStatus.CANCELLED].includes(changeset.status)) {
    return { closed: true };
  }

  const branch = await manager.findOneByOrFail(ProjectBranch, { id: changeset.branchId, projectId });
  const conflicts: Array<Record<string, unknown>> = [];
  const rebasedFileOps: ProjectChangesetFileOp[] = [];

  for (const op of changeset.fileOps) {
    if (op.op === 'delete') {
      const current = await manager.findOne(ProjectFile, { where: { projectId, path: op.path, deletedAt: IsNull() } });
      if (!current) {
        conflicts.push({ path: op.path, op: 'delete', reason: 'file does not exist' });
        continue;
      }
      if (op.base_revision_id && current.currentRevisionId !== op.base_revision_id) {
        conflicts.push({
          path: op.path,
          op: 'delete',
          reason: 'file was modified after base revision',
          base_revision_id: op.base_revision_id,
          current_revision_id: current.currentRevisionId ?? null,
        });
        continue;
      }
      rebasedFileOps.push(op);
      continue;
    }

    if (op.op === 'rename') {
      const current = await manager.findOne(ProjectFile, { where: { projectId, path: op.path, deletedAt: IsNull() } });
      if (!current) {
        conflicts.push({ path: op.path, op: 'rename', reason: 'file does not exist' });
        continue;
      }
      if (op.base_revision_id && current.currentRevisionId !== op.base_revision_id) {
        conflicts.push({
          path: op.path,
          op: 'rename',
          reason: 'file was modified after base revision',
          base_revision_id: op.base_revision_id,
          current_revision_id: current.currentRevisionId ?? null,
        });
        continue;
      }
      const target = await manager.findOne(ProjectFile, { where: { projectId, path: op.to_path!, deletedAt: IsNull() } });
      if (target) {
        conflicts.push({
          path: op.path,
          to_path: op.to_path,
          op: 'rename',
          reason: 'rename target already exists',
          target_file_id: target.id,
        });
        continue;
      }
      rebasedFileOps.push(op);
      continue;
    }

    // upsert
    const current = await manager.findOne(ProjectFile, { where: { projectId, path: op.path, deletedAt: IsNull() } });

    if (!op.base_revision_id) {
      if (current) {
        conflicts.push({
          path: op.path,
          op: 'upsert',
          reason: 'file already exists without base_revision_id',
          current_revision_id: current.currentRevisionId ?? null,
        });
      } else {
        rebasedFileOps.push(op);
      }
      continue;
    }

    if (!current) {
      conflicts.push({
        path: op.path,
        op: 'upsert',
        reason: 'base_revision_id was supplied but the file does not exist',
        base_revision_id: op.base_revision_id,
      });
      continue;
    }

    if (current.currentRevisionId === op.base_revision_id) {
      // Still fresh: keep the op as-is.
      rebasedFileOps.push(op);
      continue;
    }

    // Stale base: fetch base revision content and compare line ranges.
    const baseRevision = await manager.findOne(ProjectFileRevision, {
      where: { id: op.base_revision_id, projectId, path: op.path },
    });
    if (!baseRevision) {
      conflicts.push({
        path: op.path,
        op: 'upsert',
        reason: 'base revision not found',
        base_revision_id: op.base_revision_id,
      });
      continue;
    }

    const otherChanges = computeChangedLineRanges(baseRevision.content, current.content);
    const changesetChanges = computeChangedLineRanges(baseRevision.content, op.content ?? '');

    if (lineRangesOverlap(otherChanges, changesetChanges)) {
      conflicts.push({
        path: op.path,
        op: 'upsert',
        reason: 'content changed on the same lines as the changeset',
        base_revision_id: op.base_revision_id,
        current_revision_id: current.currentRevisionId ?? null,
        changed_lines_overlap: true,
      });
      continue;
    }

    // No overlap: best-effort auto-update the file_op to the current revision.
    rebasedFileOps.push({
      ...op,
      base_revision_id: current.currentRevisionId ?? null,
    });
  }

  if (conflicts.length > 0) {
    changeset.status = ProjectChangesetStatus.CONFLICT;
    changeset.conflicts = conflicts;
    changeset.mergeStatus = ProjectChangesetMergeStatus.CONFLICT;
    await writeConflictReport(manager, changeset, conflicts, actor);
    return { conflict: true, changeset: await manager.save(ProjectChangeset, changeset), conflicts };
  }

  changeset.fileOps = rebasedFileOps;
  changeset.baseCommitId = branch.headCommitId ?? null;
  changeset.status = ProjectChangesetStatus.SUBMITTED;
  changeset.conflicts = null;
  changeset.mergeStatus = ProjectChangesetMergeStatus.CLEAN;
  return { ok: true, changeset: await manager.save(ProjectChangeset, changeset) };
}

async function writeConflictReport(
  manager: EntityManager,
  changeset: ProjectChangeset,
  conflicts: Array<Record<string, unknown>>,
  actor: Actor,
): Promise<void> {
  const content = [
    `# Changeset Conflict: ${changeset.title}`,
    '',
    `- changeset_id: ${changeset.id}`,
    `- status: ${ProjectChangesetStatus.CONFLICT}`,
    `- generated_at: ${new Date().toISOString()}`,
    '',
    '## Conflicts',
    '',
    ...conflicts.map((conflict, index) => `${index + 1}. \`${String(conflict.path ?? '')}\`: ${String(conflict.reason ?? 'conflict')}`),
    '',
    '## Raw',
    '',
    '```json',
    JSON.stringify(conflicts, null, 2),
    '```',
    '',
  ].join('\n');
  await upsertProjectFile(manager, {
    projectId: changeset.projectId,
    path: `.agent/changesets/${changeset.id}/conflict.md`,
    content,
    actorId: actor.actorId,
    message: `Write conflict report for ${changeset.id}`,
  });
}

async function ensureDefaultBranch(projectId: string, actor: Actor | null): Promise<ProjectBranch> {
  return AppDataSource.transaction((manager) => ensureDefaultBranchInTransaction(manager, projectId, actor));
}

async function ensureDefaultBranchInTransaction(
  manager: EntityManager,
  projectId: string,
  actor: Actor | null,
): Promise<ProjectBranch> {
  const repo = manager.getRepository(ProjectBranch);
  let branch = await repo.findOne({ where: { projectId, isDefault: true } });
  if (branch) return branch;
  // Back-compat: fall back to the legacy main branch if it exists without the default flag.
  branch = await repo.findOne({ where: { projectId, name: 'main' } });
  if (branch) {
    branch.isDefault = true;
    return repo.save(branch);
  }
  branch = repo.create({
    projectId,
    name: 'main',
    isDefault: true,
    createdByUserId: actor?.userId ?? null,
    createdByAgentId: actor?.agentId ?? null,
  });
  return repo.save(branch);
}

async function buildSnapshot(manager: EntityManager, projectId: string): Promise<ProjectCommitSnapshot> {
  const files = await manager.find(ProjectFile, { where: { projectId, deletedAt: IsNull() }, order: { path: 'ASC' } });
  const snapshot: ProjectCommitSnapshot = {};
  for (const file of files) {
    snapshot[file.path] = {
      file_id: file.id,
      revision_id: file.currentRevisionId ?? null,
      content_hash: file.contentHash,
    };
  }
  return snapshot;
}

async function upsertProjectFile(
  manager: EntityManager,
  input: ProjectFileUpsertInput,
): Promise<{ file: ProjectFile; revision: ProjectFileRevision }> {
  // Delegate to the shared write core (single place for the future git `add`).
  const { file, revision } = await upsertProjectFileContent(manager, {
    projectId: input.projectId,
    path: input.path,
    content: input.content,
    contentType: input.contentType,
    message: normalizeCommitMessage(input.message),
    actorId: input.actorId,
    maxFileBytes: MAX_FILE_BYTES,
  });
  return { file, revision };
}

async function deleteProjectFile(
  manager: EntityManager,
  projectId: string,
  path: string,
  actorId: string,
): Promise<ProjectFile> {
  const file = await softDeleteProjectFile(manager, projectId, path);
  if (!file) {
    // Match prior findOneByOrFail behavior: throw if the (non-deleted) file is missing.
    throw new Error(`File not found: ${path}`);
  }
  file.updatedBy = actorId;
  return manager.save(ProjectFile, file);
}

async function commitExists(projectId: string, commitId: string): Promise<boolean> {
  return Boolean(await AppDataSource.getRepository(ProjectCommit).findOne({ where: { id: commitId, projectId }, select: ['id'] }));
}

type BranchSourceResult =
  | { ok: true; headCommitId: string | null; sourceBranchName: string | null }
  | { ok: false; status: number; detail: string };

async function resolveBranchSource(projectId: string, body: any): Promise<BranchSourceResult> {
  const explicitCommitId = typeof body.source_commit_id === 'string' && body.source_commit_id.trim()
    ? body.source_commit_id.trim()
    : null;
  if (explicitCommitId) {
    const commit = await AppDataSource.getRepository(ProjectCommit).findOne({
      where: { id: explicitCommitId, projectId },
      select: ['id'],
    });
    if (!commit) return { ok: false, status: 404, detail: 'source_commit_id not found in this project' };
    return { ok: true, headCommitId: commit.id, sourceBranchName: null };
  }

  const sourceBranchRef = typeof body.source_branch === 'string' && body.source_branch.trim()
    ? body.source_branch.trim()
    : typeof body.source_branch_id === 'string' && body.source_branch_id.trim()
      ? body.source_branch_id.trim()
      : 'main';

  await ensureDefaultBranch(projectId, null);
  const sourceBranch = await AppDataSource.getRepository(ProjectBranch)
    .createQueryBuilder('branch')
    .where('branch.projectId = :projectId', { projectId })
    .andWhere('(branch.name = :sourceBranchRef OR branch.id = :sourceBranchRef)', { sourceBranchRef })
    .getOne();
  if (!sourceBranch) return { ok: false, status: 404, detail: 'source branch not found in this project' };
  return {
    ok: true,
    headCommitId: sourceBranch.headCommitId ?? null,
    sourceBranchName: sourceBranch.name,
  };
}

async function canReviewChangeset(req: Request, changeset: ProjectChangeset): Promise<boolean> {
  if (isOwnerOrAdmin(req)) return true;
  if (!req.agent) return false;
  // Project-level main agent can review ANY changeset in the project (acts as PM).
  const project = await AppDataSource.getRepository(Project).findOne({
    where: { id: changeset.projectId },
    select: ['id', 'mainAgentId'],
  });
  if (project?.mainAgentId === req.agent.id) return true;
  // Otherwise only the orchestration-level main agent can review (legacy behavior),
  // and only when the changeset is tied to an orchestration.
  if (!changeset.orchestrationId) return false;
  const orchestration = await AppDataSource.getRepository(ProjectOrchestration).findOne({
    where: { id: changeset.orchestrationId, projectId: changeset.projectId },
    select: ['id', 'mainAgentId'],
  });
  return orchestration?.mainAgentId === req.agent.id;
}

function isOwnerOrAdmin(req: Request): boolean {
  return (req as any).projectRole === Role.Owner || (req as any).projectRole === Role.Admin;
}

function isChangesetCreator(changeset: ProjectChangeset, actor: Actor): boolean {
  return Boolean(
    (actor.userId && changeset.createdByUserId === actor.userId)
      || (actor.agentId && changeset.createdByAgentId === actor.agentId),
  );
}

function getActor(req: Request): Actor | null {
  const userId = req.user?.userId ?? null;
  const agentId = req.agent?.id ?? null;
  const actorId = userId ?? agentId;
  return actorId ? { actorId, userId, agentId } : null;
}

function validateFileOps(value: unknown): { ok: true; value: ProjectChangesetFileOp[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: 'file_ops must be a non-empty array' };
  }
  if (value.length > 100) {
    return { ok: false, error: 'file_ops cannot contain more than 100 operations' };
  }

  const ops: ProjectChangesetFileOp[] = [];
  for (const raw of value) {
    if (!isPlainObject(raw)) return { ok: false, error: 'each file op must be an object' };
    const op = raw.op === 'upsert' || raw.op === 'delete' || raw.op === 'rename' ? raw.op : null;
    if (!op) return { ok: false, error: 'file op must be upsert, delete, or rename' };

    const path = validateProjectPath(raw.path);
    if (!path.ok) return { ok: false, error: `file op path: ${path.error}` };
    if (op === 'upsert') {
      if (typeof raw.content !== 'string') return { ok: false, error: `content is required for ${path.value}` };
      if (Buffer.byteLength(raw.content, 'utf8') > MAX_FILE_BYTES) {
        return { ok: false, error: `content for ${path.value} exceeds ${MAX_FILE_BYTES} bytes` };
      }
      ops.push({
        op: 'upsert',
        path: path.value,
        content: raw.content,
        content_type: normalizeContentType(raw.content_type),
        base_revision_id: typeof raw.base_revision_id === 'string' ? raw.base_revision_id : null,
      });
      continue;
    }
    const baseRevisionId = typeof raw.base_revision_id === 'string' ? raw.base_revision_id : null;
    if (!baseRevisionId) return { ok: false, error: `base_revision_id is required for ${op} ${path.value}` };
    if (op === 'delete') {
      ops.push({ op: 'delete', path: path.value, base_revision_id: baseRevisionId });
      continue;
    }
    const toPath = validateProjectPath(raw.to_path);
    if (!toPath.ok) return { ok: false, error: `file op to_path: ${toPath.error}` };
    if (toPath.value === path.value) return { ok: false, error: 'rename to_path must be different from path' };
    ops.push({ op: 'rename', path: path.value, to_path: toPath.value, base_revision_id: baseRevisionId });
  }
  return { ok: true, value: ops };
}

function validateProjectPath(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string') {
    return { ok: false, error: 'path is required and must be a string' };
  }
  const path = value.trim().replace(/\\/g, '/');
  if (!path || path.length > 1024) {
    return { ok: false, error: 'path must be 1-1024 characters' };
  }
  if (path.startsWith('/') || path.includes('//') || path.split('/').includes('..')) {
    return { ok: false, error: 'path must be relative and cannot contain .. or empty segments' };
  }
  return { ok: true, value: path };
}

function normalizeBranchName(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string') {
    return { ok: false, error: 'name is required and must be a string' };
  }
  const name = value.trim();
  if (!name || name.length > 128) {
    return { ok: false, error: 'branch name must be 1-128 characters' };
  }
  if (
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.includes('//') ||
    name.includes('\\') ||
    name.includes('..') ||
    name.includes('@{') ||
    /[\s~^:?*\[\]\x00-\x1F\x7F]/.test(name)
  ) {
    return { ok: false, error: 'branch name contains unsupported characters' };
  }
  if (name === '.' || name.endsWith('.')) {
    return { ok: false, error: 'branch name cannot be dot or end with dot' };
  }
  return { ok: true, value: name };
}

function isDefaultBranch(branch: ProjectBranch): boolean {
  return branch.isDefault;
}

function isProtectedBranch(branch: ProjectBranch, protectedBranchPatterns: string[] = []): boolean {
  // The current default branch is always protected by behavior, even when the
  // explicit protection flag has not been toggled.
  return branch.isProtected || branch.isDefault || branchMatchesProtectedBranchPattern(branch.name, protectedBranchPatterns);
}

function normalizeOptionalPath(value: unknown, field: string): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  const path = validateProjectPath(value);
  return path.ok ? { ok: true, value: path.value } : { ok: false, error: `${field}: ${path.error}` };
}

function normalizeRequiredString(value: unknown, field: string, max: number): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: `${field} is required` };
  }
  const trimmed = value.trim();
  if (trimmed.length > max) return { ok: false, error: `${field} must be at most ${max} characters` };
  return { ok: true, value: trimmed };
}

function normalizeContentType(value: unknown): string {
  if (value === 'text/plain' || value === 'application/json' || value === 'text/markdown') {
    return value;
  }
  return 'text/markdown';
}

function normalizeCommitMessage(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 512) : null;
}

function parsePaginationInt(value: unknown, min: number, max: number, defaultValue: number): number {
  const n = typeof value === 'string' ? parseInt(value, 10) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n) || n < min || n > max) return defaultValue;
  return n;
}

type FileDiff = {
  op: 'upsert' | 'delete' | 'rename';
  path: string;
  old_path: string | null;
  old_content: string | null;
  new_content: string | null;
  old_revision_id: string | null;
  new_revision_id: string | null;
  content_type: string | null;
};

async function buildFileDiffs(
  projectId: string,
  fileOps: ProjectChangesetFileOp[],
): Promise<FileDiff[]> {
  const diffs: FileDiff[] = [];
  for (const op of fileOps) {
    if (op.op === 'upsert') {
      const base = await readBaseContent(projectId, op.path, op.base_revision_id ?? null);
      diffs.push({
        op: 'upsert',
        path: op.path,
        old_path: null,
        old_content: base.content,
        new_content: op.content ?? '',
        old_revision_id: base.revisionId,
        new_revision_id: null,
        content_type: op.content_type ?? 'text/markdown',
      });
    } else if (op.op === 'delete') {
      const base = await readBaseContent(projectId, op.path, op.base_revision_id ?? null);
      diffs.push({
        op: 'delete',
        path: op.path,
        old_path: null,
        old_content: base.content,
        new_content: null,
        old_revision_id: base.revisionId,
        new_revision_id: null,
        content_type: null,
      });
    } else if (op.op === 'rename') {
      const base = await readBaseContent(projectId, op.path, op.base_revision_id ?? null);
      const toPath = op.to_path ?? op.path;
      const toFile = await AppDataSource.getRepository(ProjectFile).findOne({
        where: { projectId, path: toPath, deletedAt: IsNull() },
      });
      diffs.push({
        op: 'rename',
        path: toPath,
        old_path: op.path,
        old_content: base.content,
        new_content: toFile?.content ?? base.content,
        old_revision_id: base.revisionId,
        new_revision_id: toFile?.currentRevisionId ?? null,
        content_type: null,
      });
    }
  }
  return diffs;
}

async function readBaseContent(
  projectId: string,
  path: string,
  baseRevisionId: string | null,
): Promise<{ content: string | null; revisionId: string | null }> {
  if (baseRevisionId) {
    const revision = await AppDataSource.getRepository(ProjectFileRevision).findOne({
      where: { id: baseRevisionId, projectId, path },
    });
    if (revision) return { content: revision.content, revisionId: revision.id };
    return { content: null, revisionId: null };
  }
  const file = await AppDataSource.getRepository(ProjectFile).findOne({
    where: { projectId, path, deletedAt: IsNull() },
  });
  if (file) return { content: file.content, revisionId: file.currentRevisionId ?? null };
  return { content: null, revisionId: null };
}

type BranchCompareFile = {
  path: string;
  old_path?: string;
  op: 'added' | 'modified' | 'deleted' | 'renamed';
  old_revision_id: string | null;
  new_revision_id: string | null;
  old_content: string | null;
  new_content: string | null;
  old_content_hash: string | null;
  new_content_hash: string | null;
};

async function buildBranchCompareResult(
  baseBranch: ProjectBranch,
  baseCommit: ProjectCommit,
  headBranch: ProjectBranch,
  headCommit: ProjectCommit,
): Promise<{
  base_branch: ReturnType<typeof serializeBranch>;
  head_branch: ReturnType<typeof serializeBranch>;
  merge_base_sha: string | null;
  summary: { files_changed: number; total: number; added: number; modified: number; deleted: number; renamed: number };
  files: BranchCompareFile[];
}> {
  const baseSnapshot = baseCommit.snapshot || {};
  const headSnapshot = headCommit.snapshot || {};
  const allPaths = new Set([...Object.keys(baseSnapshot), ...Object.keys(headSnapshot)]);

  const revisionIds = new Set<string>();
  for (const path of allPaths) {
    const baseEntry = baseSnapshot[path];
    const headEntry = headSnapshot[path];
    if (baseEntry?.revision_id) revisionIds.add(baseEntry.revision_id);
    if (headEntry?.revision_id) revisionIds.add(headEntry.revision_id);
  }
  const revisions = revisionIds.size > 0
    ? await AppDataSource.getRepository(ProjectFileRevision).findBy({ id: In([...revisionIds]) })
    : [];
  const contentByRevisionId = new Map(revisions.map((r) => [r.id, r.content]));

  const files: BranchCompareFile[] = [];
  const addedCandidates: Array<{ path: string; entry: ProjectCommitSnapshot[string] }> = [];
  const deletedCandidates: Array<{ path: string; entry: ProjectCommitSnapshot[string] }> = [];
  let added = 0;
  let modified = 0;
  let deleted = 0;
  let renamed = 0;

  for (const path of [...allPaths].sort()) {
    const baseEntry = baseSnapshot[path];
    const headEntry = headSnapshot[path];

    if (!baseEntry && headEntry) {
      addedCandidates.push({ path, entry: headEntry });
    } else if (baseEntry && !headEntry) {
      deletedCandidates.push({ path, entry: baseEntry });
    } else if (baseEntry && headEntry && baseEntry.content_hash !== headEntry.content_hash) {
      files.push({
        path,
        op: 'modified',
        old_revision_id: baseEntry.revision_id ?? null,
        new_revision_id: headEntry.revision_id ?? null,
        old_content: baseEntry.revision_id ? (contentByRevisionId.get(baseEntry.revision_id) ?? null) : null,
        new_content: headEntry.revision_id ? (contentByRevisionId.get(headEntry.revision_id) ?? null) : null,
        old_content_hash: baseEntry.content_hash,
        new_content_hash: headEntry.content_hash,
      });
      modified++;
    }
  }

  const usedAddedIndexes = new Set<number>();
  for (const deletedCandidate of deletedCandidates) {
    const addedIndex = addedCandidates.findIndex((candidate, index) =>
      !usedAddedIndexes.has(index) &&
      !!candidate.entry.content_hash &&
      candidate.entry.content_hash === deletedCandidate.entry.content_hash
    );
    if (addedIndex >= 0) {
      const addedCandidate = addedCandidates[addedIndex];
      usedAddedIndexes.add(addedIndex);
      files.push({
        path: addedCandidate.path,
        old_path: deletedCandidate.path,
        op: 'renamed',
        old_revision_id: deletedCandidate.entry.revision_id ?? null,
        new_revision_id: addedCandidate.entry.revision_id ?? null,
        old_content: deletedCandidate.entry.revision_id
          ? (contentByRevisionId.get(deletedCandidate.entry.revision_id) ?? null)
          : null,
        new_content: addedCandidate.entry.revision_id
          ? (contentByRevisionId.get(addedCandidate.entry.revision_id) ?? null)
          : null,
        old_content_hash: deletedCandidate.entry.content_hash,
        new_content_hash: addedCandidate.entry.content_hash,
      });
      renamed++;
      continue;
    }
    files.push({
      path: deletedCandidate.path,
      op: 'deleted',
      old_revision_id: deletedCandidate.entry.revision_id ?? null,
      new_revision_id: null,
      old_content: deletedCandidate.entry.revision_id
        ? (contentByRevisionId.get(deletedCandidate.entry.revision_id) ?? null)
        : null,
      new_content: null,
      old_content_hash: deletedCandidate.entry.content_hash,
      new_content_hash: null,
    });
    deleted++;
  }

  for (let index = 0; index < addedCandidates.length; index++) {
    if (usedAddedIndexes.has(index)) continue;
    const addedCandidate = addedCandidates[index];
    files.push({
      path: addedCandidate.path,
      op: 'added',
      old_revision_id: null,
      new_revision_id: addedCandidate.entry.revision_id ?? null,
      old_content: null,
      new_content: addedCandidate.entry.revision_id
        ? (contentByRevisionId.get(addedCandidate.entry.revision_id) ?? null)
        : null,
      old_content_hash: null,
      new_content_hash: addedCandidate.entry.content_hash,
    });
    added++;
  }

  files.sort((left, right) => (left.old_path || left.path).localeCompare(right.old_path || right.path));

  // Compute the real-git merge base (common ancestor) when both commits have a
  // gitSha, enabling true three-way diff semantics. Null when git history isn't
  // available for either side (pre-git commits / rollback without backfill).
  let mergeBaseSha: string | null = null;
  if (baseCommit.gitSha && headCommit.gitSha) {
    try {
      const { gitMergeBase } = await import('../services/project-git.service');
      mergeBaseSha = await gitMergeBase(baseCommit.projectId, baseCommit.gitSha, headCommit.gitSha);
    } catch {
      mergeBaseSha = null;
    }
  }

  return {
    base_branch: serializeBranch(baseBranch),
    head_branch: serializeBranch(headBranch),
    merge_base_sha: mergeBaseSha,
    summary: {
      files_changed: files.length,
      total: files.length,
      added,
      modified,
      deleted,
      renamed,
    },
    files,
  };
}

function serializeBranch(branch: ProjectBranch, projectProtectedBranchPatterns?: string[]) {
  const protectedBranchPatterns = projectProtectedBranchPatterns ??
    normalizeStoredProtectedBranchPatterns(branch.protectionRules?.protected_branch_patterns);
  const patternProtected = branchMatchesProtectedBranchPattern(branch.name, protectedBranchPatterns);
  const effectivelyProtected = branch.isProtected || branch.isDefault || patternProtected;
  const rules = {
    block_direct_writes: branch.protectionRules?.block_direct_writes === true,
    direct_write_bypass_roles: normalizeStoredDirectWriteBypassRoles(
      branch.protectionRules?.direct_write_bypass_roles,
    ),
    direct_write_bypass_user_ids: normalizeStoredDirectWriteBypassUserIds(
      branch.protectionRules?.direct_write_bypass_user_ids,
    ),
    required_approvals: normalizeStoredRequiredApprovals(branch.protectionRules?.required_approvals),
    required_status_checks: normalizeStoredRequiredStatusChecks(branch.protectionRules?.required_status_checks),
    merge_queue_enabled: normalizeStoredMergeQueueEnabled(branch.protectionRules?.merge_queue_enabled),
    protected_branch_patterns: protectedBranchPatterns,
  };
  return {
    id: branch.id,
    project_id: branch.projectId,
    name: branch.name,
    head_commit_id: branch.headCommitId ?? null,
    is_default: branch.isDefault,
    is_protected: branch.isProtected,
    protection: {
      is_protected: effectivelyProtected,
      is_pattern_protected: patternProtected,
      rules,
    },
    created_by_user_id: branch.createdByUserId ?? null,
    created_by_agent_id: branch.createdByAgentId ?? null,
    created_at: branch.createdAt,
    updated_at: branch.updatedAt,
  };
}

async function loadProjectProtectedBranchPatterns(projectId: string): Promise<string[]> {
  const branch = await AppDataSource.getRepository(ProjectBranch).findOne({ where: { projectId, isDefault: true } });
  return normalizeStoredProtectedBranchPatterns(branch?.protectionRules?.protected_branch_patterns);
}

async function loadProjectProtectedBranchPatternsInTransaction(
  manager: EntityManager,
  projectId: string,
): Promise<string[]> {
  const branch = await manager.findOne(ProjectBranch, { where: { projectId, isDefault: true } });
  return normalizeStoredProtectedBranchPatterns(branch?.protectionRules?.protected_branch_patterns);
}

async function resolveEffectiveBranchProtectionRules(
  projectId: string,
  branch: ProjectBranch,
): Promise<ProjectBranch['protectionRules']> {
  if (branch.isDefault || branch.isProtected) return branch.protectionRules ?? null;
  const defaultBranch = await AppDataSource.getRepository(ProjectBranch).findOne({ where: { projectId, isDefault: true } });
  const protectedBranchPatterns = normalizeStoredProtectedBranchPatterns(
    defaultBranch?.protectionRules?.protected_branch_patterns,
  );
  if (branchMatchesProtectedBranchPattern(branch.name, protectedBranchPatterns)) {
    return defaultBranch?.protectionRules ?? null;
  }
  return branch.protectionRules ?? null;
}

function normalizeDirectWriteBypassRoles(value: unknown): { ok: true; value: ProjectRole[] | null } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: null };
  if (!Array.isArray(value)) return { ok: false, error: 'direct_write_bypass_roles must be an array' };
  const seen = new Set<string>();
  const normalized: ProjectRole[] = [];
  for (const role of value) {
    if (role !== ProjectRole.OWNER && role !== ProjectRole.ADMIN && role !== ProjectRole.MEMBER) {
      return { ok: false, error: 'direct_write_bypass_roles may only include owner, admin, or member' };
    }
    if (seen.has(role)) return { ok: false, error: 'direct_write_bypass_roles must not contain duplicates' };
    seen.add(role);
    normalized.push(role);
  }
  return { ok: true, value: sortDirectWriteBypassRoles(normalized) };
}

function normalizeStoredDirectWriteBypassRoles(value: unknown): ProjectRole[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set([ProjectRole.OWNER, ProjectRole.ADMIN, ProjectRole.MEMBER]);
  const roles = value.filter((role): role is ProjectRole => allowed.has(role as ProjectRole));
  return sortDirectWriteBypassRoles(Array.from(new Set(roles)));
}

async function normalizeDirectWriteBypassUserIds(
  projectId: string,
  value: unknown,
): Promise<
  | { ok: true; value: string[] | null }
  | { ok: false; error: string; missingUserIds?: string[]; ineligibleUserIds?: string[] }
> {
  if (value === undefined) return { ok: true, value: null };
  if (!Array.isArray(value)) return { ok: false, error: 'direct_write_bypass_user_ids must be an array' };
  if (value.length > 12) return { ok: false, error: 'direct_write_bypass_user_ids may include at most 12 users' };
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || !raw.trim()) {
      return { ok: false, error: 'direct_write_bypass_user_ids entries must be non-empty strings' };
    }
    const id = raw.trim();
    if (seen.has(id)) return { ok: false, error: 'direct_write_bypass_user_ids must not contain duplicates' };
    seen.add(id);
    ids.push(id);
  }
  if (!ids.length) return { ok: true, value: [] };

  const members = await AppDataSource.getRepository(ProjectMember).find({
    where: { projectId, userId: In(ids) },
  });
  const byUserId = new Map(members.map((member) => [member.userId, member]));
  const missingUserIds = ids.filter((id) => !byUserId.has(id));
  const ineligibleUserIds = ids.filter((id) => byUserId.get(id)?.role === ProjectRole.VIEWER);
  if (missingUserIds.length || ineligibleUserIds.length) {
    return {
      ok: false,
      error: 'direct_write_bypass_user_ids may only include owner, admin, or member project users',
      missingUserIds,
      ineligibleUserIds,
    };
  }
  return { ok: true, value: ids.slice().sort() };
}

function normalizeStoredDirectWriteBypassUserIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((id): id is string => typeof id === 'string' && !!id.trim()).map((id) => id.trim());
  return Array.from(new Set(ids)).sort();
}

function normalizeRequiredApprovals(value: unknown): { ok: true; value: number | null } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: null };
  if (!Number.isInteger(value)) return { ok: false, error: 'required_approvals must be an integer' };
  const approvals = value as number;
  if (approvals < 0 || approvals > 6) return { ok: false, error: 'required_approvals must be between 0 and 6' };
  return { ok: true, value: approvals };
}

function normalizeStoredRequiredApprovals(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 6
    ? value as number
    : 0;
}

function normalizeMergeQueueEnabled(value: unknown): { ok: true; value: boolean | null } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: null };
  if (typeof value !== 'boolean') return { ok: false, error: 'merge_queue_enabled must be a boolean' };
  return { ok: true, value };
}

function normalizeStoredMergeQueueEnabled(value: unknown): boolean {
  return value === true;
}

function normalizeStatusCheckName(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string') return { ok: false, error: 'status check name must be a string' };
  const name = value.trim();
  if (!name) return { ok: false, error: 'status check name is required' };
  if (name.length > 80) return { ok: false, error: 'status check name must be 80 characters or less' };
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) {
    return { ok: false, error: 'status check name may only include letters, numbers, dot, underscore, slash, or dash' };
  }
  return { ok: true, value: name };
}

function normalizeRequiredStatusChecks(value: unknown): { ok: true; value: string[] | null } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: null };
  if (!Array.isArray(value)) return { ok: false, error: 'required_status_checks must be an array' };
  if (value.length > 8) return { ok: false, error: 'required_status_checks may include at most 8 checks' };
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of value) {
    const normalized = normalizeStatusCheckName(item);
    if (!normalized.ok) return { ok: false, error: normalized.error };
    const key = normalized.value.toLowerCase();
    if (seen.has(key)) return { ok: false, error: 'required_status_checks must not contain duplicates' };
    seen.add(key);
    names.push(normalized.value);
  }
  return { ok: true, value: names };
}

function normalizeStoredRequiredStatusChecks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized = normalizeRequiredStatusChecks(value);
  return normalized.ok && normalized.value ? normalized.value : [];
}

function normalizeProtectedBranchPatterns(value: unknown): { ok: true; value: string[] | null } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: null };
  if (!Array.isArray(value)) return { ok: false, error: 'protected_branch_patterns must be an array' };
  if (value.length > 8) return { ok: false, error: 'protected_branch_patterns may include at most 8 patterns' };
  const seen = new Set<string>();
  const patterns: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') return { ok: false, error: 'protected_branch_patterns entries must be strings' };
    const pattern = raw.trim();
    if (!pattern) return { ok: false, error: 'protected_branch_patterns entries must be non-empty strings' };
    if (pattern.length > 96) return { ok: false, error: 'protected_branch_patterns entries must be 96 characters or less' };
    if (!/^[A-Za-z0-9/._*?-]+$/.test(pattern)) {
      return { ok: false, error: 'protected_branch_patterns may only include letters, numbers, slash, dot, underscore, dash, star, or question mark' };
    }
    if (!/[?*]/.test(pattern)) {
      return { ok: false, error: 'protected_branch_patterns entries must include * or ? wildcard' };
    }
    if (seen.has(pattern)) return { ok: false, error: 'protected_branch_patterns must not contain duplicates' };
    seen.add(pattern);
    patterns.push(pattern);
  }
  return { ok: true, value: patterns };
}

function normalizeStoredProtectedBranchPatterns(value: unknown): string[] {
  const normalized = normalizeProtectedBranchPatterns(value);
  return normalized.ok && normalized.value ? normalized.value : [];
}

function branchMatchesProtectedBranchPattern(branchName: string, patterns: string[]): boolean {
  return patterns.some((pattern) => protectedBranchPatternToRegExp(pattern).test(branchName));
}

function protectedBranchPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function changesetApprovalCount(changeset: ProjectChangeset): number {
  const reviews = normalizeChangesetReviews(changeset.reviews);
  const approvers = new Set<string>();
  for (const review of reviews) {
    if (review.decision === 'approved') approvers.add(`${review.reviewer_type}:${review.reviewer_id}`);
  }
  if (approvers.size > 0) return approvers.size;
  return (changeset.reviewedByUserId || changeset.reviewedByAgentId || changeset.reviewedAt) ? 1 : 0;
}

function normalizeChangesetStatusChecks(value: unknown): ProjectChangesetStatusCheckRecord[] {
  if (!Array.isArray(value)) return [];
  const byName = new Map<string, ProjectChangesetStatusCheckRecord>();
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const name = normalizeStatusCheckName(item.name);
    const status = ['passed', 'failed', 'pending'].includes(String(item.status))
      ? item.status as ProjectChangesetStatusCheckRecord['status']
      : null;
    const actorType = item.actor_type === 'user' || item.actor_type === 'agent' ? item.actor_type : null;
    const actorId = typeof item.actor_id === 'string' && item.actor_id ? item.actor_id : null;
    const checkedAt = typeof item.checked_at === 'string' && item.checked_at ? item.checked_at : null;
    if (!name.ok || !status || !actorType || !actorId || !checkedAt) continue;
    byName.set(name.value.toLowerCase(), {
      name: name.value,
      status,
      summary: typeof item.summary === 'string' ? item.summary : null,
      actor_type: actorType,
      actor_id: actorId,
      checked_at: checkedAt,
    });
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeRequestedReviewerIds(value: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: 'requested_reviewers must be an array' };
  if (value.length > 12) return { ok: false, error: 'requested_reviewers may include at most 12 users' };
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    const raw = typeof item === 'string'
      ? item
      : isPlainObject(item) && typeof item.reviewer_id === 'string'
        ? item.reviewer_id
        : isPlainObject(item) && typeof item.user_id === 'string'
          ? item.user_id
          : null;
    const id = raw?.trim();
    if (!id) return { ok: false, error: 'requested reviewer id must be a string' };
    const key = id.toLowerCase();
    if (seen.has(key)) return { ok: false, error: 'requested_reviewers must not contain duplicates' };
    seen.add(key);
    ids.push(id);
  }
  return { ok: true, value: ids };
}

function buildRequestedReviewers(
  reviewerIds: string[],
  actor: Actor,
  requestedAt: Date,
): ProjectChangesetRequestedReviewerRecord[] {
  return reviewerIds.map((reviewerId) => ({
    reviewer_type: 'user',
    reviewer_id: reviewerId,
    requested_by_user_id: actor.userId,
    requested_by_agent_id: actor.agentId,
    requested_at: requestedAt.toISOString(),
  }));
}

function normalizeRequestedReviewers(value: unknown): ProjectChangesetRequestedReviewerRecord[] {
  if (!Array.isArray(value)) return [];
  const byReviewer = new Map<string, ProjectChangesetRequestedReviewerRecord>();
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const reviewerId = typeof item.reviewer_id === 'string' && item.reviewer_id ? item.reviewer_id : null;
    const requestedAt = typeof item.requested_at === 'string' && item.requested_at ? item.requested_at : null;
    if (!reviewerId || !requestedAt) continue;
    byReviewer.set(reviewerId.toLowerCase(), {
      reviewer_type: 'user',
      reviewer_id: reviewerId,
      requested_by_user_id: typeof item.requested_by_user_id === 'string' ? item.requested_by_user_id : null,
      requested_by_agent_id: typeof item.requested_by_agent_id === 'string' ? item.requested_by_agent_id : null,
      requested_at: requestedAt,
    });
  }
  return Array.from(byReviewer.values()).sort((a, b) => a.requested_at.localeCompare(b.requested_at));
}

function serializeRequestedReviewerSummary(changeset: ProjectChangeset) {
  const reviewers = normalizeRequestedReviewers(changeset.requestedReviewers);
  return {
    requested_count: reviewers.length,
    reviewer_ids: reviewers.map((reviewer) => reviewer.reviewer_id),
  };
}

function upsertChangesetStatusCheck(
  checks: unknown,
  actor: Actor,
  name: string,
  status: string,
  summary: string | null,
  checkedAt: Date,
): ProjectChangesetStatusCheckRecord[] {
  const actorType = actor.userId ? 'user' : 'agent';
  const actorId = actor.userId ?? actor.agentId;
  const next = normalizeChangesetStatusChecks(checks);
  if (!actorId) return next;
  const existing = next.find((check) => check.name.toLowerCase() === name.toLowerCase());
  const record: ProjectChangesetStatusCheckRecord = {
    name,
    status: status as ProjectChangesetStatusCheckRecord['status'],
    summary,
    actor_type: actorType,
    actor_id: actorId,
    checked_at: checkedAt.toISOString(),
  };
  if (existing) Object.assign(existing, record);
  else next.push(record);
  return next.sort((a, b) => a.name.localeCompare(b.name));
}

function serializeChangesetStatusCheckSummary(changeset: ProjectChangeset) {
  const checks = normalizeChangesetStatusChecks(changeset.statusChecks);
  return {
    total: checks.length,
    passed: checks.filter((check) => check.status === 'passed').length,
    failed: checks.filter((check) => check.status === 'failed').length,
    pending: checks.filter((check) => check.status === 'pending').length,
    checks,
  };
}

function buildRequiredStatusChecksBlock(required: string[], changeset: ProjectChangeset) {
  if (!required.length) return null;
  const checks = normalizeChangesetStatusChecks(changeset.statusChecks);
  const byName = new Map(checks.map((check) => [check.name.toLowerCase(), check]));
  const passed: string[] = [];
  const failed: string[] = [];
  const pending: string[] = [];
  const missing: string[] = [];
  for (const name of required) {
    const check = byName.get(name.toLowerCase());
    if (!check) missing.push(name);
    else if (check.status === 'passed') passed.push(name);
    else if (check.status === 'failed') failed.push(name);
    else pending.push(name);
  }
  if (!missing.length && !failed.length && !pending.length) return null;
  return {
    required_status_checks: required,
    passed_status_checks: passed,
    missing_status_checks: missing,
    failed_status_checks: failed,
    pending_status_checks: pending,
  };
}

async function buildMergeQueueBlock(projectId: string, branchId: string, changeset: ProjectChangeset) {
  if (changeset.mergeQueuePosition == null) {
    return {
      queued: false,
      queue_position: null,
      queue_head_changeset_id: null,
    };
  }
  const head = await AppDataSource.getRepository(ProjectChangeset)
    .createQueryBuilder('queued')
    .where('queued.projectId = :projectId', { projectId })
    .andWhere('queued.branchId = :branchId', { branchId })
    .andWhere('queued.status = :status', { status: ProjectChangesetStatus.MERGE_READY })
    .andWhere('queued.mergeQueuePosition IS NOT NULL')
    .orderBy('queued.mergeQueuePosition', 'ASC')
    .addOrderBy('queued.queuedAt', 'ASC')
    .getOne();
  if (!head || head.id === changeset.id) return null;
  return {
    queued: true,
    queue_position: changeset.mergeQueuePosition,
    queue_head_changeset_id: head.id,
    queue_head_position: head.mergeQueuePosition ?? null,
  };
}

async function compactMergeQueueAfterRemoval(
  manager: EntityManager,
  projectId: string,
  branchId: string,
  removedPosition: number,
): Promise<void> {
  const queued = await manager.getRepository(ProjectChangeset)
    .createQueryBuilder('queued')
    .where('queued.projectId = :projectId', { projectId })
    .andWhere('queued.branchId = :branchId', { branchId })
    .andWhere('queued.mergeQueuePosition IS NOT NULL')
    .andWhere('queued.mergeQueuePosition > :removedPosition', { removedPosition })
    .orderBy('queued.mergeQueuePosition', 'ASC')
    .addOrderBy('queued.queuedAt', 'ASC')
    .getMany();
  for (const item of queued) {
    if (item.mergeQueuePosition != null) {
      item.mergeQueuePosition -= 1;
      await manager.save(ProjectChangeset, item);
    }
  }
}

function serializeMergeQueueState(changeset: ProjectChangeset): ProjectChangesetMergeQueueState {
  const position = changeset.mergeQueuePosition ?? null;
  const queuedAt = changeset.queuedAt instanceof Date
    ? changeset.queuedAt.toISOString()
    : (typeof changeset.queuedAt === 'string' ? changeset.queuedAt : null);
  return {
    queued: position != null,
    position,
    queued_at: queuedAt,
    queued_by_user_id: changeset.queuedByUserId ?? null,
    queued_by_agent_id: changeset.queuedByAgentId ?? null,
  };
}

function upsertChangesetReview(
  reviews: unknown,
  actor: Actor,
  decision: string,
  notes: string | null,
  reviewedAt: Date,
): ProjectChangesetReviewRecord[] {
  const reviewerType = actor.userId ? 'user' : 'agent';
  const reviewerId = actor.userId ?? actor.agentId;
  if (!reviewerId) return normalizeChangesetReviews(reviews);
  const next = normalizeChangesetReviews(reviews);
  const existing = next.find((review) => review.reviewer_type === reviewerType && review.reviewer_id === reviewerId);
  const record: ProjectChangesetReviewRecord = {
    reviewer_type: reviewerType,
    reviewer_id: reviewerId,
    decision: decision as ProjectChangesetReviewRecord['decision'],
    notes,
    reviewed_at: reviewedAt.toISOString(),
  };
  if (existing) Object.assign(existing, record);
  else next.push(record);
  return next;
}

function normalizeChangesetReviews(value: unknown): ProjectChangesetReviewRecord[] {
  if (!Array.isArray(value)) return [];
  const byReviewer = new Map<string, ProjectChangesetReviewRecord>();
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const reviewerType = item.reviewer_type === 'user' || item.reviewer_type === 'agent' ? item.reviewer_type : null;
    const reviewerId = typeof item.reviewer_id === 'string' && item.reviewer_id ? item.reviewer_id : null;
    const decision = ['approved', 'changes_requested', 'rejected'].includes(String(item.decision))
      ? item.decision as ProjectChangesetReviewRecord['decision']
      : null;
    const reviewedAt = typeof item.reviewed_at === 'string' && item.reviewed_at ? item.reviewed_at : null;
    if (!reviewerType || !reviewerId || !decision || !reviewedAt) continue;
    byReviewer.set(`${reviewerType}:${reviewerId}`, {
      reviewer_type: reviewerType,
      reviewer_id: reviewerId,
      decision,
      notes: typeof item.notes === 'string' ? item.notes : null,
      reviewed_at: reviewedAt,
    });
  }
  return Array.from(byReviewer.values()).sort((a, b) => a.reviewed_at.localeCompare(b.reviewed_at));
}

function serializeChangesetReviewSummary(changeset: ProjectChangeset) {
  const reviews = normalizeChangesetReviews(changeset.reviews);
  const approvals = reviews.filter((review) => review.decision === 'approved');
  return {
    current_approvals: changesetApprovalCount(changeset),
    approvals_count: approvals.length,
    reviews_count: reviews.length,
    reviews,
  };
}

function sortDirectWriteBypassRoles(roles: ProjectRole[]): ProjectRole[] {
  const order: ProjectRole[] = [ProjectRole.OWNER, ProjectRole.ADMIN, ProjectRole.MEMBER];
  return order.filter((role) => roles.includes(role));
}

function directWriteBypassRolesEqual(a: ProjectRole[], b: ProjectRole[]): boolean {
  return a.length === b.length && a.every((role, index) => role === b[index]);
}

function stringArraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function serializeCommitSummary(commit: ProjectCommit) {
  const verificationStatus = commit.verificationStatus || ProjectCommitVerificationStatus.UNAVAILABLE;
  return {
    id: commit.id,
    project_id: commit.projectId,
    branch_id: commit.branchId,
    parent_commit_id: commit.parentCommitId ?? null,
    message: commit.message,
    changed_files: commit.changedFiles,
    changeset_id: commit.changesetId ?? null,
    verification: {
      status: verificationStatus,
      verified: verificationStatus === ProjectCommitVerificationStatus.VERIFIED,
      local_only: true,
      cryptographic: false,
      source: commit.verificationSource || 'local_unavailable',
      reason: commit.verificationReason ?? null,
      actor_type: commit.verificationActorType ?? null,
      actor_id: commit.verificationActorId ?? null,
      verified_at: commit.verifiedAt ?? null,
      description: verificationStatus === ProjectCommitVerificationStatus.VERIFIED
        ? 'Project Space local provenance verified through the reviewed changeset workflow. This is not GPG/SSH cryptographic signature verification.'
        : 'No Project Space local reviewed-merge verification is available for this commit. This is not GPG/SSH cryptographic signature verification.',
    },
    created_by_user_id: commit.createdByUserId ?? null,
    created_by_agent_id: commit.createdByAgentId ?? null,
    git_sha: (commit as ProjectCommit).gitSha ?? null,
    created_at: commit.createdAt,
  };
}

function serializeCommit(commit: ProjectCommit) {
  return {
    ...serializeCommitSummary(commit),
    snapshot: commit.snapshot,
    orchestration_id: commit.orchestrationId ?? null,
    task_id: commit.taskId ?? null,
  };
}

function serializeChangeset(changeset: ProjectChangeset) {
  return {
    id: changeset.id,
    project_id: changeset.projectId,
    branch_id: changeset.branchId,
    base_commit_id: changeset.baseCommitId ?? null,
    title: changeset.title,
    description: changeset.description ?? null,
    status: changeset.status,
    merge_status: changeset.mergeStatus ?? null,
    file_ops: changeset.fileOps,
    conflicts: changeset.conflicts ?? null,
    result_path: changeset.resultPath ?? null,
    evidence_path: changeset.evidencePath ?? null,
    created_by_user_id: changeset.createdByUserId ?? null,
    created_by_agent_id: changeset.createdByAgentId ?? null,
    reviewed_by_user_id: changeset.reviewedByUserId ?? null,
    reviewed_by_agent_id: changeset.reviewedByAgentId ?? null,
    review_notes: changeset.reviewNotes ?? null,
    review_summary: serializeChangesetReviewSummary(changeset),
    reviews: normalizeChangesetReviews(changeset.reviews),
    requested_reviewer_summary: serializeRequestedReviewerSummary(changeset),
    requested_reviewers: normalizeRequestedReviewers(changeset.requestedReviewers),
    status_check_summary: serializeChangesetStatusCheckSummary(changeset),
    status_checks: normalizeChangesetStatusChecks(changeset.statusChecks),
    merge_queue: serializeMergeQueueState(changeset),
    merged_commit_id: changeset.mergedCommitId ?? null,
    orchestration_id: changeset.orchestrationId ?? null,
    task_id: changeset.taskId ?? null,
    reviewed_at: changeset.reviewedAt ?? null,
    merged_at: changeset.mergedAt ?? null,
    created_at: changeset.createdAt,
    updated_at: changeset.updatedAt,
  };
}

function serializeChangesetComment(comment: ProjectChangesetComment) {
  return {
    id: comment.id,
    project_id: comment.projectId,
    changeset_id: comment.changesetId,
    parent_comment_id: comment.parentCommentId ?? null,
    author_type: comment.authorType,
    author_id: comment.authorId,
    content: comment.content,
    file_path: comment.filePath ?? null,
    side: comment.side ?? null,
    line: comment.line ?? null,
    base_revision_id: comment.baseRevisionId ?? null,
    head_revision_id: comment.headRevisionId ?? null,
    status: comment.status,
    resolved_by: comment.resolvedBy ?? null,
    resolved_at: comment.resolvedAt ?? null,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

function isCommentAuthor(comment: ProjectChangesetComment, actor: Actor): boolean {
  const actorType = actor.userId ? ProjectChangesetCommentAuthorType.USER : ProjectChangesetCommentAuthorType.AGENT;
  const actorId = actor.userId ?? actor.agentId;
  return comment.authorType === actorType && comment.authorId === actorId;
}

type CommentAnchorResult =
  | { ok: true; filePath: string | null; side: ProjectChangesetCommentSide | null; line: number | null; baseRevisionId: string | null; headRevisionId: string | null }
  | { ok: false; error: string };

function validateCommentAnchor(body: Record<string, unknown>): CommentAnchorResult {
  const hasFilePath = body.file_path !== undefined && body.file_path !== null;
  const hasLine = body.line !== undefined && body.line !== null;
  const hasSide = body.side !== undefined && body.side !== null;
  // JSON `null` is treated as present-but-invalid; only a missing key is absent.
  const hasBaseRevisionId = body.base_revision_id !== undefined;
  const hasHeadRevisionId = body.head_revision_id !== undefined;

  if ((hasLine || hasSide || hasBaseRevisionId || hasHeadRevisionId) && !hasFilePath) {
    return {
      ok: false,
      error: 'file_path is required when line, side, base_revision_id, or head_revision_id is provided',
    };
  }

  let filePath: string | null = null;
  if (hasFilePath) {
    if (typeof body.file_path !== 'string') {
      return { ok: false, error: 'file_path must be a string' };
    }
    const validated = validateProjectPath(body.file_path);
    if (!validated.ok) {
      return { ok: false, error: `file_path: ${validated.error}` };
    }
    filePath = validated.value;
  }

  let side: ProjectChangesetCommentSide | null = null;
  if (hasSide) {
    if (body.side !== ProjectChangesetCommentSide.BASE && body.side !== ProjectChangesetCommentSide.HEAD) {
      return { ok: false, error: 'side must be base or head' };
    }
    side = body.side;
  }

  let line: number | null = null;
  if (hasLine) {
    if (typeof body.line === 'number') {
      if (!Number.isInteger(body.line) || body.line < 1) {
        return { ok: false, error: 'line must be a positive integer' };
      }
      line = body.line;
    } else if (typeof body.line === 'string') {
      if (!/^\d+$/.test(body.line)) {
        return { ok: false, error: 'line must be a positive integer' };
      }
      const n = parseInt(body.line, 10);
      if (n < 1) {
        return { ok: false, error: 'line must be a positive integer' };
      }
      line = n;
    } else {
      return { ok: false, error: 'line must be a positive integer' };
    }
  }

  let baseRevisionId: string | null = null;
  if (body.base_revision_id !== undefined) {
    const value = body.base_revision_id;
    if (value === null || typeof value !== 'string' || value.trim() === '') {
      return { ok: false, error: 'base_revision_id must be a non-empty string UUID' };
    }
    if (!isUuid(value)) {
      return { ok: false, error: 'base_revision_id must be a valid UUID' };
    }
    baseRevisionId = value;
  }

  let headRevisionId: string | null = null;
  if (body.head_revision_id !== undefined) {
    const value = body.head_revision_id;
    if (value === null || typeof value !== 'string' || value.trim() === '') {
      return { ok: false, error: 'head_revision_id must be a non-empty string UUID' };
    }
    if (!isUuid(value)) {
      return { ok: false, error: 'head_revision_id must be a valid UUID' };
    }
    headRevisionId = value;
  }

  return { ok: true, filePath, side, line, baseRevisionId, headRevisionId };
}

async function verifyCommentRevisions(
  projectId: string,
  filePath: string,
  baseRevisionId: string | null,
  headRevisionId: string | null,
): Promise<{ ok: true } | { ok: false; status: 404 | 422; error: string }> {
  const revisionIds = [baseRevisionId, headRevisionId].filter((id): id is string => Boolean(id));
  if (!revisionIds.length) return { ok: true };

  const revisions = await AppDataSource.getRepository(ProjectFileRevision).findBy({
    id: In(revisionIds),
    projectId,
    path: filePath,
  });

  const foundIds = new Set(revisions.map((revision) => revision.id));
  for (const id of revisionIds) {
    if (!foundIds.has(id)) {
      return { ok: false, status: 404, error: `Revision ${id} not found for file_path in this project` };
    }
  }
  return { ok: true };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export default router;
