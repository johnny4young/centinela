import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  checkDependencies,
  checkDescription,
  checkEvidence,
  checkIdentity,
  checkIssue,
  checkLanguage,
  checkSensitive,
  sizeOf,
} from '../src/lib/checks.mjs';
import {
  addedLines,
  detectLanguage,
  matcher,
  readMarker,
  reviewKey,
  sections,
} from '../src/lib/core.mjs';
import {
  changedDependencies,
  dependencyChanges,
  findTypos,
  localeGaps,
  pinnedVersion,
} from '../src/lib/enrich.mjs';
import { createClient } from '../src/lib/github.mjs';
import { renderComment } from '../src/lib/render.mjs';
import {
  loadConfig,
  outcome,
  ownComment,
  parseTarget,
  rulesVersion,
  shouldSkip,
  triageIssue,
  triagePullRequest,
  relevantEvent,
} from '../src/centinela.mjs';
import { parseConfig, resolveConfig } from '../src/lib/config.mjs';

const config = parseConfig(
  readFileSync(new URL('./fixtures/electron-monorepo.json', import.meta.url), 'utf8')
);
const defaults = resolveConfig({});
const BODY =
  '## What\n\nAdds a thing.\n\n## Why\n\nUsers asked.\n\n## How to test\n\n1. Open sales\n';
const patch = lines => `@@ -1,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join('\n')}`;
const file = (filename, lines = ['x'], extra = {}) => ({
  filename,
  status: 'modified',
  additions: lines.length,
  deletions: 0,
  patch: patch(lines),
  ...extra,
});
const ids = findings => findings.map(f => `${f.id}:${f.severity}`);

test('glob matcher handles ** and * segments', () => {
  const is = matcher(['apps/*/src/**', '**/*.test.*', 'LICENSE*']);
  assert.ok(is('apps/web/src/a/b.tsx'));
  assert.ok(is('scripts/triage.test.mjs'));
  assert.ok(is('LICENSE.md'));
  assert.ok(!is('apps/web/vite.config.ts'));
});

test('added lines keep their line numbers in the new file', () => {
  const lines = addedLines('@@ -10,3 +10,4 @@\n keep\n-old\n+new\n+two\n keep');
  assert.deepEqual(lines, [
    { line: 11, text: 'new' },
    { line: 12, text: 'two' },
  ]);
  assert.deepEqual(addedLines(undefined), []);
});

test('sections ignore template comments and language detection prefers the majority', () => {
  const parsed = sections('## What\n<!-- What does this PR change? -->\n\n## Why\nBecause');
  assert.equal(parsed.get('what'), '');
  assert.equal(parsed.get('why'), 'Because');
  assert.equal(
    detectLanguage('Arregla el carrito', 'Cuando se cierra la sesión, el carrito se pierde'),
    'es'
  );
  assert.equal(detectLanguage('Fix the cart', 'When the session expires the cart is lost'), 'en');
});

test('review key changes only with what the review depends on', () => {
  const base = { rulesVersion: 'r1', kind: 'pr', headSha: 'a', title: 't', body: 'b', labels: [] };
  assert.equal(reviewKey(base), reviewKey({ ...base }));
  assert.notEqual(reviewKey(base), reviewKey({ ...base, headSha: 'b' }));
  assert.notEqual(reviewKey(base), reviewKey({ ...base, rulesVersion: 'r2' }));
  assert.notEqual(reviewKey(base), reviewKey({ ...base, labels: ['triage: approved'] }));
});

test('description requires a conventional title and the template sections', () => {
  assert.deepEqual(checkDescription({ title: 'feat(sales): add a thing', body: BODY, config }), []);
  assert.deepEqual(
    checkDescription({ title: 'feat(sales): agrega', body: BODY.replace('What', 'Qué'), config }),
    []
  );
  const bad = checkDescription({
    title: 'feat(purchases):\n record it',
    body: '## What\n<!-- x -->',
    config,
  });
  assert.deepEqual(ids(bad), ['title:blocking', 'description:blocking']);
  assert.deepEqual(bad[1].params.missing, ['what', 'why', 'howToTest']);
  const custom = resolveConfig({
    pullRequest: {
      conventionalTitle: false,
      sections: [{ id: 'summary', names: ['summary'] }],
    },
  });
  const loose = checkDescription({ title: 'Make it faster', body: '## Notes\nx', config: custom });
  assert.deepEqual(ids(loose), ['description:blocking']);
  assert.deepEqual(loose[0].params.labels, [{ en: 'summary' }]);
});

test('UI changes need media, and features need tests', () => {
  const ui = [
    file('apps/web/src/features/sales/Cart.tsx', Array(30).fill('x')),
    file('apps/web/src/features/sales/Cart.test.tsx'),
  ];
  const blocked = checkEvidence({ title: 'feat(sales): x', body: BODY, files: ui, config });
  assert.deepEqual(ids(blocked), ['screenshots:blocking']);
  assert.deepEqual(blocked[0].params.files, ['apps/web/src/features/sales/Cart.tsx']);
  const withImage = `${BODY}\n![after](https://github.com/user-attachments/assets/1)`;
  assert.deepEqual(
    checkEvidence({ title: 'feat(sales): x', body: withImage, files: ui, config }),
    []
  );
  const untested = [file('packages/server/src/a.ts', Array(30).fill('x'))];
  assert.deepEqual(
    ids(checkEvidence({ title: 'feat(x): y', body: BODY, files: untested, config })),
    ['tests:blocking']
  );
  assert.deepEqual(
    ids(checkEvidence({ title: 'refactor(x): y', body: BODY, files: untested, config })),
    ['tests:suggestion']
  );
});

test('Spanish copy rejects voseo and tú but not ordinary accented words', () => {
  const files = [
    file('apps/web/src/i18n/locales/es/sales.json', [
      '  "a": "Seleccioná un producto",',
      '  "b": "Si tienes dudas, escriba",',
      '  "c": "Está listo y podrá continuar",',
    ]),
  ];
  const findings = checkLanguage({ files, config });
  assert.deepEqual(
    findings.map(f => [f.line, f.params.words]),
    [
      [1, ['Seleccioná']],
      [2, ['tienes']],
    ]
  );
  assert.deepEqual(checkLanguage({ files, config: defaults }), []);
  const tu = resolveConfig({
    language: { spanishRegister: { register: 'tu', paths: ['apps/web/src/i18n/locales/es/**'] } },
  });
  assert.deepEqual(
    checkLanguage({ files, config: tu }).map(f => f.params.words),
    [['Seleccioná']]
  );
  const gaps = checkLanguage({
    files: [],
    config,
    localeGaps: [{ file: 'en/a.json', missingIn: 'es/a.json', key: 'k' }],
  });
  assert.deepEqual(ids(gaps), ['locale-parity:blocking']);
});

test('risky changes are flagged for a maintainer or blocked', () => {
  const findings = checkSensitive({
    config,
    files: [
      file('.github/workflows/ci.yml'),
      file('apps/desktop/src/main/window.ts', [
        '  sandbox: false,',
        'const x = "‮";',
        'eval(code)',
      ]),
      file('package.json', ['    "postinstall": "node x.js",', '  "author": "someone"']),
      file('pnpm-lock.yaml', ['A'.repeat(300)]),
      file('native/addon.node', [], { patch: undefined, status: 'added' }),
    ],
  });
  assert.deepEqual(ids(findings), [
    'sensitive-paths:maintainer',
    'hidden-unicode:blocking',
    'dynamic-code:maintainer',
    'lifecycle-script:maintainer',
    'authorship:maintainer',
    'binary:maintainer',
  ]);
});

test('identity trusts a maintainer only when that maintainer signed the commit', () => {
  const me = 'johnny4young';
  const commits = [
    { sha: 'aaaaaaa1', authorLogin: me, committerLogin: me, verified: false, message: 'x' },
    { sha: 'bbbbbbb2', authorLogin: me, committerLogin: me, verified: true, message: 'x' },
    {
      sha: 'ccccccc3',
      authorLogin: 'someone',
      committerLogin: 'someone',
      verified: true,
      message: `x\n\nCo-authored-by: ${me} <x@y>`,
    },
    // Signed by the contributor with the maintainer as author.
    { sha: 'ddddddd4', authorLogin: me, committerLogin: 'someone', verified: true, message: 'x' },
    {
      sha: 'eeeeeee5',
      authorLogin: 'someone',
      committerLogin: me,
      verified: true,
      message: `x\n\nCo-authored-by: ${me} <x@y>`,
    },
  ];
  assert.deepEqual(
    checkIdentity({ author: 'someone', commits, config }).map(f => f.params.sha),
    ['aaaaaaa', 'ccccccc', 'ddddddd']
  );
  assert.deepEqual(checkIdentity({ author: me, commits, config }), []);
});

test('dependencies are checked for license and release age', () => {
  const findings = checkDependencies({
    config,
    dependencies: [
      { name: 'gpl-lib', version: '1.0.0', license: 'GPL-3.0', ageDays: 400 },
      { name: 'fresh', version: '2.0.0', license: 'MIT', ageDays: 2 },
      { name: 'ok', version: '3.0.0', license: 'MIT', ageDays: 90 },
    ],
  });
  assert.deepEqual(ids(findings), [
    'dep-license:blocking',
    'dep-age:blocking',
    'dependency:maintainer',
  ]);
});

test('size ignores generated files and picks a bucket', () => {
  const size = sizeOf(
    [file('pnpm-lock.yaml', Array(5000).fill('x')), file('a.ts', Array(150).fill('x'))],
    config
  );
  assert.deepEqual(size, { lines: 150, label: 'M', files: 1 });
});

test('issues: empty, incomplete bug, complete bug form and security hints', () => {
  assert.deepEqual(ids(checkIssue({ title: 'Idea', body: 'short', labels: [], config })), [
    'issue-empty:blocking',
  ]);
  const incomplete = checkIssue({
    title: 'Crash when printing',
    body: 'It crashes every time I print a ticket.',
    labels: [],
    config,
  });
  assert.deepEqual(incomplete[0].params.missing, [
    'steps',
    'expected',
    'actual',
    'version',
    'platform',
  ]);
  const form = [
    '### Steps to reproduce\n1. Open sales\n2. Print',
    '### Expected behavior\nA ticket',
    '### Actual behavior\nNothing',
    '### Puntovivo version\n1.20.0',
    '### Operating system\nWindows 11',
    '![ticket](https://github.com/user-attachments/assets/2)',
  ].join('\n\n');
  assert.deepEqual(
    checkIssue({ title: 'Crash when printing', body: form, labels: [], config }),
    []
  );
  const bilingual = form
    .replace('Steps to reproduce', 'Steps to reproduce / Pasos para reproducir')
    .replace('Operating system', 'Operating system / Sistema operativo');
  assert.deepEqual(
    checkIssue({ title: 'Crash when printing', body: bilingual, labels: [], config }),
    []
  );
  const feature = checkIssue({
    title: 'Possible XSS in receipts',
    body: 'The receipt template renders raw HTML from the name.',
    labels: [],
    config,
  });
  assert.deepEqual(ids(feature), ['security-report:suggestion']);
});

test('the comment groups repeated findings, speaks the author language and carries its key', () => {
  const findings = [
    {
      id: 'typo',
      severity: 'suggestion',
      params: { typo: 'teh', corrections: ['the'] },
      file: 'a.md',
      line: 1,
    },
    {
      id: 'typo',
      severity: 'suggestion',
      params: { typo: 'teh', corrections: ['the'] },
      file: 'b.md',
      line: 2,
    },
    {
      id: 'description',
      severity: 'blocking',
      params: { missing: ['why'], labels: [{ en: 'Why', es: 'Por qué' }] },
    },
  ];
  const body = renderComment({
    kind: 'pr',
    repo: 'o/r',
    config,
    author: 'ana',
    findings,
    language: 'es',
    key: 'abc123',
    rulesVersion: 'f'.repeat(64),
  });
  assert.equal(readMarker(body), 'abc123');
  assert.match(body, /¡Gracias por su contribución, @ana!/);
  assert.match(body, /\*\*Para avanzar\*\*/);
  assert.match(body, /`a\.md:1`, `b\.md:2`: Posible error de escritura `teh`/);
  assert.doesNotMatch(body, /\b(tienes|puedes|tu)\b/);
  const clean = renderComment({
    kind: 'pr',
    repo: 'o/r',
    config,
    author: 'ana',
    findings: [],
    language: 'en',
    key: 'k1',
    rulesVersion: 'r',
  });
  assert.match(clean, /Everything looks good/);
});

test('skip, ownership and outcome rules', () => {
  const base = { author: 'ana', association: 'CONTRIBUTOR', labels: [], draft: false, config };
  assert.equal(shouldSkip(base), null);
  assert.equal(shouldSkip({ ...base, draft: true }), 'draft');
  assert.equal(shouldSkip({ ...base, author: 'dependabot[bot]' }), 'automation author');
  assert.equal(
    shouldSkip({ ...base, author: 'johnny4young', association: 'OWNER' }),
    'maintainer without opt-in label'
  );
  assert.equal(
    shouldSkip({ ...base, author: 'johnny4young', association: 'OWNER', labels: ['triage'] }),
    null
  );

  const forged = { user: { type: 'User' }, body: '<!-- centinela key=abc -->' };
  const mine = { user: { type: 'Bot' }, body: '<!-- centinela key=def -->' };
  assert.equal(ownComment([forged]), null);
  assert.equal(ownComment([forged, mine]), mine);
  const newer = { user: { type: 'Bot' }, body: '<!-- centinela key=fed -->' };
  assert.equal(ownComment([mine, forged, newer]), newer);
  const own = {
    user: { type: 'Bot', login: 'centinela[bot]' },
    body: '<!-- centinela key=aaa -->',
  };
  const other = { user: { type: 'Bot', login: 'quoter[bot]' }, body: '<!-- centinela key=bbb -->' };
  assert.equal(ownComment([own, other], 'centinela[bot]'), own);
  assert.equal(ownComment([other], 'centinela[bot]'), null);
  assert.equal(readMarker('> quoted\n<!-- centinela key=ccc -->'), null);

  const blocking = [{ severity: 'blocking' }];
  assert.equal(outcome(blocking, false).state, 'failure');
  assert.equal(outcome(blocking, true).state, 'success');
  assert.equal(outcome([{ severity: 'suggestion' }], false).state, 'success');
});

test('target parsing fails without something to triage', () => {
  assert.throws(() => parseTarget([], {}), /pass --pr/);
  assert.deepEqual(parseTarget(['--pr', '7', '--dry-run', '--force'], {}), {
    kind: 'pr',
    number: 7,
    dryRun: true,
    force: true,
    configFile: null,
    action: null,
    ref: null,
  });
  assert.equal(parseTarget(['--pr', '7', '--force'], {}).force, false);
});

test('rules version is stable for the same sources and follows the project config', () => {
  assert.match(rulesVersion(config), /^[a-f0-9]{64}$/);
  assert.equal(rulesVersion(config), rulesVersion(config));
  assert.notEqual(rulesVersion(config), rulesVersion(defaults));
});

test('enrichment: dependency diff, pinned versions and locale gaps', async () => {
  assert.deepEqual(
    changedDependencies(
      { dependencies: { a: '1.0.0' } },
      { dependencies: { a: '1.0.0', b: '^2.1.0' } }
    ),
    [{ name: 'b', spec: '^2.1.0', field: 'dependencies' }]
  );
  assert.equal(pinnedVersion('^2.1.0'), '2.1.0');
  assert.equal(pinnedVersion('workspace:*'), null);

  const contents = {
    'package.json@base': '{"dependencies":{}}',
    'package.json@head': '{"dependencies":{"left-pad":"1.3.0"}}',
    'apps/web/src/i18n/locales/en/x.json@head': '{"a":{"b":"B","c":"C"}}',
    'apps/web/src/i18n/locales/es/x.json@head': '{"a":{"b":"B"}}',
  };
  const fileAt = async (name, ref) => contents[`${name}@${ref}`] ?? null;
  const deps = await dependencyChanges({
    files: [file('package.json')],
    fileAt,
    baseSha: 'base',
    headSha: 'head',
    lookup: async () => ({ license: 'WTFPL', ageDays: 3000 }),
  });
  assert.deepEqual(deps, [{ name: 'left-pad', version: '1.3.0', license: 'WTFPL', ageDays: 3000 }]);
  const gaps = await localeGaps({
    files: [file('apps/web/src/i18n/locales/en/x.json')],
    fileAt,
    headSha: 'head',
    parity: config.language.localeParity,
  });
  assert.deepEqual(gaps, [
    {
      file: 'apps/web/src/i18n/locales/en/x.json',
      missingIn: 'apps/web/src/i18n/locales/es/x.json',
      key: 'a.c',
    },
  ]);
});

test('typos runs on added lines only and maps results back to PR lines', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-typos-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'typos');
  const line = JSON.stringify({
    type: 'typo',
    path: './docs/a.md',
    line_num: 2,
    typo: 'teh',
    corrections: ['the'],
  });
  await writeFile(fake, `#!/bin/sh\necho '${line}'\nexit 2\n`);
  await chmod(fake, 0o755);
  const files = [{ filename: 'docs/a.md', patch: '@@ -1,1 +1,3 @@\n keep\n+fine\n+teh end' }];
  assert.deepEqual(await findTypos({ files, binary: fake }), [
    { file: 'docs/a.md', line: 3, typo: 'teh', corrections: ['the'] },
  ]);
  assert.equal(await findTypos({ files, binary: path.join(dir, 'missing') }), null);
  await assert.rejects(
    findTypos({ files, binary: path.join(dir, 'missing'), required: true }),
    /typos binary not found/
  );
});

function fakeClient({ pr, issue, comments = [] }) {
  const writes = [];
  return {
    writes,
    pull: async () => pr,
    issue: async () => issue,
    comments: async () => comments,
    pullFiles: async () => [file('docs/a.md', ['hello'])],
    pullCommits: async () => [],
    fileAt: async () => null,
    tree: async () => [],
    ensureLabel: async label => writes.push(['label', label.name]),
    upsertComment: async (number, existing, body) =>
      writes.push(['comment', existing?.id ?? null, body]),
    addLabels: async (number, labels) => writes.push(['add', ...labels]),
    removeLabel: async (number, name) => writes.push(['remove', name]),
    setStatus: async (sha, state) => writes.push(['status', sha, state]),
  };
}

test('a pull request is reviewed once per head, description and rules', async () => {
  process.env.TYPOS_BIN = '/nonexistent/typos';
  const pr = {
    number: 9,
    state: 'open',
    draft: false,
    title: 'docs(readme): fix wording',
    body: BODY,
    user: { login: 'ana' },
    author_association: 'CONTRIBUTOR',
    labels: [{ name: 'status: waiting-on-author' }],
    head: { sha: 'h1' },
    base: { sha: 'b1' },
  };
  const options = {
    config,
    number: 9,
    dryRun: false,
    force: false,
    repo: 'o/r',
    version: 'v1',
    log: () => {},
  };
  const first = fakeClient({ pr });
  await triagePullRequest({ ...options, client: first });
  const comment = first.writes.find(w => w[0] === 'comment');
  assert.ok(comment, 'expected a review comment');
  assert.deepEqual(
    first.writes.find(w => w[0] === 'status'),
    ['status', 'h1', 'success']
  );
  assert.ok(first.writes.some(w => w[0] === 'remove' && w[1] === 'status: waiting-on-author'));

  const again = fakeClient({ pr, comments: [{ id: 1, user: { type: 'Bot' }, body: comment[2] }] });
  await triagePullRequest({ ...options, client: again });
  assert.deepEqual(again.writes, [], 'an unchanged pull request must not be reviewed twice');

  const pushed = fakeClient({
    pr: { ...pr, head: { sha: 'h2' } },
    comments: [{ id: 1, user: { type: 'Bot' }, body: comment[2] }],
  });
  await triagePullRequest({ ...options, client: pushed });
  assert.equal(
    pushed.writes.find(w => w[0] === 'comment')[1],
    1,
    'a new push updates the same comment'
  );
});

test('a complete issue gets no comment, an incomplete one gets needs-info', async () => {
  const options = {
    config,
    number: 3,
    dryRun: false,
    force: false,
    repo: 'o/r',
    version: 'v1',
    log: () => {},
  };
  const base = {
    number: 3,
    state: 'open',
    user: { login: 'ana' },
    author_association: 'NONE',
    labels: [],
  };
  const fine = fakeClient({
    issue: {
      ...base,
      title: 'Add dark receipts',
      body: 'It would be great to print receipts with a darker font.',
    },
  });
  await triageIssue({ ...options, client: fine });
  assert.deepEqual(fine.writes, []);
  const bug = fakeClient({
    issue: {
      ...base,
      title: 'Crash on print',
      body: 'The app crashes when I print a long ticket.',
    },
  });
  await triageIssue({ ...options, client: bug });
  assert.deepEqual(
    bug.writes.map(w => w[0]),
    ['label', 'comment', 'add']
  );
});

test('a skipped maintainer pull request still gets a passing status', async () => {
  const pr = {
    state: 'open',
    draft: false,
    title: 'feat(x): y',
    body: '',
    user: { login: 'johnny4young' },
    author_association: 'OWNER',
    labels: [],
    head: { sha: 'h9' },
  };
  const client = fakeClient({ pr });
  const options = {
    config,
    number: 1,
    dryRun: false,
    force: false,
    repo: 'o/r',
    version: 'v1',
    log: () => {},
  };
  await triagePullRequest({ ...options, client });
  assert.deepEqual(client.writes, [['status', 'h9', 'success']]);
});

test('editing a comment from another bot identity falls back to a new comment', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init.method);
    const status = init.method === 'PATCH' ? 403 : 201;
    return new Response(status === 201 ? '{"id":2}' : 'forbidden', { status });
  };
  const client = createClient({ token: 't', repo: 'o/r', fetchImpl });
  const result = await client.upsertComment(5, { id: 1 }, 'body');
  assert.deepEqual(calls, ['PATCH', 'POST']);
  assert.deepEqual(result.data, { id: 2 });
});

test('incomplete API data fails closed and dependency licenses render as code', () => {
  const findings = checkSensitive({
    config,
    totals: { files: 3001, commits: 300 },
    commits: Array(250).fill({}),
    files: [
      file('src/huge.ts', [], { patch: undefined }),
      file('pnpm-lock.yaml', [], { patch: undefined }),
    ],
  });
  assert.deepEqual(ids(findings), ['sensitive-paths:maintainer', 'incomplete-diff:maintainer']);
  assert.deepEqual(findings[1].params, {
    files: [2, 3001],
    commits: [250, 300],
    unread: ['src/huge.ts', 'pnpm-lock.yaml'],
  });
  const incomplete = renderComment({
    kind: 'pr',
    repo: 'o/r',
    config,
    author: 'ana',
    findings: [
      {
        id: 'incomplete-diff',
        severity: 'maintainer',
        params: { files: null, commits: null, unread: ['[x](https://evil).ts'] },
      },
    ],
    language: 'en',
    key: 'k',
    rulesVersion: 'r',
  });
  assert.match(incomplete, /\(`\[x\]\(https:\/\/evil\)\.ts`\)/);
  const body = renderComment({
    kind: 'pr',
    repo: 'o/r',
    config,
    author: 'ana',
    findings: [
      {
        id: 'dependency',
        severity: 'maintainer',
        params: { name: 'x', version: '1.0.0', license: '[click](https://evil)' },
      },
    ],
    language: 'en',
    key: 'k',
    rulesVersion: 'r',
  });
  assert.match(body, /\(`\[click\]\(https:\/\/evil\)`\)/);
});

test('results are dropped when the pull request moves during the review', async () => {
  process.env.TYPOS_BIN = '/nonexistent/typos';
  const pr = {
    state: 'open',
    draft: false,
    title: 'docs(readme): fix wording',
    body: BODY,
    user: { login: 'ana' },
    author_association: 'CONTRIBUTOR',
    labels: [],
    head: { sha: 'old' },
    base: { sha: 'b' },
  };
  const client = fakeClient({ pr });
  let calls = 0;
  client.pull = async () => (calls++ === 0 ? pr : { ...pr, head: { sha: 'new' } });
  const options = {
    config,
    number: 1,
    dryRun: false,
    force: false,
    repo: 'o/r',
    version: 'v1',
    log: () => {},
  };
  await triagePullRequest({ ...options, client });
  assert.deepEqual(
    client.writes.filter(w => w[0] !== 'label'),
    []
  );
});

test('overrides count as dependency changes and the lockfile needs a maintainer', () => {
  const changes = changedDependencies(
    { pnpm: { overrides: { a: '1.0.0' } } },
    { pnpm: { overrides: { a: '1.0.1' } }, resolutions: { b: '2.0.0' } }
  );
  assert.deepEqual(
    changes.map(c => `${c.field}:${c.name}`),
    ['pnpm.overrides:a', 'resolutions:b']
  );
  assert.ok(matcher(config.paths.sensitive)('pnpm-lock.yaml'));
});

test('an approval covers only the head it was given on', async () => {
  process.env.TYPOS_BIN = '/nonexistent/typos';
  const pr = {
    state: 'open',
    draft: false,
    title: 'docs(readme): fix wording',
    body: BODY,
    user: { login: 'ana' },
    author_association: 'CONTRIBUTOR',
    labels: [{ name: 'triage: approved' }],
    head: { sha: 'aaa' },
    base: { sha: 'b' },
  };
  const options = {
    config,
    number: 1,
    dryRun: false,
    force: false,
    repo: 'o/r',
    version: 'v1',
    log: () => {},
  };
  const run = async (prState, extra, comments = []) => {
    const client = fakeClient({ pr: prState, comments });
    client.pullFiles = async () => [file('.github/workflows/ci.yml')];
    await triagePullRequest({ ...options, client, ...extra });
    return client;
  };

  // The label event carried an older head than the PR has now: not approved.
  const raced = await run(
    { ...pr, head: { sha: 'bbb' } },
    { action: 'labeled', eventLabel: 'triage: approved', eventHeadSha: 'aaa' }
  );
  assert.ok(raced.writes.some(w => w[0] === 'remove' && w[1] === 'triage: approved'));
  assert.deepEqual(
    raced.writes.find(w => w[0] === 'status'),
    ['status', 'bbb', 'failure']
  );

  const approved = await run(pr, {
    action: 'labeled',
    eventLabel: 'triage: approved',
    eventHeadSha: 'aaa',
  });
  assert.deepEqual(
    approved.writes.find(w => w[0] === 'status'),
    ['status', 'aaa', 'success']
  );
  const comment = approved.writes.find(w => w[0] === 'comment')[2];
  assert.match(comment, /approved=aaa -->/);
  const previous = [{ id: 1, user: { type: 'Bot' }, body: comment }];

  // Any later run keeps it on the same head, even if a cancelled run never removed the label.
  const edited = await run(
    { ...pr, title: 'docs(readme): fix more wording' },
    { action: 'edited' },
    previous
  );
  assert.deepEqual(
    edited.writes.find(w => w[0] === 'status'),
    ['status', 'aaa', 'success']
  );
  const pushed = await run({ ...pr, head: { sha: 'ccc' } }, { action: 'edited' }, previous);
  assert.ok(pushed.writes.some(w => w[0] === 'remove' && w[1] === 'triage: approved'));
  assert.deepEqual(
    pushed.writes.find(w => w[0] === 'status'),
    ['status', 'ccc', 'failure']
  );
});

test('renames out of a sensitive path need a maintainer', () => {
  const findings = checkSensitive({
    config,
    files: [
      file('docs/moved.yml', ['x'], {
        status: 'renamed',
        previous_filename: '.github/workflows/ci.yml',
      }),
    ],
  });
  assert.deepEqual(ids(findings), ['sensitive-paths:maintainer']);
});

test('config: defaults, project overrides and the sensitive floor', () => {
  assert.equal(defaults.statusContext, 'centinela');
  assert.ok(matcher(defaults.paths.sensitive)('.github/workflows/ci.yml'));
  const project = resolveConfig({ paths: { sensitive: ['infra/**'] }, maintainers: ['ana'] });
  assert.ok(matcher(project.paths.sensitive)('infra/main.tf'));
  assert.ok(matcher(project.paths.sensitive)('.github/workflows/ci.yml'));
  assert.deepEqual(project.maintainers, ['ana']);
  assert.equal(project.labels.size.XL.max, 1500);
  assert.throws(() => parseConfig('{nope'), /invalid config/);
  assert.throws(() => resolveConfig({ size: { justifyFrom: 'HUGE' } }), /justifyFrom/);
});

test('config is read from the base branch, never from the pull request', async () => {
  const reads = [];
  const client = {
    repository: async () => ({ default_branch: 'main' }),
    fileAt: async (name, ref) => {
      reads.push(`${name}@${ref}`);
      return '{"maintainers":["ana"]}';
    },
  };
  assert.deepEqual((await loadConfig({ client, ref: 'basesha' })).maintainers, ['ana']);
  await loadConfig({ client });
  assert.deepEqual(reads, ['.github/centinela.json@basesha', '.github/centinela.json@main']);
  const missing = await loadConfig({ client: { ...client, fileAt: async () => null }, ref: 'x' });
  assert.deepEqual(missing.maintainers, []);
});

test('only the opt-in, approval and bug labels trigger a review', () => {
  assert.ok(relevantEvent({ action: 'opened' }, config));
  assert.ok(relevantEvent({ action: 'labeled', eventLabel: 'triage: approved' }, config));
  assert.ok(!relevantEvent({ action: 'labeled', eventLabel: 'size/XS' }, config));
});

test('the comment links the project security policy and rules', () => {
  const findings = [{ id: 'security-report', severity: 'suggestion', params: {} }];
  const options = {
    kind: 'issue',
    repo: 'o/r',
    author: 'ana',
    findings,
    key: 'k',
    rulesVersion: 'abcdef1234',
  };
  const es = renderComment({ ...options, config, language: 'es' });
  assert.match(es, /\(https:\/\/github\.com\/o\/r\/blob\/HEAD\/docs\/es\/SECURITY\.md\)/);
  assert.match(es, /\[reglas abcdef12\]\(https:\/\/github\.com\/o\/r\/blob\/HEAD\/docs\/es\//);
  const plain = renderComment({ ...options, config: defaults, language: 'en' });
  assert.match(plain, /\(https:\/\/github\.com\/o\/r\/security\/policy\)/);
  assert.match(
    plain,
    /\[Centinela\]\(https:\/\/github\.com\/johnny4young\/centinela\) · rules abcdef12 ·/
  );
});

test('the example workflow filters the same labels the defaults use', () => {
  const workflow = readFileSync(new URL('../examples/centinela.yml', import.meta.url), 'utf8');
  for (const label of [defaults.optInLabel, defaults.overrideLabel, defaults.issues.bugLabel]) {
    assert.match(workflow, new RegExp(`"${label}"`));
  }
  assert.doesNotMatch(workflow, /actions\/checkout/, 'the caller must never check out PR code');
});

test('bug titles are recognized by everyday wording in both languages', () => {
  const body = 'It happens every time I print a long ticket from the sales screen.';
  for (const title of [
    'La app se cierra al imprimir',
    'El inventario no carga',
    'Pantalla en blanco al iniciar',
    "Printing doesn't work",
    'App hangs on startup',
    "Window won't open",
  ]) {
    const findings = checkIssue({ title, body, labels: [], config });
    assert.ok(
      findings.some(f => f.id === 'issue-incomplete'),
      `expected a bug report check for: ${title}`
    );
  }
  assert.deepEqual(checkIssue({ title: 'Agregar recibos oscuros', body, labels: [], config }), []);
});

test('stack detection reads manifests and tracked paths, and skips fixtures', async () => {
  const { detectPacks, detectStack, manifestPaths } = await import('../src/lib/packs.mjs');
  assert.deepEqual(
    manifestPaths(['package.json', 'apps/web/package.json', 'test/fixtures/app/package.json']),
    ['package.json', 'apps/web/package.json']
  );
  assert.deepEqual(
    detectPacks({
      paths: ['project.yml', 'Cargo.toml'],
      manifests: [{ dependencies: { react: '19' } }, { devDependencies: { electron: '45' } }],
    }),
    ['electron', 'react', 'swift', 'rust']
  );
  const files = {
    'package.json': '{"devDependencies":{"vitest":"5"}}',
    'packages/server/package.json': '{"dependencies":{"fastify":"5"}}',
  };
  const client = {
    tree: async () => ['package.json', 'packages/server/package.json', 'src/a.ts'],
    fileAt: async name => files[name] ?? null,
  };
  assert.deepEqual((await detectStack({ client, ref: 'b' })).packs, ['node-server']);
  assert.deepEqual(
    (await detectStack({ client, ref: 'b', setting: ['swift'], legacy: { electron: true } })).packs,
    ['swift', 'electron']
  );
});

test('stack packs add paths and rules that review added lines', async () => {
  const { applyStack } = await import('../src/lib/packs.mjs');
  const { checkPatterns } = await import('../src/lib/checks.mjs');
  const stack = { packs: ['electron', 'swift', 'node-server'], paths: ['project.yml'] };
  const { config: effective, rules } = applyStack(defaults, stack);
  assert.ok(matcher(effective.paths.sensitive)('apps/desktop/src/preload/index.ts'));
  assert.ok(matcher(effective.paths.tests)('Apps/Gancho/GanchoTests/StoreTests.swift'));
  const findings = checkPatterns({
    config: effective,
    rules,
    files: [
      file('apps/desktop/src/preload/index.ts', ["import { readFile } from 'node:fs';"]),
      file('apps/desktop/src/main/window.ts', ['  sandbox: false,', 'ipcRenderer.sendSync("x")']),
      file('Apps/Gancho/Store.swift', [
        'final class A: @unchecked Sendable {}',
        'final class B: @unchecked Sendable {} // guarded by lock',
        'DispatchQueue.main.sync { }',
      ]),
      file('Apps/Gancho/GanchoTests/StoreTests.swift', ['DispatchQueue.main.sync { }']),
      file('Gancho.xcodeproj/project.pbxproj', ['x']),
      file('packages/server/src/routes/a.ts', ['const x = readFileSync(p)']),
    ],
  });
  assert.deepEqual(ids(findings), [
    'electron-hardening:blocking',
    'electron-preload-node:blocking',
    'electron-sync-ipc:maintainer',
    'swift-unchecked-sendable:maintainer',
    'swift-main-sync:maintainer',
    'swift-xcodeproj-edit:maintainer',
    'server-sync-io:suggestion',
  ]);
  const withoutXcodegen = applyStack(defaults, { packs: ['swift'], paths: [] });
  assert.ok(!withoutXcodegen.rules.some(r => r.id === 'swift-xcodeproj-edit'));
});

test('project rules turn AGENTS.md invariants into checks', async () => {
  const { checkPatterns } = await import('../src/lib/checks.mjs');
  const project = resolveConfig({
    rules: {
      custom: [
        {
          id: 'no-rest-routes',
          severity: 'blocking',
          paths: ['packages/server/src/routes/**'],
          message: { en: 'Use tRPC, not REST.', es: 'Use tRPC, no REST.' },
        },
        {
          id: 'tenant-scope',
          severity: 'maintainer',
          pattern: '\\.from\\(',
          unless: 'tenantId',
          paths: ['packages/server/src/trpc/routers/**'],
          message: 'Every query must scope by ctx.tenantId.',
        },
      ],
    },
  });
  const findings = checkPatterns({
    config: project,
    files: [
      file('packages/server/src/routes/new.ts', ['x']),
      file('packages/server/src/trpc/routers/a.ts', [
        'db.select().from(sales)',
        'db.select().from(sales).where(eq(sales.tenantId, ctx.tenantId))',
      ]),
    ],
  });
  assert.deepEqual(ids(findings), ['no-rest-routes:blocking', 'tenant-scope:maintainer']);
  const body = renderComment({
    kind: 'pr',
    repo: 'o/r',
    config: project,
    author: 'ana',
    findings,
    language: 'es',
    key: 'k',
    rulesVersion: 'r',
    stack: ['electron', 'react'],
  });
  assert.match(body, /`packages\/server\/src\/routes\/new\.ts`: Use tRPC, no REST\./);
  assert.match(body, /Every query must scope by ctx\.tenantId\./);
  assert.match(body, /stack: Electron, React/);
  for (const bad of [
    { id: 'Bad Id', severity: 'blocking', pattern: 'x', message: 'm' },
    { id: 'ok', severity: 'fatal', pattern: 'x', message: 'm' },
    { id: 'ok', severity: 'blocking', message: 'm' },
    { id: 'ok', severity: 'blocking', pattern: '(', message: 'm' },
    { id: 'ok', severity: 'blocking', pattern: 'x' },
  ]) {
    assert.throws(() => resolveConfig({ rules: { custom: [bad] } }), /rules\.custom\[0\]/);
  }
  assert.throws(() => resolveConfig({ stack: 'swift' }), /stack must be/);
});

test('workflow changes are checked for injection, privileged checkouts and timeouts', async () => {
  const { checkWorkflows, jobs, runLines } = await import('../src/lib/workflows.mjs');
  const content = [
    'on:',
    '  pull_request_target:',
    'permissions: write-all',
    'jobs:',
    '  greet:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v7',
    '        with:',
    '          ref: ${{ github.event.pull_request.head.sha }}',
    '      - uses: someone/tool@v2',
    '      - uses: johnny4young/centinela@v1',
    '      - name: Echo',
    '        env:',
    '          TITLE: ${{ github.event.pull_request.title }}',
    '        run: |',
    '          echo "${{ github.event.pull_request.title }}"',
    '          echo "$TITLE ${{ github.event.pull_request.number }}"',
    '        timeout-minutes: 1',
    '  safe:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 5',
    '    steps:',
    '      - run: echo ok',
  ].join('\n');
  assert.deepEqual(
    [...runLines(content)].sort((a, b) => a - b),
    [17, 18, 24]
  );
  assert.deepEqual(
    jobs(content).map(j => [j.name, j.timeout]),
    [
      ['greet', false],
      ['safe', true],
    ]
  );
  const lines = content.split('\n');
  const files = [
    {
      filename: '.github/workflows/greet.yml',
      status: 'added',
      patch: `@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}`,
    },
  ];
  const findings = checkWorkflows({
    files,
    owner: 'johnny4young',
    workflows: [{ file: '.github/workflows/greet.yml', content }],
  });
  assert.deepEqual(findings.map(f => `${f.id}:${f.line}`).sort(), [
    'workflow-injection:17',
    'workflow-pr-target-checkout:10',
    'workflow-timeout:5',
    'workflow-unpinned-action:11',
    'workflow-write-all:3',
  ]);
});

test('a pull request review uses the detected stack and fetches changed workflows', async () => {
  process.env.TYPOS_BIN = '/nonexistent/typos';
  const pr = {
    state: 'open',
    draft: false,
    title: 'ci(repo): add a greeting',
    body: BODY,
    user: { login: 'ana' },
    author_association: 'CONTRIBUTOR',
    labels: [],
    head: { sha: 'h' },
    base: { sha: 'b' },
  };
  const client = fakeClient({ pr });
  const workflow =
    'on: issues\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi';
  client.tree = async () => ['package.json'];
  client.fileAt = async (name, ref) =>
    name === 'package.json' && ref === 'b'
      ? '{"dependencies":{"react":"19"}}'
      : name === '.github/workflows/a.yml' && ref === 'h'
        ? workflow
        : null;
  client.pullFiles = async () => [
    file('.github/workflows/a.yml', workflow.split('\n'), { status: 'added' }),
    file('src/App.tsx', ['<div dangerouslySetInnerHTML={x} />']),
  ];
  const options = {
    number: 1,
    dryRun: true,
    force: false,
    repo: 'o/r',
    version: 'v',
    log: () => {},
  };
  const { findings } = await triagePullRequest({ ...options, client, config: defaults });
  const found = findings.map(f => f.id);
  assert.ok(found.includes('react-dangerous-html'));
  assert.ok(found.includes('workflow-timeout'));
});

test('workflow checks resist YAML tricks and review a newly privileged workflow in full', async () => {
  const { checkWorkflows, runLines, untrusted } = await import('../src/lib/workflows.mjs');
  assert.ok(untrusted("echo ${{ format('{0}', github.event.issue.title) }}"));
  assert.ok(untrusted('echo ${{ toJSON(github.event) }}'));
  assert.ok(
    !untrusted('echo ${{ github.event.pull_request.number }} ${{ github.event.inputs.name }}')
  );
  assert.ok(untrusted(`echo \${{ github['event']["issue"]['title'] }}`));
  assert.ok(untrusted('echo ${{ github.event.workflow_run.head_branch }}'));
  assert.ok(untrusted('echo ${{ github.event.workflow_run.display_title }}'));
  assert.ok(untrusted('echo ${{ toJSON(github.event.pull_request) }}'));
  assert.ok(
    !untrusted('echo ${{ github.event.pull_request.head.sha }} ${{ github.event.sender.login }}')
  );
  const tricky = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: | # comment',
    '          echo "${{ github.event.issue.body }}"',
    '      - run: "echo one',
    '          ${{ github.head_ref }}"',
  ].join('\n');
  assert.deepEqual(
    [...runLines(tricky)].sort((a, b) => a - b),
    [5, 6, 7]
  );

  const base = [
    'on:',
    '  issues:',
    'jobs:',
    '  a:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 5',
    '    steps:',
    '      - run: echo "${{ github.event.issue.title }}"',
  ];
  const head = [...base];
  head.splice(2, 0, '  workflow_run:');
  const content = head.join('\n');
  const files = [
    {
      filename: '.github/workflows/a.yml',
      status: 'modified',
      patch: '@@ -2,0 +3,1 @@\n+  workflow_run:',
    },
    { filename: '.github/workflows/b.yml', status: 'modified', patch: '@@ -1,0 +1,1 @@\n+x' },
  ];
  const { PR_HEAD_REF } = await import('../src/lib/workflows.mjs');
  assert.ok(PR_HEAD_REF.test('ref: ${{ github.event.workflow_run.head_sha }}'));
  const findings = checkWorkflows({
    files,
    owner: 'o',
    workflows: [
      { file: '.github/workflows/a.yml', content },
      { file: '.github/workflows/b.yml', content: null },
    ],
  });
  assert.deepEqual(
    findings.map(f => `${f.id}:${f.line}`),
    ['workflow-injection:9', 'workflow-unread:null']
  );
});

test('security pack rules also scan test files', async () => {
  const { applyStack } = await import('../src/lib/packs.mjs');
  const { checkPatterns } = await import('../src/lib/checks.mjs');
  const { config: effective, rules } = applyStack(defaults, { packs: ['electron'], paths: [] });
  const findings = checkPatterns({
    config: effective,
    rules,
    files: [file('src/__tests__/window.test.ts', ['  sandbox: false,', 'readFileSync(p)'])],
  });
  assert.deepEqual(ids(findings), ['electron-hardening:blocking']);
});
