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
    'electron-hardening:blocking',
    'hidden-unicode:blocking',
    'dynamic-code:maintainer',
    'lifecycle-script:maintainer',
    'authorship:maintainer',
    'binary:maintainer',
  ]);
  const generic = checkSensitive({
    config: defaults,
    files: [file('src/window.ts', ['  sandbox: false,'])],
  });
  assert.deepEqual(generic, [], 'the Electron rules apply only when enabled');
});

test('identity flags only unsigned maintainer commits from outside contributors', () => {
  const commits = [
    { sha: 'aaaaaaa1', authorLogin: 'johnny4young', verified: false, message: 'x' },
    { sha: 'bbbbbbb2', authorLogin: 'johnny4young', verified: true, message: 'x' },
    {
      sha: 'ccccccc3',
      authorLogin: 'someone',
      verified: false,
      message: 'x\n\nCo-authored-by: johnny4young <x@y>',
    },
  ];
  assert.deepEqual(
    checkIdentity({ author: 'someone', commits, config }).map(f => f.params.sha),
    ['aaaaaaa', 'ccccccc']
  );
  assert.deepEqual(checkIdentity({ author: 'johnny4young', commits, config }), []);
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
