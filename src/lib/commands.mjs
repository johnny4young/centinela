export const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const COMMANDS = ['recheck', 'review', 'help'];

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

/** The author and maintainers may run commands; an AI review costs money, so only maintainers. */
export function canRun({ name, login, association, itemAuthor, config }) {
  if (name === 'review') return isMaintainer({ login, association, config });
  return login === itemAuthor || isMaintainer({ login, association, config });
}

/** `--again` after the command name asks for a review the current commit already has. */
export const wantsAgain = (body = '') => /^\s*\/centinela[ \t]+\S+[ \t]+--again\b/i.test(body);

const HELP = {
  en: [
    'Commands Centinela understands, from the author or a maintainer:',
    '',
    '- `/centinela recheck` runs the checks again.',
    '- `/centinela review` asks Claude to review the diff for performance, memory and freezes (maintainers only).',
    '- `/centinela help` shows this list.',
  ],
  es: [
    'Comandos que Centinela entiende, del autor o de un mantenedor:',
    '',
    '- `/centinela recheck` ejecuta los chequeos de nuevo.',
    '- `/centinela review` pide a Claude revisar el diff por rendimiento, memoria y congelamientos (solo mantenedores).',
    '- `/centinela help` muestra esta lista.',
  ],
};

export const helpText = language => HELP[language].join('\n');
