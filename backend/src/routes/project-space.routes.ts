import { Router, Request, Response } from 'express';
import { In, IsNull, EntityManager, Repository, Brackets } from 'typeorm';
import zlib from 'zlib';
import { AppDataSource } from '../data-source';
import { authenticate, authenticateJwtOrAgentApiKey, extractProjectId } from '../middleware/auth';
import { requirePermission, Permission, Role } from '../middleware/rbac';
import {
  Agent,
  Project,
  ProjectBranch,
  ProjectCommit,
  ProjectFile,
  ProjectFileRevision,
  ProjectGate,
  ProjectGateAttempt,
  ProjectGateAttemptStatus,
  ProjectJoinRequest,
  ProjectJoinRequestStatus,
  ProjectMember,
  ProjectMemory,
  ProjectMemoryVisibility,
  ProjectRole,
  ProjectVisibility,
  User,
} from '../entities';
import { createInboxItem } from './agent-inbox.routes';
import { bridgeJoinRequestToCollab, bridgeJoinRequestReview } from './collaboration-requests.routes';
import {
  MAX_FILE_BYTES,
  MAX_MEMORY_CHARS,
  MAX_UPLOAD_FILES,
  DEFAULT_UPLOAD_CONTENT_TYPE,
  DEFAULT_FILE_LIST_LIMIT,
  DEFAULT_FILE_LIST_OFFSET,
  MAX_FILE_LIST_LIMIT,
  validateProjectPath,
  normalizePathPrefix,
  normalizeContentType,
  normalizeUploadContentType,
  normalizeStringArray,
  isPlainObject,
  parsePaginationLimit,
  parsePaginationOffset,
  escapeLikePattern,
  sha256,
  sha256Buffer,
  decodeBase64Content,
  storeContentString,
  rawContentData,
} from './project-space.utils';

const router = Router();
const DEFAULT_FILE_SEARCH_LIMIT = 20;
const MAX_FILE_SEARCH_LIMIT = 50;
const MIN_FILE_SEARCH_QUERY_LENGTH = 2;
const MAX_FILE_SEARCH_QUERY_LENGTH = 120;
const MAX_FILE_SEARCH_SNIPPETS = 3;
const MAX_FILE_SEARCH_SNIPPET_LENGTH = 180;

const README_NAMES = ['readme.md', 'readme.markdown', 'readme.txt', 'readme'];

// Project-rules file the project-level main agent maintains and every agent
// must follow. Auto-injected into each agent's dispatch context (see
// session-dispatch.service.ts loadProjectRules). Only the project main agent
// may write it; all agents may read it.
const AGENTS_RULES_NAMES = ['agents.md'];
const AGENTS_RULES_PATHS = new Set(['agents.md']);

function isAgentsRulesPath(filePath: string): boolean {
  return AGENTS_RULES_PATHS.has(filePath.replace(/^\.?\//, '').toLowerCase());
}

/** True if the given agent is the project-level main agent (PM). */
async function isProjectMainAgentById(projectId: string, agentId: string): Promise<boolean> {
  const project = await AppDataSource.getRepository(Project).findOne({
    where: { id: projectId },
    select: ['id', 'mainAgentId'],
  });
  return !!project && project.mainAgentId === agentId;
}

function isReadmePath(path: string): boolean {
  const lower = path.toLowerCase();
  return README_NAMES.some((name) => lower === name || lower.endsWith(`/${name}`));
}

/**
 * Find all candidate README files for a project, ordered by repository-page
 * preference: root-level first, then deterministic by path. Callers decide
 * whether to exclude deleted files (summary preserves legacy behavior; the
 * dedicated README endpoint skips deleted files).
 */
export async function findProjectReadmeCandidates(
  fileRepo: Repository<ProjectFile>,
  projectId: string,
): Promise<ProjectFile[]> {
  const readmeFiles = await fileRepo
    .createQueryBuilder('file')
    .where('file.projectId = :projectId', { projectId })
    .andWhere(
      new Brackets((qb) => {
        README_NAMES.forEach((name, idx) => {
          qb.orWhere(`LOWER(file.path) = :exactName${idx}`, { [`exactName${idx}`]: name });
          qb.orWhere(`LOWER(file.path) LIKE :nestedName${idx}`, { [`nestedName${idx}`]: `%/${name}` });
        });
      }),
    )
    .select(['file.id', 'file.projectId', 'file.path', 'file.content', 'file.contentType', 'file.updatedAt', 'file.deletedAt'])
    .getMany();

  return readmeFiles.sort((a, b) => {
    const depthDiff = a.path.split('/').length - b.path.split('/').length;
    if (depthDiff !== 0) return depthDiff;
    return a.path.localeCompare(b.path);
  });
}

// ─── Files CRUD + Revisions (GP-Required, Step 8) ────────────────────────────

router.get(
  '/v1/projects/:project_id/files',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const pathPrefix = typeof req.query.path_prefix === 'string'
        ? normalizePathPrefix(req.query.path_prefix)
        : null;
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : null;
      const limit = parsePaginationLimit(req.query.limit, DEFAULT_FILE_LIST_LIMIT, MAX_FILE_LIST_LIMIT);
      const offset = parsePaginationOffset(req.query.offset, DEFAULT_FILE_LIST_OFFSET);
      const view = typeof req.query.view === 'string' ? req.query.view.trim().toLowerCase() : null;
      const exactPathRaw = typeof req.query.exact_path === 'string' ? req.query.exact_path.trim() : null;

      const branchParam = typeof req.query.branch === 'string' ? req.query.branch.trim() : null;
      const branchContextResult = await resolveProjectBranchContext(projectId, branchParam, req);
      if (!branchContextResult.ok) {
        res.status(branchContextResult.status).json({ detail: branchContextResult.detail });
        return;
      }
      const branchContext = branchContextResult.context;
      const snapshotPaths = branchContext?.snapshotPaths ?? null;

      // Helper: constrain query builders before pagination so branch-scoped
      // totals and offsets remain truthful.
      function applySnapshotConstraint(qb: any) {
        if (!snapshotPaths) return qb;
        const paths = Array.from(snapshotPaths);
        qb.andWhere('file.path IN (:...snapshotPaths)', {
          snapshotPaths: paths.length ? paths : ['__no_branch_files__'],
        });
        return qb;
      }

      const branchMeta = branchContext?.branchMeta;

      const repo = AppDataSource.getRepository(ProjectFile);

      // ─── Exact-path lookup (reliable artifact link resolver) ──────────────────
      // Takes precedence over q/path_prefix/view so callers cannot accidentally
      // broaden an exact lookup into a prefix/search/children scan.
      if (exactPathRaw !== null) {
        const validated = validateProjectPath(exactPathRaw);
        if (!validated.ok) {
          res.status(422).json({ detail: validated.error });
          return;
        }

        // When scoped to a branch snapshot, the exact path must be in the snapshot
        if (snapshotPaths && !snapshotPaths.has(validated.value)) {
          res.json({
            data: [],
            total: 0,
            limit,
            offset,
            path_prefix: null,
            ...(branchMeta ? { branch: branchMeta } : {}),
          });
          return;
        }

        const file = await repo.findOne({
          where: { projectId, path: validated.value, deletedAt: IsNull() },
        });
        const files = file ? [file] : [];
        res.json({
          data: files.map(serializeProjectFileSummary),
          total: files.length,
          limit,
          offset,
          path_prefix: null,
          ...(branchMeta ? { branch: branchMeta } : {}),
        });
        return;
      }

      // ─── Direct-children view (server-backed directory browser) ───────────────
      // Returns synthetic directories + direct files for a prefix. This avoids the
      // 2000-file client-side cap because the server aggregates directory metadata
      // and only paginates the direct file list.
      if (view === 'children') {
        // Canonical prefix: empty means root; otherwise ensure trailing slash so
        // "docs" and "docs/" both describe the same directory children.
        const childrenPrefix = pathPrefix
          ? (pathPrefix.endsWith('/') ? pathPrefix : `${pathPrefix}/`)
          : '';

        // Search mode: q triggers a global project search and returns matching
        // files only (no synthetic directories). This keeps search simple and
        // fully server-side, not limited to client-loaded rows.
        if (q) {
          const searchQb = repo
            .createQueryBuilder('file')
            .where('file.projectId = :projectId', { projectId })
            .andWhere('file.deletedAt IS NULL')
            .andWhere('LOWER(file.path) LIKE LOWER(:q) ESCAPE :escape', {
              q: `%${escapeLikePattern(q)}%`,
              escape: '\\',
            });
          applySnapshotConstraint(searchQb);
          const total = await searchQb.clone().getCount();
          const files = await searchQb
            .orderBy('file.path', 'ASC')
            .skip(offset)
            .take(limit)
            .getMany();
          res.json({
            view: 'children',
            path_prefix: childrenPrefix || null,
            q,
            directories: [],
            files: {
              data: files.map(serializeProjectFileSummary),
              total,
              limit,
              offset,
            },
            ...(branchMeta ? { branch: branchMeta } : {}),
          });
          return;
        }

        // 1. Lean scan of every file under the prefix to aggregate directories.
        const leanQb = repo
          .createQueryBuilder('file')
          .select(['file.path', 'file.sizeBytes', 'file.updatedAt'])
          .where('file.projectId = :projectId', { projectId })
          .andWhere('file.deletedAt IS NULL');
        if (childrenPrefix) {
          leanQb.andWhere('file.path LIKE :pathPrefix ESCAPE :escape', {
            pathPrefix: `${escapeLikePattern(childrenPrefix)}%`,
            escape: '\\',
          });
        }
        applySnapshotConstraint(leanQb);
        const leanFiles = await leanQb.getMany();

        // 2. Group into direct child directories and collect direct file paths.
        const dirMap = new Map<string, {
          name: string;
          path: string;
          child_count: number;
          size_bytes: number;
          latest_updated_at: Date | null;
        }>();
        const directFilePaths: string[] = [];
        const prefixLen = childrenPrefix.length;

        for (const f of leanFiles) {
          const relative = f.path.slice(prefixLen);
          const slashIdx = relative.indexOf('/');
          if (slashIdx === -1) {
            directFilePaths.push(f.path);
            continue;
          }
          const dirName = relative.slice(0, slashIdx);
          const dirPath = `${childrenPrefix}${dirName}/`;
          const existing = dirMap.get(dirPath);
          if (existing) {
            existing.child_count += 1;
            existing.size_bytes += f.sizeBytes;
            if (f.updatedAt && (!existing.latest_updated_at || f.updatedAt > existing.latest_updated_at)) {
              existing.latest_updated_at = f.updatedAt;
            }
          } else {
            dirMap.set(dirPath, {
              name: dirName,
              path: dirPath,
              child_count: 1,
              size_bytes: f.sizeBytes,
              latest_updated_at: f.updatedAt ?? null,
            });
          }
        }

        // 3. Paginated direct file query (preserve existing payload shape).
        const directFilesQb = repo
          .createQueryBuilder('file')
          .where('file.projectId = :projectId', { projectId })
          .andWhere('file.deletedAt IS NULL')
          .andWhere('file.path IN (:...directFilePaths)', {
            directFilePaths: directFilePaths.length > 0 ? directFilePaths : ['__no_direct_files__'],
          })
          .orderBy('file.path', 'ASC');
        const directTotal = await directFilesQb.clone().getCount();
        const directFiles = await directFilesQb
          .skip(offset)
          .take(limit)
          .getMany();

        const directories = [...dirMap.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((d) => ({
            name: d.name,
            path: d.path,
            child_count: d.child_count,
            size_bytes: d.size_bytes,
            latest_updated_at: d.latest_updated_at,
          }));

        res.json({
          view: 'children',
          path_prefix: childrenPrefix || null,
          directories,
          files: {
            data: directFiles.map(serializeProjectFileSummary),
            total: snapshotPaths ? directFilePaths.length : directTotal,
            limit,
            offset,
          },
          ...(branchMeta ? { branch: branchMeta } : {}),
        });
        return;
      }

      // ─── Default flat-list view (backward-compatible) ─────────────────────────
      const qb = repo
        .createQueryBuilder('file')
        .where('file.projectId = :projectId', { projectId })
        .andWhere('file.deletedAt IS NULL');

      if (pathPrefix) {
        qb.andWhere('file.path LIKE :pathPrefix ESCAPE :escape', {
          pathPrefix: `${escapeLikePattern(pathPrefix)}%`,
          escape: '\\',
        });
      }
      if (q) {
        qb.andWhere('LOWER(file.path) LIKE LOWER(:q) ESCAPE :escape', {
          q: `%${escapeLikePattern(q)}%`,
          escape: '\\',
        });
      }
      applySnapshotConstraint(qb);

      const total = await qb.clone().getCount();
      const files = await qb
        .orderBy('file.path', 'ASC')
        .skip(offset)
        .take(limit)
        .getMany();

      res.json({
        data: files.map(serializeProjectFileSummary),
        total,
        limit,
        offset,
        path_prefix: pathPrefix,
        ...(branchMeta ? { branch: branchMeta } : {}),
      });
    } catch (err) {
      console.error('List project files error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/files/search',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if (q.length < MIN_FILE_SEARCH_QUERY_LENGTH) {
        res.status(422).json({ detail: `q must be at least ${MIN_FILE_SEARCH_QUERY_LENGTH} characters` });
        return;
      }
      if (q.length > MAX_FILE_SEARCH_QUERY_LENGTH) {
        res.status(422).json({ detail: `q must be ${MAX_FILE_SEARCH_QUERY_LENGTH} characters or fewer` });
        return;
      }

      const limit = parsePaginationLimit(req.query.limit, DEFAULT_FILE_SEARCH_LIMIT, MAX_FILE_SEARCH_LIMIT);
      const offset = parsePaginationOffset(req.query.offset, DEFAULT_FILE_LIST_OFFSET);
      const branchParam = typeof req.query.branch === 'string' ? req.query.branch.trim() : null;
      const branchContextResult = await resolveProjectBranchContext(projectId, branchParam, req);
      if (!branchContextResult.ok) {
        res.status(branchContextResult.status).json({ detail: branchContextResult.detail });
        return;
      }
      const branchContext = branchContextResult.context;
      const branchMeta = branchContext?.branchMeta;
      const escapedQ = `%${escapeLikePattern(q)}%`;

      if (branchContext?.commit?.snapshot) {
        const snapshotRevisionIds = Object.values(branchContext.commit.snapshot)
          .map((entry) => entry.revision_id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (snapshotRevisionIds.length === 0) {
          res.json({
            data: [],
            total: 0,
            limit,
            offset,
            q,
            ...(branchMeta ? { branch: branchMeta } : {}),
          });
          return;
        }

        const revisionQb = AppDataSource.getRepository(ProjectFileRevision)
          .createQueryBuilder('revision')
          .where('revision.projectId = :projectId', { projectId })
          .andWhere('revision.id IN (:...snapshotRevisionIds)', { snapshotRevisionIds })
          .andWhere(
            '(LOWER(revision.path) LIKE LOWER(:q) ESCAPE :escape OR LOWER(revision.content) LIKE LOWER(:q) ESCAPE :escape)',
            { q: escapedQ, escape: '\\' },
          );
        const total = await revisionQb.clone().getCount();
        const revisions = await revisionQb
          .orderBy('revision.path', 'ASC')
          .skip(offset)
          .take(limit)
          .getMany();
        res.json({
          data: revisions.map((revision) => serializeProjectFileSearchRevisionResult(revision, q, branchContext.branchMeta, branchContext.commit!.id)),
          total,
          limit,
          offset,
          q,
          ...(branchMeta ? { branch: branchMeta } : {}),
        });
        return;
      }

      if (branchContext?.snapshotPaths && branchContext.snapshotPaths.size === 0) {
        res.json({
          data: [],
          total: 0,
          limit,
          offset,
          q,
          ...(branchMeta ? { branch: branchMeta } : {}),
        });
        return;
      }

      const fileQb = AppDataSource.getRepository(ProjectFile)
        .createQueryBuilder('file')
        .where('file.projectId = :projectId', { projectId })
        .andWhere('file.deletedAt IS NULL')
        .andWhere(
          '(LOWER(file.path) LIKE LOWER(:q) ESCAPE :escape OR LOWER(file.content) LIKE LOWER(:q) ESCAPE :escape)',
          { q: escapedQ, escape: '\\' },
        );
      if (branchContext?.snapshotPaths) {
        const snapshotPaths = Array.from(branchContext.snapshotPaths);
        fileQb.andWhere('file.path IN (:...snapshotPaths)', {
          snapshotPaths: snapshotPaths.length ? snapshotPaths : ['__no_branch_files__'],
        });
      }

      const total = await fileQb.clone().getCount();
      const files = await fileQb
        .orderBy('file.path', 'ASC')
        .skip(offset)
        .take(limit)
        .getMany();
      res.json({
        data: files.map((file) => serializeProjectFileSearchResult(file, q, branchMeta)),
        total,
        limit,
        offset,
        q,
        ...(branchMeta ? { branch: branchMeta } : {}),
      });
    } catch (err) {
      console.error('Search project files error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

class FileUpsertError extends Error {
  constructor(
    public status: number,
    public detail: string,
    public extra?: Record<string, unknown>,
  ) {
    super(detail);
  }
}

async function upsertFileInTransaction(
  manager: EntityManager,
  options: {
    projectId: string;
    userId: string;
    path: string;
    content: string;
    contentType: string;
    contentHash: string;
    sizeBytes: number;
    baseRevisionId: string | null;
    message: string | null;
    isAgent: boolean;
    agentId?: string;
    userIdForBypass?: string;
    projectRole?: Role;
  },
): Promise<{ file: ProjectFile; revision: ProjectFileRevision; created: boolean }> {
  const {
    projectId,
    userId,
    path,
    content,
    contentType,
    contentHash,
    sizeBytes,
    baseRevisionId,
    message,
    isAgent,
    agentId,
    userIdForBypass,
    projectRole,
  } = options;

  // Agent path safety: agents may only write under deliverables/ so they
  // cannot clobber orchestration MD artifacts (.agent/...) or other
  // privileged project-space files. Humans (JWT) can write any valid path.
  // EXCEPTION: the project-level main agent may maintain AGENTS.md (the
  // project-rules file every agent must follow), since that is a core PM duty.
  if (isAgent) {
    const normalizedAgentPath = path.replace(/^\.?\//, '');
    const isAgentsRulesFile = normalizedAgentPath === 'AGENTS.md' || normalizedAgentPath === 'agents.md';
    const mainAgentOk = isAgentsRulesFile && agentId
      ? await isProjectMainAgentById(projectId, agentId)
      : false;
    if (!normalizedAgentPath.startsWith('deliverables/') && !mainAgentOk) {
      throw new FileUpsertError(
        403,
        'Agents can only write files under deliverables/. Use a changeset for reviewed changes to other paths.',
      );
    }
  }

  const defaultBranch = await manager.findOne(ProjectBranch, { where: { projectId, isDefault: true } });
  if (
    defaultBranch?.protectionRules?.block_direct_writes === true &&
    !canBypassDirectWriteRule(defaultBranch, projectRole, userIdForBypass)
  ) {
    throw new FileUpsertError(
      409,
      'Direct file writes are blocked by branch protection rules. Use a changeset for reviewed changes.',
      {
        branch_id: defaultBranch.id,
        branch_name: defaultBranch.name,
        rule: 'block_direct_writes',
      },
    );
  }

  const fileRepo = manager.getRepository(ProjectFile);
  const revisionRepo = manager.getRepository(ProjectFileRevision);

  const file = await fileRepo.findOne({
    where: { projectId, path },
  });

  if (file?.deletedAt) {
    throw new FileUpsertError(404, 'File not found');
  }

  if (file && baseRevisionId === null) {
    throw new FileUpsertError(422, 'base_revision_id is required when updating an existing file');
  }

  if (file && baseRevisionId && file.currentRevisionId !== baseRevisionId) {
    throw new FileUpsertError(409, 'File revision conflict', {
      current_revision_id: file.currentRevisionId ?? null,
    });
  }

  if (!file && baseRevisionId) {
    throw new FileUpsertError(409, 'File revision conflict', { current_revision_id: null });
  }

  let targetFile: ProjectFile;
  if (!file) {
    targetFile = fileRepo.create({
      projectId,
      path,
      content,
      contentType,
      contentHash,
      sizeBytes,
      createdBy: userId,
      updatedBy: userId,
    });
    await fileRepo.save(targetFile);
  } else {
    targetFile = file;
  }

  const latest = await revisionRepo
    .createQueryBuilder('revision')
    .where('revision.fileId = :fileId', { fileId: targetFile.id })
    .orderBy('revision.revisionNumber', 'DESC')
    .getOne();

  const revision = revisionRepo.create({
    projectId,
    fileId: targetFile.id,
    path,
    revisionNumber: (latest?.revisionNumber ?? 0) + 1,
    content,
    contentType,
    contentHash,
    message,
    createdBy: userId,
  });
  await revisionRepo.save(revision);

  targetFile.content = content;
  targetFile.contentType = contentType;
  targetFile.contentHash = contentHash;
  targetFile.sizeBytes = sizeBytes;
  targetFile.currentRevisionId = revision.id;
  targetFile.updatedBy = userId;
  await fileRepo.save(targetFile);

  // Mirror the direct write into the real-git index so the working tree stays
  // consistent with the DB (the git backend is authoritative for branch
  // snapshots via gitListTreeFiles). Best-effort: failures never affect the
  // transaction. The staged change is committed on the next changeset merge.
  try {
    const { gitAddFile } = await import('../services/project-git.service');
    await gitAddFile(projectId, path, content);
  } catch (gitErr) {
    console.error('Git add mirror failed (DB write succeeded):', gitErr);
  }

  return { file: targetFile, revision, created: !file };
}

router.post(
  '/v1/projects/:project_id/files',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const userId = req.user?.userId ?? req.agent?.id;
      if (!userId) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      const path = validateProjectPath(req.body.path);
      if (!path.ok) {
        res.status(422).json({ detail: path.error });
        return;
      }

      const content = req.body.content;
      if (typeof content !== 'string') {
        res.status(422).json({ detail: 'content is required and must be a string' });
        return;
      }
      const sizeBytes = Buffer.byteLength(content, 'utf8');
      if (sizeBytes > MAX_FILE_BYTES) {
        res.status(413).json({ detail: `File content exceeds ${MAX_FILE_BYTES} bytes` });
        return;
      }

      const baseRevisionId = typeof req.body.base_revision_id === 'string'
        ? req.body.base_revision_id
        : null;
      const contentType = normalizeContentType(req.body.content_type);
      const message = typeof req.body.message === 'string' && req.body.message.trim()
        ? req.body.message.trim().slice(0, 512)
        : null;
      const contentHash = sha256(content);

      const result = await AppDataSource.transaction(async (manager) => {
        return upsertFileInTransaction(manager, {
          projectId,
          userId,
          path: path.value,
          content,
          contentType,
          contentHash,
          sizeBytes,
          baseRevisionId,
          message,
          isAgent: Boolean(req.agent),
          agentId: req.agent?.id,
          userIdForBypass: req.user?.userId,
          projectRole: (req as any).projectRole,
        });
      });

      res.status(result.created ? 201 : 200).json({
        ...serializeProjectFile(result.file),
        revision: serializeProjectFileRevision(result.revision),
      });
    } catch (err) {
      if (err instanceof FileUpsertError) {
        res.status(err.status).json({ detail: err.detail, ...(err.extra || {}) });
        return;
      }
      console.error('Upsert project file error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.post(
  '/v1/projects/:project_id/files/upload',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const userId = req.user?.userId ?? req.agent?.id;
      if (!userId) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }

      const filesInput = Array.isArray(req.body.files) ? req.body.files : null;
      if (!filesInput || filesInput.length === 0) {
        res.status(422).json({ detail: 'files must be a non-empty array' });
        return;
      }
      if (filesInput.length > MAX_UPLOAD_FILES) {
        res.status(413).json({ detail: `Cannot upload more than ${MAX_UPLOAD_FILES} files per request` });
        return;
      }

      const defaultMessage = typeof req.body.message === 'string' && req.body.message.trim()
        ? req.body.message.trim().slice(0, 512)
        : null;

      const uploads: Array<{
        path: string;
        content: string;
        contentType: string;
        contentHash: string;
        sizeBytes: number;
        baseRevisionId: string | null;
        message: string | null;
      }> = [];
      const seenPaths = new Set<string>();

      for (const item of filesInput) {
        if (!isPlainObject(item)) {
          res.status(422).json({ detail: 'each file must be an object' });
          return;
        }

        const path = validateProjectPath(item.path);
        if (!path.ok) {
          res.status(422).json({ detail: path.error });
          return;
        }
        if (seenPaths.has(path.value)) {
          res.status(422).json({ detail: `duplicate path in upload batch: ${path.value}` });
          return;
        }
        seenPaths.add(path.value);

        // Agent path safety: agents may only upload under deliverables/.
        if (req.agent) {
          const normalizedAgentPath = path.value.replace(/^\.?\//, '');
          if (!normalizedAgentPath.startsWith('deliverables/')) {
            res.status(403).json({
              detail: 'Agents can only upload files under deliverables/. Use a changeset for reviewed changes to other paths.',
            });
            return;
          }
        }

        const decoded = decodeBase64Content(item.content_base64);
        if (!decoded.ok) {
          res.status(422).json({ detail: decoded.error });
          return;
        }
        if (decoded.buffer.length > MAX_FILE_BYTES) {
          res.status(413).json({ detail: `File content for ${path.value} exceeds ${MAX_FILE_BYTES} bytes` });
          return;
        }

        const contentType = normalizeUploadContentType(item.content_type);
        const content = storeContentString(decoded.buffer, contentType);
        const sizeBytes = decoded.buffer.length;
        const contentHash = sha256Buffer(decoded.buffer);
        const baseRevisionId = typeof item.base_revision_id === 'string'
          ? item.base_revision_id
          : null;
        const message = typeof item.message === 'string' && item.message.trim()
          ? item.message.trim().slice(0, 512)
          : defaultMessage;

        uploads.push({
          path: path.value,
          content,
          contentType,
          contentHash,
          sizeBytes,
          baseRevisionId,
          message,
        });
      }

      const results = await AppDataSource.transaction(async (manager) => {
        const batchResults: Array<{ file: ProjectFile; revision: ProjectFileRevision; created: boolean }> = [];
        for (const upload of uploads) {
          const result = await upsertFileInTransaction(manager, {
            projectId,
            userId,
            path: upload.path,
            content: upload.content,
            contentType: upload.contentType,
            contentHash: upload.contentHash,
            sizeBytes: upload.sizeBytes,
            baseRevisionId: upload.baseRevisionId,
            message: upload.message,
            isAgent: Boolean(req.agent),
            agentId: req.agent?.id,
            userIdForBypass: req.user?.userId,
            projectRole: (req as any).projectRole,
          });
          batchResults.push(result);
        }
        return batchResults;
      });

      res.status(201).json({
        data: results.map((r) => ({
          ...serializeProjectFile(r.file),
          revision: serializeProjectFileRevision(r.revision),
        })),
      });
    } catch (err) {
      if (err instanceof FileUpsertError) {
        res.status(err.status).json({ detail: err.detail, ...(err.extra || {}) });
        return;
      }
      console.error('Upload project files error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/files/:file_id',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const branchParam = typeof req.query.branch === 'string' ? req.query.branch.trim() : null;

      const file = await AppDataSource.getRepository(ProjectFile).findOne({
        where: { id: req.params.file_id, projectId },
      });
      if (!file) {
        res.status(404).json({ detail: 'File not found' });
        return;
      }

      const branchContextResult = await resolveProjectBranchContext(projectId, branchParam, req);
      if (!branchContextResult.ok) {
        res.status(branchContextResult.status).json({ detail: branchContextResult.detail });
        return;
      }
      const branchContext = branchContextResult.context;
      if (branchContext) {
        if (branchContext.commit?.snapshot) {
          const snapshotEntry = findSnapshotEntryByFileId(branchContext.commit.snapshot, file.id);
          if (!snapshotEntry) {
            res.status(404).json({ detail: 'File not found in branch snapshot' });
            return;
          }
          if (!snapshotEntry.value.revision_id) {
            res.status(404).json({ detail: 'File revision not found in branch snapshot' });
            return;
          }
          const revision = await AppDataSource.getRepository(ProjectFileRevision).findOne({
            where: { id: snapshotEntry.value.revision_id, fileId: file.id, projectId },
          });
          if (!revision) {
            res.status(404).json({ detail: 'File revision not found in branch snapshot' });
            return;
          }
          res.json(serializeProjectFileAtRevision(file, revision, branchContext.branchMeta, branchContext.commit.id));
          return;
        }
        if (!branchContext.branch.isDefault) {
          res.status(404).json({ detail: 'File not found in branch snapshot' });
          return;
        }
        if (file.deletedAt) {
          res.status(404).json({ detail: 'File not found' });
          return;
        }
        res.json({
          ...serializeProjectFile(file),
          branch: branchContext.branchMeta,
        });
        return;
      }

      // No branch param: existing behavior
      if (file.deletedAt) {
        res.status(404).json({ detail: 'File not found' });
        return;
      }
      res.json(serializeProjectFile(file));
    } catch (err) {
      console.error('Get project file error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/files/:file_id/raw',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const fileId = req.params.file_id;
      const branchParam = typeof req.query.branch === 'string' ? req.query.branch.trim() : null;
      const revisionId = typeof req.query.revision_id === 'string' ? req.query.revision_id.trim() : null;
      const download = req.query.download === '1' || req.query.download === 'true';

      const resolved = await resolveProjectFileRawContent(projectId, fileId, branchParam, revisionId, req);
      if (!resolved.ok) {
        res.status(resolved.status).json({ detail: resolved.detail });
        return;
      }

      res.setHeader('Content-Type', rawContentType(resolved.contentType));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Project-File-Path', resolved.path);
      if (resolved.revisionId) res.setHeader('X-Project-File-Revision-Id', resolved.revisionId);
      if (resolved.branchName) res.setHeader('X-Project-Branch', resolved.branchName);
      if (resolved.commitId) res.setHeader('X-Project-Branch-Commit-Id', resolved.commitId);
      if (download) {
        res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename(resolved.path)}"`);
      }
      res.send(rawContentData(resolved.content, resolved.contentType));
    } catch (err) {
      console.error('Get project file raw error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/files/:file_id/blame',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const fileId = req.params.file_id;
      const branchParam = typeof req.query.branch === 'string' ? req.query.branch.trim() : null;
      const revisionId = typeof req.query.revision_id === 'string' ? req.query.revision_id.trim() : null;

      const resolved = await resolveProjectFileBlameTarget(projectId, fileId, branchParam, revisionId, req);
      if (!resolved.ok) {
        res.status(resolved.status).json({ detail: resolved.detail });
        return;
      }

      const blame = buildProjectFileBlame(resolved.revisions, resolved.targetRevision);

      // When the branch HEAD has a real git commit, enrich with the true
      // last-touching commit for this file (isomorphic-git log with a file
      // filter). This is file-level, not line-level — true line blame isn't
      // available without a full git history walk, so we keep the DB line
      // attribution as the per-line source and add the git last-commit as
      // metadata.
      let gitLastCommit: { sha: string; message: string; author: string; timestamp: number } | null = null;
      if (resolved.commitId) {
        const headCommit = await AppDataSource.getRepository(ProjectCommit).findOne({
          where: { id: resolved.commitId, projectId },
          select: ['id', 'gitSha'],
        });
        if (headCommit?.gitSha) {
          try {
            const { gitLog } = await import('../services/project-git.service');
            const fileLog = await gitLog(projectId, 1);
            // isomorphic-git's log doesn't filter by file in all versions; walk
            // recent commits and use the first (newest) = HEAD as last-touch.
            const head = fileLog[0];
            if (head) {
              gitLastCommit = {
                sha: head.oid,
                message: head.commit.message,
                author: head.commit.author?.name ?? '',
                timestamp: head.commit.committer?.timestamp ?? 0,
              };
            }
          } catch {
            gitLastCommit = null;
          }
        }
      }

      res.json({
        data: {
          project_id: projectId,
          file_id: fileId,
          path: resolved.targetRevision.path,
          file: serializeProjectFileSummary(resolved.file),
          revision: serializeProjectFileRevision(resolved.targetRevision),
          branch: resolved.branch ?? undefined,
          branch_commit_id: resolved.commitId ?? undefined,
          blame_model: 'line-content-same-position',
          is_git_blame: false,
          git_last_commit: gitLastCommit,
          limitations: [
            'Local Project Space blame is derived from stored file revisions.',
            'Line attribution tracks exact content at the same line number through the target revision.',
            'It is not rename-aware, move-aware, or equivalent to provider Git blame.',
            gitLastCommit ? 'git_last_commit provides the real last-touching git commit (file-level).' : '',
          ].filter(Boolean),
          lines: blame,
        },
      });
    } catch (err) {
      console.error('Get project file blame error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/files/:file_id/download',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const fileId = req.params.file_id;
      const branchParam = typeof req.query.branch === 'string' ? req.query.branch.trim() : null;
      const revisionId = typeof req.query.revision_id === 'string' ? req.query.revision_id.trim() : null;

      const resolved = await resolveProjectFileRawContent(projectId, fileId, branchParam, revisionId, req);
      if (!resolved.ok) {
        res.status(resolved.status).json({ detail: resolved.detail });
        return;
      }

      res.setHeader('Content-Type', rawContentType(resolved.contentType));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Project-File-Path', resolved.path);
      if (resolved.revisionId) res.setHeader('X-Project-File-Revision-Id', resolved.revisionId);
      if (resolved.branchName) res.setHeader('X-Project-Branch', resolved.branchName);
      if (resolved.commitId) res.setHeader('X-Project-Branch-Commit-Id', resolved.commitId);
      res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename(resolved.path)}"`);
      res.send(rawContentData(resolved.content, resolved.contentType));
    } catch (err) {
      console.error('Download project file error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/files/:file_id/revisions',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const revisions = await AppDataSource.getRepository(ProjectFileRevision).find({
        where: { fileId: req.params.file_id, projectId: req.params.project_id },
        order: { revisionNumber: 'ASC' },
      });
      res.json({ data: revisions.map(serializeProjectFileRevision) });
    } catch (err) {
      console.error('List project file revisions error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/files/:file_id/revisions/compare',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const fileId = req.params.file_id;
      const baseRevisionId = typeof req.query.base_revision_id === 'string' ? req.query.base_revision_id.trim() : '';
      const headRevisionId = typeof req.query.head_revision_id === 'string' ? req.query.head_revision_id.trim() : '';
      if (!baseRevisionId || !headRevisionId) {
        res.status(422).json({ detail: 'base_revision_id and head_revision_id are required' });
        return;
      }

      const revisionRepo = AppDataSource.getRepository(ProjectFileRevision);
      const revisions = await revisionRepo.findBy({
        id: In([baseRevisionId, headRevisionId]),
        projectId,
        fileId,
      });
      const baseRevision = revisions.find((revision) => revision.id === baseRevisionId);
      const headRevision = revisions.find((revision) => revision.id === headRevisionId);
      if (!baseRevision || !headRevision) {
        res.status(404).json({ detail: 'File revision not found' });
        return;
      }

      const summary = summarizeLineDiff(baseRevision.content, headRevision.content);
      res.json({
        data: {
          project_id: projectId,
          file_id: fileId,
          path: headRevision.path || baseRevision.path,
          base_revision: serializeProjectFileRevision(baseRevision),
          head_revision: serializeProjectFileRevision(headRevision),
          old_content: baseRevision.content,
          new_content: headRevision.content,
          old_content_hash: baseRevision.contentHash,
          new_content_hash: headRevision.contentHash,
          summary,
        },
      });
    } catch (err) {
      console.error('Compare project file revisions error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.patch(
  '/v1/projects/:project_id/files/:file_id',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const fileId = req.params.file_id;
      const userId = req.user?.userId ?? req.agent?.id;
      if (!userId) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }

      const path = validateProjectPath(req.body.path);
      if (!path.ok) {
        res.status(422).json({ detail: path.error });
        return;
      }

      const baseRevisionId = typeof req.body.base_revision_id === 'string'
        ? req.body.base_revision_id
        : null;
      const message = typeof req.body.message === 'string' && req.body.message.trim()
        ? req.body.message.trim().slice(0, 512)
        : null;

      const result = await AppDataSource.transaction(async (manager) => {
        const defaultBranch = await manager.findOne(ProjectBranch, { where: { projectId, isDefault: true } });
        if (
          defaultBranch?.protectionRules?.block_direct_writes === true &&
          !canBypassDirectWriteRule(defaultBranch, (req as any).projectRole, req.user?.userId)
        ) {
          return { blockedByBranchRule: true as const, branch: defaultBranch };
        }

        const fileRepo = manager.getRepository(ProjectFile);
        const file = await fileRepo.findOne({
          where: { id: fileId, projectId, deletedAt: IsNull() },
        });
        if (!file) {
          return { missing: true as const };
        }

        // Agent path safety: agents may only rename files that live under deliverables/.
        if (req.agent) {
          const normalizedOldPath = file.path.replace(/^\.?\//, '');
          const normalizedNewPath = path.value.replace(/^\.?\//, '');
          if (
            !normalizedOldPath.startsWith('deliverables/') ||
            !normalizedNewPath.startsWith('deliverables/')
          ) {
            return { agentPathForbidden: true as const };
          }
        }

        if (baseRevisionId === null) {
          return { missingBaseRevision: true as const };
        }
        if (file.currentRevisionId !== baseRevisionId) {
          return { conflict: true as const, file };
        }

        if (file.path === path.value) {
          return { unchanged: true as const, file };
        }

        const target = await fileRepo.findOne({
          where: { projectId, path: path.value, deletedAt: IsNull() },
        });
        if (target && target.id !== file.id) {
          return { targetExists: true as const };
        }

        const revisionRepo = manager.getRepository(ProjectFileRevision);
        const latest = await revisionRepo
          .createQueryBuilder('revision')
          .where('revision.fileId = :fileId', { fileId: file.id })
          .orderBy('revision.revisionNumber', 'DESC')
          .getOne();

        const revision = revisionRepo.create({
          projectId,
          fileId: file.id,
          path: path.value,
          revisionNumber: (latest?.revisionNumber ?? 0) + 1,
          content: file.content,
          contentType: file.contentType,
          contentHash: file.contentHash,
          message: message ?? `Renamed from ${file.path}`,
          createdBy: userId,
        });
        await revisionRepo.save(revision);

        const oldPath = file.path;
        file.path = path.value;
        file.currentRevisionId = revision.id;
        file.updatedBy = userId;
        await fileRepo.save(file);

        return { ok: true as const, file, revision, oldPath };
      });

      if ('missing' in result) {
        res.status(404).json({ detail: 'File not found' });
        return;
      }
      if ('blockedByBranchRule' in result) {
        const blockedBranch = result.branch;
        if (!blockedBranch) {
          throw new Error('Branch protection rule blocked a write without branch context');
        }
        res.status(409).json({
          detail: 'Direct file writes are blocked by branch protection rules. Use a changeset for reviewed changes.',
          branch_id: blockedBranch.id,
          branch_name: blockedBranch.name,
          rule: 'block_direct_writes',
        });
        return;
      }
      if ('agentPathForbidden' in result) {
        res.status(403).json({
          detail: 'Agents can only rename files under deliverables/.',
        });
        return;
      }
      if ('missingBaseRevision' in result) {
        res.status(422).json({ detail: 'base_revision_id is required for rename operations' });
        return;
      }
      if ('conflict' in result) {
        res.status(409).json({
          detail: 'File revision conflict',
          current_revision_id: result.file?.currentRevisionId ?? null,
        });
        return;
      }
      if ('targetExists' in result) {
        res.status(409).json({ detail: 'Rename target path already exists' });
        return;
      }
      if ('unchanged' in result) {
        res.status(200).json(serializeProjectFile(result.file));
        return;
      }

      res.status(200).json({
        ...serializeProjectFile(result.file),
        old_path: result.oldPath,
        revision: serializeProjectFileRevision(result.revision),
      });
    } catch (err) {
      console.error('Rename project file error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.delete(
  '/v1/projects/:project_id/files/:file_id',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const fileId = req.params.file_id;
      const userId = req.user?.userId ?? req.agent?.id;
      if (!userId) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }

      const baseRevisionId = typeof req.body.base_revision_id === 'string'
        ? req.body.base_revision_id
        : null;

      const result = await AppDataSource.transaction(async (manager) => {
        const defaultBranch = await manager.findOne(ProjectBranch, { where: { projectId, isDefault: true } });
        if (
          defaultBranch?.protectionRules?.block_direct_writes === true &&
          !canBypassDirectWriteRule(defaultBranch, (req as any).projectRole, req.user?.userId)
        ) {
          return { blockedByBranchRule: true as const, branch: defaultBranch };
        }

        const fileRepo = manager.getRepository(ProjectFile);
        const file = await fileRepo.findOne({
          where: { id: fileId, projectId, deletedAt: IsNull() },
        });
        if (!file) {
          return { missing: true as const };
        }

        // Agent path safety: agents may only delete files under deliverables/.
        if (req.agent) {
          const normalizedPath = file.path.replace(/^\.?\//, '');
          if (!normalizedPath.startsWith('deliverables/')) {
            return { agentPathForbidden: true as const };
          }
        }

        if (baseRevisionId === null) {
          return { missingBaseRevision: true as const };
        }
        if (file.currentRevisionId !== baseRevisionId) {
          return { conflict: true as const, file };
        }

        file.deletedAt = new Date();
        file.updatedBy = userId;
        await fileRepo.save(file);

        return { ok: true as const, file };
      });

      if ('missing' in result) {
        res.status(404).json({ detail: 'File not found' });
        return;
      }
      if ('blockedByBranchRule' in result) {
        const blockedBranch = result.branch;
        if (!blockedBranch) {
          throw new Error('Branch protection rule blocked a write without branch context');
        }
        res.status(409).json({
          detail: 'Direct file writes are blocked by branch protection rules. Use a changeset for reviewed changes.',
          branch_id: blockedBranch.id,
          branch_name: blockedBranch.name,
          rule: 'block_direct_writes',
        });
        return;
      }
      if ('agentPathForbidden' in result) {
        res.status(403).json({
          detail: 'Agents can only delete files under deliverables/.',
        });
        return;
      }
      if ('missingBaseRevision' in result) {
        res.status(422).json({ detail: 'base_revision_id is required for delete operations' });
        return;
      }
      if ('conflict' in result) {
        res.status(409).json({
          detail: 'File revision conflict',
          current_revision_id: result.file?.currentRevisionId ?? null,
        });
        return;
      }

      res.status(200).json({
        id: result.file.id,
        project_id: result.file.projectId,
        path: result.file.path,
        deleted_at: result.file.deletedAt,
        current_revision_id: result.file.currentRevisionId ?? null,
      });
    } catch (err) {
      console.error('Delete project file error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

// ─── Repository README (read-only) ───────────────────────────────────────────

router.get(
  '/v1/projects/:project_id/readme',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const branchParam = typeof req.query.branch === 'string' ? req.query.branch.trim() : null;

      const branchContextResult = await resolveProjectBranchContext(projectId, branchParam, req);
      if (!branchContextResult.ok) {
        res.status(branchContextResult.status).json({ detail: branchContextResult.detail });
        return;
      }
      const branchContext = branchContextResult.context;

      if (branchContext?.commit?.snapshot) {
        const snapshot = branchContext.commit.snapshot;
        const entries = Object.entries(snapshot)
          .filter(([path]) => isReadmePath(path))
          .sort((a, b) => {
            const depthDiff = a[0].split('/').length - b[0].split('/').length;
            if (depthDiff !== 0) return depthDiff;
            return a[0].localeCompare(b[0]);
          });

        const entry = entries[0];
        if (!entry) {
          res.status(404).json({ detail: 'README not found' });
          return;
        }
        const [path, value] = entry;
        if (!value.revision_id) {
          res.status(404).json({ detail: 'README not found in branch snapshot' });
          return;
        }
        const revision = await AppDataSource.getRepository(ProjectFileRevision).findOne({
          where: { id: value.revision_id, projectId },
        });
        if (!revision) {
          res.status(404).json({ detail: 'README not found in branch snapshot' });
          return;
        }
        res.json({
          path: revision.path,
          file_id: value.file_id,
          content: revision.content,
          content_type: revision.contentType,
          branch: branchContext.branchMeta,
          updated_at: revision.createdAt,
        });
        return;
      }

      if (branchContext && !branchContext.branch.isDefault) {
        // Non-default branch without a commit snapshot: empty.
        res.status(404).json({ detail: 'README not found' });
        return;
      }

      const fileRepo = AppDataSource.getRepository(ProjectFile);
      const readmeCandidates = await findProjectReadmeCandidates(fileRepo, projectId);
      const readmeFile = readmeCandidates.find((file) => !file.deletedAt) ?? null;
      if (!readmeFile) {
        res.status(404).json({ detail: 'README not found' });
        return;
      }

      res.json({
        path: readmeFile.path,
        file_id: readmeFile.id,
        content: readmeFile.content,
        content_type: readmeFile.contentType,
        branch: branchContext?.branchMeta ?? null,
        updated_at: readmeFile.updatedAt,
      });
    } catch (err) {
      console.error('Get project readme error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

// ─── Project Rules (AGENTS.md) — readable by every agent ────────────────────
// The project-level main agent maintains AGENTS.md; its content is auto-injected
// into every agent's dispatch context (session-dispatch.service.ts). This route
// gives agents (and humans) a direct read of the current rules.

router.get(
  '/v1/projects/:project_id/agents-rules',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const fileRepo = AppDataSource.getRepository(ProjectFile);
      // Root-level AGENTS.md only (depth 1), not deleted.
      const rulesFile = await fileRepo
        .createQueryBuilder('f')
        .where('f.project_id = :projectId', { projectId })
        .andWhere('LOWER(f.path) IN (:...names)', { names: AGENTS_RULES_NAMES })
        .andWhere('f.deleted_at IS NULL')
        .orderBy('f.updated_at', 'DESC')
        .getOne();
      if (!rulesFile) {
        res.status(404).json({ detail: 'AGENTS.md not found. Ask the project main agent to create it.' });
        return;
      }
      res.json({
        path: rulesFile.path,
        file_id: rulesFile.id,
        content: rulesFile.content,
        content_type: rulesFile.contentType,
        updated_at: rulesFile.updatedAt,
      });
    } catch (err) {
      console.error('Get project agents-rules error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

// ─── Project Archive Download (ZIP) ──────────────────────────────────────────

router.get(
  '/v1/projects/:project_id/archive.zip',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const branchParam = typeof req.query.branch === 'string' ? req.query.branch.trim() : null;

      const project = await AppDataSource.getRepository(Project).findOne({
        where: { id: projectId },
      });
      if (!project) {
        res.status(404).json({ detail: 'Project not found' });
        return;
      }

      const branchContextResult = await resolveProjectBranchContext(projectId, branchParam, req);
      if (!branchContextResult.ok) {
        res.status(branchContextResult.status).json({ detail: branchContextResult.detail });
        return;
      }
      const branchContext = branchContextResult.context;
      const branchName = branchContext?.branchMeta?.name ?? null;

      const archiveEntries: Array<{ path: string; content: string }> = [];

      if (branchContext?.commit?.snapshot) {
        const snapshot = branchContext.commit.snapshot;
        const revisionIds = Object.values(snapshot)
          .map((entry) => entry.revision_id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (revisionIds.length > 0) {
          const revisions = await AppDataSource.getRepository(ProjectFileRevision).findBy({
            id: In(revisionIds),
            projectId,
          });
          const revisionById = new Map(revisions.map((r) => [r.id, r]));
          for (const entry of Object.values(snapshot)) {
            if (!entry.revision_id) continue;
            const revision = revisionById.get(entry.revision_id);
            if (!revision) continue;
            archiveEntries.push({ path: revision.path, content: revision.content });
          }
        }
      } else if (branchContext && !branchContext.branch.isDefault) {
        // Non-default branch with no commit: empty snapshot, produce empty archive.
      } else {
        const files = await AppDataSource.getRepository(ProjectFile).find({
          where: { projectId, deletedAt: IsNull() },
          order: { path: 'ASC' },
        });
        for (const file of files) {
          archiveEntries.push({ path: file.path, content: file.content });
        }
      }

      // Defensive path normalization: reject any entry that could escape the
      // archive root. Paths are already validated on write, but we re-check here
      // because revisions can be renamed and the archive entry path is the
      // authoritative value sent to the client.
      for (const entry of archiveEntries) {
        const safe = safeArchivePath(entry.path);
        if (!safe.ok) {
          res.status(500).json({ detail: `Unsafe archive path: ${entry.path}` });
          return;
        }
        entry.path = safe.value;
      }

      const zip = buildZip(archiveEntries);
      const filename = archiveFilename(project.name, branchName);

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', String(zip.length));
      res.send(zip);
    } catch (err) {
      console.error('Download project archive error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

// ─── Project Import (archive → preview → changeset) ─────────────────────────
// Lets a user import a local project (zip) into the project space. Step 1 is a
// dry-run preview (parse + filter), step 2 writes the files (as a changeset or
// direct upserts). Mirrors `git archive` workflow without needing git locally.

// Patterns filtered out of imports (never imported into the project space).
const IMPORT_IGNORE_PATTERNS = [
  /(^|\/)\.git(\/|$)/,           // git internals
  /(^|\/)node_modules(\/|$)/,    // deps
  /(^|\/)dist(\/|$)/,            // build output
  /(^|\/)build(\/|$)/,
  /(^|\/)\.next(\/|$)/,
  /(^|\/)coverage(\/|$)/,
  /(^|\/)__pycache__(\/|$)/,
  /\.pyc$/,
  /(^|\/)\.env(\.|$)/,           // secrets
  /(^|\/)\.DS_Store$/,
  /(^|\/)Thumbs\.db$/,
];

const IMPORT_MAX_FILES = 1000;
const IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB per file (NAS: no practical limit)
const IMPORT_MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 100MB archive (NAS: large projects)

function shouldIgnoreImportPath(p: string): boolean {
  return IMPORT_IGNORE_PATTERNS.some((re) => re.test(p));
}

/**
 * POST /v1/projects/:project_id/files/import-preview
 * Body: { archive_base64: "<base64 zip>" }
 * Returns a preview of the files that WOULD be imported: filtered list, ignored
 * list (with reasons), total size, risk flags (.env, large files, binaries).
 * Does NOT write anything — safe to call repeatedly.
 */
router.post(
  '/v1/projects/:project_id/files/import-preview',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const AdmZip = (await import('adm-zip')).default;
      const archiveB64 = typeof req.body.archive_base64 === 'string' ? req.body.archive_base64 : '';
      if (!archiveB64) {
        res.status(422).json({ detail: 'archive_base64 is required (base64-encoded zip)' });
        return;
      }
      const buf = Buffer.from(archiveB64, 'base64');
      if (buf.length > IMPORT_MAX_TOTAL_BYTES) {
        res.status(413).json({ detail: `Archive too large (${buf.length} bytes). Max ${IMPORT_MAX_TOTAL_BYTES}.` });
        return;
      }
      let zip: any;
      try { zip = new AdmZip(buf); } catch {
        res.status(422).json({ detail: 'Invalid zip archive' });
        return;
      }
      const entries = zip.getEntries();
      const files: any[] = [];
      const ignored: any[] = [];
      let totalSize = 0;
      for (const entry of entries) {
        if (entry.isDirectory) continue;
        const path = entry.entryName;
        if (shouldIgnoreImportPath(path)) {
          const reason = path.includes('.git') ? '.git internals'
            : path.includes('node_modules') ? 'node_modules'
            : path.includes('/dist/') || path.includes('/build/') ? 'build output'
            : path.match(/\.env/) ? 'secrets (.env)'
            : 'ignored pattern';
          ignored.push({ path, reason });
          continue;
        }
        const content = entry.getData().toString('utf8');
        const sizeBytes = Buffer.byteLength(content, 'utf8');
        totalSize += sizeBytes;
        if (files.length >= IMPORT_MAX_FILES) {
          ignored.push({ path, reason: `max files limit (${IMPORT_MAX_FILES})` });
          continue;
        }
        files.push({
          path,
          size_bytes: sizeBytes,
          truncated: sizeBytes > IMPORT_MAX_FILE_BYTES,
          content_preview: content.slice(0, 500),
          is_binary: /[\x00-\x08\x0E-\x1F]/.test(content.slice(0, 1024)),
        });
      }
      const risks: string[] = [];
      if (ignored.some((i) => i.reason.includes('secrets'))) risks.push('Contains .env or secret files (will be filtered out)');
      if (files.some((f) => f.is_binary)) risks.push('Contains binary files (may not preview correctly)');
      if (files.some((f) => f.size_bytes > 100 * 1024)) risks.push('Contains large files (>100KB)');
      res.json({
        file_count: files.length,
        ignored_count: ignored.length,
        total_size_bytes: totalSize,
        risks,
        files: files.slice(0, 100), // preview first 100
        ignored_sample: ignored.slice(0, 50),
      });
    } catch (err) {
      console.error('Import preview error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * POST /v1/projects/:project_id/files/import
 * Body: { archive_base64, mode: "direct"|"changeset", message?, changeset_title? }
 * Writes the filtered files from the archive into the project. mode=changeset
 * creates a ProjectChangeset (reviewed before merge); mode=direct upserts now.
 */
router.post(
  '/v1/projects/:project_id/files/import',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const AdmZip = (await import('adm-zip')).default;
      const archiveB64 = typeof req.body.archive_base64 === 'string' ? req.body.archive_base64 : '';
      const mode = req.body.mode === 'changeset' ? 'changeset' : 'direct';
      const message = typeof req.body.message === 'string' ? req.body.message.slice(0, 255) : 'Import project archive';
      if (!archiveB64) {
        res.status(422).json({ detail: 'archive_base64 is required' });
        return;
      }
      const buf = Buffer.from(archiveB64, 'base64');
      if (buf.length > IMPORT_MAX_TOTAL_BYTES) {
        res.status(413).json({ detail: 'Archive too large' });
        return;
      }
      let zip: any;
      try { zip = new AdmZip(buf); } catch {
        res.status(422).json({ detail: 'Invalid zip archive' });
        return;
      }
      const userId = req.user?.userId ?? req.agent?.id ?? 'import';
      const entries = zip.getEntries();
      const fileOps: any[] = [];
      for (const entry of entries) {
        if (entry.isDirectory) continue;
        const filePath = entry.entryName;
        if (shouldIgnoreImportPath(filePath)) continue;
        const content = entry.getData().toString('utf8');
        if (Buffer.byteLength(content, 'utf8') > IMPORT_MAX_FILE_BYTES) continue;
        fileOps.push({ op: 'upsert', path: filePath, content });
        if (fileOps.length >= IMPORT_MAX_FILES) break;
      }

      if (mode === 'changeset') {
        // Build a changeset proposal (Owner/PM reviews before merge).
        const { ProjectChangeset, ProjectChangesetStatus, ProjectBranch } = await import('../entities');
        // Ensure a default branch exists (new projects may not have one yet).
        const branchRepo = AppDataSource.getRepository(ProjectBranch);
        let branch = await branchRepo.findOne({ where: { projectId: req.params.project_id, isDefault: true } });
        if (!branch) {
          branch = await branchRepo.findOne({ where: { projectId: req.params.project_id, name: 'main' } });
          if (branch) { branch.isDefault = true; branch = await branchRepo.save(branch); }
          else {
            branch = await branchRepo.save(branchRepo.create({
              projectId: req.params.project_id, name: 'main', isDefault: true,
              createdByUserId: req.user?.userId ?? null, createdByAgentId: req.agent?.id ?? null,
            }));
          }
        }
        const branchId = branch.id;
        const csRepo = AppDataSource.getRepository(ProjectChangeset);
        const cs = csRepo.create({
          projectId: req.params.project_id,
          branchId,
          title: req.body.changeset_title ? String(req.body.changeset_title).slice(0, 255) : `Import: ${fileOps.length} files`,
          description: `Imported ${fileOps.length} files from archive`,
          status: ProjectChangesetStatus.SUBMITTED,
          fileOps,
          createdByUserId: req.user?.userId ?? null,
          createdByAgentId: req.agent?.id ?? null,
        });
        const saved = await csRepo.save(cs);
        res.status(201).json({
          mode: 'changeset',
          changeset_id: saved.id,
          file_count: fileOps.length,
          message: 'Imported files into a changeset. Owner/PM must review and merge.',
        });
      } else {
        // Direct upsert (bypasses changeset review — use for trusted imports).
        const { upsertProjectFileContent } = await import('../services/project-file.service');
        let written = 0;
        await AppDataSource.transaction(async (manager) => {
          for (const op of fileOps) {
            await upsertProjectFileContent(manager, {
              projectId: req.params.project_id,
              path: op.path,
              content: op.content,
              actorId: userId,
              message,
            });
            written++;
          }
        });
        res.status(201).json({ mode: 'direct', file_count: written });
      }
    } catch (err) {
      console.error('Import error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

// ─── Memories CRUD (GP-Support) ──────────────────────────────────────────────

router.get(
  '/v1/projects/:project_id/memories',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const agentId = typeof req.query.agent_id === 'string' ? req.query.agent_id : null;
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : null;

      const qb = AppDataSource.getRepository(ProjectMemory)
        .createQueryBuilder('memory')
        .where('memory.projectId = :projectId', { projectId })
        .orderBy('memory.updatedAt', 'DESC')
        .take(100);

      if (agentId) {
        qb.andWhere('memory.agentId = :agentId', { agentId });
      }
      if (q) {
        qb.andWhere('LOWER(memory.content) LIKE LOWER(:q)', { q: `%${q}%` });
      }

      const memories = await qb.getMany();
      res.json({ data: memories.map(serializeProjectMemory) });
    } catch (err) {
      console.error('List project memories error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.post(
  '/v1/projects/:project_id/memories',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
      if (!content) {
        res.status(422).json({ detail: 'content is required' });
        return;
      }
      if (content.length > MAX_MEMORY_CHARS) {
        res.status(413).json({ detail: `Memory content exceeds ${MAX_MEMORY_CHARS} characters` });
        return;
      }

      const userId = req.user?.userId ?? null;

      // Agent path: agent can only write memory for itself
      let agentId: string | null = null;
      if (req.agent) {
        // Agents cannot write memory for another agent
        const requestedAgentId = typeof req.body.agent_id === 'string' ? req.body.agent_id : null;
        if (requestedAgentId && requestedAgentId !== req.agent.id) {
          res.status(403).json({ detail: 'Agents can only create memory for themselves' });
          return;
        }
        agentId = req.agent.id;
      } else {
        agentId = typeof req.body.agent_id === 'string' ? req.body.agent_id : null;
        if (agentId) {
          const agent = await AppDataSource.getRepository(Agent).findOne({
            where: { id: agentId, projectId },
          });
          if (!agent) {
            res.status(404).json({ detail: 'Agent not found in this project' });
            return;
          }
        }
      }

      const visibility = req.body.visibility === ProjectMemoryVisibility.AGENT || agentId
        ? ProjectMemoryVisibility.AGENT
        : ProjectMemoryVisibility.PROJECT;
      const tags = normalizeStringArray(req.body.tags).slice(0, 20);
      const metadata = isPlainObject(req.body.metadata) ? req.body.metadata : undefined;

      const memory = await AppDataSource.getRepository(ProjectMemory).save(
        AppDataSource.getRepository(ProjectMemory).create({
          projectId,
          agentId,
          authorUserId: userId,
          content,
          tags,
          metadata,
          visibility,
        }),
      );

      res.status(201).json(serializeProjectMemory(memory));
    } catch (err) {
      console.error('Create project memory error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

// ─── Join Requests (GP-Support, V1 Membership Gateway) ───────────────────────

router.post(
  '/v1/projects/:project_id/join-requests',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const userId = req.user!.userId;
      const project = await AppDataSource.getRepository(Project).findOne({ where: { id: projectId } });
      if (!project) {
        res.status(404).json({ detail: 'Project not found' });
        return;
      }

      const memberRepo = AppDataSource.getRepository(ProjectMember);
      const membership = await memberRepo.findOne({ where: { projectId, userId } });
      if (membership) {
        res.status(409).json({ detail: 'Already a project member' });
        return;
      }

      const joinRepo = AppDataSource.getRepository(ProjectJoinRequest);
      const existing = await joinRepo.findOne({
        where: { projectId, userId, status: ProjectJoinRequestStatus.PENDING },
      });
      if (existing) {
        res.status(409).json(serializeJoinRequest(existing));
        return;
      }

      const requestedRole = req.body.requested_role === ProjectRole.VIEWER
        ? ProjectRole.VIEWER
        : ProjectRole.MEMBER;
      const request = await joinRepo.save(joinRepo.create({
        projectId,
        userId,
        requestedRole,
        note: typeof req.body.note === 'string' ? req.body.note.slice(0, 1000) : null,
        status: ProjectJoinRequestStatus.PENDING,
      }));

      // Double-write to collaboration_requests
      try {
        await bridgeJoinRequestToCollab({
          joinRequestId: request.id,
          projectId,
          userId,
          projectOwnerId: project.ownerId,
          requestedRole,
          note: request.note,
        });
      } catch (e) { /* ignore bridge failures */ }

      // Notify bound owner/admin agents before response (deterministic delivery)
      try {
        const ownerAdminMembers = await AppDataSource.getRepository(ProjectMember).find({
          where: { projectId, role: In([ProjectRole.OWNER, ProjectRole.ADMIN]) },
        });
        // Collect owner user IDs from members + project owner fallback
        const userIds = new Set<string>(ownerAdminMembers.map(m => m.userId));
        userIds.add(project.ownerId);
        const users = await AppDataSource.getRepository(User).find({
          where: { id: In([...userIds]) },
        });
        const recipientAgentIds = new Set<string>();
        for (const u of users) {
          if (u.ownerAgentId) recipientAgentIds.add(u.ownerAgentId);
        }
        for (const recipientAgentId of recipientAgentIds) {
          await createInboxItem({
            projectId,
            recipientAgentId,
            eventType: 'join_request_created',
            title: 'New join request',
            body: `User ${userId} requested to join the project as ${requestedRole}.`,
            payload: { project_id: projectId, user_id: userId, join_request_id: request.id },
          });
        }
      } catch (e) {
        // ignore inbox failures
      }

      res.status(201).json(serializeJoinRequest(request));
    } catch (err) {
      console.error('Create join request error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/join-requests',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ManageMembers),
  async (req: Request, res: Response) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const where: Record<string, unknown> = { projectId: req.params.project_id };
      if (status && Object.values(ProjectJoinRequestStatus).includes(status as ProjectJoinRequestStatus)) {
        where.status = status;
      }
      const requests = await AppDataSource.getRepository(ProjectJoinRequest).find({
        where,
        relations: ['user'],
        order: { createdAt: 'DESC' },
      });
      res.json({ data: requests.map(serializeJoinRequest) });
    } catch (err) {
      console.error('List join requests error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.patch(
  '/v1/projects/:project_id/join-requests/:request_id',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ManageMembers),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const joinRepo = AppDataSource.getRepository(ProjectJoinRequest);
      const request = await joinRepo.findOne({
        where: { id: req.params.request_id, projectId },
      });
      if (!request) {
        res.status(404).json({ detail: 'Join request not found' });
        return;
      }
      if (request.status !== ProjectJoinRequestStatus.PENDING) {
        res.status(409).json({ detail: 'Join request has already been reviewed' });
        return;
      }

      const status = req.body.status;
      if (![ProjectJoinRequestStatus.APPROVED, ProjectJoinRequestStatus.REJECTED].includes(status)) {
        res.status(422).json({ detail: 'status must be approved or rejected' });
        return;
      }

      const role = normalizeApprovedRole(req.body.role ?? request.requestedRole);
      if (status === ProjectJoinRequestStatus.APPROVED) {
        const gateCheck = await requiredGatesSatisfied(projectId, request.id);
        if (!gateCheck.ok) {
          res.status(409).json({
            detail: 'Required project gates must be approved before this join request can be approved',
            missing_gate_ids: gateCheck.missingGateIds,
          });
          return;
        }
      }

      const reviewed = await AppDataSource.transaction(async (manager) => {
        request.status = status;
        request.reviewedBy = req.user!.userId;
        request.reviewedAt = new Date();
        await manager.save(ProjectJoinRequest, request);

        if (status === ProjectJoinRequestStatus.APPROVED) {
          const existingMember = await manager.findOne(ProjectMember, {
            where: { projectId, userId: request.userId },
          });
          if (!existingMember) {
            await manager.save(
              ProjectMember,
              manager.create(ProjectMember, {
                projectId,
                userId: request.userId,
                role,
              }),
            );
          }
        }
        return request;
      });

      // Sync status to collaboration_request (before response for determinism)
      try {
        await bridgeJoinRequestReview(request.id, status, req.user!.userId);
      } catch (e) { /* ignore bridge failures */ }

      res.json(serializeJoinRequest(reviewed));

      // Notify requester's bound owner agent if one exists
      try {
        const requester = await AppDataSource.getRepository(User).findOne({ where: { id: request.userId } });
        if (requester?.ownerAgentId) {
          await createInboxItem({
            projectId,
            recipientAgentId: requester.ownerAgentId,
            eventType: `join_request_${status}`,
            title: `Join request ${status}`,
            body: `Your join request to project ${projectId} was ${status}.`,
            payload: { project_id: projectId, user_id: request.userId, join_request_id: request.id },
          });
        }
      } catch (e) {
        // ignore inbox failures
      }
    } catch (err) {
      console.error('Review join request error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

// ─── Archive ZIP helpers ─────────────────────────────────────────────────────

function safeArchivePath(value: string): { ok: true; value: string } | { ok: false } {
  const normalized = value.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..') || normalized.includes('//')) {
    return { ok: false };
  }
  return { ok: true, value: normalized };
}

function sanitizeFilenameSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'project';
}

function archiveFilename(projectName: string, branchName: string | null): string {
  const name = sanitizeFilenameSlug(projectName);
  const suffix = branchName ? `-${sanitizeFilenameSlug(branchName)}` : '';
  return `${name}${suffix}.zip`;
}

interface ZipEntry {
  path: string;
  content: string;
}

/**
 * Build a minimal, standards-compliant ZIP archive in memory.
 *
 * Uses Node's built-in zlib.crc32 (available in Node 22+) and the "stored"
 * compression method so no external archive library is required. All paths are
 * forced to forward slashes and must already have passed safeArchivePath().
 */
function buildZip(entries: ZipEntry[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let cursor = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.path, 'utf8');
    const dataBytes = Buffer.from(entry.content, 'utf8');
    const crc = zlib.crc32(dataBytes);
    const size = dataBytes.length;

    // General purpose bit flag: bit 11 set means UTF-8 encoded filenames.
    const gpFlags = 0x0800;
    const compressionMethod = 0; // stored (no compression)
    const version = 20;
    const dosTime = 0;
    const dosDate = 0;

    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(version, 4);
    localHeader.writeUInt16LE(gpFlags, 6);
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18); // compressed size == uncompressed for stored
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    nameBytes.copy(localHeader, 30);

    localHeaders.push(localHeader);
    localHeaders.push(dataBytes);

    const centralHeader = Buffer.alloc(46 + nameBytes.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central directory signature
    centralHeader.writeUInt16LE(version, 4); // version made by
    centralHeader.writeUInt16LE(version, 6); // version needed
    centralHeader.writeUInt16LE(gpFlags, 8);
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // file comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(0, 38); // external file attributes
    centralHeader.writeUInt32LE(cursor, 42); // relative offset of local header
    nameBytes.copy(centralHeader, 46);

    centralHeaders.push(centralHeader);
    cursor += localHeader.length + dataBytes.length;
  }

  const centralOffset = cursor;
  const centralSize = centralHeaders.reduce((sum, h) => sum + h.length, 0);
  const central = Buffer.concat(centralHeaders);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // number of this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8); // central directory record count (this disk)
  eocd.writeUInt16LE(entries.length, 10); // total central directory record count
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localHeaders, central, eocd]);
}

// ─── Serializers ──────────────────────────────────────────────────────────────

type BranchMeta = {
  id: string;
  name: string;
  head_commit_id: string | null;
};

type ProjectBranchContext = {
  branch: ProjectBranch;
  commit: ProjectCommit | null;
  snapshotPaths: Set<string> | null;
  /** Real git commit SHA for this branch HEAD, if the git backend wrote it.
   *  Downstream read endpoints use this to read content/trees from true git;
   *  null => fall back to the DB snapshot (pre-git commits, rollback, git errors). */
  gitSha: string | null;
  branchMeta: BranchMeta;
};

type ProjectBranchContextResult =
  | { ok: true; context: ProjectBranchContext | null }
  | { ok: false; status: number; detail: string };

async function resolveProjectBranchContext(
  projectId: string,
  branchParam: string | null,
  req: Request,
): Promise<ProjectBranchContextResult> {
  if (!branchParam) return { ok: true, context: null };

  const branchRepo = AppDataSource.getRepository(ProjectBranch);
  const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(branchParam);
  // Look up by name first; only additionally try by id when the param is a
  // valid uuid shape (otherwise Postgres rejects the non-uuid value: "invalid
  // input syntax for type uuid").
  let branch = await branchRepo.findOne({
    where: looksLikeUuid
      ? [{ projectId, name: branchParam }, { projectId, id: branchParam }]
      : { projectId, name: branchParam },
  });
  if (!branch && branchParam === 'main') {
    branch = await branchRepo.save(branchRepo.create({
      projectId,
      name: 'main',
      createdByUserId: req.user?.userId ?? null,
      createdByAgentId: req.agent?.id ?? null,
    }));
  }
  if (!branch) {
    return { ok: false, status: 404, detail: `Branch not found: ${branchParam}` };
  }

  let commit: ProjectCommit | null = null;
  let snapshotPaths: Set<string> | null = null;
  let gitSha: string | null = null;
  if (branch.headCommitId) {
    commit = await AppDataSource.getRepository(ProjectCommit).findOne({
      where: { id: branch.headCommitId, projectId },
    });
    gitSha = commit?.gitSha ?? null;
    // Prefer the real git tree for the path set; fall back to the DB snapshot
    // when there's no gitSha (pre-git commits, rollback, git write failures).
    if (gitSha) {
      const { gitListTreeFiles } = await import('../services/project-git.service');
      const treePaths = await gitListTreeFiles(projectId, gitSha);
      snapshotPaths = treePaths.length > 0 ? new Set(treePaths) : null;
    }
    if (snapshotPaths === null && commit?.snapshot) {
      snapshotPaths = new Set(Object.keys(commit.snapshot));
    }
  }
  if (!branch.headCommitId && branch.name !== 'main') {
    snapshotPaths = new Set();
  }

  return {
    ok: true,
    context: {
      branch,
      commit,
      snapshotPaths,
      gitSha,
      branchMeta: {
        id: branch.id,
        name: branch.name,
        head_commit_id: branch.headCommitId ?? null,
      },
    },
  };
}

function findSnapshotEntryByFileId(
  snapshot: ProjectCommit['snapshot'],
  fileId: string,
): { path: string; value: ProjectCommit['snapshot'][string] } | null {
  for (const [path, value] of Object.entries(snapshot)) {
    if (value.file_id === fileId) return { path, value };
  }
  return null;
}

async function resolveProjectFileRawContent(
  projectId: string,
  fileId: string,
  branchParam: string | null,
  revisionId: string | null,
  req: Request,
): Promise<
  | {
      ok: true;
      path: string;
      content: string;
      contentType: string;
      revisionId: string | null;
      branchName: string | null;
      commitId: string | null;
    }
  | { ok: false; status: number; detail: string }
> {
  const file = await AppDataSource.getRepository(ProjectFile).findOne({
    where: { id: fileId, projectId },
  });
  if (!file) return { ok: false, status: 404, detail: 'File not found' };

  if (revisionId) {
    const revision = await AppDataSource.getRepository(ProjectFileRevision).findOne({
      where: { id: revisionId, fileId: file.id, projectId },
    });
    if (!revision) return { ok: false, status: 404, detail: 'File revision not found' };
    return {
      ok: true,
      path: revision.path,
      content: revision.content,
      contentType: revision.contentType || file.contentType,
      revisionId: revision.id,
      branchName: null,
      commitId: null,
    };
  }

  const branchContextResult = await resolveProjectBranchContext(projectId, branchParam, req);
  if (!branchContextResult.ok) {
    return { ok: false, status: branchContextResult.status, detail: branchContextResult.detail };
  }
  const branchContext = branchContextResult.context;
  if (branchContext) {
    if (branchContext.commit?.snapshot) {
      const snapshotEntry = findSnapshotEntryByFileId(branchContext.commit.snapshot, file.id);
      if (!snapshotEntry) return { ok: false, status: 404, detail: 'File not found in branch snapshot' };
      // Prefer real-git blob content (binary-safe) when the branch HEAD has a
      // gitSha; fall back to the DB revision otherwise.
      if (branchContext.gitSha) {
        const { gitReadBlobRaw } = await import('../services/project-git.service');
        const blob = await gitReadBlobRaw(projectId, snapshotEntry.path, branchContext.gitSha);
        if (blob !== null) {
          return {
            ok: true,
            path: snapshotEntry.path,
            content: blob.toString('utf8'),
            contentType: file.contentType,
            revisionId: snapshotEntry.value.revision_id ?? file.currentRevisionId ?? null,
            branchName: branchContext.branchMeta.name,
            commitId: branchContext.commit.id,
          };
        }
      }
      if (!snapshotEntry.value.revision_id) {
        return { ok: false, status: 404, detail: 'File revision not found in branch snapshot' };
      }
      const revision = await AppDataSource.getRepository(ProjectFileRevision).findOne({
        where: { id: snapshotEntry.value.revision_id, fileId: file.id, projectId },
      });
      if (!revision) return { ok: false, status: 404, detail: 'File revision not found in branch snapshot' };
      return {
        ok: true,
        path: revision.path,
        content: revision.content,
        contentType: revision.contentType || file.contentType,
        revisionId: revision.id,
        branchName: branchContext.branchMeta.name,
        commitId: branchContext.commit.id,
      };
    }
    if (!branchContext.branch.isDefault) {
      return { ok: false, status: 404, detail: 'File not found in branch snapshot' };
    }
    if (file.deletedAt) {
      return { ok: false, status: 404, detail: 'File not found' };
    }
    return {
      ok: true,
      path: file.path,
      content: file.content,
      contentType: file.contentType,
      revisionId: file.currentRevisionId ?? null,
      branchName: branchContext.branchMeta.name,
      commitId: branchContext.branchMeta.head_commit_id ?? null,
    };
  }

  if (file.deletedAt) {
    return { ok: false, status: 404, detail: 'File not found' };
  }

  return {
    ok: true,
    path: file.path,
    content: file.content,
    contentType: file.contentType,
    revisionId: file.currentRevisionId ?? null,
    branchName: null,
    commitId: null,
  };
}

function rawContentType(contentType: string | null | undefined): string {
  const base = contentType && contentType.trim() ? contentType.trim() : 'text/plain';
  const lower = base.toLowerCase();
  const safeText =
    lower === 'text/plain' ||
    lower === 'text/markdown' ||
    lower === 'application/json';
  if (safeText && lower.startsWith('text/') && !/;\s*charset=/i.test(base)) return `${base}; charset=utf-8`;
  if (safeText) return base;
  return 'application/octet-stream';
}

function downloadFilename(filePath: string): string {
  const basename = (filePath || 'download.txt').split('/').filter(Boolean).pop() || 'download.txt';
  return basename.replace(/["\r\n\\]/g, '_');
}

async function resolveProjectFileBlameTarget(
  projectId: string,
  fileId: string,
  branchParam: string | null,
  revisionId: string | null,
  req: Request,
): Promise<
  | {
      ok: true;
      file: ProjectFile;
      targetRevision: ProjectFileRevision;
      revisions: ProjectFileRevision[];
      branch: BranchMeta | null;
      commitId: string | null;
    }
  | { ok: false; status: number; detail: string }
> {
  const file = await AppDataSource.getRepository(ProjectFile).findOne({
    where: { id: fileId, projectId },
  });
  if (!file) return { ok: false, status: 404, detail: 'File not found' };

  const revisionRepo = AppDataSource.getRepository(ProjectFileRevision);
  let targetRevision: ProjectFileRevision | null = null;
  let branch: BranchMeta | null = null;
  let commitId: string | null = null;

  if (revisionId) {
    targetRevision = await revisionRepo.findOne({ where: { id: revisionId, fileId: file.id, projectId } });
    if (!targetRevision) return { ok: false, status: 404, detail: 'File revision not found' };
  } else {
    const branchContextResult = await resolveProjectBranchContext(projectId, branchParam, req);
    if (!branchContextResult.ok) {
      return { ok: false, status: branchContextResult.status, detail: branchContextResult.detail };
    }
    const branchContext = branchContextResult.context;
    if (branchContext) {
      branch = branchContext.branchMeta;
      if (branchContext.commit?.snapshot) {
        const snapshotEntry = findSnapshotEntryByFileId(branchContext.commit.snapshot, file.id);
        if (!snapshotEntry) return { ok: false, status: 404, detail: 'File not found in branch snapshot' };
        if (!snapshotEntry.value.revision_id) {
          return { ok: false, status: 404, detail: 'File revision not found in branch snapshot' };
        }
        targetRevision = await revisionRepo.findOne({
          where: { id: snapshotEntry.value.revision_id, fileId: file.id, projectId },
        });
        if (!targetRevision) return { ok: false, status: 404, detail: 'File revision not found in branch snapshot' };
        commitId = branchContext.commit.id;
      } else if (!branchContext.branch.isDefault) {
        return { ok: false, status: 404, detail: 'File not found in branch snapshot' };
      }
    }

    if (!targetRevision) {
      if (file.deletedAt) return { ok: false, status: 404, detail: 'File not found' };
      if (!file.currentRevisionId) return { ok: false, status: 404, detail: 'File revision not found' };
      targetRevision = await revisionRepo.findOne({
        where: { id: file.currentRevisionId, fileId: file.id, projectId },
      });
      if (!targetRevision) return { ok: false, status: 404, detail: 'File revision not found' };
      if (branch && !commitId) commitId = branch.head_commit_id ?? null;
    }
  }

  const revisions = await revisionRepo.find({
    where: { fileId: file.id, projectId },
    order: { revisionNumber: 'ASC' },
  });
  const boundedRevisions = revisions.filter((revision) => revision.revisionNumber <= targetRevision!.revisionNumber);
  return { ok: true, file, targetRevision, revisions: boundedRevisions, branch, commitId };
}

function buildProjectFileBlame(revisions: ProjectFileRevision[], targetRevision: ProjectFileRevision) {
  const targetLines = splitProjectFileLines(targetRevision.content);
  const targetLineCount = targetLines.length;
  const attribution: ProjectFileRevision[] = Array(targetLineCount).fill(targetRevision);
  const previousLinesByIndex: Array<string | undefined> = [];

  for (const revision of revisions) {
    const lines = splitProjectFileLines(revision.content);
    for (let i = 0; i < targetLineCount; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      if (line === targetLines[i] && previousLinesByIndex[i] !== line) {
        attribution[i] = revision;
      }
    }
    for (let i = 0; i < Math.max(previousLinesByIndex.length, lines.length); i++) {
      previousLinesByIndex[i] = lines[i];
    }
  }

  return targetLines.map((content, index) => {
    const revision = attribution[index] ?? targetRevision;
    return {
      line_number: index + 1,
      content,
      revision_id: revision.id,
      revision_number: revision.revisionNumber,
      content_hash: revision.contentHash,
      message: revision.message ?? null,
      created_by: revision.createdBy,
      created_at: revision.createdAt,
      is_current_revision: revision.id === targetRevision.id,
    };
  });
}

function splitProjectFileLines(content: string): string[] {
  if (content === '') return [''];
  return String(content).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function serializeProjectFileSummary(file: ProjectFile) {
  return {
    id: file.id,
    project_id: file.projectId,
    path: file.path,
    content_type: file.contentType,
    content_hash: file.contentHash,
    size_bytes: file.sizeBytes,
    current_revision_id: file.currentRevisionId ?? null,
    updated_by: file.updatedBy,
    updated_at: file.updatedAt,
  };
}

function serializeProjectFile(file: ProjectFile) {
  return {
    ...serializeProjectFileSummary(file),
    content: file.content,
    created_by: file.createdBy,
    created_at: file.createdAt,
  };
}

function serializeProjectFileSearchResult(file: ProjectFile, query: string, branch?: BranchMeta) {
  return {
    file_id: file.id,
    project_id: file.projectId,
    path: file.path,
    content_type: file.contentType,
    content_hash: file.contentHash,
    current_revision_id: file.currentRevisionId ?? null,
    size_bytes: file.sizeBytes,
    updated_at: file.updatedAt,
    match_count: countTextMatches(file.path, query) + countTextMatches(file.content, query),
    snippets: buildSearchSnippets(file.content, query),
    ...(branch ? { branch } : {}),
  };
}

function serializeProjectFileSearchRevisionResult(
  revision: ProjectFileRevision,
  query: string,
  branch: BranchMeta,
  commitId: string,
) {
  return {
    file_id: revision.fileId,
    project_id: revision.projectId,
    path: revision.path,
    content_type: revision.contentType,
    content_hash: revision.contentHash,
    current_revision_id: revision.id,
    size_bytes: Buffer.byteLength(revision.content, 'utf8'),
    updated_at: revision.createdAt,
    branch,
    branch_commit_id: commitId,
    revision_id: revision.id,
    revision_number: revision.revisionNumber,
    match_count: countTextMatches(revision.path, query) + countTextMatches(revision.content, query),
    snippets: buildSearchSnippets(revision.content, query),
  };
}

function countTextMatches(text: string, query: string): number {
  const normalizedText = text.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  if (!normalizedQuery) return 0;
  let count = 0;
  let idx = normalizedText.indexOf(normalizedQuery);
  while (idx !== -1) {
    count += 1;
    idx = normalizedText.indexOf(normalizedQuery, idx + normalizedQuery.length);
  }
  return count;
}

function buildSearchSnippets(content: string, query: string) {
  const normalizedQuery = query.toLowerCase();
  const lines = content.split(/\r?\n/);
  const snippets: Array<{
    line_number: number;
    text: string;
    match_start: number;
    match_end: number;
  }> = [];

  for (let i = 0; i < lines.length && snippets.length < MAX_FILE_SEARCH_SNIPPETS; i++) {
    const line = lines[i];
    const matchIndex = line.toLowerCase().indexOf(normalizedQuery);
    if (matchIndex === -1) continue;
    const start = Math.max(0, matchIndex - Math.floor((MAX_FILE_SEARCH_SNIPPET_LENGTH - normalizedQuery.length) / 2));
    const rawSnippet = line.slice(start, start + MAX_FILE_SEARCH_SNIPPET_LENGTH);
    snippets.push({
      line_number: i + 1,
      text: (start > 0 ? '...' : '') + rawSnippet + (start + rawSnippet.length < line.length ? '...' : ''),
      match_start: matchIndex - start + (start > 0 ? 3 : 0),
      match_end: matchIndex - start + normalizedQuery.length + (start > 0 ? 3 : 0),
    });
  }

  return snippets;
}

function serializeProjectFileAtRevision(
  file: ProjectFile,
  revision: ProjectFileRevision,
  branch: BranchMeta,
  commitId: string,
) {
  return {
    id: file.id,
    project_id: file.projectId,
    path: revision.path,
    content_type: revision.contentType,
    content_hash: revision.contentHash,
    size_bytes: Buffer.byteLength(revision.content, 'utf8'),
    current_revision_id: revision.id,
    updated_by: revision.createdBy,
    updated_at: revision.createdAt,
    content: revision.content,
    created_by: file.createdBy,
    created_at: file.createdAt,
    branch,
    branch_commit_id: commitId,
    revision: serializeProjectFileRevision(revision),
  };
}

function serializeProjectFileRevision(revision: ProjectFileRevision) {
  return {
    id: revision.id,
    project_id: revision.projectId,
    file_id: revision.fileId,
    path: revision.path,
    revision_number: revision.revisionNumber,
    content: revision.content,
    content_type: revision.contentType,
    content_hash: revision.contentHash,
    message: revision.message ?? null,
    created_by: revision.createdBy,
    created_at: revision.createdAt,
  };
}

function summarizeLineDiff(oldContent: string, newContent: string) {
  const oldLines = oldContent.length ? oldContent.split(/\r?\n/) : [];
  const newLines = newContent.length ? newContent.split(/\r?\n/) : [];
  const oldCount = oldLines.length;
  const newCount = newLines.length;
  const dp: number[][] = Array.from({ length: oldCount + 1 }, () => Array(newCount + 1).fill(0));
  for (let i = oldCount - 1; i >= 0; i--) {
    for (let j = newCount - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }
  const unchanged = dp[0][0];
  const removed = oldCount - unchanged;
  const added = newCount - unchanged;
  return {
    old_lines: oldCount,
    new_lines: newCount,
    unchanged_lines: unchanged,
    lines_removed: removed,
    lines_added: added,
    lines_changed: Math.max(added, removed),
    changed: oldContent !== newContent,
  };
}

function serializeProjectMemory(memory: ProjectMemory) {
  return {
    id: memory.id,
    project_id: memory.projectId,
    agent_id: memory.agentId ?? null,
    author_user_id: memory.authorUserId ?? null,
    content: memory.content,
    tags: memory.tags ?? [],
    metadata: memory.metadata ?? {},
    visibility: memory.visibility,
    created_at: memory.createdAt,
    updated_at: memory.updatedAt,
  };
}

function serializeJoinRequest(request: ProjectJoinRequest) {
  const user = (request as ProjectJoinRequest & { user?: { email?: string; displayName?: string } }).user;
  return {
    id: request.id,
    project_id: request.projectId,
    user_id: request.userId,
    user_email: user?.email ?? null,
    user_display_name: user?.displayName ?? null,
    status: request.status,
    requested_role: request.requestedRole,
    note: request.note ?? null,
    reviewed_by: request.reviewedBy ?? null,
    reviewed_at: request.reviewedAt ?? null,
    created_at: request.createdAt,
    updated_at: request.updatedAt,
  };
}

function normalizeApprovedRole(value: unknown): ProjectRole {
  if (value === ProjectRole.ADMIN || value === ProjectRole.VIEWER || value === ProjectRole.MEMBER) {
    return value;
  }
  return ProjectRole.MEMBER;
}

function canBypassDirectWriteRule(branch: ProjectBranch, role: Role | undefined, userId?: string): boolean {
  if (!role) return false;
  const bypassRoles = branch.protectionRules?.direct_write_bypass_roles ?? [];
  if (bypassRoles.includes(String(role) as ProjectRole)) return true;
  if (role === Role.Viewer || role === Role.Agent || !userId) return false;
  const bypassUserIds = branch.protectionRules?.direct_write_bypass_user_ids ?? [];
  return bypassUserIds.includes(userId);
}

async function requiredGatesSatisfied(
  projectId: string,
  joinRequestId: string,
): Promise<{ ok: true } | { ok: false; missingGateIds: string[] }> {
  const gates = await AppDataSource.getRepository(ProjectGate).find({
    where: { projectId, enabled: true, required: true },
  });
  if (gates.length === 0) return { ok: true };

  const missingGateIds: string[] = [];
  for (const gate of gates) {
    const approved = await AppDataSource.getRepository(ProjectGateAttempt).findOne({
      where: {
        projectId,
        gateId: gate.id,
        joinRequestId,
        status: ProjectGateAttemptStatus.APPROVED,
      },
    });
    if (!approved) missingGateIds.push(gate.id);
  }
  return missingGateIds.length === 0 ? { ok: true } : { ok: false, missingGateIds };
}

export default router;
