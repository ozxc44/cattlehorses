import assert from 'node:assert/strict';
import http from 'node:http';
import { MAX_FILE_BYTES } from '../src/routes/project-space.utils';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'project-space-test-secret';

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
    const owner = await register(baseUrl, 'owner');
    const requester = await register(baseUrl, 'requester');
    const viewer = await register(baseUrl, 'viewer');
    const member = await register(baseUrl, 'member');
    const admin = await register(baseUrl, 'admin');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Project Space Test',
      description: 'MD-driven collaboration workspace',
      visibility: 'public',
    });
    assert.equal(project.status, 201);
    assert.equal(project.data.visibility, 'public');

    const file = await api(baseUrl, 'POST', `/v1/projects/${project.data.id}/files`, owner.token, {
      path: 'README.md',
      content: '# Project Space\n\nInitial brief.',
      message: 'Initial project brief',
    });
    assert.equal(file.status, 201);
    assert.equal(file.data.path, 'README.md');
    assert.equal(file.data.revision.revision_number, 1);

    const conflict = await api(baseUrl, 'POST', `/v1/projects/${project.data.id}/files`, owner.token, {
      path: 'README.md',
      content: '# Project Space\n\nConflicting edit.',
      base_revision_id: '00000000-0000-0000-0000-000000000000',
    });
    assert.equal(conflict.status, 409);

    const update = await api(baseUrl, 'POST', `/v1/projects/${project.data.id}/files`, owner.token, {
      path: 'README.md',
      content: '# Project Space\n\nUpdated brief.',
      base_revision_id: file.data.current_revision_id,
      message: 'Update brief',
    });
    assert.equal(update.status, 200);
    assert.equal(update.data.revision.revision_number, 2);

    // ─── Seed deterministic file tree for query tests ────────────────────────
    const seededPaths = [
      'docs/guide.md',
      'docs/api.md',
      'src/main.ts',
      'src/utils.ts',
      'tests/main.test.ts',
    ];
    for (const p of seededPaths) {
      const r = await api(baseUrl, 'POST', `/v1/projects/${project.data.id}/files`, owner.token, {
        path: p,
        content: p === 'src/utils.ts'
          ? 'export function projectSpaceNeedle() {\n  return "LOCAL_CODE_SEARCH_TOKEN";\n}\n'
          : `content of ${p}`,
      });
      assert.equal(r.status, 201, `seed ${p}`);
    }

    const addProjectViewer = await api(baseUrl, 'POST', `/v1/projects/${project.data.id}/members`, owner.token, {
      user_id: viewer.userId,
      role: 'viewer',
    });
    assert.equal(addProjectViewer.status, 201);

    const addProjectMember = await api(baseUrl, 'POST', `/v1/projects/${project.data.id}/members`, owner.token, {
      user_id: member.userId,
      role: 'member',
    });
    assert.equal(addProjectMember.status, 201);

    const addProjectAdmin = await api(baseUrl, 'POST', `/v1/projects/${project.data.id}/members`, owner.token, {
      user_id: admin.userId,
      role: 'admin',
    });
    assert.equal(addProjectAdmin.status, 201);

    // default listing compatible + metadata present
    const defaultList = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files`, owner.token);
    assert.equal(defaultList.status, 200);
    assert(Array.isArray(defaultList.data.data));
    assert.equal(defaultList.data.data.length, seededPaths.length + 1); // includes original README
    assert.equal(defaultList.data.limit, 50);
    assert.equal(defaultList.data.offset, 0);
    assert.equal(defaultList.data.total, seededPaths.length + 1);
    assert.equal(defaultList.data.path_prefix, null);
    // deterministic path sort
    const defaultPaths = defaultList.data.data.map((f: any) => f.path);
    assert.deepEqual(defaultPaths, [...defaultPaths].sort());

    // path_prefix still works
    const docsList = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?path_prefix=docs/`, owner.token);
    assert.equal(docsList.status, 200);
    assert.deepEqual(docsList.data.data.map((f: any) => f.path).sort(), ['docs/api.md', 'docs/guide.md']);
    assert.equal(docsList.data.path_prefix, 'docs/');
    assert.equal(docsList.data.total, 2);

    // pagination returns deterministic path-sorted slices
    const page1 = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?limit=3&offset=0`, owner.token);
    assert.equal(page1.status, 200);
    assert.equal(page1.data.limit, 3);
    assert.equal(page1.data.offset, 0);
    assert.equal(page1.data.data.length, 3);
    assert.deepEqual(page1.data.data.map((f: any) => f.path), defaultPaths.slice(0, 3));

    const page2 = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?limit=3&offset=3`, owner.token);
    assert.equal(page2.status, 200);
    assert.equal(page2.data.data.length, 3);
    assert.deepEqual(page2.data.data.map((f: any) => f.path), defaultPaths.slice(3, 6));

    const emptyPage = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?limit=10&offset=100`, owner.token);
    assert.equal(emptyPage.status, 200);
    assert.deepEqual(emptyPage.data.data, []);
    assert.equal(emptyPage.data.total, seededPaths.length + 1);

    // path search works and is project-scoped
    const searchApi = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?q=api`, owner.token);
    assert.equal(searchApi.status, 200);
    assert.deepEqual(searchApi.data.data.map((f: any) => f.path).sort(), ['docs/api.md']);
    assert.equal(searchApi.data.total, 1);

    const searchMain = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?q=main`, owner.token);
    assert.equal(searchMain.status, 200);
    assert.deepEqual(searchMain.data.data.map((f: any) => f.path).sort(), ['src/main.ts', 'tests/main.test.ts']);

    const searchCaseInsensitive = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?q=API`, owner.token);
    assert.equal(searchCaseInsensitive.status, 200);
    assert.equal(searchCaseInsensitive.data.data.length, 1);
    assert.equal(searchCaseInsensitive.data.data[0].path, 'docs/api.md');

    const codeSearchContent = await api(
      baseUrl,
      'GET',
      `/v1/projects/${project.data.id}/files/search?q=${encodeURIComponent('LOCAL_CODE_SEARCH_TOKEN')}`,
      owner.token,
    );
    assert.equal(codeSearchContent.status, 200);
    assert.equal(codeSearchContent.data.total, 1);
    assert.equal(codeSearchContent.data.data[0].path, 'src/utils.ts');
    assert.equal(codeSearchContent.data.data[0].file_id.length > 0, true);
    assert.equal(codeSearchContent.data.data[0].match_count >= 1, true);
    assert.equal(codeSearchContent.data.data[0].snippets.length, 1);
    assert.equal(codeSearchContent.data.data[0].snippets[0].line_number, 2);
    assert.match(codeSearchContent.data.data[0].snippets[0].text, /LOCAL_CODE_SEARCH_TOKEN/);

    const codeSearchPath = await api(
      baseUrl,
      'GET',
      `/v1/projects/${project.data.id}/files/search?q=${encodeURIComponent('utils')}`,
      owner.token,
    );
    assert.equal(codeSearchPath.status, 200);
    assert.equal(codeSearchPath.data.data.some((f: any) => f.path === 'src/utils.ts'), true);

    const codeSearchViewer = await api(
      baseUrl,
      'GET',
      `/v1/projects/${project.data.id}/files/search?q=${encodeURIComponent('LOCAL_CODE_SEARCH_TOKEN')}`,
      viewer.token,
    );
    assert.equal(codeSearchViewer.status, 200, 'viewer can use local code search');
    assert.equal(codeSearchViewer.data.total, 1);

    const codeSearchOutsider = await api(
      baseUrl,
      'GET',
      `/v1/projects/${project.data.id}/files/search?q=${encodeURIComponent('LOCAL_CODE_SEARCH_TOKEN')}`,
      requester.token,
    );
    assert.equal(codeSearchOutsider.status, 403, 'outsider cannot use local code search');

    const codeSearchNoMatch = await api(
      baseUrl,
      'GET',
      `/v1/projects/${project.data.id}/files/search?q=${encodeURIComponent('NO_MATCH_LOCAL_CODE_SEARCH')}`,
      owner.token,
    );
    assert.equal(codeSearchNoMatch.status, 200);
    assert.equal(codeSearchNoMatch.data.total, 0);
    assert.deepEqual(codeSearchNoMatch.data.data, []);

    const codeSearchTooShort = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files/search?q=x`, owner.token);
    assert.equal(codeSearchTooShort.status, 422);

    const otherProject = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Search Scope Isolation',
    });
    assert.equal(otherProject.status, 201);
    const otherFile = await api(baseUrl, 'POST', `/v1/projects/${otherProject.data.id}/files`, owner.token, {
      path: 'api.md',
      content: 'other project api file',
    });
    assert.equal(otherFile.status, 201);
    const searchOriginal = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?q=api`, owner.token);
    assert.equal(searchOriginal.data.total, 1);
    const searchOther = await api(baseUrl, 'GET', `/v1/projects/${otherProject.data.id}/files?q=api`, owner.token);
    assert.equal(searchOther.data.total, 1);
    assert.equal(searchOther.data.data[0].path, 'api.md');

    // q in children view is also project-scoped (global within the project)
    const childrenSearchOther = await api(baseUrl, 'GET', `/v1/projects/${otherProject.data.id}/files?view=children&q=api`, owner.token);
    assert.equal(childrenSearchOther.status, 200);
    assert.deepEqual(childrenSearchOther.data.files.data.map((f: any) => f.path).sort(), ['api.md']);
    assert.equal(childrenSearchOther.data.files.total, 1);

    // invalid/oversized pagination inputs normalized safely
    const oversized = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?limit=9999`, owner.token);
    assert.equal(oversized.status, 200);
    assert.equal(oversized.data.limit, 200); // clamped to max

    const negativeLimit = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?limit=-5`, owner.token);
    assert.equal(negativeLimit.status, 200);
    assert.equal(negativeLimit.data.limit, 50); // invalid -> default

    const badLimit = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?limit=abc`, owner.token);
    assert.equal(badLimit.status, 200);
    assert.equal(badLimit.data.limit, 50);

    const limitZero = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?limit=0`, owner.token);
    assert.equal(limitZero.status, 200);
    assert.equal(limitZero.data.limit, 50); // invalid/default, not 0

    const hugeOffset = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?offset=999999`, owner.token);
    assert.equal(hugeOffset.status, 200);
    assert.equal(hugeOffset.data.offset, 999999); // large offsets are allowed

    const negativeOffset = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?offset=-10`, owner.token);
    assert.equal(negativeOffset.status, 200);
    assert.equal(negativeOffset.data.offset, 0);

    const badOffset = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?offset=xyz`, owner.token);
    assert.equal(badOffset.status, 200);
    assert.equal(badOffset.data.offset, 0);

    // combined prefix + search + pagination
    const combined = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?path_prefix=src/&q=main&limit=1&offset=0`, owner.token);
    assert.equal(combined.status, 200);
    assert.equal(combined.data.total, 1);
    assert.equal(combined.data.data[0].path, 'src/main.ts');

    // ─── Direct-children view (server-backed directory browser) ───────────────
    // default flat response remains backward-compatible when view is omitted
    assert.equal(defaultList.data.view, undefined, 'default view must not set view field');

    // root children include expected directories and direct files
    const rootChildren = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?view=children`, owner.token);
    assert.equal(rootChildren.status, 200);
    assert.equal(rootChildren.data.view, 'children');
    assert.equal(rootChildren.data.path_prefix, null);
    const rootDirNames = rootChildren.data.directories.map((d: any) => d.name).sort();
    assert.deepEqual(rootDirNames, ['docs', 'src', 'tests']);
    const rootFilePaths = rootChildren.data.files.data.map((f: any) => f.path).sort();
    assert.deepEqual(rootFilePaths, ['README.md']);
    assert.equal(rootChildren.data.files.total, 1);
    assert.ok(rootChildren.data.directories.every((d: any) =>
      typeof d.name === 'string' &&
      typeof d.path === 'string' &&
      typeof d.child_count === 'number' &&
      typeof d.size_bytes === 'number' &&
      (d.latest_updated_at === null || typeof d.latest_updated_at === 'string')
    ));

    // nested prefix children are scoped correctly
    const docsChildren = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?view=children&path_prefix=docs/`, owner.token);
    assert.equal(docsChildren.status, 200);
    assert.equal(docsChildren.data.path_prefix, 'docs/');
    assert.deepEqual(docsChildren.data.directories, []);
    assert.deepEqual(docsChildren.data.files.data.map((f: any) => f.path).sort(), ['docs/api.md', 'docs/guide.md']);
    assert.equal(docsChildren.data.files.total, 2);

    const srcChildren = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?view=children&path_prefix=src`, owner.token);
    assert.equal(srcChildren.status, 200);
    assert.equal(srcChildren.data.path_prefix, 'src/');
    assert.deepEqual(srcChildren.data.directories, []);
    assert.deepEqual(srcChildren.data.files.data.map((f: any) => f.path).sort(), ['src/main.ts', 'src/utils.ts']);

    // q search in children view is global, project-scoped, and returns files only
    const childrenSearch = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?view=children&path_prefix=docs/&q=main`, owner.token);
    assert.equal(childrenSearch.status, 200);
    assert.equal(childrenSearch.data.q, 'main');
    assert.deepEqual(childrenSearch.data.directories, []);
    assert.deepEqual(childrenSearch.data.files.data.map((f: any) => f.path).sort(), ['src/main.ts', 'tests/main.test.ts']);
    assert.equal(childrenSearch.data.files.total, 2);

    // pagination works for direct files in children view
    const childrenPage1 = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?view=children&path_prefix=src/&limit=1&offset=0`, owner.token);
    assert.equal(childrenPage1.status, 200);
    assert.equal(childrenPage1.data.files.limit, 1);
    assert.equal(childrenPage1.data.files.offset, 0);
    assert.equal(childrenPage1.data.files.data.length, 1);
    assert.equal(childrenPage1.data.files.total, 2);

    const childrenPage2 = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?view=children&path_prefix=src/&limit=1&offset=1`, owner.token);
    assert.equal(childrenPage2.status, 200);
    assert.equal(childrenPage2.data.files.data.length, 1);
    assert.notEqual(childrenPage1.data.files.data[0].path, childrenPage2.data.files.data[0].path);

    // wildcard characters in path_prefix are escaped as literals
    const wildcardPaths = ['reports_2024.md', 'reports%cache.md', 'reportsX2024.md'];
    for (const p of wildcardPaths) {
      const r = await api(baseUrl, 'POST', `/v1/projects/${project.data.id}/files`, owner.token, {
        path: p,
        content: `content of ${p}`,
      });
      assert.equal(r.status, 201, `seed wildcard ${p}`);
    }

    const literalUnderscore = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?path_prefix=${encodeURIComponent('reports_')}`, owner.token);
    assert.equal(literalUnderscore.status, 200);
    assert.deepEqual(literalUnderscore.data.data.map((f: any) => f.path).sort(), ['reports_2024.md']);
    assert.equal(literalUnderscore.data.total, 1);

    const literalPercent = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?path_prefix=${encodeURIComponent('reports%')}`, owner.token);
    assert.equal(literalPercent.status, 200);
    assert.deepEqual(literalPercent.data.data.map((f: any) => f.path).sort(), ['reports%cache.md']);
    assert.equal(literalPercent.data.total, 1);

    // combined q + path_prefix with escaped wildcard
    const combinedWildcard = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?path_prefix=${encodeURIComponent('reports_')}&q=2024`, owner.token);
    assert.equal(combinedWildcard.status, 200);
    assert.equal(combinedWildcard.data.total, 1);
    assert.equal(combinedWildcard.data.data[0].path, 'reports_2024.md');

    // ─── Exact-path lookup (artifact link resolver) ───────────────────────────
    // owner exact match returns one file in the standard flat list shape
    const exactMatch = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?exact_path=docs/api.md`, owner.token);
    assert.equal(exactMatch.status, 200);
    assert.equal(exactMatch.data.total, 1);
    assert.equal(exactMatch.data.data.length, 1);
    assert.equal(exactMatch.data.data[0].path, 'docs/api.md');
    assert.equal(exactMatch.data.path_prefix, null);

    // missing path returns empty list
    const exactMissing = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?exact_path=docs/does-not-exist.md`, owner.token);
    assert.equal(exactMissing.status, 200);
    assert.equal(exactMissing.data.total, 0);
    assert.deepEqual(exactMissing.data.data, []);

    // other-project file is not visible through exact_path
    const exactOtherProject = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?exact_path=api.md`, owner.token);
    assert.equal(exactOtherProject.status, 200);
    assert.equal(exactOtherProject.data.total, 0);

    // wildcard characters in exact_path are literal, not SQL wildcards
    const exactWildcardUnderscore = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?exact_path=${encodeURIComponent('reports_2024.md')}`, owner.token);
    assert.equal(exactWildcardUnderscore.status, 200);
    assert.equal(exactWildcardUnderscore.data.total, 1);
    assert.equal(exactWildcardUnderscore.data.data[0].path, 'reports_2024.md');

    const exactWildcardPercent = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?exact_path=${encodeURIComponent('reports%cache.md')}`, owner.token);
    assert.equal(exactWildcardPercent.status, 200);
    assert.equal(exactWildcardPercent.data.total, 1);
    assert.equal(exactWildcardPercent.data.data[0].path, 'reports%cache.md');

    // invalid path returns 422
    const exactInvalid = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?exact_path=../etc/passwd`, owner.token);
    assert.equal(exactInvalid.status, 422);

    // exact_path takes precedence over q/path_prefix/view=children to avoid broad searches
    const exactWithPrefix = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?exact_path=docs/api.md&path_prefix=src/`, owner.token);
    assert.equal(exactWithPrefix.status, 200);
    assert.equal(exactWithPrefix.data.total, 1);
    assert.equal(exactWithPrefix.data.data[0].path, 'docs/api.md');

    const exactWithQ = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?exact_path=docs/api.md&q=main`, owner.token);
    assert.equal(exactWithQ.status, 200);
    assert.equal(exactWithQ.data.total, 1);
    assert.equal(exactWithQ.data.data[0].path, 'docs/api.md');

    const exactWithChildren = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?exact_path=docs/api.md&view=children`, owner.token);
    assert.equal(exactWithChildren.status, 200);
    assert.equal(exactWithChildren.data.total, 1);
    assert.equal(exactWithChildren.data.data[0].path, 'docs/api.md');
    assert.equal(exactWithChildren.data.view, undefined);

    // ─── Branch-scoped file browsing ──────────────────────────────────────────
    // default/no-branch behavior unchanged (no branch param, no branch metadata)
    const noBranchDefault = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files`, owner.token);
    assert.equal(noBranchDefault.status, 200);
    assert.equal(noBranchDefault.data.branch, undefined, 'no branch param means no branch metadata');
    assert.equal(noBranchDefault.data.total, seededPaths.length + 1 + wildcardPaths.length);

    // unknown branch returns 404
    const unknownBranch = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?branch=nonexistent`, owner.token);
    assert.equal(unknownBranch.status, 404);
    assert.match(unknownBranch.data.detail, /Branch not found/);

    // branch=main succeeds and includes branch metadata
    const branchMain = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?branch=main`, owner.token);
    assert.equal(branchMain.status, 200);
    assert.equal(branchMain.data.branch.name, 'main');
    assert.ok(branchMain.data.branch.id, 'branch id present');
    // main has no head_commit_id yet, so falls back to live file table
    assert.equal(branchMain.data.branch.head_commit_id, null);

    // branch=<id> also works
    const branchById = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?branch=${branchMain.data.branch.id}`, owner.token);
    assert.equal(branchById.status, 200);
    assert.equal(branchById.data.branch.id, branchMain.data.branch.id);

    // Create a changeset + commit to give the branch a head_commit_id
    // so we can test snapshot-scoped browsing
    const csTitle = 'Branch scope test commit';
    const cs = await api(baseUrl, 'POST', `/v1/projects/${project.data.id}/changesets`, owner.token, {
      title: csTitle,
      status: 'submitted',
      file_ops: [
        { op: 'upsert', path: 'branch-only.md', content: 'only in branch snapshot' },
      ],
    });
    assert.equal(cs.status, 201);

    // approve
    const reviewCs = await api(baseUrl, 'PATCH', `/v1/projects/${project.data.id}/changesets/${cs.data.id}/review`, owner.token, {
      decision: 'approved', auto_merge: false,
    });
    assert.equal(reviewCs.status, 200);

    // merge
    const mergeCs = await api(baseUrl, 'POST', `/v1/projects/${project.data.id}/changesets/${cs.data.id}/merge`, owner.token);
    assert.equal(mergeCs.status, 200);
    const headCommitId = mergeCs.data.commit.id;

    // Now add a new file AFTER the branch head to prove it's hidden from
    // branch-scoped results but visible in live/default mode
    const afterFile = await api(baseUrl, 'POST', `/v1/projects/${project.data.id}/files`, owner.token, {
      path: 'post-commit-file.md',
      content: 'added after branch head',
    });
    assert.equal(afterFile.status, 201);

    // Live/default mode shows the new file
    const liveAfter = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files`, owner.token);
    const livePaths = liveAfter.data.data.map((f: any) => f.path);
    assert.ok(livePaths.includes('post-commit-file.md'), 'post-commit file visible in live mode');

    // Branch-scoped mode hides it
    const branchAfter = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?branch=main`, owner.token);
    assert.equal(branchAfter.status, 200);
    assert.equal(branchAfter.data.branch.head_commit_id, headCommitId);
    const branchPaths = branchAfter.data.data.map((f: any) => f.path);
    assert.ok(!branchPaths.includes('post-commit-file.md'), 'post-commit file hidden in branch-scoped mode');
    assert.ok(branchPaths.includes('branch-only.md'), 'branch-only file visible in branch-scoped mode');

    // Branch-scoped exact_path: file in snapshot works
    const branchExact = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?branch=main&exact_path=branch-only.md`, owner.token);
    assert.equal(branchExact.status, 200);
    assert.equal(branchExact.data.total, 1);
    assert.equal(branchExact.data.data[0].path, 'branch-only.md');

    // Branch-scoped exact_path: file NOT in snapshot returns empty
    const branchExactMissing = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?branch=main&exact_path=post-commit-file.md`, owner.token);
    assert.equal(branchExactMissing.status, 200);
    assert.equal(branchExactMissing.data.total, 0);
    assert.deepEqual(branchExactMissing.data.data, []);

    // ─── Branch-scoped children view (directory tree browser) ─────────────────
    // Root children scoped to branch snapshot include expected directories and
    // snapshot files, but exclude files added after the branch head.
    const branchRootChildren = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?view=children&branch=main`, owner.token);
    assert.equal(branchRootChildren.status, 200);
    assert.equal(branchRootChildren.data.view, 'children');
    assert.equal(branchRootChildren.data.branch.name, 'main');
    assert.equal(branchRootChildren.data.branch.head_commit_id, headCommitId);
    const branchRootDirNames = branchRootChildren.data.directories.map((d: any) => d.name).sort();
    assert.deepEqual(branchRootDirNames, ['docs', 'src', 'tests']);
    const branchRootFilePaths = branchRootChildren.data.files.data.map((f: any) => f.path).sort();
    assert.ok(branchRootFilePaths.includes('README.md'), 'README.md visible in branch root children');
    assert.ok(branchRootFilePaths.includes('branch-only.md'), 'branch-only.md visible in branch root children');
    assert.ok(!branchRootFilePaths.includes('post-commit-file.md'), 'post-commit file hidden in branch root children');
    assert.ok(branchRootChildren.data.directories.every((d: any) =>
      typeof d.name === 'string' &&
      typeof d.path === 'string' &&
      typeof d.child_count === 'number' &&
      typeof d.size_bytes === 'number'
    ));

    // Nested children scoped to branch snapshot list files under the prefix.
    const branchDocsChildren = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?view=children&path_prefix=docs/&branch=main`, owner.token);
    assert.equal(branchDocsChildren.status, 200);
    assert.equal(branchDocsChildren.data.path_prefix, 'docs/');
    assert.deepEqual(branchDocsChildren.data.directories, []);
    assert.deepEqual(branchDocsChildren.data.files.data.map((f: any) => f.path).sort(), ['docs/api.md', 'docs/guide.md']);

    // Search inside branch-scoped children view is global within the snapshot.
    const branchChildrenSearch = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?view=children&branch=main&q=main`, owner.token);
    assert.equal(branchChildrenSearch.status, 200);
    assert.deepEqual(branchChildrenSearch.data.directories, []);
    const branchSearchPaths = branchChildrenSearch.data.files.data.map((f: any) => f.path).sort();
    assert.ok(branchSearchPaths.includes('src/main.ts'), 'snapshot file matches branch children search');
    assert.ok(!branchSearchPaths.includes('post-commit-file.md'), 'post-commit file hidden from branch children search');

    // ─── Branch-aware file detail ─────────────────────────────────────────────
    // Update README.md AFTER the branch HEAD to prove branch returns the
    // snapshot revision, not the later live content
    const liveUpdate = await api(baseUrl, 'POST', `/v1/projects/${project.data.id}/files`, owner.token, {
      path: 'README.md',
      content: '# Project Space\n\nLive updated after commit.',
      base_revision_id: update.data.current_revision_id,
      message: 'Post-commit live update',
    });
    assert.equal(liveUpdate.status, 200);

    // Live (no branch) returns the latest content
    const fileDetailLive = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files/${file.data.id}`, owner.token);
    assert.equal(fileDetailLive.status, 200);
    assert.equal(fileDetailLive.data.content, '# Project Space\n\nLive updated after commit.');
    assert.equal(fileDetailLive.data.branch, undefined, 'no branch metadata in live mode');

    // Branch=main returns the snapshot revision content, not the live content
    const fileDetailBranch = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files/${file.data.id}?branch=main`, owner.token);
    assert.equal(fileDetailBranch.status, 200);
    assert.equal(fileDetailBranch.data.id, file.data.id);
    assert.equal(fileDetailBranch.data.content, '# Project Space\n\nUpdated brief.', 'branch detail returns snapshot revision content');
    assert.equal(fileDetailBranch.data.current_revision_id, update.data.current_revision_id);
    assert.equal(fileDetailBranch.data.revision.id, update.data.current_revision_id);
    assert.equal(fileDetailBranch.data.revision.revision_number, 2);
    assert.equal(fileDetailBranch.data.branch.name, 'main');
    assert.equal(fileDetailBranch.data.branch.head_commit_id, headCommitId);
    assert.equal(fileDetailBranch.data.branch_commit_id, headCommitId);

    // Branch detail for a file NOT in snapshot returns 404
    const fileDetailMissing = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files/${afterFile.data.id}?branch=main`, owner.token);
    assert.equal(fileDetailMissing.status, 404);

    // Unknown branch returns 404
    const fileDetailUnknown = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files/${file.data.id}?branch=nonexistent`, owner.token);
    assert.equal(fileDetailUnknown.status, 404);
    assert.match(fileDetailUnknown.data.detail, /Branch not found/);

    // ─── Raw/download file content ───────────────────────────────────────────
    const rawLive = await rawApi(baseUrl, `/v1/projects/${project.data.id}/files/${file.data.id}/raw`, owner.token);
    assert.equal(rawLive.status, 200);
    assert.equal(rawLive.raw, '# Project Space\n\nLive updated after commit.');
    assert.match(rawLive.contentType || '', /^text\/markdown/i);
    assert.equal(rawLive.revisionId, liveUpdate.data.current_revision_id);

    const rawDownload = await rawApi(baseUrl, `/v1/projects/${project.data.id}/files/${file.data.id}/raw?download=1`, owner.token);
    assert.equal(rawDownload.status, 200);
    assert.equal(rawDownload.raw, '# Project Space\n\nLive updated after commit.');
    assert.match(rawDownload.contentDisposition || '', /attachment/);
    assert.match(rawDownload.contentDisposition || '', /README\.md/);

    const rawViewer = await rawApi(baseUrl, `/v1/projects/${project.data.id}/files/${file.data.id}/raw`, viewer.token);
    assert.equal(rawViewer.status, 200, 'viewer can raw-read project files');
    assert.equal(rawViewer.raw, '# Project Space\n\nLive updated after commit.');

    const rawOutsider = await rawApi(baseUrl, `/v1/projects/${project.data.id}/files/${file.data.id}/raw`, requester.token);
    assert.equal(rawOutsider.status, 403, 'outsider cannot raw-read project files');
    const rawAnonymous = await rawApi(baseUrl, `/v1/projects/${project.data.id}/files/${file.data.id}/raw`, undefined);
    assert.equal(rawAnonymous.status, 401, 'anonymous cannot raw-read project files');

    const rawBranch = await rawApi(baseUrl, `/v1/projects/${project.data.id}/files/${file.data.id}/raw?branch=main`, owner.token);
    assert.equal(rawBranch.status, 200);
    assert.equal(rawBranch.raw, '# Project Space\n\nUpdated brief.', 'branch raw returns snapshot content, not later live content');
    assert.equal(rawBranch.revisionId, update.data.current_revision_id);
    assert.equal(rawBranch.branch, 'main');
    assert.equal(rawBranch.branchCommitId, headCommitId);

    const rawMissingBranchFile = await rawApi(baseUrl, `/v1/projects/${project.data.id}/files/${afterFile.data.id}/raw?branch=main`, owner.token);
    assert.equal(rawMissingBranchFile.status, 404);
    const rawUnknownBranch = await rawApi(baseUrl, `/v1/projects/${project.data.id}/files/${file.data.id}/raw?branch=nonexistent`, owner.token);
    assert.equal(rawUnknownBranch.status, 404);
    const rawMissingFile = await rawApi(baseUrl, `/v1/projects/${project.data.id}/files/00000000-0000-0000-0000-000000000000/raw`, owner.token);
    assert.equal(rawMissingFile.status, 404);

    const downloadRoute = await rawApi(baseUrl, `/v1/projects/${project.data.id}/files/${file.data.id}/download`, owner.token);
    assert.equal(downloadRoute.status, 200);
    assert.equal(downloadRoute.raw, '# Project Space\n\nLive updated after commit.');
    assert.match(downloadRoute.contentDisposition || '', /attachment/);
    assert.match(downloadRoute.contentDisposition || '', /README\.md/);

    const downloadViewer = await rawApi(baseUrl, `/v1/projects/${project.data.id}/files/${file.data.id}/download`, viewer.token);
    assert.equal(downloadViewer.status, 200, 'viewer can download project files');
    const downloadOutsider = await rawApi(baseUrl, `/v1/projects/${project.data.id}/files/${file.data.id}/download`, requester.token);
    assert.equal(downloadOutsider.status, 403, 'outsider cannot download project files');
    const downloadAnonymous = await rawApi(baseUrl, `/v1/projects/${project.data.id}/files/${file.data.id}/download`, undefined);
    assert.equal(downloadAnonymous.status, 401, 'anonymous cannot download project files');

    // ─── Project archive download (ZIP) ───────────────────────────────────────
    const archiveOwner = await archiveApi(baseUrl, `/v1/projects/${project.data.id}/archive.zip`, owner.token);
    assert.equal(archiveOwner.status, 200, 'owner can download project archive');
    assert.equal(archiveOwner.contentType, 'application/zip');
    assert.match(archiveOwner.contentDisposition || '', /attachment/);
    assert.match(archiveOwner.contentDisposition || '', /\.zip/);
    assert.equal(archiveOwner.buffer.length > 0, true);
    assert.equal(archiveOwner.buffer.readUInt32LE(0), 0x04034b50, 'archive begins with ZIP local file header signature');
    assert.equal(archiveOwner.contentLength, String(archiveOwner.buffer.length));
    assert.equal(bufferContains(archiveOwner.buffer, 'README.md'), true, 'archive contains README.md path entry');
    assert.equal(bufferContains(archiveOwner.buffer, 'src/main.ts'), true, 'archive contains nested file path entry');
    assert.equal(bufferContains(archiveOwner.buffer, '# Project Space\n\nLive updated after commit.'), true, 'archive contains latest live file content');

    const archiveMember = await archiveApi(baseUrl, `/v1/projects/${project.data.id}/archive.zip`, member.token);
    assert.equal(archiveMember.status, 200, 'member can download project archive');

    const archiveViewer = await archiveApi(baseUrl, `/v1/projects/${project.data.id}/archive.zip`, viewer.token);
    assert.equal(archiveViewer.status, 200, 'viewer can download project archive');
    assert.equal(archiveViewer.buffer.readUInt32LE(0), 0x04034b50, 'viewer archive is a valid ZIP');

    const archiveOutsider = await archiveApi(baseUrl, `/v1/projects/${project.data.id}/archive.zip`, requester.token);
    assert.equal(archiveOutsider.status, 403, 'outsider cannot download project archive');

    const archiveAnonymous = await archiveApi(baseUrl, `/v1/projects/${project.data.id}/archive.zip`, undefined);
    assert.equal(archiveAnonymous.status, 401, 'anonymous cannot download project archive');

    // Branch archive uses HEAD snapshot contents, not later live edits.
    const archiveBranch = await archiveApi(baseUrl, `/v1/projects/${project.data.id}/archive.zip?branch=main`, owner.token);
    assert.equal(archiveBranch.status, 200, 'owner can download branch-scoped archive');
    assert.equal(archiveBranch.buffer.readUInt32LE(0), 0x04034b50, 'branch archive is a valid ZIP');
    assert.equal(bufferContains(archiveBranch.buffer, 'branch-only.md'), true, 'branch archive contains snapshot-only file');
    assert.equal(bufferContains(archiveBranch.buffer, 'only in branch snapshot'), true, 'branch archive contains snapshot file content');
    assert.equal(bufferContains(archiveBranch.buffer, 'post-commit-file.md'), false, 'branch archive excludes file added after branch HEAD');
    assert.equal(bufferContains(archiveBranch.buffer, '# Project Space\n\nLive updated after commit.'), false, 'branch archive uses snapshot content, not later live edit');
    assert.equal(bufferContains(archiveBranch.buffer, '# Project Space\n\nUpdated brief.'), true, 'branch archive contains snapshot revision of README.md');
    assert.match(archiveBranch.contentDisposition || '', /main/, 'branch archive filename includes branch slug');

    // Unknown branch returns 404 before producing an archive.
    const archiveUnknownBranch = await archiveApi(baseUrl, `/v1/projects/${project.data.id}/archive.zip?branch=nonexistent`, owner.token);
    assert.equal(archiveUnknownBranch.status, 404);

    // Deleted files are excluded from the live archive.
    const archiveAfterDelete = await archiveApi(baseUrl, `/v1/projects/${project.data.id}/archive.zip`, owner.token);
    assert.equal(archiveAfterDelete.status, 200);
    assert.equal(bufferContains(archiveAfterDelete.buffer, 'ops/renamed.md'), false, 'deleted file is excluded from archive');

    const revisions = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files/${file.data.id}/revisions`, owner.token);
    assert.equal(revisions.status, 200);
    assert.equal(revisions.data.data.length, 3);
    assert.deepEqual(
      revisions.data.data.map((r: any) => r.revision_number),
      [1, 2, 3],
      'file revisions are returned oldest-first by revision number',
    );
    assert.deepEqual(
      revisions.data.data.map((r: any) => r.content),
      [
        '# Project Space\n\nInitial brief.',
        '# Project Space\n\nUpdated brief.',
        '# Project Space\n\nLive updated after commit.',
      ],
      'file revisions preserve historical content instead of returning only latest content',
    );
    assert.equal(revisions.data.data[0].message, 'Initial project brief');
    assert.equal(revisions.data.data[2].message, 'Post-commit live update');
    assert.ok(revisions.data.data[0].content_hash);
    assert.ok(revisions.data.data[0].content_type);

    const blameLive = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files/${file.data.id}/blame`, owner.token);
    assert.equal(blameLive.status, 200);
    assert.equal(blameLive.data.data.blame_model, 'line-content-same-position');
    assert.equal(blameLive.data.data.is_git_blame, false);
    assert.ok(blameLive.data.data.limitations.join(' ').includes('same line number'));
    assert.equal(blameLive.data.data.revision.id, revisions.data.data[2].id);
    assert.deepEqual(
      blameLive.data.data.lines.map((line: any) => line.content),
      ['# Project Space', '', 'Live updated after commit.'],
    );
    assert.equal(blameLive.data.data.lines[0].revision_id, revisions.data.data[0].id, 'unchanged line is attributed to initial revision');
    assert.equal(blameLive.data.data.lines[2].revision_id, revisions.data.data[2].id, 'changed live line is attributed to live revision');
    assert.equal(blameLive.data.data.lines[2].is_current_revision, true);

    const blameBranch = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files/${file.data.id}/blame?branch=main`, owner.token);
    assert.equal(blameBranch.status, 200);
    assert.equal(blameBranch.data.data.branch.name, 'main');
    assert.equal(blameBranch.data.data.branch_commit_id, headCommitId);
    assert.equal(blameBranch.data.data.revision.id, revisions.data.data[1].id);
    assert.deepEqual(
      blameBranch.data.data.lines.map((line: any) => line.content),
      ['# Project Space', '', 'Updated brief.'],
      'branch blame returns snapshot lines, not later live content',
    );
    assert.equal(blameBranch.data.data.lines[0].revision_id, revisions.data.data[0].id);
    assert.equal(blameBranch.data.data.lines[2].revision_id, revisions.data.data[1].id);

    const blameRevision = await api(
      baseUrl,
      'GET',
      `/v1/projects/${project.data.id}/files/${file.data.id}/blame?revision_id=${revisions.data.data[0].id}`,
      owner.token,
    );
    assert.equal(blameRevision.status, 200);
    assert.equal(blameRevision.data.data.revision.id, revisions.data.data[0].id);
    assert.deepEqual(
      blameRevision.data.data.lines.map((line: any) => line.revision_id),
      [revisions.data.data[0].id, revisions.data.data[0].id, revisions.data.data[0].id],
      'historical revision blame is bounded to the requested revision',
    );

    const blameViewer = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files/${file.data.id}/blame`, viewer.token);
    assert.equal(blameViewer.status, 200, 'viewer can read file blame');
    const blameOutsider = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files/${file.data.id}/blame`, requester.token);
    assert.equal(blameOutsider.status, 403, 'outsider cannot read file blame');
    const blameAnonymous = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files/${file.data.id}/blame`, undefined);
    assert.equal(blameAnonymous.status, 401, 'anonymous cannot read file blame');
    const blameMissingBranchFile = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files/${afterFile.data.id}/blame?branch=main`, owner.token);
    assert.equal(blameMissingBranchFile.status, 404);
    const blameUnknownBranch = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files/${file.data.id}/blame?branch=nonexistent`, owner.token);
    assert.equal(blameUnknownBranch.status, 404);
    const blameUnknownRevision = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files/${file.data.id}/blame?revision_id=00000000-0000-0000-0000-000000000000`, owner.token);
    assert.equal(blameUnknownRevision.status, 404);
    const blameUnknownFile = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files/00000000-0000-0000-0000-000000000000/blame`, owner.token);
    assert.equal(blameUnknownFile.status, 404);

    const rawRevision = await rawApi(
      baseUrl,
      `/v1/projects/${project.data.id}/files/${file.data.id}/raw?revision_id=${revisions.data.data[0].id}`,
      owner.token,
    );
    assert.equal(rawRevision.status, 200);
    assert.equal(rawRevision.raw, '# Project Space\n\nInitial brief.', 'raw revision returns exact historical content');
    assert.equal(rawRevision.revisionId, revisions.data.data[0].id);

    const downloadRevision = await rawApi(
      baseUrl,
      `/v1/projects/${project.data.id}/files/${file.data.id}/download?revision_id=${revisions.data.data[0].id}`,
      owner.token,
    );
    assert.equal(downloadRevision.status, 200);
    assert.equal(downloadRevision.raw, '# Project Space\n\nInitial brief.', 'download revision returns exact historical content');
    assert.equal(downloadRevision.revisionId, revisions.data.data[0].id);
    assert.match(downloadRevision.contentDisposition || '', /attachment/);

    const rawForeignRevision = await rawApi(
      baseUrl,
      `/v1/projects/${project.data.id}/files/${file.data.id}/raw?revision_id=00000000-0000-0000-0000-000000000000`,
      owner.token,
    );
    assert.equal(rawForeignRevision.status, 404);

    const anonymousRevisions = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files/${file.data.id}/revisions`, undefined);
    assert.equal(anonymousRevisions.status, 401);

    const privateRevisionProject = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Private Revision Scope',
      visibility: 'private',
    });
    assert.equal(privateRevisionProject.status, 201);
    const privateRevisionFile = await api(baseUrl, 'POST', `/v1/projects/${privateRevisionProject.data.id}/files`, owner.token, {
      path: 'secret.md',
      content: 'private v1',
      message: 'private initial',
    });
    assert.equal(privateRevisionFile.status, 201);
    const privateOutsiderRevisions = await api(baseUrl, 'GET', `/v1/projects/${privateRevisionProject.data.id}/files/${privateRevisionFile.data.id}/revisions`, requester.token);
    assert.equal(privateOutsiderRevisions.status, 403);
    const addViewer = await api(baseUrl, 'POST', `/v1/projects/${privateRevisionProject.data.id}/members`, owner.token, {
      user_id: requester.userId,
      role: 'viewer',
    });
    assert.equal(addViewer.status, 201);
    const privateViewerRevisions = await api(baseUrl, 'GET', `/v1/projects/${privateRevisionProject.data.id}/files/${privateRevisionFile.data.id}/revisions`, requester.token);
    assert.equal(privateViewerRevisions.status, 200);
    assert.equal(privateViewerRevisions.data.data.length, 1);
    assert.equal(privateViewerRevisions.data.data[0].content, 'private v1');

    const revisionCompare = await api(
      baseUrl,
      'GET',
      `/v1/projects/${project.data.id}/files/${file.data.id}/revisions/compare?base_revision_id=${revisions.data.data[0].id}&head_revision_id=${revisions.data.data[2].id}`,
      owner.token,
    );
    assert.equal(revisionCompare.status, 200);
    assert.equal(revisionCompare.data.data.file_id, file.data.id);
    assert.equal(revisionCompare.data.data.base_revision.id, revisions.data.data[0].id);
    assert.equal(revisionCompare.data.data.head_revision.id, revisions.data.data[2].id);
    assert.equal(revisionCompare.data.data.old_content, '# Project Space\n\nInitial brief.');
    assert.equal(revisionCompare.data.data.new_content, '# Project Space\n\nLive updated after commit.');
    assert.equal(revisionCompare.data.data.old_content_hash, revisions.data.data[0].content_hash);
    assert.equal(revisionCompare.data.data.new_content_hash, revisions.data.data[2].content_hash);
    assert.equal(revisionCompare.data.data.summary.changed, true);
    assert.ok(revisionCompare.data.data.summary.lines_added >= 1);
    assert.ok(revisionCompare.data.data.summary.lines_removed >= 1);

    const missingCompareParams = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files/${file.data.id}/revisions/compare`, owner.token);
    assert.equal(missingCompareParams.status, 422);
    const anonymousCompare = await api(
      baseUrl,
      'GET',
      `/v1/projects/${project.data.id}/files/${file.data.id}/revisions/compare?base_revision_id=${revisions.data.data[0].id}&head_revision_id=${revisions.data.data[2].id}`,
      undefined,
    );
    assert.equal(anonymousCompare.status, 401);
    const privateOutsiderCompare = await api(
      baseUrl,
      'GET',
      `/v1/projects/${privateRevisionProject.data.id}/files/${privateRevisionFile.data.id}/revisions/compare?base_revision_id=${privateViewerRevisions.data.data[0].id}&head_revision_id=${privateViewerRevisions.data.data[0].id}`,
      owner.token,
    );
    assert.equal(privateOutsiderCompare.status, 200, 'owner can compare private project revision');
    const privateRequesterCompare = await api(
      baseUrl,
      'GET',
      `/v1/projects/${privateRevisionProject.data.id}/files/${privateRevisionFile.data.id}/revisions/compare?base_revision_id=${privateViewerRevisions.data.data[0].id}&head_revision_id=${privateViewerRevisions.data.data[0].id}`,
      requester.token,
    );
    assert.equal(privateRequesterCompare.status, 200, 'viewer can compare private project revisions');
    const foreignRevisionCompare = await api(
      baseUrl,
      'GET',
      `/v1/projects/${project.data.id}/files/${file.data.id}/revisions/compare?base_revision_id=${revisions.data.data[0].id}&head_revision_id=${privateViewerRevisions.data.data[0].id}`,
      owner.token,
    );
    assert.equal(foreignRevisionCompare.status, 404);
    const unknownRevisionCompare = await api(
      baseUrl,
      'GET',
      `/v1/projects/${project.data.id}/files/${file.data.id}/revisions/compare?base_revision_id=${revisions.data.data[0].id}&head_revision_id=00000000-0000-0000-0000-000000000000`,
      owner.token,
    );
    assert.equal(unknownRevisionCompare.status, 404);

    // ─── Direct file rename and delete operations ─────────────────────────────
    // These mirror the changeset rename/delete semantics but operate directly on
    // the live project file table, with stale-write protection via base_revision_id.

    const opsFile = await api(baseUrl, 'POST', `/v1/projects/${project.data.id}/files`, owner.token, {
      path: 'ops/to-rename.md',
      content: 'rename me',
      message: 'seed rename file',
    });
    assert.equal(opsFile.status, 201);

    const renameTargetFile = await api(baseUrl, 'POST', `/v1/projects/${project.data.id}/files`, owner.token, {
      path: 'ops/exists.md',
      content: 'existing target',
    });
    assert.equal(renameTargetFile.status, 201);

    // project member can rename a file
    const renameOk = await api(baseUrl, 'PATCH', `/v1/projects/${project.data.id}/files/${opsFile.data.id}`, member.token, {
      path: 'ops/renamed.md',
      base_revision_id: opsFile.data.current_revision_id,
      message: 'Renamed by member',
    });
    assert.equal(renameOk.status, 200);
    assert.equal(renameOk.data.path, 'ops/renamed.md');
    assert.equal(renameOk.data.old_path, 'ops/to-rename.md');
    assert.ok(renameOk.data.revision);
    assert.equal(renameOk.data.revision.revision_number, 2);
    assert.equal(renameOk.data.revision.path, 'ops/renamed.md');

    // listing reflects the new path and hides the old path
    const listRenamed = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?exact_path=ops/renamed.md`, owner.token);
    assert.equal(listRenamed.status, 200);
    assert.equal(listRenamed.data.total, 1);

    const listOldPath = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?exact_path=ops/to-rename.md`, owner.token);
    assert.equal(listOldPath.status, 200);
    assert.equal(listOldPath.data.total, 0);

    // rename target path conflict
    const renameTargetConflict = await api(baseUrl, 'PATCH', `/v1/projects/${project.data.id}/files/${renameOk.data.id}`, owner.token, {
      path: 'ops/exists.md',
      base_revision_id: renameOk.data.current_revision_id,
    });
    assert.equal(renameTargetConflict.status, 409);

    // stale base_revision_id on rename
    const renameStale = await api(baseUrl, 'PATCH', `/v1/projects/${project.data.id}/files/${renameOk.data.id}`, owner.token, {
      path: 'ops/stale-rename.md',
      base_revision_id: opsFile.data.current_revision_id,
    });
    assert.equal(renameStale.status, 409);
    assert.equal(renameStale.data.current_revision_id, renameOk.data.current_revision_id);

    // missing base_revision_id on rename
    const renameMissingBase = await api(baseUrl, 'PATCH', `/v1/projects/${project.data.id}/files/${renameOk.data.id}`, owner.token, {
      path: 'ops/missing-base.md',
    });
    assert.equal(renameMissingBase.status, 422);

    // viewer cannot rename
    const viewerRename = await api(baseUrl, 'PATCH', `/v1/projects/${project.data.id}/files/${renameOk.data.id}`, viewer.token, {
      path: 'ops/viewer-rename.md',
      base_revision_id: renameOk.data.current_revision_id,
    });
    assert.equal(viewerRename.status, 403);

    // delete with stale base_revision_id fails
    const deleteStale = await api(baseUrl, 'DELETE', `/v1/projects/${project.data.id}/files/${renameOk.data.id}`, owner.token, {
      base_revision_id: opsFile.data.current_revision_id,
    });
    assert.equal(deleteStale.status, 409);

    // delete success
    const deleteOk = await api(baseUrl, 'DELETE', `/v1/projects/${project.data.id}/files/${renameOk.data.id}`, owner.token, {
      base_revision_id: renameOk.data.current_revision_id,
    });
    assert.equal(deleteOk.status, 200);
    assert.equal(deleteOk.data.id, renameOk.data.id);
    assert.equal(deleteOk.data.path, 'ops/renamed.md');
    assert.ok(deleteOk.data.deleted_at);

    // file detail returns 404 after delete
    const detailAfterDelete = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files/${renameOk.data.id}`, owner.token);
    assert.equal(detailAfterDelete.status, 404);

    // listing excludes deleted file
    const listDeleted = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/files?exact_path=ops/renamed.md`, owner.token);
    assert.equal(listDeleted.status, 200);
    assert.equal(listDeleted.data.total, 0);

    // viewer cannot delete
    const viewerDeleteFile = await api(baseUrl, 'POST', `/v1/projects/${project.data.id}/files`, owner.token, {
      path: 'ops/viewer-delete.md',
      content: 'viewer delete target',
    });
    assert.equal(viewerDeleteFile.status, 201);
    const viewerDelete = await api(baseUrl, 'DELETE', `/v1/projects/${project.data.id}/files/${viewerDeleteFile.data.id}`, viewer.token, {
      base_revision_id: viewerDeleteFile.data.current_revision_id,
    });
    assert.equal(viewerDelete.status, 403);

    // missing base_revision_id on delete
    const deleteMissingBase = await api(baseUrl, 'DELETE', `/v1/projects/${project.data.id}/files/${viewerDeleteFile.data.id}`, owner.token, {});
    assert.equal(deleteMissingBase.status, 422);

    // branch protection block_direct_writes prevents direct rename and delete
    const branches = await api(baseUrl, 'GET', `/v1/projects/${project.data.id}/branches`, owner.token);
    assert.equal(branches.status, 200);
    const defaultBranch = branches.data.data.find((b: any) => b.is_default);
    assert.ok(defaultBranch);

    const blockedFile = await api(baseUrl, 'POST', `/v1/projects/${project.data.id}/files`, owner.token, {
      path: 'ops/blocked.md',
      content: 'blocked target',
    });
    assert.equal(blockedFile.status, 201);

    const protect = await api(baseUrl, 'PATCH', `/v1/projects/${project.data.id}/branches/${defaultBranch.id}/protection-rules`, owner.token, {
      block_direct_writes: true,
    });
    assert.equal(protect.status, 200);

    const renameBlocked = await api(baseUrl, 'PATCH', `/v1/projects/${project.data.id}/files/${blockedFile.data.id}`, owner.token, {
      path: 'ops/blocked-renamed.md',
      base_revision_id: blockedFile.data.current_revision_id,
    });
    assert.equal(renameBlocked.status, 409);
    assert.equal(renameBlocked.data.rule, 'block_direct_writes');

    const deleteBlocked = await api(baseUrl, 'DELETE', `/v1/projects/${project.data.id}/files/${blockedFile.data.id}`, owner.token, {
      base_revision_id: blockedFile.data.current_revision_id,
    });
    assert.equal(deleteBlocked.status, 409);
    assert.equal(deleteBlocked.data.rule, 'block_direct_writes');

    // restore permissive state for remaining tests
    const unprotect = await api(baseUrl, 'PATCH', `/v1/projects/${project.data.id}/branches/${defaultBranch.id}/protection-rules`, owner.token, {
      block_direct_writes: false,
    });
    assert.equal(unprotect.status, 200);

    // ─── Inline editor save semantics (Batch93 D) ─────────────────────────────
    // These use a fresh project so the assertions below do not disturb the
    // clone-count math of the main test project.

    const inlineProject = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Inline Editor Contract',
      visibility: 'private',
    });
    assert.equal(inlineProject.status, 201);

    const addInlineAdmin = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/members`, owner.token, {
      user_id: admin.userId,
      role: 'admin',
    });
    assert.equal(addInlineAdmin.status, 201);

    const addInlineMember = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/members`, owner.token, {
      user_id: member.userId,
      role: 'member',
    });
    assert.equal(addInlineMember.status, 201);

    const addInlineViewer = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/members`, owner.token, {
      user_id: viewer.userId,
      role: 'viewer',
    });
    assert.equal(addInlineViewer.status, 201);

    const inlineFile = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files`, owner.token, {
      path: 'editable.md',
      content: '# initial',
    });
    assert.equal(inlineFile.status, 201);
    const initialRevisionId = inlineFile.data.current_revision_id;
    assert.ok(initialRevisionId);
    assert.equal(inlineFile.data.revision.revision_number, 1);

    // member can update existing file content with current base_revision_id
    const memberUpdate = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files`, member.token, {
      path: 'editable.md',
      content: '# member edit',
      base_revision_id: initialRevisionId,
    });
    assert.equal(memberUpdate.status, 200);
    assert.equal(memberUpdate.data.path, 'editable.md');
    assert.equal(memberUpdate.data.content, '# member edit');
    assert.equal(memberUpdate.data.revision.revision_number, 2);
    assert.ok(memberUpdate.data.revision.id);
    assert.equal(memberUpdate.data.current_revision_id, memberUpdate.data.revision.id);

    // admin can update existing file content
    const adminUpdate = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files`, admin.token, {
      path: 'editable.md',
      content: '# admin edit',
      base_revision_id: memberUpdate.data.current_revision_id,
    });
    assert.equal(adminUpdate.status, 200);
    assert.equal(adminUpdate.data.revision.revision_number, 3);

    // viewer cannot mutate
    const viewerUpdate = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files`, viewer.token, {
      path: 'editable.md',
      content: '# viewer edit',
      base_revision_id: adminUpdate.data.current_revision_id,
    });
    assert.equal(viewerUpdate.status, 403);

    // outsider cannot mutate
    const outsiderUpdate = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files`, requester.token, {
      path: 'editable.md',
      content: '# outsider edit',
      base_revision_id: adminUpdate.data.current_revision_id,
    });
    assert.equal(outsiderUpdate.status, 403);

    // anonymous cannot mutate
    const anonymousUpdate = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files`, undefined, {
      path: 'editable.md',
      content: '# anonymous edit',
      base_revision_id: adminUpdate.data.current_revision_id,
    });
    assert.equal(anonymousUpdate.status, 401);

    // updating an existing file without base_revision_id is rejected
    const missingBase = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files`, owner.token, {
      path: 'editable.md',
      content: '# missing base',
    });
    assert.equal(missingBase.status, 422);

    // stale base_revision_id returns a conflict with the current revision id
    const staleUpdate = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files`, owner.token, {
      path: 'editable.md',
      content: '# stale edit',
      base_revision_id: initialRevisionId,
    });
    assert.equal(staleUpdate.status, 409);
    assert.equal(staleUpdate.data.current_revision_id, adminUpdate.data.current_revision_id);

    // default-branch block_direct_writes prevents direct content updates
    const inlineBranches = await api(baseUrl, 'GET', `/v1/projects/${inlineProject.data.id}/branches`, owner.token);
    assert.equal(inlineBranches.status, 200);
    const inlineDefaultBranch = inlineBranches.data.data.find((b: any) => b.is_default);
    assert.ok(inlineDefaultBranch);

    const protectInline = await api(baseUrl, 'PATCH', `/v1/projects/${inlineProject.data.id}/branches/${inlineDefaultBranch.id}/protection-rules`, owner.token, {
      block_direct_writes: true,
    });
    assert.equal(protectInline.status, 200);

    const blockedUpdate = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files`, owner.token, {
      path: 'editable.md',
      content: '# blocked edit',
      base_revision_id: adminUpdate.data.current_revision_id,
    });
    assert.equal(blockedUpdate.status, 409);
    assert.equal(blockedUpdate.data.rule, 'block_direct_writes');

    // bypass by role allows update despite block_direct_writes
    const bypassRoleProtect = await api(baseUrl, 'PATCH', `/v1/projects/${inlineProject.data.id}/branches/${inlineDefaultBranch.id}/protection-rules`, owner.token, {
      block_direct_writes: true,
      direct_write_bypass_roles: ['member'],
    });
    assert.equal(bypassRoleProtect.status, 200);

    const memberBypassUpdate = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files`, member.token, {
      path: 'editable.md',
      content: '# bypass role edit',
      base_revision_id: adminUpdate.data.current_revision_id,
    });
    assert.equal(memberBypassUpdate.status, 200);
    assert.equal(memberBypassUpdate.data.revision.revision_number, 4);

    // bypass by user id allows update despite block_direct_writes
    const bypassUserProtect = await api(baseUrl, 'PATCH', `/v1/projects/${inlineProject.data.id}/branches/${inlineDefaultBranch.id}/protection-rules`, owner.token, {
      block_direct_writes: true,
      direct_write_bypass_roles: [],
      direct_write_bypass_user_ids: [owner.userId],
    });
    assert.equal(bypassUserProtect.status, 200);

    const ownerBypassUpdate = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files`, owner.token, {
      path: 'editable.md',
      content: '# bypass user edit',
      base_revision_id: memberBypassUpdate.data.current_revision_id,
    });
    assert.equal(ownerBypassUpdate.status, 200);
    assert.equal(ownerBypassUpdate.data.revision.revision_number, 5);

    // restore permissive state
    const unprotectInline = await api(baseUrl, 'PATCH', `/v1/projects/${inlineProject.data.id}/branches/${inlineDefaultBranch.id}/protection-rules`, owner.token, {
      block_direct_writes: false,
    });
    assert.equal(unprotectInline.status, 200);

    // ─── Batch file upload (Batch97D) ─────────────────────────────────────────
    // Uses the inline project which already has owner/member/viewer/admin members.

    const uploadText = 'uploaded text content\nwith unicode: 你好';
    const uploadBase64 = Buffer.from(uploadText).toString('base64');

    // owner can upload a single file
    const ownerUpload = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files/upload`, owner.token, {
      files: [{ path: 'uploads/owner.txt', content_base64: uploadBase64, content_type: 'text/plain', message: 'Owner upload' }],
    });
    assert.equal(ownerUpload.status, 201);
    assert.equal(ownerUpload.data.data.length, 1);
    assert.equal(ownerUpload.data.data[0].path, 'uploads/owner.txt');
    assert.equal(ownerUpload.data.data[0].content_type, 'text/plain');
    assert.equal(ownerUpload.data.data[0].size_bytes, Buffer.byteLength(uploadText, 'utf8'));
    assert.equal(ownerUpload.data.data[0].revision.revision_number, 1);
    assert.ok(ownerUpload.data.data[0].content_hash);

    // member can upload multiple files
    const memberUpload = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files/upload`, member.token, {
      files: [
        { path: 'uploads/member-a.md', content_base64: Buffer.from('# A').toString('base64'), content_type: 'text/markdown' },
        { path: 'uploads/member-b.json', content_base64: Buffer.from('{"key":"value"}').toString('base64'), content_type: 'application/json' },
      ],
      message: 'Member batch upload',
    });
    assert.equal(memberUpload.status, 201);
    assert.equal(memberUpload.data.data.length, 2);
    assert.equal(memberUpload.data.data[0].path, 'uploads/member-a.md');
    assert.equal(memberUpload.data.data[1].path, 'uploads/member-b.json');

    // raw returns uploaded text with correct content type
    const uploadRaw = await rawApi(baseUrl, `/v1/projects/${inlineProject.data.id}/files/${ownerUpload.data.data[0].id}/raw`, owner.token);
    assert.equal(uploadRaw.status, 200);
    assert.equal(uploadRaw.raw, uploadText);
    assert.match(uploadRaw.contentType || '', /^text\/plain/);

    // download returns uploaded content as attachment
    const uploadDownload = await rawApi(baseUrl, `/v1/projects/${inlineProject.data.id}/files/${ownerUpload.data.data[0].id}/download`, owner.token);
    assert.equal(uploadDownload.status, 200);
    assert.equal(uploadDownload.raw, uploadText);
    assert.match(uploadDownload.contentDisposition || '', /attachment/);
    assert.match(uploadDownload.contentDisposition || '', /owner\.txt/);

    // viewer cannot upload
    const viewerUpload = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files/upload`, viewer.token, {
      files: [{ path: 'uploads/viewer.txt', content_base64: Buffer.from('x').toString('base64') }],
    });
    assert.equal(viewerUpload.status, 403);

    // outsider cannot upload
    const outsiderUpload = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files/upload`, requester.token, {
      files: [{ path: 'uploads/outsider.txt', content_base64: Buffer.from('x').toString('base64') }],
    });
    assert.equal(outsiderUpload.status, 403);

    // anonymous cannot upload
    const anonymousUpload = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files/upload`, undefined, {
      files: [{ path: 'uploads/anon.txt', content_base64: Buffer.from('x').toString('base64') }],
    });
    assert.equal(anonymousUpload.status, 401);

    // missing/empty files array
    const missingFiles = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files/upload`, owner.token, { files: [] });
    assert.equal(missingFiles.status, 422);

    // empty path
    const emptyPath = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files/upload`, owner.token, {
      files: [{ path: '', content_base64: Buffer.from('x').toString('base64') }],
    });
    assert.equal(emptyPath.status, 422);

    // unsafe path
    const unsafePath = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files/upload`, owner.token, {
      files: [{ path: '../etc/passwd', content_base64: Buffer.from('x').toString('base64') }],
    });
    assert.equal(unsafePath.status, 422);

    // malformed base64
    const malformedBase64 = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files/upload`, owner.token, {
      files: [{ path: 'uploads/bad64.txt', content_base64: '!!!not-base64!!!' }],
    });
    assert.equal(malformedBase64.status, 422);

    // duplicate path in batch
    const duplicateInBatch = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files/upload`, owner.token, {
      files: [
        { path: 'uploads/dup.txt', content_base64: Buffer.from('a').toString('base64') },
        { path: 'uploads/dup.txt', content_base64: Buffer.from('b').toString('base64') },
      ],
    });
    assert.equal(duplicateInBatch.status, 422);

    // duplicate path without base_revision_id rejected
    const duplicateNoBase = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files/upload`, owner.token, {
      files: [{ path: 'uploads/owner.txt', content_base64: Buffer.from('new').toString('base64') }],
    });
    assert.equal(duplicateNoBase.status, 422);

    // overwrite success
    const overwriteText = 'overwritten content';
    const overwriteUpload = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files/upload`, owner.token, {
      files: [{ path: 'uploads/owner.txt', content_base64: Buffer.from(overwriteText).toString('base64'), content_type: 'text/plain', base_revision_id: ownerUpload.data.data[0].current_revision_id, message: 'Overwrite' }],
    });
    assert.equal(overwriteUpload.status, 201);
    assert.equal(overwriteUpload.data.data[0].revision.revision_number, 2);

    const overwriteRaw = await rawApi(baseUrl, `/v1/projects/${inlineProject.data.id}/files/${ownerUpload.data.data[0].id}/raw`, owner.token);
    assert.equal(overwriteRaw.status, 200);
    assert.equal(overwriteRaw.raw, overwriteText);

    // overwrite with stale base_revision_id
    const staleOverwrite = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files/upload`, owner.token, {
      files: [{ path: 'uploads/owner.txt', content_base64: Buffer.from('stale').toString('base64'), base_revision_id: ownerUpload.data.data[0].current_revision_id }],
    });
    assert.equal(staleOverwrite.status, 409);
    assert.equal(staleOverwrite.data.current_revision_id, overwriteUpload.data.data[0].current_revision_id);

    // oversized payload
    const oversizedBase64 = Buffer.alloc(MAX_FILE_BYTES + 1).toString('base64');
    const oversizedUpload = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files/upload`, owner.token, {
      files: [{ path: 'uploads/huge.txt', content_base64: oversizedBase64 }],
    });
    assert.equal(oversizedUpload.status, 413);

    // branch protection blocks upload
    const protectUpload = await api(baseUrl, 'PATCH', `/v1/projects/${inlineProject.data.id}/branches/${inlineDefaultBranch.id}/protection-rules`, owner.token, {
      block_direct_writes: true,
      direct_write_bypass_user_ids: [],
    });
    assert.equal(protectUpload.status, 200);

    const blockedUpload = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files/upload`, owner.token, {
      files: [{ path: 'uploads/blocked.txt', content_base64: Buffer.from('blocked').toString('base64') }],
    });
    assert.equal(blockedUpload.status, 409);
    assert.equal(blockedUpload.data.rule, 'block_direct_writes');

    // restore permissive state
    const unprotectUpload = await api(baseUrl, 'PATCH', `/v1/projects/${inlineProject.data.id}/branches/${inlineDefaultBranch.id}/protection-rules`, owner.token, {
      block_direct_writes: false,
    });
    assert.equal(unprotectUpload.status, 200);

    // binary upload round-trips through raw/download
    const binaryBytes = Buffer.from([0x00, 0x01, 0xff, 0xfe]);
    const binaryBase64 = binaryBytes.toString('base64');
    const binaryUpload = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files/upload`, owner.token, {
      files: [{ path: 'uploads/binary.bin', content_base64: binaryBase64, content_type: 'application/octet-stream' }],
    });
    assert.equal(binaryUpload.status, 201);
    assert.equal(binaryUpload.data.data[0].size_bytes, binaryBytes.length);
    assert.equal(binaryUpload.data.data[0].content.includes('\u0000'), false, 'binary upload is stored as text-safe base64');

    const binaryRaw = await archiveApi(baseUrl, `/v1/projects/${inlineProject.data.id}/files/${binaryUpload.data.data[0].id}/raw`, owner.token);
    assert.equal(binaryRaw.status, 200);
    assert.ok(binaryRaw.buffer.equals(binaryBytes), 'binary upload round-trips bytes exactly');
    assert.equal(binaryRaw.contentType, 'application/octet-stream');
    assert.equal(binaryRaw.noSniff, 'nosniff');

    const binaryDownload = await archiveApi(baseUrl, `/v1/projects/${inlineProject.data.id}/files/${binaryUpload.data.data[0].id}/download`, owner.token);
    assert.equal(binaryDownload.status, 200);
    assert.ok(binaryDownload.buffer.equals(binaryBytes), 'binary download round-trips bytes exactly');
    assert.match(binaryDownload.contentDisposition || '', /binary\.bin/);
    assert.equal(binaryDownload.noSniff, 'nosniff');

    // empty file upload is allowed and round-trips as an empty raw body
    const emptyUpload = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files/upload`, owner.token, {
      files: [{ path: 'uploads/empty.bin', content_base64: '', content_type: 'application/octet-stream' }],
    });
    assert.equal(emptyUpload.status, 201);
    assert.equal(emptyUpload.data.data[0].size_bytes, 0);
    const emptyRaw = await archiveApi(baseUrl, `/v1/projects/${inlineProject.data.id}/files/${emptyUpload.data.data[0].id}/raw`, owner.token);
    assert.equal(emptyRaw.status, 200);
    assert.equal(emptyRaw.buffer.length, 0);

    // active content types are served as octet-stream, not executable inline MIME
    const activeUpload = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files/upload`, owner.token, {
      files: [{ path: 'uploads/active.html', content_base64: Buffer.from('<script>alert(1)</script>').toString('base64'), content_type: 'text/html' }],
    });
    assert.equal(activeUpload.status, 201);
    const activeRaw = await rawApi(baseUrl, `/v1/projects/${inlineProject.data.id}/files/${activeUpload.data.data[0].id}/raw`, owner.token);
    assert.equal(activeRaw.status, 200);
    assert.equal(activeRaw.contentType, 'application/octet-stream');
    assert.equal(activeRaw.noSniff, 'nosniff');

    // branch snapshot browsing is not silently mutated by direct live-file updates
    const snapshotFile = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files`, owner.token, {
      path: 'snapshot.md',
      content: '# snapshot v1',
    });
    assert.equal(snapshotFile.status, 201);

    const snapshotCs = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets`, owner.token, {
      title: 'Snapshot commit',
      status: 'submitted',
      file_ops: [
        { op: 'upsert', path: 'snapshot.md', content: '# snapshot v1', base_revision_id: snapshotFile.data.current_revision_id },
      ],
    });
    assert.equal(snapshotCs.status, 201);

    const snapshotReview = await api(baseUrl, 'PATCH', `/v1/projects/${inlineProject.data.id}/changesets/${snapshotCs.data.id}/review`, owner.token, {
      decision: 'approved', auto_merge: false,
    });
    assert.equal(snapshotReview.status, 200);

    const snapshotMerge = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${snapshotCs.data.id}/merge`, owner.token);
    assert.equal(snapshotMerge.status, 200);
    const snapshotCommitId = snapshotMerge.data.commit.id;
    const snapshotRevisionId = snapshotMerge.data.commit.snapshot['snapshot.md'].revision_id;

    const liveEditAfterCommit = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/files`, owner.token, {
      path: 'snapshot.md',
      content: '# snapshot v2 live',
      base_revision_id: snapshotRevisionId,
    });
    assert.equal(liveEditAfterCommit.status, 200);

    const branchDetailAfterLiveEdit = await api(baseUrl, 'GET', `/v1/projects/${inlineProject.data.id}/files/${snapshotFile.data.id}?branch=main`, owner.token);
    assert.equal(branchDetailAfterLiveEdit.status, 200);
    assert.equal(branchDetailAfterLiveEdit.data.content, '# snapshot v1', 'branch snapshot remains immutable after direct live edit');
    assert.equal(branchDetailAfterLiveEdit.data.branch.head_commit_id, snapshotCommitId);
    assert.equal(branchDetailAfterLiveEdit.data.branch_commit_id, snapshotCommitId);
    assert.equal(branchDetailAfterLiveEdit.data.current_revision_id, snapshotRevisionId);
    assert.equal(branchDetailAfterLiveEdit.data.revision.id, snapshotRevisionId);

    // ─── Changeset review comments (Batch99-D) ────────────────────────────────
    // Uses the inline project which already has owner/member/viewer/admin members.

    const inlineChangeset = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets`, owner.token, {
      title: 'Comment target changeset',
      file_ops: [
        { op: 'upsert', path: 'comment-target.md', content: '# line 1\n# line 2\n# line 3\n' },
      ],
    });
    assert.equal(inlineChangeset.status, 201);
    const inlineChangesetId = inlineChangeset.data.id;

    // general comment by owner
    const ownerGeneralComment = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, owner.token, {
      content: 'General feedback on the approach.',
    });
    assert.equal(ownerGeneralComment.status, 201);
    assert.equal(ownerGeneralComment.data.content, 'General feedback on the approach.');
    assert.equal(ownerGeneralComment.data.author_type, 'user');
    assert.equal(ownerGeneralComment.data.author_id, owner.userId);
    assert.equal(ownerGeneralComment.data.file_path, null);
    assert.equal(ownerGeneralComment.data.status, 'active');

    // file/line anchored comment by member (uses snapshot.md revisions that exist in this project)
    const memberFileComment = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, member.token, {
      content: 'This line looks off.',
      file_path: 'snapshot.md',
      side: 'head',
      line: 2,
      base_revision_id: snapshotRevisionId,
      head_revision_id: liveEditAfterCommit.data.current_revision_id,
    });
    assert.equal(memberFileComment.status, 201);
    assert.equal(memberFileComment.data.file_path, 'snapshot.md');
    assert.equal(memberFileComment.data.side, 'head');
    assert.equal(memberFileComment.data.line, 2);
    assert.equal(memberFileComment.data.base_revision_id, snapshotRevisionId);
    assert.equal(memberFileComment.data.head_revision_id, liveEditAfterCommit.data.current_revision_id);
    assert.equal(memberFileComment.data.author_id, member.userId);

    // admin can create comments
    const adminComment = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, admin.token, {
      content: 'Admin note.',
    });
    assert.equal(adminComment.status, 201);

    // viewer can read but cannot create
    const viewerList = await api(baseUrl, 'GET', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, viewer.token);
    assert.equal(viewerList.status, 200);
    assert.equal(viewerList.data.total, 3);
    assert.ok(viewerList.data.data.some((c: any) => c.id === ownerGeneralComment.data.id));

    const viewerCreate = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, viewer.token, {
      content: 'Viewer comment should fail.',
    });
    assert.equal(viewerCreate.status, 403, 'viewer cannot create changeset comments');

    // outsider/anonymous denied read and write
    const outsiderList = await api(baseUrl, 'GET', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, requester.token);
    assert.equal(outsiderList.status, 403, 'outsider cannot list changeset comments');

    const outsiderCreate = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, requester.token, {
      content: 'Outsider comment should fail.',
    });
    assert.equal(outsiderCreate.status, 403, 'outsider cannot create changeset comments');

    const anonymousList = await api(baseUrl, 'GET', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, undefined);
    assert.equal(anonymousList.status, 401, 'anonymous cannot list changeset comments');

    const anonymousCreate = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, undefined, {
      content: 'Anonymous comment should fail.',
    });
    assert.equal(anonymousCreate.status, 401, 'anonymous cannot create changeset comments');

    // reply threading
    const reply = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, member.token, {
      content: 'Reply to general feedback.',
      parent_comment_id: ownerGeneralComment.data.id,
    });
    assert.equal(reply.status, 201);
    assert.equal(reply.data.parent_comment_id, ownerGeneralComment.data.id);

    // invalid reply parent rejected
    const badReply = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, member.token, {
      content: 'Bad reply.',
      parent_comment_id: '00000000-0000-0000-0000-000000000000',
    });
    assert.equal(badReply.status, 404);

    // line without file_path rejected
    const lineWithoutFile = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, owner.token, {
      content: 'Orphan line.',
      line: 1,
    });
    assert.equal(lineWithoutFile.status, 422);

    // invalid side rejected
    const invalidSide = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, owner.token, {
      content: 'Bad side.',
      file_path: 'comment-target.md',
      side: 'middle',
    });
    assert.equal(invalidSide.status, 422);

    // side without file_path rejected
    const sideWithoutFile = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, owner.token, {
      content: 'Orphan side.',
      side: 'head',
    });
    assert.equal(sideWithoutFile.status, 422, 'side requires file_path');

    // revision ids without file_path rejected
    const baseRevisionWithoutFile = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, owner.token, {
      content: 'Orphan base revision.',
      base_revision_id: snapshotRevisionId,
    });
    assert.equal(baseRevisionWithoutFile.status, 422, 'base_revision_id requires file_path');

    const headRevisionWithoutFile = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, owner.token, {
      content: 'Orphan head revision.',
      head_revision_id: liveEditAfterCommit.data.current_revision_id,
    });
    assert.equal(headRevisionWithoutFile.status, 422, 'head_revision_id requires file_path');

    // malformed revision ids rejected as 422 before DB
    const malformedBaseRevision = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, owner.token, {
      content: 'Malformed base revision.',
      file_path: 'snapshot.md',
      base_revision_id: 'not-a-uuid',
    });
    assert.equal(malformedBaseRevision.status, 422, 'malformed base_revision_id rejected');

    const malformedHeadRevision = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, owner.token, {
      content: 'Malformed head revision.',
      file_path: 'snapshot.md',
      head_revision_id: '00000000-0000-0000-0000-000000000000-extra',
    });
    assert.equal(malformedHeadRevision.status, 422, 'malformed head_revision_id rejected');

    // empty string revision ids rejected as malformed, not as missing
    const emptyBaseRevision = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, owner.token, {
      content: 'Empty base revision.',
      file_path: 'snapshot.md',
      base_revision_id: '',
    });
    assert.equal(emptyBaseRevision.status, 422, 'empty base_revision_id rejected');

    const emptyHeadRevision = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, owner.token, {
      content: 'Empty head revision.',
      file_path: 'snapshot.md',
      head_revision_id: '',
    });
    assert.equal(emptyHeadRevision.status, 422, 'empty head_revision_id rejected');

    // non-string revision ids rejected
    const numericBaseRevision = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, owner.token, {
      content: 'Numeric base revision.',
      file_path: 'snapshot.md',
      base_revision_id: 12345,
    });
    assert.equal(numericBaseRevision.status, 422, 'numeric base_revision_id rejected');

    const booleanHeadRevision = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, owner.token, {
      content: 'Boolean head revision.',
      file_path: 'snapshot.md',
      head_revision_id: true,
    });
    assert.equal(booleanHeadRevision.status, 422, 'boolean head_revision_id rejected');

    const arrayBaseRevision = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, owner.token, {
      content: 'Array base revision.',
      file_path: 'snapshot.md',
      base_revision_id: [snapshotRevisionId],
    });
    assert.equal(arrayBaseRevision.status, 422, 'array base_revision_id rejected');

    const objectHeadRevision = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, owner.token, {
      content: 'Object head revision.',
      file_path: 'snapshot.md',
      head_revision_id: { id: snapshotRevisionId },
    });
    assert.equal(objectHeadRevision.status, 422, 'object head_revision_id rejected');

    // partial numeric line strings rejected
    const partialNumericLine = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, owner.token, {
      content: 'Partial numeric line.',
      file_path: 'snapshot.md',
      side: 'head',
      line: '1abc',
    });
    assert.equal(partialNumericLine.status, 422, 'partial numeric line rejected');

    // JSON null revision ids are present-but-invalid
    const nullBaseRevision = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, owner.token, {
      content: 'Null base revision.',
      file_path: 'snapshot.md',
      base_revision_id: null,
    });
    assert.equal(nullBaseRevision.status, 422, 'null base_revision_id rejected');

    const nullHeadRevision = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, owner.token, {
      content: 'Null head revision.',
      file_path: 'snapshot.md',
      head_revision_id: null,
    });
    assert.equal(nullHeadRevision.status, 422, 'null head_revision_id rejected');

    // null revision id without file_path still rejected as 422
    const nullRevisionWithoutFile = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, owner.token, {
      content: 'Null revision without file_path.',
      base_revision_id: null,
    });
    assert.equal(nullRevisionWithoutFile.status, 422, 'null revision id requires file_path');

    // malformed payloads are rejected before the changeset DB lookup
    const malformedBeforeDb = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/00000000-0000-0000-0000-000000000000/comments`, owner.token, {
      content: 'Malformed anchor before DB.',
      file_path: 'snapshot.md',
      base_revision_id: 'not-a-uuid',
    });
    assert.equal(malformedBeforeDb.status, 422, 'malformed anchor rejected before changeset lookup');

    const malformedLineBeforeDb = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/00000000-0000-0000-0000-000000000000/comments`, owner.token, {
      content: 'Malformed line before DB.',
      file_path: 'snapshot.md',
      side: 'head',
      line: 'bad',
    });
    assert.equal(malformedLineBeforeDb.status, 422, 'malformed line rejected before changeset lookup');

    // nonexistent revision id returns 404
    const unknownRevision = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, owner.token, {
      content: 'Unknown revision.',
      file_path: 'snapshot.md',
      base_revision_id: '12345678-1234-4123-8234-123456789abc',
    });
    assert.equal(unknownRevision.status, 404, 'nonexistent revision id returns 404');

    // foreign revision id (valid but belongs to another project/file) returns 404
    const foreignRevision = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, owner.token, {
      content: 'Foreign revision.',
      file_path: 'snapshot.md',
      base_revision_id: privateViewerRevisions.data.data[0].id,
    });
    assert.equal(foreignRevision.status, 404, 'foreign revision id returns 404');

    // resolve/reopen: owner can resolve any active thread
    const resolveByOwner = await api(baseUrl, 'PATCH', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments/${memberFileComment.data.id}`, owner.token, {
      status: 'resolved',
    });
    assert.equal(resolveByOwner.status, 200);
    assert.equal(resolveByOwner.data.status, 'resolved');
    assert.equal(resolveByOwner.data.resolved_by, owner.userId);
    assert.ok(resolveByOwner.data.resolved_at);

    // author can reopen their own thread
    const reopenByAuthor = await api(baseUrl, 'PATCH', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments/${memberFileComment.data.id}`, member.token, {
      status: 'active',
    });
    assert.equal(reopenByAuthor.status, 200);
    assert.equal(reopenByAuthor.data.status, 'active');
    assert.equal(reopenByAuthor.data.resolved_by, null);
    assert.equal(reopenByAuthor.data.resolved_at, null);

    // member cannot resolve another member's thread
    const otherMemberComment = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, member.token, {
      content: 'Second member comment.',
    });
    assert.equal(otherMemberComment.status, 201);

    const memberResolveOther = await api(baseUrl, 'PATCH', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments/${adminComment.data.id}`, member.token, {
      status: 'resolved',
    });
    assert.equal(memberResolveOther.status, 403, 'member cannot resolve another member\'s thread');

    // viewer cannot resolve
    const viewerResolve = await api(baseUrl, 'PATCH', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments/${memberFileComment.data.id}`, viewer.token, {
      status: 'resolved',
    });
    assert.equal(viewerResolve.status, 403, 'viewer cannot resolve changeset comments');

    // author can edit their own comment content
    const authorEdit = await api(baseUrl, 'PATCH', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments/${memberFileComment.data.id}`, member.token, {
      content: 'Updated file comment content.',
    });
    assert.equal(authorEdit.status, 200);
    assert.equal(authorEdit.data.content, 'Updated file comment content.');

    // non-author cannot edit content
    const ownerEditMemberComment = await api(baseUrl, 'PATCH', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments/${memberFileComment.data.id}`, owner.token, {
      content: 'Owner override.',
    });
    assert.equal(ownerEditMemberComment.status, 403, 'owner cannot edit another author\'s comment content');

    // list includes reply and resolved state
    const finalList = await api(baseUrl, 'GET', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, owner.token);
    assert.equal(finalList.status, 200);
    assert.equal(finalList.data.total, 5);
    assert.ok(finalList.data.data.some((c: any) => c.id === reply.data.id && c.parent_comment_id === ownerGeneralComment.data.id));
    assert.ok(finalList.data.data.some((c: any) => c.id === memberFileComment.data.id && c.status === 'active' && c.content === 'Updated file comment content.'));

    // comments are local-only: no remote state, no notifications, just persisted rows
    assert.equal(finalList.data.data.every((c: any) => c.project_id === inlineProject.data.id && c.changeset_id === inlineChangesetId), true);

    // ─── Agent API-key comment behavior ───────────────────────────────────────
    // Agent API keys are explicitly denied on comment create/update. They may
    // still list comments because the read path only requires ViewProject, but
    // they cannot author or mutate local review comments.

    const commentAgent = await api(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/agents`, owner.token, {
      name: 'Comment Agent',
    });
    assert.equal(commentAgent.status, 201);
    const commentAgentKey = commentAgent.data.api_key;

    const agentCreateDenied = await apiWithKey(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, commentAgentKey, {
      content: 'Agent feedback on changeset.',
    });
    assert.equal(agentCreateDenied.status, 403, 'agent API key cannot create changeset comments');

    const agentUpdateDenied = await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments/${ownerGeneralComment.data.id}`, commentAgentKey, {
      status: 'resolved',
    });
    assert.equal(agentUpdateDenied.status, 403, 'agent API key cannot update changeset comments');

    // Agent from another project is also denied (and project-scoped before permission checks)
    const otherProjectAgent = await api(baseUrl, 'POST', `/v1/projects/${project.data.id}/agents`, owner.token, {
      name: 'Other Project Comment Agent',
    });
    assert.equal(otherProjectAgent.status, 201);
    const otherAgentCreateDenied = await apiWithKey(baseUrl, 'POST', `/v1/projects/${inlineProject.data.id}/changesets/${inlineChangesetId}/comments`, otherProjectAgent.data.api_key, {
      content: 'Cross-project agent comment.',
    });
    assert.equal(otherAgentCreateDenied.status, 403, 'agent from another project cannot create comments');

    const memory = await api(baseUrl, 'POST', `/v1/projects/${project.data.id}/memories`, owner.token, {
      content: 'Reviewer agent should preserve API contract notes.',
      tags: ['reviewer', 'api'],
    });
    assert.equal(memory.status, 201);
    assert.deepEqual(memory.data.tags, ['reviewer', 'api']);

    const clone = await api(baseUrl, 'POST', `/v1/projects/${project.data.id}/clone`, requester.token, {
      name: 'Requester Clone',
    });
    assert.equal(clone.status, 201);
    assert.equal(clone.data.clone_source_project_id, project.data.id);

    // The clone copies every live file at the time of cloning. The original
    // project accumulated the seeded files + README + wildcard files + branch
    // test files, plus 4 net new files from the direct rename/delete tests
    // (ops/exists.md, ops/renamed.md, ops/viewer-delete.md, ops/blocked.md).
    const expectedCloneTotal = seededPaths.length + 1 + wildcardPaths.length + 2 + 4;
    const clonedFiles = await api(baseUrl, 'GET', `/v1/projects/${clone.data.id}/files`, requester.token);
    assert.equal(clonedFiles.status, 200);
    assert.equal(clonedFiles.data.data.length, expectedCloneTotal);
    assert.equal(clonedFiles.data.data[0].path, 'README.md');
    assert.equal(clonedFiles.data.total, expectedCloneTotal);

    const privateProject = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Private Project Space',
    });
    assert.equal(privateProject.status, 201);
    assert.equal(privateProject.data.visibility, 'private');

    const joinRequest = await api(
      baseUrl,
      'POST',
      `/v1/projects/${privateProject.data.id}/join-requests`,
      requester.token,
      { note: 'I can help with validation.' },
    );
    assert.equal(joinRequest.status, 201);
    assert.equal(joinRequest.data.status, 'pending');

    const reviewed = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${privateProject.data.id}/join-requests/${joinRequest.data.id}`,
      owner.token,
      { status: 'approved', role: 'viewer' },
    );
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.data.status, 'approved');

    const privateView = await api(baseUrl, 'GET', `/v1/projects/${privateProject.data.id}`, requester.token);
    assert.equal(privateView.status, 200);

    // ─── Project archive / unarchive (danger zone) ────────────────────────────
    const archiveProject = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Archive Test Project',
      description: 'Project to archive',
    });
    assert.equal(archiveProject.status, 201);
    assert.equal(archiveProject.data.status, 'active');
    const archiveProjectId = archiveProject.data.id;

    // Owner/admin can archive via PATCH with status
    const patchArchive = await api(baseUrl, 'PATCH', `/v1/projects/${archiveProjectId}`, owner.token, {
      status: 'archived',
    });
    assert.equal(patchArchive.status, 200);
    assert.equal(patchArchive.data.status, 'archived');

    // Status is visible in GET and summary
    const archivedRead = await api(baseUrl, 'GET', `/v1/projects/${archiveProjectId}`, owner.token);
    assert.equal(archivedRead.status, 200);
    assert.equal(archivedRead.data.status, 'archived');

    const archivedSummary = await api(baseUrl, 'GET', `/v1/projects/${archiveProjectId}/summary`, owner.token);
    assert.equal(archivedSummary.status, 200);
    assert.equal(archivedSummary.data.status, 'archived');

    // Member cannot archive/unarchive
    const memberArchive = await api(baseUrl, 'PATCH', `/v1/projects/${archiveProjectId}`, member.token, {
      status: 'active',
    });
    assert.equal(memberArchive.status, 403);

    const memberArchivePost = await api(baseUrl, 'POST', `/v1/projects/${archiveProjectId}/unarchive`, member.token, {
      confirm_project_name: 'Archive Test Project',
    });
    assert.equal(memberArchivePost.status, 403);

    // Anonymous cannot archive
    const anonArchive = await api(baseUrl, 'POST', `/v1/projects/${archiveProjectId}/unarchive`, undefined, {
      confirm_project_name: 'Archive Test Project',
    });
    assert.equal(anonArchive.status, 401);

    // Wrong confirmation is rejected
    const wrongConfirm = await api(baseUrl, 'POST', `/v1/projects/${archiveProjectId}/unarchive`, owner.token, {
      confirm_project_name: 'Wrong Name',
    });
    assert.equal(wrongConfirm.status, 422);
    assert.match(wrongConfirm.data.detail || '', /Project name confirmation does not match/);

    // Owner can unarchive with exact name confirmation
    const unarchive = await api(baseUrl, 'POST', `/v1/projects/${archiveProjectId}/unarchive`, owner.token, {
      confirm_project_name: 'Archive Test Project',
    });
    assert.equal(unarchive.status, 200);
    assert.equal(unarchive.data.status, 'active');

    // Idempotent: archiving an active project works, archiving an archived project is a no-op
    const archive1 = await api(baseUrl, 'POST', `/v1/projects/${archiveProjectId}/archive`, owner.token, {
      confirm_project_name: 'Archive Test Project',
    });
    assert.equal(archive1.status, 200);
    assert.equal(archive1.data.status, 'archived');
    const archive2 = await api(baseUrl, 'POST', `/v1/projects/${archiveProjectId}/archive`, owner.token, {
      confirm_project_name: 'Archive Test Project',
    });
    assert.equal(archive2.status, 200);
    assert.equal(archive2.data.status, 'archived');

    // Invalid status enum rejected by PATCH
    const invalidStatus = await api(baseUrl, 'PATCH', `/v1/projects/${archiveProjectId}`, owner.token, {
      status: 'deleted',
    });
    assert.equal(invalidStatus.status, 422);
    assert.match(invalidStatus.data.detail || '', /Invalid status/);

    console.log('project-space tests passed');
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
    password: 'ProjectSpaceTest123!',
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

async function apiWithKey(
  baseUrl: string,
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
  };
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

async function rawApi(
  baseUrl: string,
  path: string,
  token?: string,
): Promise<{
  status: number;
  raw: string;
  contentType: string | null;
  contentDisposition: string | null;
  revisionId: string | null;
  branch: string | null;
  branchCommitId: string | null;
  noSniff: string | null;
}> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, { method: 'GET', headers });
  const raw = await response.text();
  return {
    status: response.status,
    raw,
    contentType: response.headers.get('content-type'),
    contentDisposition: response.headers.get('content-disposition'),
    revisionId: response.headers.get('x-project-file-revision-id'),
    branch: response.headers.get('x-project-branch'),
    branchCommitId: response.headers.get('x-project-branch-commit-id'),
    noSniff: response.headers.get('x-content-type-options'),
  };
}

async function archiveApi(
  baseUrl: string,
  path: string,
  token?: string,
): Promise<{
  status: number;
  buffer: Buffer;
  contentType: string | null;
  contentDisposition: string | null;
  contentLength: string | null;
  noSniff: string | null;
}> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, { method: 'GET', headers });
  const arrayBuffer = await response.arrayBuffer();
  return {
    status: response.status,
    buffer: Buffer.from(arrayBuffer),
    contentType: response.headers.get('content-type'),
    contentDisposition: response.headers.get('content-disposition'),
    contentLength: response.headers.get('content-length'),
    noSniff: response.headers.get('x-content-type-options'),
  };
}

function bufferContains(buffer: Buffer, text: string): boolean {
  return buffer.includes(Buffer.from(text, 'utf8'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
