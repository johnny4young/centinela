import { addedLines, matcher, section, sections, words } from './core.mjs';
import { checkWorkflows } from './workflows.mjs';

export const SEVERITIES = ['blocking', 'maintainer', 'suggestion'];

const CONVENTIONAL_TITLE =
  /^(feat|fix|refactor|docs|build|chore|ci|test|perf|style|revert)(\([\w./-]+\))?!?: \S/;
const MEDIA = /!\[[^\]]*\]\([^)]+\)|<img\s|<video\s|https:\/\/github\.com\/user-attachments\//i;
const ISSUE_LINK = /(?:^|\s)#\d+\b|github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/;
const BINARY = /\.(node|exe|dll|so|dylib|wasm|bin|zip|tgz|gz|jar|dmg|msi|appimage)$/i;

const VOSEO = words(
  'tenés podés querés sabés hacés decís sos vos ingresá seleccioná elegí agregá guardá buscá escaneá verificá probá mirá andá confirmá intentá revisá tocá hacé poné tené configurá creá indicá'.split(
    ' '
  )
);
const TUTEO = words(
  'tienes puedes quieres deseas necesitas debes eres estás tu tus contigo elige haz'.split(' ')
);

const SUSPICIOUS = [
  { id: 'hidden-unicode', severity: 'blocking', pattern: /[‪-‮⁦-⁩​-‍⁠﻿]/ },
  {
    id: 'secret',
    severity: 'blocking',
    pattern:
      /AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|sk-ant-[\w-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  { id: 'dynamic-code', severity: 'maintainer', pattern: /\beval\s*\(|\bnew\s+Function\s*\(/ },
  {
    id: 'process-spawn',
    severity: 'maintainer',
    pattern: /\bchild_process\b|\bexecSync\s*\(|\bspawnSync\s*\(/,
  },
  {
    id: 'pipe-to-shell',
    severity: 'maintainer',
    pattern: /\b(curl|wget)\b[^|\n]*\|\s*(ba|z)?sh\b/,
  },
  {
    id: 'obfuscation',
    severity: 'maintainer',
    pattern:
      /(\\x[0-9a-fA-F]{2}){8,}|String\.fromCharCode\((\s*\d+\s*,){6,}|[A-Za-z0-9+/]{200,}={0,2}/,
  },
];
const LIFECYCLE = /"(pre|post)?install"\s*:|"prepare"\s*:|"prepublish(Only)?"\s*:/;
const AUTHORSHIP = /"(author|contributors|maintainers)"\s*:|copyright\s*(\(c\)|©)|©\s*\d{4}/i;
const OBFUSCATION_EXEMPT = matcher([
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/bun.lock',
  '**/go.sum',
  '**/Cargo.lock',
  '**/*.svg',
  '**/*.snap',
  '**/__snapshots__/**',
]);

function finding(id, severity, params = {}, location = {}) {
  return { id, severity, params, ...location };
}

export function sizeOf(files, config) {
  const ignored = matcher(config.size.ignore);
  const counted = files.filter(file => !ignored(file.filename));
  const lines = counted.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  const buckets = Object.entries(config.labels.size);
  const [label] = buckets.find(([, bucket]) => bucket.max === null || lines <= bucket.max);
  return { lines, label, files: counted.length };
}

export function checkSize(ctx) {
  const { lines, label } = sizeOf(ctx.files, ctx.config);
  const order = Object.keys(ctx.config.labels.size);
  if (order.indexOf(label) < order.indexOf(ctx.config.size.justifyFrom)) return [];
  const severity = label === order.at(-1) ? 'maintainer' : 'suggestion';
  return [finding('size', severity, { lines, label })];
}

export function checkDescription(ctx) {
  const results = [];
  const rules = ctx.config.pullRequest;
  // A pasted title can carry a line break; GitHub shows it but commit subjects break on it.
  const multiline = /[\r\n]/.test(ctx.title.trim());
  const title = ctx.title.replace(/\s+/g, ' ').trim();
  if (multiline) results.push(finding('title-lines', 'blocking', { title }));
  if (rules.conventionalTitle && !CONVENTIONAL_TITLE.test(title))
    results.push(finding('title', 'blocking', { title }));
  const parsed = sections(ctx.body ?? '');
  const required = Array.isArray(rules.sections) ? rules.sections : [];
  const missing = required.filter(({ names }) => !section(parsed, names));
  if (missing.length) {
    results.push(
      finding('description', 'blocking', {
        missing: missing.map(s => s.id),
        labels: missing.map(s => s.label ?? { en: s.names[0] }),
      })
    );
  }
  return results;
}

export function checkEvidence(ctx) {
  const results = [];
  const isUi = matcher(ctx.config.paths.ui);
  const isSource = matcher(ctx.config.paths.source);
  const isTest = matcher(ctx.config.paths.tests);
  const body = ctx.body ?? '';
  const type = ctx.title.match(/^(\w+)/)?.[1];

  const uiFiles = ctx.files.filter(
    file => isUi(file.filename) && !isTest(file.filename) && file.status !== 'removed'
  );
  if (uiFiles.length && !MEDIA.test(body)) {
    results.push(finding('screenshots', 'blocking', { files: uiFiles.map(f => f.filename) }));
  }
  if (type === 'fix' && !ISSUE_LINK.test(body)) {
    const sectionsList = Array.isArray(ctx.config.pullRequest.sections)
      ? ctx.config.pullRequest.sections
      : [];
    const howTo = sectionsList.find(s => s.id === 'howToTest');
    const steps = (howTo ? section(sections(body), howTo.names) : body) ?? '';
    if (!/^\s*(\d+\.|-)\s+\S/m.test(steps)) results.push(finding('reproduction', 'suggestion'));
  }
  const sourceAdded = ctx.files
    .filter(file => isSource(file.filename) && !isTest(file.filename))
    .reduce((sum, file) => sum + file.additions, 0);
  const testsTouched = ctx.files.some(file => isTest(file.filename));
  if (sourceAdded > 0 && !testsTouched) {
    const severity =
      (type === 'feat' || type === 'fix') && sourceAdded > 20 ? 'blocking' : 'suggestion';
    results.push(finding('tests', severity, { lines: sourceAdded }));
  }
  return results;
}

export function checkLanguage(ctx) {
  const results = [];
  const register = ctx.config.language.spanishRegister;
  const isSpanish = matcher(register?.paths ?? []);
  // Usted copy rejects voseo and tú; tú copy rejects only voseo.
  const forms = register?.register === 'tu' ? [VOSEO] : [VOSEO, TUTEO];
  for (const file of register ? ctx.files : []) {
    if (!isSpanish(file.filename)) continue;
    for (const { line, text } of addedLines(file.patch)) {
      const value = text.match(/:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
      if (!value) continue;
      const found = forms.flatMap(form => value.match(form) ?? []);
      if (found.length) {
        results.push(
          finding(
            'dialect',
            'blocking',
            { words: found, register: register.register ?? 'usted' },
            { file: file.filename, line }
          )
        );
      }
    }
  }
  for (const gap of ctx.localeGaps ?? []) {
    results.push(finding('locale-parity', 'blocking', gap, { file: gap.file }));
  }
  for (const typo of (ctx.typos ?? []).slice(0, 15)) {
    results.push(
      finding(
        'typo',
        'suggestion',
        { typo: typo.typo, corrections: typo.corrections },
        { file: typo.file, line: typo.line }
      )
    );
  }
  return results;
}

export function checkSensitive(ctx) {
  const results = [];
  const isSensitive = matcher(ctx.config.paths.sensitive);
  // A rename out of a sensitive path is as risky as an edit inside it.
  const touched = ctx.files
    .filter(
      file =>
        isSensitive(file.filename) ||
        (file.previous_filename && isSensitive(file.previous_filename))
    )
    .map(file => file.filename);
  if (touched.length) results.push(finding('sensitive-paths', 'maintainer', { files: touched }));

  // Fail closed on unread files, except non-sensitive generated metadata (e.g. migration snapshots).
  const isGenerated = matcher(ctx.config.paths.generated ?? []);
  const unread = ctx.files
    .filter(
      file =>
        !file.patch &&
        file.status !== 'removed' &&
        !BINARY.test(file.filename) &&
        !(isGenerated(file.filename) && !isSensitive(file.filename))
    )
    .map(file => file.filename);
  const files = ctx.totals?.files > ctx.files.length ? [ctx.files.length, ctx.totals.files] : null;
  const commitCount = ctx.commits?.length ?? 0;
  const commits = ctx.totals?.commits > commitCount ? [commitCount, ctx.totals.commits] : null;
  if (files || commits || unread.length) {
    results.push(finding('incomplete-diff', 'maintainer', { files, commits, unread }));
  }

  for (const file of ctx.files) {
    if (!file.patch && file.status !== 'removed' && BINARY.test(file.filename)) {
      results.push(finding('binary', 'maintainer', {}, { file: file.filename }));
    }
    const lines = addedLines(file.patch);
    const isManifest = file.filename === 'package.json' || file.filename.endsWith('/package.json');
    for (const { line, text } of lines) {
      if (isManifest && LIFECYCLE.test(text)) {
        results.push(finding('lifecycle-script', 'maintainer', {}, { file: file.filename, line }));
      }
      if (AUTHORSHIP.test(text)) {
        results.push(finding('authorship', 'maintainer', {}, { file: file.filename, line }));
      }
      for (const rule of SUSPICIOUS) {
        if (rule.id === 'obfuscation' && OBFUSCATION_EXEMPT(file.filename)) continue;
        if (rule.pattern.test(text)) {
          results.push(finding(rule.id, rule.severity, {}, { file: file.filename, line }));
        }
      }
    }
  }
  return results;
}

export function checkIdentity(ctx) {
  const maintainers = new Set(ctx.config.maintainers.map(login => login.toLowerCase()));
  if (maintainers.has(ctx.author.toLowerCase())) return [];
  const results = [];
  for (const commit of ctx.commits ?? []) {
    const author = commit.authorLogin?.toLowerCase();
    const committer = commit.committerLogin?.toLowerCase();
    // A valid signature proves only who committed, so a maintainer identity counts only
    // when that maintainer signed the commit.
    const signedBy = commit.verified && committer ? committer : null;
    const trailers = [...commit.message.matchAll(/^co-authored-by:(.*)$/gim)].map(m =>
      m[1].toLowerCase()
    );
    const spoofedAuthor = author && maintainers.has(author) && signedBy !== author;
    const spoofedTrailer =
      !maintainers.has(signedBy) &&
      trailers.some(trailer => [...maintainers].some(m => trailer.includes(m)));
    if (spoofedAuthor || spoofedTrailer)
      results.push(finding('impersonation', 'maintainer', { sha: commit.sha.slice(0, 7) }));
  }
  return results;
}

export function checkDependencies(ctx) {
  const results = [];
  const blocked = ctx.config.deps.blockedLicenses;
  for (const dep of ctx.dependencies ?? []) {
    const license = dep.license ?? '';
    if (blocked.some(prefix => license.toUpperCase().startsWith(prefix))) {
      results.push(finding('dep-license', 'blocking', dep));
    } else if (dep.ageDays !== null && dep.ageDays < ctx.config.deps.minAgeDays) {
      results.push(
        finding('dep-age', 'blocking', { ...dep, minAgeDays: ctx.config.deps.minAgeDays })
      );
    } else {
      results.push(finding('dependency', 'maintainer', dep));
    }
  }
  return results;
}

/** Compile the project's own rules from the config into the shape pack rules use. */
export function customRules(config) {
  return (config.rules.custom ?? []).map(rule => ({
    ...rule,
    pattern: rule.pattern
      ? new RegExp(rule.pattern, (rule.flags ?? '').replace(/[gy]/g, ''))
      : null,
    unless: rule.unless ? new RegExp(rule.unless) : null,
  }));
}

/** Stack and project rules: a pattern fires per added line, a path-only rule once per file. */
export function checkPatterns(ctx) {
  const results = [];
  const isTest = matcher(ctx.config.paths.tests);
  const rules = [...(ctx.rules ?? []), ...customRules(ctx.config)];
  for (const rule of rules) {
    const inPaths = rule.paths ? matcher(rule.paths) : () => true;
    const excluded = matcher(rule.exclude ?? []);
    const params = rule.message ? { message: rule.message } : {};
    for (const file of ctx.files) {
      const name = file.filename;
      if (file.status === 'removed' || !inPaths(name) || excluded(name)) continue;
      if (!rule.tests && isTest(name)) continue;
      if (!rule.pattern) {
        results.push(finding(rule.id, rule.severity, params, { file: name }));
        continue;
      }
      for (const { line, text } of addedLines(file.patch)) {
        if (rule.pattern.test(text) && !rule.unless?.test(text)) {
          results.push(finding(rule.id, rule.severity, params, { file: name, line }));
        }
      }
    }
  }
  return results;
}

export function checkPullRequest(ctx) {
  const owner = ctx.repo?.split('/')[0];
  return [
    ...checkDescription(ctx),
    ...checkSize(ctx),
    ...checkEvidence(ctx),
    ...checkLanguage(ctx),
    ...checkSensitive(ctx),
    ...checkPatterns(ctx),
    ...(ctx.config.rules.workflows === false ? [] : checkWorkflows({ ...ctx, owner })),
    ...checkIdentity(ctx),
    ...checkDependencies(ctx),
  ];
}

const BUG_TITLE = words([
  ...'bug bugs error errores crash crashes crashed crashea falla falló fallo problema broken fails failing freeze freezes frozen congela hangs exception excepción regression regresión roto rota wrong incorrecto'.split(
    ' '
  ),
  ...['no funciona', 'deja de funcionar', 'se cierra', 'se cuelga', 'se traba', 'se bloquea'],
  ...['no abre', 'no carga', 'no inicia', 'no arranca', 'no imprime', 'no guarda'],
  ...['pantalla en blanco', 'not working', "doesn't work", 'does not work', 'stopped working'],
  ...["won't open", "won't start", 'blank screen', 'stack trace'],
]);
const SECURITY = words(
  'vulnerability vulnerabilidad exploit cve xss injection inyección rce bypass'.split(' ')
);
const REPRO = ['steps to reproduce', 'pasos para reproducir', 'reproduction', 'reproducción'];
const EXPECTED = ['expected behavior', 'comportamiento esperado', 'expected', 'esperado'];
const ACTUAL = ['actual behavior', 'comportamiento actual', 'actual'];
const VERSION = ['version', 'versión', 'app version', 'versión de la app'];
const PLATFORM = ['operating system', 'sistema operativo', 'platform', 'plataforma', 'os'];

const CODE_REF_LINE = /[\w./-]+\.(?:[cm]?[jt]sx?|swift|go|rs|py|sql|sh):\d+/;

/** Engineering bug reports cite source locations directly and do not need end-user OS/version forms. */
export function isCodeBugReport(title = '', body = '') {
  if (body.trim().length < 120) return false;
  const hasCodeRef = CODE_REF_LINE.test(body);
  const hasStructuredAnalysis = /^##\s+(where|impact|root cause|suggested direction|context)\b/im.test(
    body
  );
  const conventionalFix = /^fix(\([\w./-]+\))?:/i.test(title.trim());
  return hasCodeRef && (hasStructuredAnalysis || conventionalFix);
}

export function checkIssue(ctx) {
  const results = [];
  const product = ctx.config.issues.productName?.toLowerCase();
  const versionNames = product
    ? [...VERSION, `${product} version`, `versión de ${product}`]
    : VERSION;
  const body = ctx.body ?? '';
  const text = `${ctx.title}\n${body}`;
  if (text.match(SECURITY)) results.push(finding('security-report', 'suggestion'));

  const isBug =
    ctx.labels.includes(ctx.config.issues.bugLabel) ||
    ctx.title.match(BUG_TITLE) !== null ||
    /^fix(\([\w./-]+\))?:/i.test(ctx.title.trim());
  if (body.trim().length < 30) {
    results.push(finding('issue-empty', 'blocking'));
    return results;
  }
  if (!isBug || isCodeBugReport(ctx.title, body)) return results;

  const parsed = sections(body);
  const hasList = /^\s*\d+\.\s+\S/m.test(body);
  const missing = [
    ['steps', REPRO, hasList],
    ['expected', EXPECTED, false],
    ['actual', ACTUAL, false],
    ['version', versionNames, /\bv?\d+\.\d+\.\d+\b/.test(body)],
    ['platform', PLATFORM, /\b(windows|macos|mac os|linux|ubuntu)\b/i.test(body)],
  ]
    .filter(([, names, fallback]) => !section(parsed, names) && !fallback)
    .map(([name]) => name);
  if (missing.length) results.push(finding('issue-incomplete', 'blocking', { missing }));
  if (!MEDIA.test(body)) results.push(finding('issue-media', 'suggestion'));
  return results;
}
