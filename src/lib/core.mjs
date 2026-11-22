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

export function markerFor(key, approvedSha = null) {
  return `<!-- ${MARKER} key=${key}${approvedSha ? ` approved=${approvedSha}` : ''} -->`;
}

export function readMarker(text = '') {
  return (
    text.match(new RegExp(`^<!-- ${MARKER} key=([a-f0-9]+)(?: approved=[a-f0-9]+)? -->`))?.[1] ??
    null
  );
}

export function readApproval(text = '') {
  return (
    text.match(new RegExp(`^<!-- ${MARKER} key=[a-f0-9]+ approved=([a-f0-9]+) -->`))?.[1] ?? null
  );
}
