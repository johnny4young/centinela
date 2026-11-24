const API = 'https://api.github.com';

export function createClient({ token, repo, statusContext = 'centinela', fetchImpl = fetch }) {
  if (!token) throw new Error('centinela: a GitHub token is required');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? ''))
    throw new Error(`centinela: invalid repository ${repo}`);

  async function request(method, path, { body, accept, allow = [] } = {}) {
    const url = path.startsWith('http') ? path : `${API}${path.replace('{repo}', `repos/${repo}`)}`;
    const response = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: accept ?? 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'centinela',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (allow.includes(response.status)) return { status: response.status, data: null };
    if (!response.ok) {
      throw new Error(
        `centinela: ${method} ${url} failed with ${response.status}: ${await response.text()}`
      );
    }
    const data =
      response.status === 204
        ? null
        : accept?.includes('raw')
          ? await response.text()
          : await response.json();
    return { status: response.status, data, link: response.headers.get('link') };
  }

  async function paginate(path, limit = 3000) {
    const items = [];
    let next = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
    while (next && items.length < limit) {
      const { data, link } = await request('GET', next);
      items.push(...data);
      next = link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    }
    return items;
  }

  return {
    request,
    paginate,
    pull: number => request('GET', `/{repo}/pulls/${number}`).then(r => r.data),
    issue: number => request('GET', `/{repo}/issues/${number}`).then(r => r.data),
    pullFiles: number => paginate(`/{repo}/pulls/${number}/files`),
    pullCommits: number => paginate(`/{repo}/pulls/${number}/commits`, 250),
    comments: number => paginate(`/{repo}/issues/${number}/comments`),
    reviewComments: number => paginate(`/{repo}/pulls/${number}/comments`),
    createReview: (number, review) =>
      request('POST', `/{repo}/pulls/${number}/reviews`, { body: review }),
    commitTree: sha => request('GET', `/{repo}/git/commits/${sha}`).then(r => r.data.tree.sha),
    repository: () => request('GET', '/{repo}').then(r => r.data),
    async tree(ref) {
      const { data } = await request('GET', `/{repo}/git/trees/${ref}?recursive=1`);
      return data.tree.filter(entry => entry.type === 'blob').map(entry => entry.path);
    },
    async fileAt(path, ref) {
      const encoded = path.split('/').map(encodeURIComponent).join('/');
      const { data } = await request('GET', `/{repo}/contents/${encoded}?ref=${ref}`, {
        accept: 'application/vnd.github.raw+json',
        allow: [404],
      });
      return data;
    },
    async upsertComment(number, existing, body) {
      // Another bot identity wrote the old comment and cannot be edited: post a new one.
      if (existing) {
        const patched = await request('PATCH', `/{repo}/issues/comments/${existing.id}`, {
          body: { body },
          allow: [403, 404],
        });
        if (patched.data !== null) return patched;
      }
      return request('POST', `/{repo}/issues/${number}/comments`, { body: { body } });
    },
    openItems: () => paginate('/{repo}/issues?state=open&sort=created&direction=desc', 100),
    timeline: number => paginate(`/{repo}/issues/${number}/timeline`, 1000),
    waitingOn: label =>
      paginate(`/{repo}/issues?state=open&labels=${encodeURIComponent(label)}`, 500),
    react: (commentId, content) =>
      request('POST', `/{repo}/issues/comments/${commentId}/reactions`, { body: { content } }),
    comment: (number, body) =>
      request('POST', `/{repo}/issues/${number}/comments`, { body: { body } }),
    close: (number, pull) =>
      request('PATCH', `/{repo}/issues/${number}`, {
        body: pull ? { state: 'closed' } : { state: 'closed', state_reason: 'not_planned' },
      }),
    setStatus: (sha, state, description) =>
      request('POST', `/{repo}/statuses/${sha}`, {
        body: { state, context: statusContext, description: description.slice(0, 140) },
      }),
    ensureLabel: ({ name, color }) =>
      request('POST', '/{repo}/labels', { body: { name, color }, allow: [422] }),
    addLabels: (number, labels) =>
      request('POST', `/{repo}/issues/${number}/labels`, { body: { labels } }),
    removeLabel: (number, name) =>
      request('DELETE', `/{repo}/issues/${number}/labels/${encodeURIComponent(name)}`, {
        allow: [404],
      }),
  };
}
