// Where GitHub looks for a single pull request template, in its order of precedence.
const CANDIDATES = [
  '.github/pull_request_template.md',
  'pull_request_template.md',
  'docs/pull_request_template.md',
];
const OPTIONAL =
  /\b(optional|notes?|screenshots?|additional|others?|checklist|linked issues?|related|references?)\b/i;
// Common headings with their translations, so a body written in either language passes.
export const KNOWN_SECTIONS = [
  {
    id: 'what',
    names: [
      'what',
      'summary',
      'description',
      'what does this change',
      'qué',
      'que',
      'resumen',
      'descripción',
    ],
    label: { en: 'What', es: 'Qué' },
  },
  {
    id: 'why',
    names: ['why', 'motivation', 'por qué', 'por que', 'motivación'],
    label: { en: 'Why', es: 'Por qué' },
  },
  {
    id: 'howToTest',
    names: [
      'how to test',
      'testing',
      'tests',
      'verification',
      'validation',
      'test plan',
      'how was this tested',
      'how to verify',
      'checks',
      'evidence',
      'evidencia',
      'cómo probar',
      'como probar',
      'pruebas',
      'verificación',
      'validación',
    ],
    label: { en: 'How to test', es: 'Cómo probar' },
  },
];
const KNOWN = KNOWN_SECTIONS;

const clean = heading =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[?:.]+$/, '');

/**
 * Sections the author must fill: a heading whose body prompts with an HTML comment. Checklists,
 * headings without a prompt and optional-sounding headings are left out.
 */
export function templateSections(template = '') {
  const sections = [];
  let current = null;
  for (const line of template.replace(/\r\n/g, '\n').split('\n')) {
    const heading = line.match(/^#{2,3}\s+(.+?)\s*$/);
    if (heading) {
      current = { heading: heading[1], prompt: false };
      sections.push(current);
    } else if (current && /<!--/.test(line)) {
      current.prompt = true;
    }
  }
  return sections
    .filter(s => s.prompt && !OPTIONAL.test(s.heading))
    .map(({ heading }) => {
      const name = clean(heading);
      // A heading the defaults know keeps its translations, so a Spanish body still passes.
      // Synonyms count, but the message names the heading the template uses.
      const known = KNOWN.find(s => s.names.includes(name));
      if (known) return { ...known, label: { ...known.label, en: heading.trim() } };
      const id = name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section';
      return {
        id,
        names: [...new Set([name, heading.trim().toLowerCase()])],
        label: { en: heading.trim() },
      };
    });
}

/** The pull request template path in a repository's tracked paths, matched case-insensitively. */
export function findTemplate(paths) {
  const byLower = new Map(paths.map(p => [p.toLowerCase(), p]));
  for (const candidate of CANDIDATES) {
    if (byLower.has(candidate)) return byLower.get(candidate);
  }
  return null;
}

/** Required sections from the base branch template, or [] when the repository has none. */
export async function loadTemplateSections({ client, ref, paths }) {
  const tracked = paths?.length ? paths : await client.tree(ref);
  const file = findTemplate(tracked);
  if (!file) return [];
  return templateSections((await client.fileAt(file, ref)) ?? '');
}
