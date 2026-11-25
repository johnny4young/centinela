export const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const COMMANDS = ['recheck', 'review', 'triage', 'learn', 'draft-pr', 'fix-nits', 'help'];
const MAINTAINER_ONLY = new Set(['review', 'triage', 'learn', 'draft-pr', 'fix-nits']);

/** The command on the first line of a comment, `/centinela <name>`, or null. */
export function parseCommand(body = '') {
  const match = body
    .slice(0, 200)
    .trimStart()
    .match(/^\/centinela(?:[ \t]+([a-z-]+))?[ \t]*(?:\r?\n|$)/i);
  if (!match) return null;
  return (match[1] ?? 'help').toLowerCase();
}

export const knownCommand = name => COMMANDS.includes(name);

export const isMaintainer = ({ login, association, config }) =>
  MAINTAINER_ASSOCIATIONS.has(association) || config.maintainers.includes(login);

/** The author and maintainers may run safe checks; AI, learning and execution commands stay maintainer-only. */
export function canRun({ name, login, association, itemAuthor, config }) {
  if (MAINTAINER_ONLY.has(name)) return isMaintainer({ login, association, config });
  return login === itemAuthor || isMaintainer({ login, association, config });
}

/** `--again` after the command name asks for a review the current commit already has. */
export const wantsAgain = (body = '') => /^\s*\/centinela[ \t]+\S+[ \t]+--again\b/i.test(body);

const HELP = {
  en: [
    'Commands Centinela understands, from the author or a maintainer:',
    '',
    '- `/centinela recheck` runs the checks again.',
    '- `/centinela review` asks Claude for a deep agentic review (maintainers only).',
    '- `/centinela triage` runs AI issue triage for duplicates, already-fixed checks and direction (maintainers only).',
    '- `/centinela learn` harvests recent maintainer reviews and updates learned rules (maintainers only).',
    '- `/centinela draft-pr` opens a Draft PR from an issue via Tier 2 execution (maintainers only).',
    '- `/centinela fix-nits` applies mechanical review fixes on a pull request via Tier 2 (maintainers only).',
    '- `/centinela help` shows this list.',
  ],
  es: [
    'Comandos que Centinela entiende, del autor o de un mantenedor:',
    '',
    '- `/centinela recheck` ejecuta los chequeos de nuevo.',
    '- `/centinela review` pide a Claude una revisión agéntica profunda (solo mantenedores).',
    '- `/centinela triage` ejecuta triage con IA en el issue: duplicados, ya resuelto en main y guía (solo mantenedores).',
    '- `/centinela learn` cosecha revisiones recientes y propone actualizar los aprendizajes (solo mantenedores).',
    '- `/centinela draft-pr` abre un Draft PR desde un issue con Tier 2 (solo mantenedores).',
    '- `/centinela fix-nits` aplica correcciones mecánicas en una pull request con Tier 2 (solo mantenedores).',
    '- `/centinela help` muestra esta lista.',
  ],
};

export const helpText = language => HELP[language].join('\n');
