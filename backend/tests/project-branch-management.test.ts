import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'project-branch-management-test-secret';

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const app = (await import('../src/app')).default;
  await AppDataSource.initialize();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const owner = await register(baseUrl, 'branch-owner');
    const admin = await register(baseUrl, 'branch-admin');
    const member = await register(baseUrl, 'branch-member');
    const viewer = await register(baseUrl, 'branch-viewer');
    const outsider = await register(baseUrl, 'branch-outsider');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Branch Management Test',
      description: 'Project branch management',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const addAdmin = await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: admin.userId,
      role: 'admin',
    });
    assert.equal(addAdmin.status, 201);
    const addViewer = await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: viewer.userId,
      role: 'viewer',
    });
    assert.equal(addViewer.status, 201);
    const addMember = await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: member.userId,
      role: 'member',
    });
    assert.equal(addMember.status, 201);

    const reviewerChangeset = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Request local reviewers',
      file_ops: [{ op: 'upsert', path: 'reviewer-assignment.md', content: 'reviewer assignment' }],
    });
    assert.equal(reviewerChangeset.status, 201);
    assert.equal(reviewerChangeset.data.requested_reviewer_summary?.requested_count, 0);

    const invalidReviewerPayload = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${reviewerChangeset.data.id}/requested-reviewers`,
      owner.token,
      { requested_reviewers: 'not-array' },
    );
    assert.equal(invalidReviewerPayload.status, 422);

    const duplicateReviewer = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${reviewerChangeset.data.id}/requested-reviewers`,
      owner.token,
      { requested_reviewers: [admin.userId, admin.userId] },
    );
    assert.equal(duplicateReviewer.status, 422);

    const outsiderReviewer = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${reviewerChangeset.data.id}/requested-reviewers`,
      owner.token,
      { requested_reviewers: [outsider.userId] },
    );
    assert.equal(outsiderReviewer.status, 422);
    assert.deepEqual(outsiderReviewer.data.missing_reviewer_ids, [outsider.userId]);

    const viewerCannotRequestReviewers = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${reviewerChangeset.data.id}/requested-reviewers`,
      viewer.token,
      { requested_reviewers: [admin.userId] },
    );
    assert.equal(viewerCannotRequestReviewers.status, 403);

    const requestReviewers = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${reviewerChangeset.data.id}/requested-reviewers`,
      owner.token,
      { requested_reviewers: [admin.userId, member.userId] },
    );
    assert.equal(requestReviewers.status, 200);
    assert.equal(requestReviewers.data.requested_reviewer_summary?.requested_count, 2);
    assert.deepEqual(requestReviewers.data.requested_reviewer_summary?.reviewer_ids, [admin.userId, member.userId]);
    assert.equal(requestReviewers.data.review_summary?.current_approvals, 0);
    assert.equal(requestReviewers.data.requested_reviewers?.[0]?.reviewer_type, 'user');
    assert.equal(requestReviewers.data.requested_reviewers?.[0]?.requested_by_user_id, owner.userId);

    const reviewerDetail = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/changesets/${reviewerChangeset.data.id}`,
      viewer.token,
    );
    assert.equal(reviewerDetail.status, 200);
    assert.equal(reviewerDetail.data.requested_reviewer_summary?.requested_count, 2);

    const reviewerList = await api(baseUrl, 'GET', `/v1/projects/${projectId}/changesets?limit=10`, viewer.token);
    assert.equal(reviewerList.status, 200);
    assert.ok(
      reviewerList.data.data.some((row: any) =>
        row.id === reviewerChangeset.data.id &&
        row.requested_reviewer_summary?.requested_count === 2
      ),
      'changeset list should include requested reviewer summary',
    );

    const branches = await listBranches(baseUrl, projectId, owner.token);
    assert.equal(branches.status, 200);
    const main = branches.data.data.find((branch: any) => branch.name === 'main');
    assert.ok(main, 'default branch should exist');
    assert.equal(main.is_default, true, 'main should start as explicit default branch');
    assert.equal(main.is_protected, false, 'main should not need the explicit protection flag');
    assert.equal(main.protection?.is_protected, true, 'default branch should be effectively protected');

    // Seed main with a file so branch compare can observe added/modified/deleted
    // entries from real changeset file_ops.
    const seedChangeset = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Seed compare target',
      file_ops: [{ op: 'upsert', path: 'compare-target.md', content: 'initial compare content' }],
    });
    assert.equal(seedChangeset.status, 201);
    const approveSeed = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${seedChangeset.data.id}/review`,
      owner.token,
      { decision: 'approved', auto_merge: false },
    );
    assert.equal(approveSeed.status, 200);
    const mergeSeed = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${seedChangeset.data.id}/merge`,
      owner.token,
    );
    assert.equal(mergeSeed.status, 200);
    const seedRevisionId = mergeSeed.data.commit.snapshot['compare-target.md']?.revision_id;
    assert.ok(seedRevisionId, 'seed file revision should be in merge commit snapshot');

    const compareFeature = await api(baseUrl, 'POST', `/v1/projects/${projectId}/branches`, owner.token, {
      name: 'feature/compare-delete',
      source_branch: 'main',
    });
    assert.equal(compareFeature.status, 201);
    assert.equal(compareFeature.data.head_commit_id, mergeSeed.data.commit.id);

    const deleteChangeset = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Delete compare target',
      file_ops: [{ op: 'delete', path: 'compare-target.md', base_revision_id: seedRevisionId }],
    });
    assert.equal(deleteChangeset.status, 201);
    const approveDelete = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${deleteChangeset.data.id}/review`,
      owner.token,
      { decision: 'approved', auto_merge: false },
    );
    assert.equal(approveDelete.status, 200);
    const mergeDelete = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${deleteChangeset.data.id}/merge`,
      owner.token,
    );
    assert.equal(mergeDelete.status, 200);

    const deletedCompare = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/branches/compare?base=feature%2Fcompare-delete&head=main`,
      owner.token,
    );
    assert.equal(deletedCompare.status, 200);
    assert.equal(deletedCompare.data.data.summary?.deleted, 1, 'compare should report one deleted file');
    assert.equal(deletedCompare.data.data.summary?.files_changed, 1);
    const deletedFile = deletedCompare.data.data.files?.find((f: any) => f.path === 'compare-target.md');
    assert.ok(deletedFile, 'compare should include a deleted file entry');
    assert.equal(deletedFile.op, 'deleted');
    assert.equal(deletedFile.old_revision_id, seedRevisionId);
    assert.equal(deletedFile.new_revision_id, null);
    assert.equal(deletedFile.new_content, null);
    assert.ok(deletedFile.old_content_hash, 'deleted entry should retain old content hash');

    const addedCompare = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/branches/compare?base=main&head=feature%2Fcompare-delete`,
      owner.token,
    );
    assert.equal(addedCompare.status, 200);
    assert.equal(addedCompare.data.data.summary?.added, 1, 'reverse compare should report one added file');
    const addedFile = addedCompare.data.data.files?.find((f: any) => f.path === 'compare-target.md');
    assert.ok(addedFile, 'reverse compare should include an added file entry');
    assert.equal(addedFile.op, 'added');

    const modifyChangeset = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Modify compare target',
      file_ops: [{ op: 'upsert', path: 'compare-target.md', content: 'modified compare content' }],
    });
    assert.equal(modifyChangeset.status, 201);
    const approveModify = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${modifyChangeset.data.id}/review`,
      owner.token,
      { decision: 'approved', auto_merge: false },
    );
    assert.equal(approveModify.status, 200);
    const mergeModify = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${modifyChangeset.data.id}/merge`,
      owner.token,
    );
    assert.equal(mergeModify.status, 200);

    const modifiedCompare = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/branches/compare?base=feature%2Fcompare-delete&head=main`,
      owner.token,
    );
    assert.equal(modifiedCompare.status, 200);
    assert.equal(modifiedCompare.data.data.summary?.modified, 1, 'compare should report one modified file after re-create');
    assert.equal(modifiedCompare.data.data.summary?.deleted, 0);
    assert.equal(modifiedCompare.data.data.summary?.added, 0);
    const modifiedFile = modifiedCompare.data.data.files?.find((f: any) => f.path === 'compare-target.md');
    assert.ok(modifiedFile, 'compare should include a modified file entry');
    assert.equal(modifiedFile.op, 'modified');
    assert.equal(modifiedFile.old_revision_id, seedRevisionId);
    assert.ok(modifiedFile.new_revision_id, 'modified entry should include the new revision id');

    const renameSeed = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Seed rename compare target',
      file_ops: [{ op: 'upsert', path: 'rename-source.md', content: 'rename compare content' }],
    });
    assert.equal(renameSeed.status, 201);
    const approveRenameSeed = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${renameSeed.data.id}/review`,
      owner.token,
      { decision: 'approved', auto_merge: false },
    );
    assert.equal(approveRenameSeed.status, 200);
    const mergeRenameSeed = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${renameSeed.data.id}/merge`,
      owner.token,
    );
    assert.equal(mergeRenameSeed.status, 200);
    const renameSeedRevisionId = mergeRenameSeed.data.commit.snapshot['rename-source.md']?.revision_id;
    assert.ok(renameSeedRevisionId, 'rename seed revision should be in snapshot');

    const renameFeature = await api(baseUrl, 'POST', `/v1/projects/${projectId}/branches`, owner.token, {
      name: 'feature/compare-rename',
      source_branch: 'main',
    });
    assert.equal(renameFeature.status, 201);

    const renameChangeset = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Rename compare target',
      file_ops: [{
        op: 'rename',
        path: 'rename-source.md',
        to_path: 'renamed/target.md',
        base_revision_id: renameSeedRevisionId,
      }],
    });
    assert.equal(renameChangeset.status, 201);
    const approveRename = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${renameChangeset.data.id}/review`,
      owner.token,
      { decision: 'approved', auto_merge: false },
    );
    assert.equal(approveRename.status, 200);
    const mergeRename = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${renameChangeset.data.id}/merge`,
      owner.token,
    );
    assert.equal(mergeRename.status, 200);

    const renamedCompare = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/branches/compare?base=feature%2Fcompare-rename&head=main`,
      owner.token,
    );
    assert.equal(renamedCompare.status, 200);
    assert.equal(renamedCompare.data.data.summary?.renamed, 1, 'compare should report one renamed file');
    assert.equal(renamedCompare.data.data.summary?.added, 0, 'renamed file should not be counted as added');
    assert.equal(renamedCompare.data.data.summary?.deleted, 0, 'renamed file should not be counted as deleted');
    assert.equal(renamedCompare.data.data.summary?.modified, 0, 'renamed file should not be counted as modified');
    const renamedFile = renamedCompare.data.data.files?.find((f: any) => f.path === 'renamed/target.md');
    assert.ok(renamedFile, 'compare should include renamed destination path');
    assert.equal(renamedFile.op, 'renamed');
    assert.equal(renamedFile.old_path, 'rename-source.md');
    assert.equal(renamedFile.old_revision_id, renameSeedRevisionId);
    assert.ok(renamedFile.new_revision_id, 'renamed entry should include destination revision');
    assert.equal(renamedFile.old_content, 'rename compare content');
    assert.equal(renamedFile.new_content, 'rename compare content');

    const invalidBranch = await api(baseUrl, 'POST', `/v1/projects/${projectId}/branches`, owner.token, {
      name: '../bad',
    });
    assert.equal(invalidBranch.status, 422);

    const created = await api(baseUrl, 'POST', `/v1/projects/${projectId}/branches`, owner.token, {
      name: 'feature/audit-safe',
      source_branch: 'main',
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.name, 'feature/audit-safe');
    const mainBeforeFeature = (await listBranches(baseUrl, projectId, owner.token)).data.data.find(
      (branch: any) => branch.name === 'main',
    );
    assert.ok(mainBeforeFeature, 'main branch should still exist');
    assert.equal(created.data.head_commit_id, mainBeforeFeature.head_commit_id);

    const duplicate = await api(baseUrl, 'POST', `/v1/projects/${projectId}/branches`, owner.token, {
      name: 'feature/audit-safe',
    });
    assert.equal(duplicate.status, 409);

    const renamed = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/branches/${created.data.id}`, admin.token, {
      name: 'feature/renamed',
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.data.name, 'feature/renamed');

    const defaultCandidate = await api(baseUrl, 'POST', `/v1/projects/${projectId}/branches`, owner.token, {
      name: 'release/default-candidate',
      source_branch: 'main',
    });
    assert.equal(defaultCandidate.status, 201);
    assert.equal(defaultCandidate.data.is_default, false);

    const viewerDefault = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/default`,
      viewer.token,
    );
    assert.equal(viewerDefault.status, 403);

    const outsiderProtect = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${renamed.data.id}/protection`,
      outsider.token,
      { is_protected: true },
    );
    assert.equal(outsiderProtect.status, 403);

    const setDefault = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/default`,
      owner.token,
    );
    assert.equal(setDefault.status, 200);
    assert.equal(setDefault.data.is_default, true);
    assert.equal(setDefault.data.protection?.is_protected, true);

    const afterDefaultSwitch = await listBranches(baseUrl, projectId, owner.token);
    const oldMain = afterDefaultSwitch.data.data.find((branch: any) => branch.id === main.id);
    const newDefault = afterDefaultSwitch.data.data.find((branch: any) => branch.id === defaultCandidate.data.id);
    assert.equal(oldMain.is_default, false, 'old default should lose explicit default status');
    assert.equal(newDefault.is_default, true, 'new default should be returned as explicit default');

    const invalidProtectionBody = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${renamed.data.id}/protection`,
      owner.token,
      { is_protected: 'yes' },
    );
    assert.equal(invalidProtectionBody.status, 422);

    const protectDefault = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection`,
      owner.token,
      { is_protected: false },
    );
    assert.equal(protectDefault.status, 409);

    const viewerRules = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      viewer.token,
      { block_direct_writes: true },
    );
    assert.equal(viewerRules.status, 403);

    const memberRules = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      member.token,
      { block_direct_writes: true },
    );
    assert.equal(memberRules.status, 403);

    const outsiderRules = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      outsider.token,
      { block_direct_writes: true },
    );
    assert.equal(outsiderRules.status, 403);

    const invalidRulesBody = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      { block_direct_writes: 'yes' },
    );
    assert.equal(invalidRulesBody.status, 422);

    const invalidBypassRolesBody = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      { block_direct_writes: true, direct_write_bypass_roles: ['viewer'] },
    );
    assert.equal(invalidBypassRolesBody.status, 422);

    const duplicateBypassRolesBody = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      { block_direct_writes: true, direct_write_bypass_roles: ['owner', 'owner'] },
    );
    assert.equal(duplicateBypassRolesBody.status, 422);

    const nonArrayBypassRolesBody = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      { block_direct_writes: true, direct_write_bypass_roles: 'owner' },
    );
    assert.equal(nonArrayBypassRolesBody.status, 422);

    const nonArrayBypassUsersBody = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      { block_direct_writes: true, direct_write_bypass_user_ids: member.userId },
    );
    assert.equal(nonArrayBypassUsersBody.status, 422);

    const duplicateBypassUsersBody = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      { block_direct_writes: true, direct_write_bypass_user_ids: [member.userId, member.userId] },
    );
    assert.equal(duplicateBypassUsersBody.status, 422);

    const viewerBypassUsersBody = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      { block_direct_writes: true, direct_write_bypass_user_ids: [viewer.userId] },
    );
    assert.equal(viewerBypassUsersBody.status, 422);
    assert.deepEqual(viewerBypassUsersBody.data.ineligible_user_ids, [viewer.userId]);

    const outsiderBypassUsersBody = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      { block_direct_writes: true, direct_write_bypass_user_ids: [outsider.userId] },
    );
    assert.equal(outsiderBypassUsersBody.status, 422);
    assert.deepEqual(outsiderBypassUsersBody.data.missing_user_ids, [outsider.userId]);

    const invalidRequiredApprovalsString = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      { block_direct_writes: true, required_approvals: '2' },
    );
    assert.equal(invalidRequiredApprovalsString.status, 422);

    const invalidRequiredApprovalsRange = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      { block_direct_writes: true, required_approvals: 7 },
    );
    assert.equal(invalidRequiredApprovalsRange.status, 422);

    const invalidRequiredStatusChecksBody = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      { block_direct_writes: true, required_status_checks: 'local-smoke' },
    );
    assert.equal(invalidRequiredStatusChecksBody.status, 422);

    const duplicateRequiredStatusChecksBody = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      { block_direct_writes: true, required_status_checks: ['local-smoke', 'LOCAL-SMOKE'] },
    );
    assert.equal(duplicateRequiredStatusChecksBody.status, 422);

    const nonArrayProtectedPatternsBody = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      { block_direct_writes: true, protected_branch_patterns: 'release/*' },
    );
    assert.equal(nonArrayProtectedPatternsBody.status, 422);

    const duplicateProtectedPatternsBody = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      { block_direct_writes: true, protected_branch_patterns: ['release/*', 'release/*'] },
    );
    assert.equal(duplicateProtectedPatternsBody.status, 422);

    const wildcardlessProtectedPatternsBody = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      { block_direct_writes: true, protected_branch_patterns: ['release/stable'] },
    );
    assert.equal(wildcardlessProtectedPatternsBody.status, 422);

    const badCharProtectedPatternsBody = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      { block_direct_writes: true, protected_branch_patterns: ['release/[bad]'] },
    );
    assert.equal(badCharProtectedPatternsBody.status, 422);

    const tooManyProtectedPatternsBody = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      {
        block_direct_writes: true,
        protected_branch_patterns: Array.from({ length: 9 }, (_, i) => `release/${i}*`),
      },
    );
    assert.equal(tooManyProtectedPatternsBody.status, 422);

    const setProtectedPatterns = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      {
        block_direct_writes: true,
        direct_write_bypass_roles: [],
        direct_write_bypass_user_ids: [],
        required_approvals: 0,
        required_status_checks: [],
        protected_branch_patterns: ['release/*'],
      },
    );
    assert.equal(setProtectedPatterns.status, 200);
    assert.deepEqual(setProtectedPatterns.data.protection?.rules?.protected_branch_patterns, ['release/*']);

    const patternBranch = await api(baseUrl, 'POST', `/v1/projects/${projectId}/branches`, owner.token, {
      name: 'release/pattern-target',
      source_branch: 'main',
    });
    assert.equal(patternBranch.status, 201);

    const afterPatternBranch = await listBranches(baseUrl, projectId, owner.token);
    const patternBranchDetail = afterPatternBranch.data.data.find((branch: any) => branch.id === patternBranch.data.id);
    assert.equal(patternBranchDetail.protection?.is_protected, true);
    assert.equal(patternBranchDetail.protection?.is_pattern_protected, true);
    assert.deepEqual(patternBranchDetail.protection?.rules?.protected_branch_patterns, ['release/*']);

    const renamePatternBranch = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${patternBranch.data.id}`,
      owner.token,
      { name: 'release/pattern-renamed' },
    );
    assert.equal(renamePatternBranch.status, 409);

    const deletePatternBranch = await api(
      baseUrl,
      'DELETE',
      `/v1/projects/${projectId}/branches/${patternBranch.data.id}`,
      owner.token,
    );
    assert.equal(deletePatternBranch.status, 409);

    const blockDirectWrites = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      { block_direct_writes: true, required_approvals: 1 },
    );
    assert.equal(blockDirectWrites.status, 200);
    assert.equal(blockDirectWrites.data.protection?.rules?.block_direct_writes, true);
    assert.equal(blockDirectWrites.data.protection?.rules?.required_approvals, 1);

    const directWriteBlocked = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'protected-direct.md',
      content: 'blocked direct write',
      message: 'Attempt direct write',
    });
    assert.equal(directWriteBlocked.status, 409);
    assert.equal(directWriteBlocked.data.rule, 'block_direct_writes');

    const reviewedChangeset = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Reviewed write under branch protection',
      file_ops: [{ op: 'upsert', path: 'protected-review.md', content: 'reviewed write' }],
    });
    assert.equal(reviewedChangeset.status, 201);

    const approveReviewedChangeset = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${reviewedChangeset.data.id}/review`,
      owner.token,
      { decision: 'approved', auto_merge: false },
    );
    assert.equal(approveReviewedChangeset.status, 200);

    const mergeReviewedChangeset = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${reviewedChangeset.data.id}/merge`,
      owner.token,
    );
    assert.equal(mergeReviewedChangeset.status, 200);
    assert.equal(mergeReviewedChangeset.data.changeset.status, 'merged');

    const requireTwoApprovals = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      { block_direct_writes: true, required_approvals: 2 },
    );
    assert.equal(requireTwoApprovals.status, 200);
    assert.equal(requireTwoApprovals.data.protection?.rules?.required_approvals, 2);

    const blockedByRequiredApprovals = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Blocked by required approvals',
      file_ops: [{ op: 'upsert', path: 'requires-two.md', content: 'requires two approvals' }],
    });
    assert.equal(blockedByRequiredApprovals.status, 201);
    const approveBlockedByRequiredApprovals = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${blockedByRequiredApprovals.data.id}/review`,
      owner.token,
      { decision: 'approved', auto_merge: false },
    );
    assert.equal(approveBlockedByRequiredApprovals.status, 200);
    assert.equal(approveBlockedByRequiredApprovals.data.review_summary?.current_approvals, 1);
    assert.equal(approveBlockedByRequiredApprovals.data.review_summary?.approvals_count, 1);
    assert.equal(approveBlockedByRequiredApprovals.data.reviews?.length, 1);

    const duplicateOwnerApproval = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${blockedByRequiredApprovals.data.id}/review`,
      owner.token,
      { decision: 'approved', auto_merge: false, notes: 'Owner updates the existing approval.' },
    );
    assert.equal(duplicateOwnerApproval.status, 200);
    assert.equal(duplicateOwnerApproval.data.review_summary?.current_approvals, 1);
    assert.equal(duplicateOwnerApproval.data.reviews?.length, 1);

    const mergeBlockedByRequiredApprovals = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${blockedByRequiredApprovals.data.id}/merge`,
      owner.token,
    );
    assert.equal(mergeBlockedByRequiredApprovals.status, 409);
    assert.equal(mergeBlockedByRequiredApprovals.data.rule, 'required_approvals');
    assert.equal(mergeBlockedByRequiredApprovals.data.required_approvals, 2);
    assert.equal(mergeBlockedByRequiredApprovals.data.current_approvals, 1);

    const viewerCannotApproveProtectedChangeset = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${blockedByRequiredApprovals.data.id}/review`,
      viewer.token,
      { decision: 'approved', auto_merge: false },
    );
    assert.equal(viewerCannotApproveProtectedChangeset.status, 403);

    const adminSecondApproval = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${blockedByRequiredApprovals.data.id}/review`,
      admin.token,
      { decision: 'approved', auto_merge: false, notes: 'Second distinct approval.' },
    );
    assert.equal(adminSecondApproval.status, 200);
    assert.equal(adminSecondApproval.data.review_summary?.current_approvals, 2);
    assert.equal(adminSecondApproval.data.review_summary?.approvals_count, 2);
    assert.equal(adminSecondApproval.data.reviews?.length, 2);

    const mergeAfterTwoApprovals = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${blockedByRequiredApprovals.data.id}/merge`,
      owner.token,
    );
    assert.equal(mergeAfterTwoApprovals.status, 200);
    assert.equal(mergeAfterTwoApprovals.data.changeset.status, 'merged');
    assert.equal(mergeAfterTwoApprovals.data.changeset.review_summary?.current_approvals, 2);

    const invalidStatusChecksType = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      { block_direct_writes: true, required_status_checks: 'ci' },
    );
    assert.equal(invalidStatusChecksType.status, 422);

    const invalidStatusChecksName = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      { block_direct_writes: true, required_status_checks: ['bad name!'] },
    );
    assert.equal(invalidStatusChecksName.status, 422);

    const duplicateStatusChecks = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      { block_direct_writes: true, required_status_checks: ['ci/lint', 'ci/lint'] },
    );
    assert.equal(duplicateStatusChecks.status, 422);

    const viewerCannotSetRules = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      viewer.token,
      { block_direct_writes: true, required_status_checks: ['ci/lint'] },
    );
    assert.equal(viewerCannotSetRules.status, 403);

    const requireStatusCheck = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      { block_direct_writes: true, required_approvals: 1, required_status_checks: ['local-smoke'] },
    );
    assert.equal(requireStatusCheck.status, 200);
    assert.deepEqual(requireStatusCheck.data.protection?.rules?.required_status_checks, ['local-smoke']);

    const blockedByMissingStatusCheck = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Blocked by required status check',
      file_ops: [{ op: 'upsert', path: 'requires-status-check.md', content: 'requires local status check' }],
    });
    assert.equal(blockedByMissingStatusCheck.status, 201);
    const approveBlockedByStatusCheck = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${blockedByMissingStatusCheck.data.id}/review`,
      owner.token,
      { decision: 'approved', auto_merge: false },
    );
    assert.equal(approveBlockedByStatusCheck.status, 200);

    const viewerCannotRecordStatusCheck = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${blockedByMissingStatusCheck.data.id}/status-checks`,
      viewer.token,
      { name: 'local-smoke', status: 'passed' },
    );
    assert.equal(viewerCannotRecordStatusCheck.status, 403);

    const missingStatusCheckMerge = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${blockedByMissingStatusCheck.data.id}/merge`,
      owner.token,
    );
    assert.equal(missingStatusCheckMerge.status, 409);
    assert.equal(missingStatusCheckMerge.data.rule, 'required_status_checks');
    assert.deepEqual(missingStatusCheckMerge.data.missing_status_checks, ['local-smoke']);

    const failedStatusCheck = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${blockedByMissingStatusCheck.data.id}/status-checks`,
      admin.token,
      { name: 'local-smoke', status: 'failed', summary: 'Local smoke failed' },
    );
    assert.equal(failedStatusCheck.status, 200);
    assert.equal(failedStatusCheck.data.status_check_summary?.failed, 1);
    assert.equal(failedStatusCheck.data.status_checks?.[0]?.status, 'failed');

    const failedStatusCheckMerge = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${blockedByMissingStatusCheck.data.id}/merge`,
      owner.token,
    );
    assert.equal(failedStatusCheckMerge.status, 409);
    assert.deepEqual(failedStatusCheckMerge.data.failed_status_checks, ['local-smoke']);

    const pendingStatusCheck = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${blockedByMissingStatusCheck.data.id}/status-checks`,
      admin.token,
      { name: 'local-smoke', status: 'pending', summary: 'Local smoke running' },
    );
    assert.equal(pendingStatusCheck.status, 200);
    assert.equal(pendingStatusCheck.data.status_check_summary?.pending, 1);

    const pendingStatusCheckMerge = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${blockedByMissingStatusCheck.data.id}/merge`,
      owner.token,
    );
    assert.equal(pendingStatusCheckMerge.status, 409);
    assert.deepEqual(pendingStatusCheckMerge.data.pending_status_checks, ['local-smoke']);

    const passedStatusCheck = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${blockedByMissingStatusCheck.data.id}/status-checks`,
      admin.token,
      { name: 'local-smoke', status: 'passed', summary: 'Local smoke passed' },
    );
    assert.equal(passedStatusCheck.status, 200);
    assert.equal(passedStatusCheck.data.status_check_summary?.passed, 1);

    const mergeAfterStatusCheckPass = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${blockedByMissingStatusCheck.data.id}/merge`,
      owner.token,
    );
    assert.equal(mergeAfterStatusCheckPass.status, 200);
    assert.equal(mergeAfterStatusCheckPass.data.changeset.status, 'merged');
    assert.equal(mergeAfterStatusCheckPass.data.changeset.status_check_summary?.passed, 1);

    const memberUserBypass = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      {
        block_direct_writes: true,
        direct_write_bypass_roles: [],
        direct_write_bypass_user_ids: [member.userId],
        required_approvals: 0,
        required_status_checks: [],
      },
    );
    assert.equal(memberUserBypass.status, 200);
    assert.deepEqual(memberUserBypass.data.protection?.rules?.direct_write_bypass_roles, []);
    assert.deepEqual(memberUserBypass.data.protection?.rules?.direct_write_bypass_user_ids, [member.userId]);

    const memberUserBypassWrite = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, member.token, {
      path: 'member-user-bypass.md',
      content: 'member user bypass write',
      message: 'Member user bypass direct write',
    });
    assert.equal(memberUserBypassWrite.status, 201);

    const adminBlockedByMemberUserOnly = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, admin.token, {
      path: 'admin-blocked-by-member-user-only.md',
      content: 'admin should still be blocked',
      message: 'Admin blocked by member user bypass',
    });
    assert.equal(adminBlockedByMemberUserOnly.status, 409);

    const ownerBypass = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      {
        block_direct_writes: true,
        direct_write_bypass_roles: ['owner'],
        direct_write_bypass_user_ids: [],
        required_approvals: 1,
        required_status_checks: [],
      },
    );
    assert.equal(ownerBypass.status, 200);
    assert.deepEqual(ownerBypass.data.protection?.rules?.direct_write_bypass_roles, ['owner']);
    assert.deepEqual(ownerBypass.data.protection?.rules?.direct_write_bypass_user_ids, []);

    const ownerBypassWrite = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'owner-bypass.md',
      content: 'owner bypass write',
      message: 'Owner bypass direct write',
    });
    assert.equal(ownerBypassWrite.status, 201);

    const adminBlockedByOwnerOnly = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, admin.token, {
      path: 'admin-blocked-by-owner-only.md',
      content: 'admin should still be blocked',
      message: 'Admin blocked by owner-only bypass',
    });
    assert.equal(adminBlockedByOwnerOnly.status, 409);

    const memberBlockedByOwnerOnly = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, member.token, {
      path: 'member-blocked-by-owner-only.md',
      content: 'member should still be blocked',
      message: 'Member blocked by owner-only bypass',
    });
    assert.equal(memberBlockedByOwnerOnly.status, 409);

    const adminBypass = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      { block_direct_writes: true, direct_write_bypass_roles: ['admin'], direct_write_bypass_user_ids: [] },
    );
    assert.equal(adminBypass.status, 200);
    assert.deepEqual(adminBypass.data.protection?.rules?.direct_write_bypass_roles, ['admin']);

    const adminBypassWrite = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, admin.token, {
      path: 'admin-bypass.md',
      content: 'admin bypass write',
      message: 'Admin bypass direct write',
    });
    assert.equal(adminBypassWrite.status, 201);

    const memberBlockedByAdminOnly = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, member.token, {
      path: 'member-blocked-by-admin-only.md',
      content: 'member should still be blocked',
      message: 'Member blocked by admin-only bypass',
    });
    assert.equal(memberBlockedByAdminOnly.status, 409);

    const memberBypass = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      owner.token,
      { block_direct_writes: true, direct_write_bypass_roles: ['member'], direct_write_bypass_user_ids: [] },
    );
    assert.equal(memberBypass.status, 200);
    assert.deepEqual(memberBypass.data.protection?.rules?.direct_write_bypass_roles, ['member']);

    const memberBypassWrite = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, member.token, {
      path: 'member-bypass.md',
      content: 'member bypass write',
      message: 'Member bypass direct write',
    });
    assert.equal(memberBypassWrite.status, 201);

    const viewerCannotDirectWrite = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, viewer.token, {
      path: 'viewer-bypass.md',
      content: 'viewer should never bypass',
      message: 'Viewer direct write attempt',
    });
    assert.equal(viewerCannotDirectWrite.status, 403);

    const unblockDirectWrites = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection-rules`,
      admin.token,
      { block_direct_writes: false },
    );
    assert.equal(unblockDirectWrites.status, 200);
    assert.equal(unblockDirectWrites.data.protection?.rules?.block_direct_writes, false);

    const directWriteAllowed = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'protected-direct.md',
      content: 'direct write restored',
      message: 'Restore direct write',
    });
    assert.equal(directWriteAllowed.status, 201);

    const protectFeature = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${renamed.data.id}/protection`,
      owner.token,
      { is_protected: true },
    );
    assert.equal(protectFeature.status, 200);
    assert.equal(protectFeature.data.is_protected, true);
    assert.equal(protectFeature.data.protection?.is_protected, true);

    const renameProtectedFeature = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${renamed.data.id}`,
      owner.token,
      { name: 'feature/protected-rename' },
    );
    assert.equal(renameProtectedFeature.status, 409);

    const deleteProtectedFeature = await api(
      baseUrl,
      'DELETE',
      `/v1/projects/${projectId}/branches/${renamed.data.id}`,
      owner.token,
    );
    assert.equal(deleteProtectedFeature.status, 409);

    const unprotectFeature = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/branches/${renamed.data.id}/protection`,
      owner.token,
      { is_protected: false },
    );
    assert.equal(unprotectFeature.status, 200);
    assert.equal(unprotectFeature.data.is_protected, false);
    assert.equal(unprotectFeature.data.protection?.is_protected, false);

    const protectRename = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}`, owner.token, {
      name: 'default-renamed',
    });
    assert.equal(protectRename.status, 409);

    const protectDelete = await api(baseUrl, 'DELETE', `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}`, owner.token);
    assert.equal(protectDelete.status, 409);

    const viewerCreate = await api(baseUrl, 'POST', `/v1/projects/${projectId}/branches`, viewer.token, {
      name: 'viewer-branch',
    });
    assert.equal(viewerCreate.status, 403);

    const outsiderList = await listBranches(baseUrl, projectId, outsider.token);
    assert.equal(outsiderList.status, 403);
    const outsiderCreate = await api(baseUrl, 'POST', `/v1/projects/${projectId}/branches`, outsider.token, {
      name: 'outsider-branch',
    });
    assert.equal(outsiderCreate.status, 403);

    const afterRejectedAudit = await listAudit(baseUrl, projectId, owner.token);
    const branchAuditBeforeDelete = afterRejectedAudit.data.data.filter((event: any) =>
      event.action === 'branch_created' ||
      event.action === 'branch_renamed' ||
      event.action === 'branch_deleted' ||
      event.action === 'branch_default_set' ||
      event.action === 'branch_protection_changed',
    );
    assert.equal(branchAuditBeforeDelete.length, 18, 'only successful branch mutations should be audited so far');

    const deleted = await api(baseUrl, 'DELETE', `/v1/projects/${projectId}/branches/${renamed.data.id}`, owner.token);
    assert.equal(deleted.status, 204);

    const afterDelete = await listBranches(baseUrl, projectId, owner.token);
    assert.equal(
      afterDelete.data.data.some((branch: any) => branch.id === renamed.data.id),
      false,
      'deleted branch should no longer be listed',
    );

    const audit = await listAudit(baseUrl, projectId, owner.token);
    const createEvents = audit.data.data.filter((event: any) => event.action === 'branch_created');
    const renameEvent = audit.data.data.find((event: any) =>
      event.action === 'branch_renamed' &&
      event.metadata?.previous_name === 'feature/audit-safe' &&
      event.metadata?.new_name === 'feature/renamed',
    );
    const deleteEvent = audit.data.data.find((event: any) =>
      event.action === 'branch_deleted' && event.metadata?.branch_name === 'feature/renamed',
    );
    const defaultEvent = audit.data.data.find((event: any) =>
      event.action === 'branch_default_set' && event.metadata?.branch_name === 'release/default-candidate',
    );
    const protectionEvents = audit.data.data.filter((event: any) => event.action === 'branch_protection_changed');
    assert.ok(
      createEvents.some((event: any) => event.metadata?.branch_name === 'feature/audit-safe'),
      'branch_created audit event should exist for feature/audit-safe',
    );
    assert.ok(renameEvent, 'branch_renamed audit event should exist');
    assert.ok(deleteEvent, 'branch_deleted audit event should exist');
    assert.ok(defaultEvent, 'branch_default_set audit event should exist');
    assert.equal(protectionEvents.length, 11, 'protection toggles and rule toggles should each be audited');
    assert.ok(
      protectionEvents.some((event: any) =>
        Array.isArray(event.metadata?.direct_write_bypass_roles) &&
        event.metadata.direct_write_bypass_roles.length === 1 &&
        event.metadata.direct_write_bypass_roles[0] === 'member',
      ),
      'branch protection audit should include direct_write_bypass_roles metadata',
    );
    assert.ok(
      protectionEvents.some((event: any) =>
        Array.isArray(event.metadata?.direct_write_bypass_user_ids) &&
        event.metadata.direct_write_bypass_user_ids.length === 1 &&
        event.metadata.direct_write_bypass_user_ids[0] === member.userId,
      ),
      'branch protection audit should include direct_write_bypass_user_ids metadata',
    );
    assert.ok(
      protectionEvents.some((event: any) =>
        Array.isArray(event.metadata?.required_status_checks) &&
        event.metadata.required_status_checks.includes('local-smoke'),
      ),
      'branch protection audit should include required_status_checks metadata',
    );
    assert.ok(
      protectionEvents.some((event: any) =>
        Array.isArray(event.metadata?.protected_branch_patterns) &&
        event.metadata.protected_branch_patterns.includes('release/*'),
      ),
      'branch protection audit should include protected_branch_patterns metadata',
    );
    assert.ok(
      audit.data.data.some((event: any) =>
        event.action === 'changeset_reviewers_requested' &&
        event.metadata?.changeset_id === reviewerChangeset.data.id &&
        Array.isArray(event.metadata?.requested_reviewer_ids) &&
        event.metadata.requested_reviewer_ids.includes(admin.userId) &&
        event.metadata.requested_reviewer_ids.includes(member.userId)
      ),
      'changeset_reviewers_requested audit event should exist',
    );

    console.log('project-branch-management tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

function listBranches(baseUrl: string, projectId: string, token: string): Promise<{ status: number; data: any }> {
  return api(baseUrl, 'GET', `/v1/projects/${projectId}/branches`, token);
}

function listAudit(baseUrl: string, projectId: string, token: string): Promise<{ status: number; data: any }> {
  return api(baseUrl, 'GET', `/v1/projects/${projectId}/audit-events?limit=100`, token);
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'ProjectBranchManagementTest123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return {
    token: response.data.access_token,
    userId: response.data.user.id,
  };
}

async function api(
  baseUrl: string,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
