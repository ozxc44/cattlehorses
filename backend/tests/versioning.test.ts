import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'versioning-test-secret';

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
    const owner = await register(baseUrl, 'version-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Versioning Test',
      description: 'Project commits and changesets',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const baseFile = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'README.md',
      content: '# Versioning\n\nv1',
      message: 'Initial README',
    });
    assert.equal(baseFile.status, 201);

    const branches = await api(baseUrl, 'GET', `/v1/projects/${projectId}/branches`, owner.token);
    assert.equal(branches.status, 200);
    assert.equal(branches.data.data[0].name, 'main');
    assert.equal(branches.data.data[0].head_commit_id, null);

    const changeset1 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Update README to v2',
      file_ops: [
        {
          op: 'upsert',
          path: 'README.md',
          content: '# Versioning\n\nv2',
          base_revision_id: baseFile.data.current_revision_id,
        },
      ],
    });
    assert.equal(changeset1.status, 201);
    assert.equal(changeset1.data.status, 'submitted');

    const approved1 = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${changeset1.data.id}/review`,
      owner.token,
      { decision: 'approved', notes: 'Looks good.' },
    );
    assert.equal(approved1.status, 200);
    assert.equal(approved1.data.status, 'merge_ready');

    const approvedEdit = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/changesets/${changeset1.data.id}`, owner.token, {
      file_ops: [
        {
          op: 'upsert',
          path: 'README.md',
          content: '# Versioning\n\nunreviewed',
          base_revision_id: baseFile.data.current_revision_id,
        },
      ],
    });
    assert.equal(approvedEdit.status, 409);

    const merged1 = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${changeset1.data.id}/merge`,
      owner.token,
    );
    assert.equal(merged1.status, 200);
    assert.equal(merged1.data.changeset.status, 'merged');
    assert.equal(merged1.data.commit.parent_commit_id, null);
    assert.equal(merged1.data.commit.snapshot['README.md'].content_hash.length, 64);
    assert.ok(merged1.data.commit.snapshot['README.md'].revision_id, 'snapshot must store revision_id');
    assert.ok(merged1.data.commit.snapshot['README.md'].file_id, 'snapshot must store file_id');
    assert.equal(merged1.data.gitea_sync.action, 'skipped', 'gitea sync should be skipped when disabled');
    assert.equal(merged1.data.gitea_sync.projectId, projectId);
    assert.equal(merged1.data.gitea_sync.commitId, merged1.data.commit.id);
    const commit1Id = merged1.data.commit.id;
    const commit1SnapshotRevisionId = merged1.data.commit.snapshot['README.md'].revision_id;
    const commit1SnapshotContentHash = merged1.data.commit.snapshot['README.md'].content_hash;

    const readmeAfterMerge1 = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files/${baseFile.data.id}`, owner.token);
    assert.equal(readmeAfterMerge1.data.content, '# Versioning\n\nv2');
    const revisionAfterMerge1 = readmeAfterMerge1.data.current_revision_id;

    const changesetStale = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Stale README update',
      base_commit_id: commit1Id,
      file_ops: [
        {
          op: 'upsert',
          path: 'README.md',
          content: '# Versioning\n\nstale',
          base_revision_id: revisionAfterMerge1,
        },
      ],
    });
    assert.equal(changesetStale.status, 201);

    const directEdit = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'README.md',
      content: '# Versioning\n\nout-of-band',
      base_revision_id: revisionAfterMerge1,
      message: 'Out of band edit',
    });
    assert.equal(directEdit.status, 200);
    assert.notEqual(directEdit.data.current_revision_id, revisionAfterMerge1, 'out-of-band edit creates new revision');

    // Verify commit snapshot immutability: re-fetch commit1 after the out-of-band edit
    const commit1AfterEdit = await api(baseUrl, 'GET', `/v1/projects/${projectId}/commits/${commit1Id}`, owner.token);
    assert.equal(commit1AfterEdit.status, 200);
    assert.equal(commit1AfterEdit.data.snapshot['README.md'].revision_id, commit1SnapshotRevisionId, 'commit snapshot revision_id must not change after later file edits');
    assert.equal(commit1AfterEdit.data.snapshot['README.md'].content_hash, commit1SnapshotContentHash, 'commit snapshot content_hash must not change after later file edits');

    // Verify file revisions endpoint can retrieve the snapshot revision content
    const fileRevisions = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files/${baseFile.data.id}/revisions`, owner.token);
    assert.equal(fileRevisions.status, 200);
    const snapshotRevision = fileRevisions.data.data.find((r: any) => r.id === commit1SnapshotRevisionId);
    assert.ok(snapshotRevision, 'snapshot revision_id must be retrievable via file revisions endpoint');
    assert.equal(snapshotRevision.content, '# Versioning\n\nv2', 'snapshot revision content must match commit-time content');
    assert.equal(snapshotRevision.content_hash, commit1SnapshotContentHash, 'revision content_hash must match snapshot content_hash');

    const approvedStale = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${changesetStale.data.id}/review`,
      owner.token,
      { decision: 'approved' },
    );
    assert.equal(approvedStale.status, 200);

    const staleMerge = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${changesetStale.data.id}/merge`,
      owner.token,
    );
    assert.equal(staleMerge.status, 409);
    assert.equal(staleMerge.data.changeset.status, 'conflict');
    assert.equal(staleMerge.data.changeset.conflicts[0].reason, 'base_revision_id is stale');

    const conflictFiles = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files?path_prefix=.agent/changesets/${changesetStale.data.id}`, owner.token);
    assert.equal(conflictFiles.status, 200);
    assert.equal(conflictFiles.data.data.some((file: any) => file.path.endsWith('/conflict.md')), true);

    const currentFile = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files/${baseFile.data.id}`, owner.token);
    const changeset2 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Update README to v3',
      base_commit_id: commit1Id,
      file_ops: [
        {
          op: 'upsert',
          path: 'README.md',
          content: '# Versioning\n\nv3',
          base_revision_id: currentFile.data.current_revision_id,
        },
      ],
    });
    assert.equal(changeset2.status, 201);
    const approved2 = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${changeset2.data.id}/review`,
      owner.token,
      { decision: 'approved' },
    );
    assert.equal(approved2.status, 200);
    const merged2 = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${changeset2.data.id}/merge`,
      owner.token,
    );
    assert.equal(merged2.status, 200);
    assert.equal(merged2.data.commit.parent_commit_id, commit1Id);
    assert.equal(merged2.data.gitea_sync.action, 'skipped', 'second merge also includes disabled gitea sync');
    assert.equal(merged2.data.gitea_sync.projectId, projectId);

    const parallelA = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Add notes',
      file_ops: [
        {
          op: 'upsert',
          path: 'notes.md',
          content: '# Notes',
        },
      ],
    });
    assert.equal(parallelA.status, 201);
    const parallelB = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Add tasks',
      file_ops: [
        {
          op: 'upsert',
          path: 'tasks.md',
          content: '# Tasks',
        },
      ],
    });
    assert.equal(parallelB.status, 201);
    assert.equal(parallelA.data.base_commit_id, merged2.data.commit.id);
    assert.equal(parallelB.data.base_commit_id, merged2.data.commit.id);

    const approvedParallelA = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${parallelA.data.id}/review`,
      owner.token,
      { decision: 'approved' },
    );
    assert.equal(approvedParallelA.status, 200);
    const approvedParallelB = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${parallelB.data.id}/review`,
      owner.token,
      { decision: 'approved' },
    );
    assert.equal(approvedParallelB.status, 200);

    const mergedParallelA = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${parallelA.data.id}/merge`,
      owner.token,
    );
    assert.equal(mergedParallelA.status, 200);
    assert.equal(mergedParallelA.data.commit.parent_commit_id, merged2.data.commit.id);

    const staleBranchMerge = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${parallelB.data.id}/merge`,
      owner.token,
    );
    assert.equal(staleBranchMerge.status, 409);
    assert.equal(staleBranchMerge.data.changeset.status, 'conflict');
    assert.equal(staleBranchMerge.data.changeset.conflicts[0].reason, 'branch head has advanced; rebase before merge');

    const rebasedParallelB = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${parallelB.data.id}/rebase`,
      owner.token,
    );
    assert.equal(rebasedParallelB.status, 200);
    assert.equal(rebasedParallelB.data.status, 'submitted');
    assert.equal(rebasedParallelB.data.base_commit_id, mergedParallelA.data.commit.id);
    const reapprovedParallelB = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${parallelB.data.id}/review`,
      owner.token,
      { decision: 'approved' },
    );
    assert.equal(reapprovedParallelB.status, 200);
    const mergedParallelB = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${parallelB.data.id}/merge`,
      owner.token,
    );
    assert.equal(mergedParallelB.status, 200);
    assert.equal(mergedParallelB.data.commit.parent_commit_id, mergedParallelA.data.commit.id);

    const rollback = await api(baseUrl, 'POST', `/v1/projects/${projectId}/rollback`, owner.token, {
      target_commit_id: commit1Id,
      message: 'Restore v2',
    });
    assert.equal(rollback.status, 200);
    assert.equal(rollback.data.commit.parent_commit_id, mergedParallelB.data.commit.id);
    assert.equal(rollback.data.changed_files[0].op, 'restore');

    const readmeAfterRollback = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files/${baseFile.data.id}`, owner.token);
    assert.equal(readmeAfterRollback.data.content, '# Versioning\n\nv2');

    const commits = await api(baseUrl, 'GET', `/v1/projects/${projectId}/commits`, owner.token);
    assert.equal(commits.status, 200);
    assert.equal(commits.data.data.length, 5);

    // --- focused changeset lifecycle / diff / list tests ---
    const summaryFile = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'summary.md',
      content: 'summary base',
      message: 'Summary base',
    });
    assert.equal(summaryFile.status, 201);

    const csDraft = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Draft summary item',
      status: 'draft',
      file_ops: [
        {
          op: 'upsert',
          path: 'summary.md',
          content: 'draft content',
          base_revision_id: summaryFile.data.current_revision_id,
        },
      ],
    });
    assert.equal(csDraft.status, 201);
    assert.equal(csDraft.data.status, 'draft');

    const csChangesRequested = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Needs changes',
      file_ops: [
        {
          op: 'upsert',
          path: 'summary.md',
          content: 'needs work',
          base_revision_id: summaryFile.data.current_revision_id,
        },
      ],
    });
    assert.equal(csChangesRequested.status, 201);

    const requestedReview = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${csChangesRequested.data.id}/review`,
      owner.token,
      { decision: 'changes_requested', notes: 'Please fix' },
    );
    assert.equal(requestedReview.status, 200);
    assert.equal(requestedReview.data.status, 'changes_requested');

    const csUnapproved = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Unapproved merge attempt',
      file_ops: [{ op: 'upsert', path: 'unapproved.md', content: 'unapproved' }],
    });
    assert.equal(csUnapproved.status, 201);

    const csToApprove = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Approve then merge',
      file_ops: [{ op: 'upsert', path: 'approve.md', content: 'approved content' }],
    });
    assert.equal(csToApprove.status, 201);

    const unapprovedMerge = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${csUnapproved.data.id}/merge`,
      owner.token,
    );
    assert.equal(unapprovedMerge.status, 409);
    assert.ok(String(unapprovedMerge.data.detail).toLowerCase().includes('merge_ready'));

    const blockedMerge = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${csChangesRequested.data.id}/merge`,
      owner.token,
    );
    assert.equal(blockedMerge.status, 409);

    const approveCs = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${csToApprove.data.id}/review`,
      owner.token,
      { decision: 'approved' },
    );
    assert.equal(approveCs.status, 200);
    const mergeCs = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${csToApprove.data.id}/merge`,
      owner.token,
    );
    assert.equal(mergeCs.status, 200);
    assert.equal(mergeCs.data.changeset.status, 'merged');

    const reReviewMerged = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${csToApprove.data.id}/review`,
      owner.token,
      { decision: 'approved' },
    );
    assert.equal(reReviewMerged.status, 409);
    const reMergeMerged = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${csToApprove.data.id}/merge`,
      owner.token,
    );
    assert.equal(reMergeMerged.status, 409);

    const listAll = await api(baseUrl, 'GET', `/v1/projects/${projectId}/changesets`, owner.token);
    assert.equal(listAll.status, 200);
    assert.ok(Number.isInteger(listAll.data.total));
    assert.ok(Number.isInteger(listAll.data.limit));
    assert.ok(Number.isInteger(listAll.data.offset));
    assert.ok(listAll.data.summary);
    assert.ok(Number.isInteger(listAll.data.summary.total));
    assert.ok(Number.isInteger(listAll.data.summary.by_status.draft));
    assert.ok(Number.isInteger(listAll.data.summary.by_status.changes_requested));
    assert.ok(listAll.data.summary.by_status.draft >= 1);
    assert.ok(listAll.data.summary.by_status.changes_requested >= 1);

    const listDraft = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/changesets?status=draft`,
      owner.token,
    );
    assert.equal(listDraft.status, 200);
    assert.ok(listDraft.data.data.length >= 1);
    assert.ok(listDraft.data.data.every((c: any) => c.status === 'draft'));

    const listQ = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/changesets?q=Needs%20changes`,
      owner.token,
    );
    assert.equal(listQ.status, 200);
    assert.ok(listQ.data.data.some((c: any) => c.id === csChangesRequested.data.id));

    const listLimit = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/changesets?limit=2`,
      owner.token,
    );
    assert.equal(listLimit.status, 200);
    assert.ok(listLimit.data.data.length <= 2);
    assert.equal(listLimit.data.limit, 2);

    const diff = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/changesets/${csDraft.data.id}/diff`,
      owner.token,
    );
    assert.equal(diff.status, 200);
    assert.equal(diff.data.changeset.id, csDraft.data.id);
    assert.equal(diff.data.files.length, 1);
    assert.equal(diff.data.files[0].op, 'upsert');
    assert.equal(diff.data.files[0].old_content, 'summary base');
    assert.equal(diff.data.files[0].new_content, 'draft content');

    const otherProject = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Other Versioning',
      description: 'Other',
    });
    assert.equal(otherProject.status, 201);
    const diff404 = await api(
      baseUrl,
      'GET',
      `/v1/projects/${otherProject.data.id}/changesets/${csDraft.data.id}/diff`,
      owner.token,
    );
    assert.equal(diff404.status, 404);

    const deleteSeed = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'delete-me.md',
      content: 'delete me',
      message: 'Seed delete target',
    });
    assert.equal(deleteSeed.status, 201);
    const deleteCs = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Delete file through changeset',
      file_ops: [{ op: 'delete', path: 'delete-me.md', base_revision_id: deleteSeed.data.current_revision_id }],
    });
    assert.equal(deleteCs.status, 201);
    const deleteDiff = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/changesets/${deleteCs.data.id}/diff`,
      owner.token,
    );
    assert.equal(deleteDiff.status, 200);
    assert.equal(deleteDiff.data.files[0].op, 'delete');
    assert.equal(deleteDiff.data.files[0].old_content, 'delete me');
    assert.equal(deleteDiff.data.files[0].new_content, null);
    const deleteReview = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${deleteCs.data.id}/review`,
      owner.token,
      { decision: 'approved' },
    );
    assert.equal(deleteReview.status, 200);
    const deleteMerge = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${deleteCs.data.id}/merge`,
      owner.token,
    );
    assert.equal(deleteMerge.status, 200);
    assert.equal(deleteMerge.data.commit.snapshot['delete-me.md'], undefined);
    assert.equal(deleteMerge.data.commit.changed_files[0].op, 'delete');
    const deletedList = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/files?exact_path=delete-me.md`,
      owner.token,
    );
    assert.equal(deletedList.status, 200);
    assert.equal(deletedList.data.total, 0);
    const deletedCurrent = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files/${deleteSeed.data.id}`, owner.token);
    assert.equal(deletedCurrent.status, 404);
    const deletedHistoricalRaw = await fetch(
      `${baseUrl}/v1/projects/${projectId}/files/${deleteSeed.data.id}/raw?revision_id=${deleteSeed.data.current_revision_id}`,
      { headers: { Authorization: `Bearer ${owner.token}` } },
    );
    assert.equal(deletedHistoricalRaw.status, 200);
    assert.equal(await deletedHistoricalRaw.text(), 'delete me');

    const renameSeed = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'old-name.md',
      content: 'rename me',
      message: 'Seed rename target',
    });
    assert.equal(renameSeed.status, 201);
    const renameCs = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Rename file through changeset',
      file_ops: [{
        op: 'rename',
        path: 'old-name.md',
        to_path: 'renamed/new-name.md',
        base_revision_id: renameSeed.data.current_revision_id,
      }],
    });
    assert.equal(renameCs.status, 201);
    const renameDiff = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/changesets/${renameCs.data.id}/diff`,
      owner.token,
    );
    assert.equal(renameDiff.status, 200);
    assert.equal(renameDiff.data.files[0].op, 'rename');
    assert.equal(renameDiff.data.files[0].old_path, 'old-name.md');
    assert.equal(renameDiff.data.files[0].path, 'renamed/new-name.md');
    assert.equal(renameDiff.data.files[0].old_content, 'rename me');
    assert.equal(renameDiff.data.files[0].new_content, 'rename me');
    const renameReview = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${renameCs.data.id}/review`,
      owner.token,
      { decision: 'approved' },
    );
    assert.equal(renameReview.status, 200);
    const renameMerge = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${renameCs.data.id}/merge`,
      owner.token,
    );
    assert.equal(renameMerge.status, 200);
    assert.equal(renameMerge.data.commit.snapshot['old-name.md'], undefined);
    assert.equal(renameMerge.data.commit.snapshot['renamed/new-name.md'].content_hash.length, 64);
    assert.equal(renameMerge.data.commit.changed_files[0].op, 'rename');
    const renamedList = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/files?exact_path=renamed/new-name.md`,
      owner.token,
    );
    assert.equal(renamedList.status, 200);
    assert.equal(renamedList.data.total, 1);
    assert.equal(renamedList.data.data[0].path, 'renamed/new-name.md');
    const oldNameCurrent = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files/${renameSeed.data.id}`, owner.token);
    assert.equal(oldNameCurrent.status, 404);

    const staleDeleteSeed = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'stale-delete.md',
      content: 'stale delete',
      message: 'Seed stale delete target',
    });
    assert.equal(staleDeleteSeed.status, 201);
    const staleDeleteCs = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Stale delete',
      file_ops: [{
        op: 'delete',
        path: 'stale-delete.md',
        base_revision_id: staleDeleteSeed.data.current_revision_id,
      }],
    });
    assert.equal(staleDeleteCs.status, 201);
    const staleDeleteDirectEdit = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'stale-delete.md',
      content: 'edited before delete merge',
      base_revision_id: staleDeleteSeed.data.current_revision_id,
      message: 'Make delete stale',
    });
    assert.equal(staleDeleteDirectEdit.status, 200);
    const staleDeleteReview = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${staleDeleteCs.data.id}/review`,
      owner.token,
      { decision: 'approved' },
    );
    assert.equal(staleDeleteReview.status, 200);
    const staleDeleteMerge = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/changesets/${staleDeleteCs.data.id}/merge`,
      owner.token,
    );
    assert.equal(staleDeleteMerge.status, 409);
    assert.equal(staleDeleteMerge.data.changeset.status, 'conflict');
    assert.equal(staleDeleteMerge.data.changeset.conflicts[0].reason, 'base_revision_id is stale');

    const invalidDeleteCs = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Invalid delete',
      file_ops: [{ op: 'delete', path: 'README.md' }],
    });
    assert.equal(invalidDeleteCs.status, 422);
    const invalidRenameCs = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Invalid rename',
      file_ops: [{
        op: 'rename',
        path: 'README.md',
        to_path: 'README.md',
        base_revision_id: directEdit.data.current_revision_id,
      }],
    });
    assert.equal(invalidRenameCs.status, 422);

    const unsafePathCs = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Unsafe path',
      file_ops: [{ op: 'upsert', path: '../etc/passwd', content: 'x' }],
    });
    assert.equal(unsafePathCs.status, 422);

    console.log('versioning tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'VersioningTest123!',
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
