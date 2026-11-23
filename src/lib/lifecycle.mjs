export const REMINDER = '<!-- centinela-reminder -->';
const CLOSED = '<!-- centinela-closed -->';
const DAY = 86_400_000;

/** The latest moment the author did something on the item, or anyone reopened it. */
export function lastActivity({ created, author, timeline }) {
  let latest = Date.parse(created);
  for (const event of timeline) {
    const actor = event.actor?.login ?? event.user?.login;
    const at =
      event.event === 'committed'
        ? event.committer?.date
        : actor === author || event.event === 'reopened'
          ? (event.created_at ?? event.submitted_at)
          : null;
    const time = at ? Date.parse(at) : NaN;
    if (time > latest) latest = time;
  }
  return latest;
}

/**
 * What to do with an item waiting on its author: remind once after `remindAfterDays` without
 * activity, then close after `closeAfterDays` more when closing is enabled.
 */
export function lifecycleAction({ now, activity, reminderAt, settings }) {
  const { remindAfterDays, closeAfterDays } = settings;
  if (!remindAfterDays) return null;
  if (reminderAt === null || reminderAt < activity) {
    return now - activity >= remindAfterDays * DAY ? 'remind' : null;
  }
  return closeAfterDays && now - reminderAt >= closeAfterDays * DAY ? 'close' : null;
}

/** The newest reminder Centinela posted, from the timeline, or null. */
export function reminderAt(timeline, botLogin) {
  const own = timeline.filter(
    event =>
      event.event === 'commented' &&
      (event.actor?.login ?? event.user?.login) === botLogin &&
      event.body?.startsWith(REMINDER)
  );
  return own.length ? Math.max(...own.map(event => Date.parse(event.created_at))) : null;
}

const TEXT = {
  en: {
    remind: ({ author, days, closeAfterDays }) =>
      `Hi @${author}, this has been waiting on you for ${days} days. When you have a moment, please look at the open items in the review above; if you need help, reply here.${closeAfterDays ? ` Without activity in ${closeAfterDays} days it will be closed, and you can always pick it up again.` : ''}`,
    close: ({ author, days }) =>
      `Closing this after ${days} days without activity. Thanks for your time, @${author}! If you pick it back up, comment here and a maintainer will reopen it.`,
  },
  es: {
    remind: ({ author, days, closeAfterDays }) =>
      `Hola, @${author}: esto lleva ${days} días esperando su respuesta. Cuando pueda, revise los puntos abiertos de la revisión anterior; si necesita ayuda, responda aquí.${closeAfterDays ? ` Si no hay actividad en ${closeAfterDays} días, se cerrará, y siempre podrá retomarlo.` : ''}`,
    close: ({ author, days }) =>
      `Cerramos esto tras ${days} días sin actividad. ¡Gracias por su tiempo, @${author}! Si lo retoma, comente aquí y un mantenedor lo reabrirá.`,
  },
};

export function lifecycleComment(action, language, params) {
  return `${action === 'close' ? CLOSED : REMINDER}\n${TEXT[language][action](params)}`;
}
