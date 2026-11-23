import { createHash } from 'node:crypto';

export const MARKER = 'centinela';

export function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

export function matcher(globs = []) {
  const patterns = globs.map(globToRegExp);
  return file => patterns.some(pattern => pattern.test(file));
}

/** Added lines of a unified diff patch with their line numbers in the new file. */
export function addedLines(patch) {
  if (!patch) return [];
  const lines = [];
  let next = 0;
  for (const raw of patch.split('\n')) {
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('+')) lines.push({ line: next++, text: raw.slice(1) });
    else if (!raw.startsWith('-') && !raw.startsWith('\\')) next++;
  }
  return lines;
}

const MAX_HEADING = 200;

/** HTML comments removed with a linear scan; an unclosed comment hides the rest. */
export function stripComments(text = '') {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('<!--', index);
    if (open < 0) return out + text.slice(index);
    out += text.slice(index, open);
    const close = text.indexOf('-->', open + 4);
    if (close < 0) return out;
    index = close + 3;
  }
  return out;
}

/** The text of a `##` or `###` Markdown heading, or null; parsed without backtracking regexes. */
export function headingOf(line) {
  let level = 0;
  while (line[level] === '#') level++;
  if (level < 2 || level > 3 || !/[ \t]/.test(line[level] ?? '')) return null;
  const text = line.slice(level).trim();
  return text ? text.slice(0, MAX_HEADING) : null;
}

/** A heading reduced to what decides a match: "What (v2)?" and "what" are the same section. */
export function normalizeHeading(text) {
  const trimPunctuation = value => {
    let end = value.length;
    while (end > 0 && '?:.'.includes(value[end - 1])) end--;
    return value.slice(0, end).trim();
  };
  let value = trimPunctuation(text.slice(0, MAX_HEADING).trim().toLowerCase());
  if (value.endsWith(')')) {
    const open = value.lastIndexOf('(');
    if (open > 0) value = value.slice(0, open).trim();
  }
  return trimPunctuation(value);
}

/** Markdown section bodies keyed by lowercased heading, HTML comments removed. */
export function sections(body = '') {
  const result = new Map();
  let current = null;
  const clean = stripComments(body).replace(/\r\n/g, '\n');
  for (const line of clean.split('\n')) {
    const heading = headingOf(line);
    if (heading) {
      current = heading.toLowerCase();
      result.set(current, '');
    } else if (current) {
      result.set(current, `${result.get(current)}${line}\n`);
    }
  }
  for (const [key, value] of result) result.set(key, value.trim());
  return result;
}

export function section(parsed, names) {
  const wanted = new Set(names.map(normalizeHeading));
  // Bilingual issue-form headings look like "Steps to reproduce / Pasos para reproducir".
  for (const [heading, content] of parsed) {
    if (heading.split(' / ').some(part => wanted.has(normalizeHeading(part)))) return content;
  }
  return null;
}

/** Whole-word, case-insensitive regex that treats accented letters as word characters. */
export function words(list) {
  return new RegExp(`(?<!\\p{L})(?:${list.join('|')})(?!\\p{L})`, 'giu');
}

const SPANISH = words(
  'el la los las que para con por una del cuando pero como esto está cómo qué porque también pasos'.split(
    ' '
  )
);
const ENGLISH = words(
  'the and for with when this that but from should steps because what how why'.split(' ')
);

export function detectLanguage(...texts) {
  const text = texts.join(' ');
  const es = text.match(SPANISH)?.length ?? 0;
  const en = text.match(ENGLISH)?.length ?? 0;
  return es > en ? 'es' : 'en';
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function reviewKey({ rulesVersion, kind, headSha = '', title, body, labels = [] }) {
  return sha256(
    JSON.stringify([rulesVersion, kind, headSha, title ?? '', body ?? '', [...labels].sort()])
  ).slice(0, 32);
}

const MARKER_LINE = new RegExp(`^<!-- ${MARKER} key=([a-f0-9]+)((?: [a-z]+=[a-f0-9,]*)*) -->`);

/** The hidden first line of the comment: review key, approval, approved tree and finding fingerprints. */
export function markerFor(key, { approved = null, tree = null, seen = [] } = {}) {
  const fields = [`key=${key}`];
  if (approved) fields.push(`approved=${approved}`);
  if (approved && tree) fields.push(`tree=${tree}`);
  fields.push(`seen=${seen.join(',')}`);
  return `<!-- ${MARKER} ${fields.join(' ')} -->`;
}

/** The fields of a Centinela marker, or null when the text does not start with one. */
export function parseMarker(text = '') {
  const match = text.match(MARKER_LINE);
  if (!match) return null;
  const fields = Object.fromEntries(
    match[2]
      .trim()
      .split(' ')
      .filter(Boolean)
      .map(pair => pair.split('='))
  );
  return {
    key: match[1],
    approved: fields.approved || null,
    tree: fields.tree || null,
    seen: fields.seen === undefined ? null : fields.seen.split(',').filter(Boolean),
  };
}

export function readMarker(text = '') {
  return parseMarker(text)?.key ?? null;
}

export function readApproval(text = '') {
  return parseMarker(text)?.approved ?? null;
}

const MAX_SEEN = 100;

/** A short id for a finding that survives line shifts: the rule, the file and its subject. */
export function fingerprint(finding) {
  const subject = finding.params?.sha ?? finding.params?.name ?? finding.params?.key ?? '';
  return sha256([finding.id, finding.file ?? '', subject].join('\0')).slice(0, 8);
}

/**
 * Compares this review with the previous one: marks findings it did not have and counts the
 * ones that are gone. Without a previous list nothing is new.
 */
export function compareFindings(findings, previousSeen) {
  const seen = [...new Set(findings.map(fingerprint))].slice(0, MAX_SEEN);
  if (!previousSeen) return { findings, seen, resolved: 0 };
  const before = new Set(previousSeen);
  const now = new Set(findings.map(fingerprint));
  return {
    findings: findings.map(f => (before.has(fingerprint(f)) ? f : { ...f, isNew: true })),
    seen,
    resolved: previousSeen.filter(id => !now.has(id)).length,
  };
}
