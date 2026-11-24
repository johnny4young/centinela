import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  checkBranchState,
  checkCiFailures,
  checkMigrationCollisions,
  checkPrOverlap,
} from '../src/lib/hygiene.mjs';
import { checkIssue, checkSensitive, isCodeBugReport } from '../src/lib/checks.mjs';
import { parseRemoteRef, resolveConfig } from '../src/lib/config.mjs';
import {
  buildPrompt,
  executeReadOnlyTool,
  exploreContext,
  selectReviewTier,
  verifyFindings,
} from '../src/lib/ai.mjs';
import {
  applySuppressions,
  classifyScope,
  learningStacksFor,
  loadMultiProjectLearnings,
  planLearningUpdates,
  sanitizeSharedCandidate,
  selectLearningsForFiles,
} from '../src/lib/learnings.mjs';
import { issueSearchQuery, renderIssueAiComment, triageIssueWithAi } from '../src/lib/issues.mjs';
import { answerThread, isCentinelaMention, renderThreadReply } from '../src/lib/conversation.mjs';
import { applyStack, detectPacks } from '../src/lib/packs.mjs';
import { scaffoldForRepo } from '../src/cli-init.mjs';
import {
  loadConfig,
  parseTarget,
  runAiReview,
  runConversation,
  runLearn,
  triageIssue,
} from '../src/centinela.mjs';
import { runSuite } from '../evals/run-eval.mjs';

const defaults = resolveConfig({});

test('hygiene detects merge conflicts, stale branches, migration collisions, PR overlap and CI failures', () => {
  const conflicts = checkBranchState({
    pr: { mergeable: false, base: { ref: 'main' } },
    behindBy: 25,
    config: resolveConfig({ hygiene: { maxBehindCommits: 10 } }),
  });
  assert.deepEqual(
    conflicts.map(f => `${f.id}:${f.severity}`),
    ['merge-conflict:blocking', 'branch-behind:suggestion']
  );

  const collisions = checkMigrationCollisions({
    files: [
      { filename: 'packages/server/src/db/migrations/0102_doc.sql', status: 'added' },
      { filename: 'packages/server/src/db/migrations/0109_ok.sql', status: 'added' },
    ],
    basePaths: [
      'packages/server/src/db/migrations/0107_a.sql',
      'packages/server/src/db/migrations/0108_b.sql',
    ],
    config: defaults,
  });
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].id, 'migration-collision');
  assert.equal(collisions[0].params.latest, '0108');
  assert.equal(collisions[0].params.next, '0109');

  const overlap = checkPrOverlap({
    number: 526,
    commits: [
      { message: 'Merge branch main into feat' },
      { message: 'feat(payables): consolidate several purchases into one supplier invoice' },
    ],
    openPulls: [
      { number: 526, title: 'feat(purchases): own pr' },
      {
        number: 527,
        title: 'feat(payables): consolidate several purchases into one supplier invoice',
      },
    ],
    config: defaults,
  });
  assert.equal(overlap.length, 1);
  assert.equal(overlap[0].id, 'pr-overlap');
  assert.equal(overlap[0].params.number, 527);

  const ci = checkCiFailures({
    checkRuns: [
      { name: 'Centinela', status: 'completed', conclusion: 'failure' },
      { name: 'test-server', status: 'completed', conclusion: 'failure', output: { title: '2 failed' } },
      { name: 'lint', status: 'completed', conclusion: 'success' },
    ],
    config: defaults,
  });
  assert.equal(ci.length, 1);
  assert.deepEqual(ci[0].params.checks, ['test-server']);
});

test('incomplete-diff exempts non-sensitive generated snapshots while failing closed on lockfiles', () => {
  const findings = checkSensitive({
    config: defaults,
    files: [
      { filename: 'packages/server/src/db/migrations/meta/0102_snapshot.json', status: 'added' },
      { filename: 'pnpm-lock.yaml', status: 'modified' },
    ],
  });
  const incomplete = findings.find(f => f.id === 'incomplete-diff');
  assert.ok(incomplete);
  assert.deepEqual(incomplete.params.unread, ['pnpm-lock.yaml']);
});

test('code-level engineering bug reports are not falsely blocked for end-user OS/version fields', () => {
  const title = 'fix(products): duplicate barcodes resolve to an arbitrary catalog entry';
  const body = [
    '## Summary',
    '`products.lookupByBarcode` resolves duplicates arbitrarily.',
    '## Where',
    '- `packages/server/src/db/schema/products.ts:257-261` has a non-unique index.',
    '## Impact',
    'Two products with the same barcode scan unpredictably.',
  ].join('\n\n');
  assert.ok(isCodeBugReport(title, body));
  assert.deepEqual(checkIssue({ title, body, labels: ['bug'], config: defaults }), []);
});

test('tiered AI review selector picks fast vs deep based on size and critical paths', () => {
  const cfg = resolveConfig({
    ai: { autoReview: 'tiered', deepFromSize: 'L', deepPaths: ['packages/server/src/db/**'] },
  });
  assert.equal(selectReviewTier({ files: [{ filename: 'apps/web/src/a.tsx' }], sizeLabel: 'S', config: cfg }), 'fast');
  assert.equal(selectReviewTier({ files: [{ filename: 'apps/web/src/a.tsx' }], sizeLabel: 'L', config: cfg }), 'deep');
  assert.equal(
    selectReviewTier({ files: [{ filename: 'packages/server/src/db/schema.ts' }], sizeLabel: 'XS', config: cfg }),
    'deep'
  );
  assert.equal(
    selectReviewTier({ files: [{ filename: 'a.ts' }], sizeLabel: 'XXL', config: resolveConfig({ ai: { autoReview: 'off' } }) }),
    'off'
  );
});

test('read-only agentic tools search, read bounded lines, reject traversal, and list open PRs', async () => {
  const client = {
    searchCode: async () => [{ path: 'apps/desktop/src/main/window-lifecycle.ts' }],
    fileAt: async () => 'line1\nline2\nline3\nline4',
    listDir: async () => [{ name: 'orders.ts', path: 'src/orders.ts', type: 'file' }],
    openPulls: async () => [
      { number: 525, title: 'self' },
      { number: 527, title: 'feat(payables): consolidate' },
    ],
  };
  const pr = { number: 525, base: { sha: 'b1' }, head: { sha: 'h1' } };
  assert.match(
    await executeReadOnlyTool({ name: 'search_code', input: { query: 'blob:' }, client, pr }),
    /window-lifecycle\.ts/
  );
  assert.match(
    await executeReadOnlyTool({
      name: 'read_file',
      input: { path: 'a.ts', ref: 'base', startLine: 2, endLine: 3 },
      client,
      pr,
    }),
    /2\| line2\n    3\| line3/
  );
  assert.equal(
    await executeReadOnlyTool({ name: 'read_file', input: { path: '../secret' }, client, pr }),
    'Invalid path.'
  );
  assert.match(
    await executeReadOnlyTool({ name: 'list_open_prs', input: {}, client, pr }),
    /#527/
  );
});

test('agentic exploration + critic verifier filter false positives in runAiReview', async () => {
  const pr = {
    number: 526,
    state: 'open',
    title: 'feat(purchases): attach document',
    body: 'Adds attachment.',
    user: { login: 'andres' },
    head: { sha: 'h526' },
    base: { sha: 'b526', ref: 'main' },
  };
  const files = [
    {
      filename: 'apps/web/src/Panel.tsx',
      status: 'modified',
      patch: '@@ -1,0 +1,2 @@\n+window.open(blobUrl);\n+const ok = 1;',
    },
  ];
  const writes = [];
  const client = {
    pull: async () => pr,
    comments: async () => [],
    pullFiles: async () => files,
    reviewComments: async () => [{ user: { login: 'Copilot', type: 'Bot' }, path: 'apps/web/src/Panel.tsx', line: 2, body: 'Already noted' }],
    checkRuns: async () => [],
    tree: async () => ['apps/web/src/Panel.tsx', 'apps/desktop/src/main/window-lifecycle.ts'],
    fileAt: async file =>
      file.includes('window-lifecycle')
        ? 'setWindowOpenHandler(() => ({ action: "deny" }))'
        : 'window.open(blobUrl);\nconst ok = 1;',
    searchCode: async () => [{ path: 'apps/desktop/src/main/window-lifecycle.ts' }],
    createReview: async (n, rev) => writes.push(['review', rev]),
    upsertComment: async (n, ex, body) => writes.push(['comment', body]),
  };

  let explorerCalls = 0;
  let verifierCalls = 0;
  const model = {
    messages: {
      create: async req => {
        if (req.tools) {
          explorerCalls++;
          if (explorerCalls === 1) {
            return {
              stop_reason: 'tool_use',
              usage: { input_tokens: 100, output_tokens: 40 },
              content: [
                {
                  type: 'tool_use',
                  id: 't1',
                  name: 'read_file',
                  input: { path: 'apps/desktop/src/main/window-lifecycle.ts', ref: 'base' },
                },
              ],
            };
          }
          return {
            stop_reason: 'end_turn',
            usage: { input_tokens: 150, output_tokens: 50 },
            content: [{ type: 'text', text: 'window-lifecycle.ts denies window.open.' }],
          };
        }
        verifierCalls++;
        return {
          usage: { input_tokens: 80, output_tokens: 30 },
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                decisions: [
                  { index: 0, keep: true, reason: 'Confirmed by window-lifecycle.ts', severity: 'maintainer' },
                  { index: 1, keep: false, reason: 'Duplicate of Copilot comment', severity: 'suggestion' },
                ],
              }),
            },
          ],
        };
      },
    },
    beta: {
      messages: {
        stream: () => ({
          finalMessage: async () => ({
            model: 'claude-opus-5-5',
            stop_reason: 'end_turn',
            usage: { input_tokens: 500, output_tokens: 120 },
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  summary: 'Electron blocks window.open.',
                  findings: [
                    {
                      file: 'apps/web/src/Panel.tsx',
                      startLine: 0,
                      line: 1,
                      category: 'correctness',
                      severity: 'maintainer',
                      title: 'window.open is blocked in Electron',
                      detail: 'window-lifecycle.ts denies renderer windows.',
                      suggestion: '',
                    },
                    {
                      file: 'apps/web/src/Panel.tsx',
                      startLine: 0,
                      line: 2,
                      category: 'maintainability',
                      severity: 'suggestion',
                      title: 'Duplicate nit',
                      detail: 'Already covered.',
                      suggestion: '',
                    },
                  ],
                }),
              },
            ],
          }),
        }),
      },
    },
  };

  const result = await runAiReview({
    options: { client, config: defaults, number: 526, dryRun: false, repo: 'o/r', version: 'v1', botLogin: null, log: () => {} },
    model,
  });
  assert.equal(explorerCalls, 2);
  assert.equal(verifierCalls, 1);
  assert.equal(result.inline.length, 1, 'verifier dropped the duplicate finding');
  assert.equal(result.inline[0].title, 'window.open is blocked in Electron');
});

test('multi-project 3-tier learnings isolate stacks, honor local suppressions and protect private repos', async () => {
  const sharedFiles = {
    'learnings/global.json': JSON.stringify({
      version: 1,
      learnings: [
        { id: 'global-no-d1', scope: 'global', rule: 'No internal IDs in comments', paths: [], status: 'active' },
      ],
    }),
    'learnings/stacks/electron.json': JSON.stringify({
      version: 1,
      learnings: [
        { id: 'elec-no-blob', scope: 'stack', stacks: ['electron'], rule: 'No blob window.open', paths: ['**/*.tsx'], status: 'active' },
      ],
    }),
    'learnings/stacks/swift.json': JSON.stringify({
      version: 1,
      learnings: [
        { id: 'swift-no-try-bang', scope: 'stack', stacks: ['swift'], rule: 'No try!', paths: ['**/*.swift'], status: 'active' },
      ],
    }),
  };
  const localJson = JSON.stringify({
    version: 1,
    learnings: [
      { id: 'repo-tenant', scope: 'repo', rule: 'Scope by tenantId', paths: ['packages/server/**'], status: 'active' },
    ],
    suppressions: [
      { id: 'sup-snap', ruleId: 'incomplete-diff', paths: ['**/meta/**'] },
    ],
  });
  const client = {
    externalFileAt: async (repo, p) => sharedFiles[p] ?? null,
    fileAt: async p => (p === '.github/centinela/learnings.json' ? localJson : null),
  };
  const cfg = resolveConfig({ learnings: { shared: 'johnny4young/centinela-memory@main' } });

  assert.deepEqual(
    learningStacksFor({ packs: [], paths: ['package.json', 'src/index.mjs'] }).sort(),
    ['javascript']
  );
  assert.deepEqual(
    learningStacksFor({ packs: ['react'], paths: ['tsconfig.json', 'src/App.tsx'] }).sort(),
    ['javascript', 'react', 'typescript']
  );
  assert.deepEqual(
    learningStacksFor({ packs: ['swift'], paths: ['Package.swift', 'Sources/App.swift'] }),
    ['swift']
  );

  const swiftLoaded = await loadMultiProjectLearnings({ client, ref: 'main', stacks: ['swift'], config: cfg });
  assert.deepEqual(
    swiftLoaded.learnings.map(l => l.id).sort(),
    ['global-no-d1', 'repo-tenant', 'swift-no-try-bang'],
    'Swift repos never receive Electron stack learnings'
  );

  const selected = selectLearningsForFiles({
    learnings: swiftLoaded.learnings,
    files: [{ filename: 'Sources/AppView.swift' }],
  });
  assert.deepEqual(
    selected.map(l => l.id).sort(),
    ['global-no-d1', 'swift-no-try-bang']
  );

  const filtered = applySuppressions(
    [{ id: 'incomplete-diff', params: { unread: ['db/migrations/meta/0102.json'] } }],
    swiftLoaded.suppressions
  );
  assert.deepEqual(filtered, []);

  // Privacy boundary: private repo candidates stay local when shareScope is public-only.
  assert.deepEqual(
    classifyScope(
      { rule: 'Store binary attachments in SQLite as blob', paths: ['apps/x/db/a.ts'] },
      { stacks: ['node-server'], isPrivate: true, shareScope: 'public-only', sharedIsPublic: true }
    ),
    { scope: 'repo', stacks: [] }
  );
  assert.deepEqual(
    classifyScope(
      { rule: 'Store binary attachments in SQLite as blob', paths: ['apps/x/db/a.ts'] },
      { stacks: ['node-server'], isPrivate: false, shareScope: 'public-only', sharedIsPublic: true }
    ),
    { scope: 'stack', stacks: ['node-server'] }
  );
  const sanitized = sanitizeSharedCandidate(
    {
      id: 'x',
      paths: ['apps/puntovivo/src/db/**', 'src/melosensei/secret/**'],
      origin: { repo: 'secret-app', pr: 9 },
    },
    { isPrivate: true }
  );
  assert.deepEqual(sanitized.origin, { repo: 'private' });
  assert.deepEqual(sanitized.paths, ['**/src/db/**']);
});

test('self-learning planner retires noisy rules, flags deterministic promotions, and routes multi-project PRs', () => {
  const currentLocal = {
    version: 1,
    learnings: [
      {
        id: 'noisy-rule',
        scope: 'repo',
        rule: 'Nitpicky rule',
        stats: { byRepo: { puntovivo: { shown: 6, accepted: 2, dismissed: 4 } } },
        status: 'active',
      },
      {
        id: 'ready-regex',
        scope: 'repo',
        rule: 'Avoid .default(null)',
        pattern: '\\.default\\(null\\)',
        paths: ['packages/server/src/db/**'],
        stats: { byRepo: { puntovivo: { shown: 3, accepted: 3, dismissed: 0 } } },
        status: 'active',
      },
    ],
  };
  const plan = planLearningUpdates({
    currentLocal,
    signals: {
      maintainerComments: [
        {
          pr: 526,
          path: 'packages/server/src/application/purchases/purchase-documents.ts',
          body: 'Please add eq(purchaseDocuments.tenantId, ctx.tenantId) to every query.',
        },
        {
          pr: 526,
          path: 'packages/server/src/db/schema/purchasing.ts',
          body: 'Please store binary attachments in SQLite as blob instead of base64 text.',
        },
      ],
      feedback: [],
    },
    stacks: ['node-server', 'electron'],
    repo: 'johnny4young/puntovivo',
    isPrivate: false,
    config: defaults,
  });
  assert.equal(plan.retirements.length, 1);
  assert.equal(plan.retirements[0].id, 'noisy-rule');
  assert.equal(plan.promotions.length, 1);
  assert.equal(plan.promotions[0].id, 'ready-regex');
  assert.equal(plan.addedLocal.length, 1, 'tenantId rule routes to repo scope');
  assert.equal(plan.addedShared.length, 1, 'SQLite blob rule routes to shared stack scope');
  assert.equal(plan.addedShared[0].targetKey, 'stacks/node-server.json');
});

test('smart AI issue triage detects already-fixed PRs and applies safe auto-labels', async () => {
  assert.equal(
    issueSearchQuery('fix(products): duplicate barcodes resolve arbitrarily'),
    'duplicate barcodes resolve arbitrarily'
  );
  const issue = {
    number: 501,
    state: 'open',
    title: 'fix(products): duplicate barcodes resolve to an arbitrary catalog entry',
    body: '## Summary\n\n`products.lookupByBarcode` resolves duplicates.\n\n## Where\n\n- `packages/server/src/db/schema/products.ts:257`',
    user: { login: 'Andresdotdev' },
    author_association: 'CONTRIBUTOR',
    labels: [],
  };
  const writes = [];
  const client = {
    issue: async () => issue,
    comments: async () => [],
    repository: async () => ({ default_branch: 'main' }),
    fileAt: async () => null,
    tree: async () => ['packages/server/src/db/schema/products.ts'],
    searchIssues: async () => [],
    closedPulls: async () => [
      {
        number: 503,
        title: 'feat(products): carry a packaging barcode and resolve it deterministically',
        merged_at: '2026-11-17T05:00:00Z',
        body: 'Resolves duplicate barcode lookup deterministically.',
      },
    ],
    pull: async n => (n === 503 ? { number: 503, merged: true, merged_at: '2026-11-17T05:00:00Z' } : null),
    close: async (n, pull, reason) => writes.push(['close', n, pull, reason]),
    upsertComment: async (n, ex, body) => writes.push(['comment', body]),
    ensureLabel: async def => writes.push(['ensureLabel', def.name]),
    addLabels: async (n, labels) => writes.push(['addLabels', labels]),
    removeLabel: async () => {},
  };
  const model = {
    messages: {
      create: async () => ({
        model: 'claude-sonnet-5-5',
        usage: { input_tokens: 400, output_tokens: 120 },
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              kind: 'code-bug',
              labels: ['bug', 'area:products', 'unsafe label with spaces'],
              duplicateOf: 0,
              fixedByPr: 503,
              closeIfFixed: true,
              needsClarification: false,
              questions: [],
              relevantFiles: ['packages/server/src/db/schema/products.ts'],
              contributionBrief: '',
              summary: 'Deterministic barcode resolution landed in merged PR #503.',
            }),
          },
        ],
      }),
    },
  };
  const res = await triageIssue({
    client,
    config: defaults,
    number: 501,
    dryRun: false,
    force: false,
    repo: 'johnny4young/puntovivo',
    version: 'v1',
    model,
    log: () => {},
  });
  assert.equal(res.ai.fixedByPr, 503);
  assert.equal(res.closed, true);
  assert.deepEqual(res.ai.labels, ['bug', 'area:products']);
  const posted = writes.find(w => w[0] === 'comment')[1];
  assert.match(posted, /Resolved and closed.*#503/);
  assert.deepEqual(writes.find(w => w[0] === 'close'), ['close', 501, false, 'completed']);
  assert.deepEqual(writes.find(w => w[0] === 'addLabels')[1], ['bug', 'area:products']);
});

test('conversational thread handler answers Centinela replies and records dismissal feedback markers', async () => {
  assert.ok(isCentinelaMention('Hey @centinela why did this fire?'));
  assert.ok(!isCentinelaMention('Thanks @alice!'));

  const writes = [];
  const client = {
    pull: async () => ({ number: 12, title: 'feat: test', base: { ref: 'main' } }),
    reviewComments: async () => [
      {
        id: 100,
        user: { type: 'Bot', login: 'centinela-young[bot]' },
        path: 'src/a.ts',
        line: 5,
        body: '**Bug** · Possible null\n\n<!-- centinela-ai-finding fp=deadbeef1234 -->',
      },
    ],
    fileAt: async () => null,
    tree: async () => [],
    replyToReviewComment: async (n, id, body) => writes.push(['reply', id, body]),
    resolveReviewThreadForComment: async (n, id) => {
      writes.push(['resolve', id]);
      return true;
    },
  };
  const model = {
    messages: {
      create: async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              reply: 'Good catch, that guard guarantees it is non-null. Dismissing this finding.',
              outcome: 'dismissed',
              learningCandidate: 'Skip null check after requireEntity guard.',
            }),
          },
        ],
      }),
    },
  };
  await runConversation({
    options: {
      client,
      config: defaults,
      number: 12,
      dryRun: false,
      botLogin: 'centinela-young[bot]',
      log: () => {},
    },
    conversation: {
      isReviewComment: true,
      inReplyToId: 100,
      comment: { id: 101, user: { login: 'dev', type: 'User' }, body: 'requireEntity already throws if null' },
      language: 'en',
    },
    model,
  });
  assert.equal(writes.length, 2);
  assert.equal(writes[0][1], 100);
  assert.match(writes[0][2], /<!-- centinela-feedback outcome=dismissed fp=deadbeef1234 -->/);
  assert.deepEqual(writes[1], ['resolve', 100], 'dismissed false positives auto-resolve the thread');
});

test('config extends loads shared base config and fleet packs detect Go, Shell and opt-in UI/comment rules', async () => {
  assert.deepEqual(parseRemoteRef('johnny4young/centinela-memory/base.json@main'), {
    repo: 'johnny4young/centinela-memory',
    path: 'base.json',
    ref: 'main',
  });
  const loaded = await loadConfig({
    client: {
      repository: async () => ({ default_branch: 'main' }),
      fileAt: async () => JSON.stringify({ extends: 'johnny4young/centinela-memory/base.json@main', license: 'MIT' }),
      externalFileAt: async () => JSON.stringify({ maintainers: ['johnny4young'], rules: { ui: true, comments: true } }),
    },
  });
  assert.deepEqual(loaded.maintainers, ['johnny4young']);
  assert.equal(loaded.license, 'MIT');
  assert.equal(loaded.rules.ui, true);

  assert.deepEqual(detectPacks({ paths: ['go.mod', 'cmd/server/main.go'], manifests: [] }), ['go']);
  assert.deepEqual(detectPacks({ paths: ['install.sh'], manifests: [] }), ['shell']);
  const applied = applyStack(loaded, { packs: ['go'], paths: ['go.mod'] });
  assert.ok(applied.rules.some(r => r.id === 'go-sql-concat'));
  assert.ok(applied.rules.some(r => r.id === 'ui-left-accent-bar'));
  assert.ok(applied.rules.some(r => r.id === 'internal-comment-ref'));
});

test('cli-init scaffolds valid config and reusable workflow, and eval suite passes at 100%', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'centinela-init-'));
  try {
    await writeFile(path.join(dir, 'go.mod'), 'module example.com/janusly\n');
    await writeFile(path.join(dir, 'AGENTS.md'), '# Rules\n');
    const plan = scaffoldForRepo({
      dir,
      maintainer: 'johnny4young',
      shared: 'johnny4young/centinela-memory@main',
    });
    assert.deepEqual(plan.packs, ['go']);
    assert.deepEqual(plan.config.maintainers, ['johnny4young']);
    assert.equal(plan.config.learnings.shared, 'johnny4young/centinela-memory@main');
    assert.match(plan.workflow, /reusable-centinela\.yml@v1/);
    resolveConfig(plan.config);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const evalResult = runSuite();
  assert.ok(evalResult.passed);
  assert.equal(evalResult.precision, 1);
  assert.equal(evalResult.recall, 1);
});

test('runLearn opens local and shared multi-project learning PRs', async () => {
  const writes = [];
  const client = {
    repository: async () => ({ default_branch: 'main', private: false }),
    closedPulls: async () => [{ number: 526 }],
    openPulls: async () => [],
    reviewComments: async () => [
      {
        id: 1,
        user: { login: 'johnny4young', type: 'User' },
        author_association: 'OWNER',
        path: 'packages/server/src/db/schema.ts',
        body: 'Please store binary attachments in SQLite as blob instead of base64 text.',
      },
    ],
    tree: async () => ['package.json'],
    fileAt: async f =>
      f === 'package.json' ? JSON.stringify({ dependencies: { fastify: '5.0.0' } }) : null,
    externalFileAt: async () => null,
    ensureBranch: async args => writes.push(['branch', args.targetRepo, args.branch]),
    upsertRepoFile: async args => writes.push(['file', args.targetRepo, args.filePath]),
    openOrUpdatePull: async args => writes.push(['pr', args.targetRepo, args.title]),
  };
  const cfg = resolveConfig({
    maintainers: ['johnny4young'],
    learnings: { shared: 'johnny4young/centinela-memory@main' },
  });
  await runLearn({
    options: { client, config: cfg, dryRun: false, repo: 'johnny4young/puntovivo', botLogin: null, log: () => {} },
    openPr: true,
  });
  assert.ok(
    writes.some(w => w[0] === 'pr' && w[1] === 'johnny4young/centinela-memory'),
    'routes stack learning PR to shared multi-project memory hub'
  );
});
