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
    repoReviewComments: (since, limit = 500) =>
      paginate(
        `/{repo}/pulls/comments?sort=updated&direction=desc${since ? `&since=${encodeURIComponent(since)}` : ''}`,
        limit
      ),
    reviews: number => paginate(`/{repo}/pulls/${number}/reviews`),
    createReview: (number, review) =>
      request('POST', `/{repo}/pulls/${number}/reviews`, { body: review }),
    replyToReviewComment: (number, commentId, body) =>
      request('POST', `/{repo}/pulls/${number}/comments/${commentId}/replies`, { body: { body } }),
    async reviewThreads(number) {
      const [owner, name] = repo.split('/');
      const query = `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviewThreads(first: 100) {
              nodes {
                id
                isResolved
                isOutdated
                path
                line
                originalLine
                comments(first: 10) {
                  nodes {
                    databaseId
                    body
                    url
                    createdAt
                    author { login }
                  }
                }
              }
            }
          }
        }
      }`;
      const { data } = await request('POST', `${API}/graphql`, {
        body: { query, variables: { owner, name, number } },
        allow: [403],
      });
      return data?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    },
    async resolveReviewThread(threadId) {
      const mutation = `mutation($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } }
      }`;
      const res = await request('POST', `${API}/graphql`, {
        body: { query: mutation, variables: { threadId } },
        allow: [403],
      });
      return res.data?.data?.resolveReviewThread?.thread?.isResolved === true;
    },
    async resolveReviewThreadForComment(number, commentId) {
      const threads = await this.reviewThreads(number);
      const thread = threads.find(
        t => !t.isResolved && t.comments?.nodes?.some(c => c.databaseId === commentId)
      );
      if (!thread) return false;
      return this.resolveReviewThread(thread.id);
    },
    reactions: (commentId, reviewComment = false) =>
      paginate(
        reviewComment
          ? `/{repo}/pulls/comments/${commentId}/reactions`
          : `/{repo}/issues/comments/${commentId}/reactions`,
        100
      ),
    commitTree: sha => request('GET', `/{repo}/git/commits/${sha}`).then(r => r.data.tree.sha),
    repository: () => request('GET', '/{repo}').then(r => r.data),
    compare: (base, head) =>
      request(
        'GET',
        `/{repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
        { allow: [404] }
      ).then(r => r.data),
    checkRuns: sha =>
      request('GET', `/{repo}/commits/${sha}/check-runs?per_page=100`, { allow: [404, 422] }).then(
        r => r.data?.check_runs ?? []
      ),
    openPulls: (limit = 30) =>
      paginate('/{repo}/pulls?state=open&sort=updated&direction=desc', limit),
    closedPulls: (limit = 30) =>
      paginate('/{repo}/pulls?state=closed&sort=updated&direction=desc', limit),
    async tree(ref) {
      const { data } = await request('GET', `/{repo}/git/trees/${ref}?recursive=1`);
      return data.tree.filter(entry => entry.type === 'blob').map(entry => entry.path);
    },
    async listDir(dirPath, ref) {
      const clean = String(dirPath ?? '').replace(/^\/+|\/+$/g, '');
      const encoded = clean ? clean.split('/').map(encodeURIComponent).join('/') : '';
      const suffix = encoded ? `/${encoded}` : '';
      const { data } = await request('GET', `/{repo}/contents${suffix}?ref=${ref}`, {
        allow: [404],
      });
      if (!Array.isArray(data)) return [];
      return data.map(entry => ({ name: entry.name, path: entry.path, type: entry.type }));
    },
    async fileAt(path, ref) {
      const encoded = path.split('/').map(encodeURIComponent).join('/');
      const { data } = await request('GET', `/{repo}/contents/${encoded}?ref=${ref}`, {
        accept: 'application/vnd.github.raw+json',
        allow: [404],
      });
      return data;
    },
    async externalFileAt(ownerRepo, filePath, ref = 'main') {
      if (!/^[\w.-]+\/[\w.-]+$/.test(ownerRepo ?? '')) return null;
      const encoded = filePath.split('/').map(encodeURIComponent).join('/');
      const { data } = await request(
        'GET',
        `${API}/repos/${ownerRepo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
        { accept: 'application/vnd.github.raw+json', allow: [403, 404] }
      );
      return data;
    },
    async externalTree(ownerRepo, ref = 'main') {
      if (!/^[\w.-]+\/[\w.-]+$/.test(ownerRepo ?? '')) return [];
      const { data } = await request(
        'GET',
        `${API}/repos/${ownerRepo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
        { allow: [403, 404] }
      );
      return (data?.tree ?? []).filter(entry => entry.type === 'blob').map(entry => entry.path);
    },
    async searchCode(query, limit = 10) {
      const q = `${query} repo:${repo}`;
      const { data } = await request(
        'GET',
        `${API}/search/code?q=${encodeURIComponent(q)}&per_page=${Math.min(limit, 20)}`,
        { allow: [403, 422] }
      );
      return (data?.items ?? []).map(item => ({ path: item.path, sha: item.sha }));
    },
    async searchIssues(query, limit = 10) {
      const q = `${query} repo:${repo}`;
      const { data } = await request(
        'GET',
        `${API}/search/issues?q=${encodeURIComponent(q)}&per_page=${Math.min(limit, 20)}`,
        { allow: [403, 422] }
      );
      return (data?.items ?? []).map(item => ({
        number: item.number,
        title: item.title,
        state: item.state,
        isPr: Boolean(item.pull_request),
        merged: Boolean(item.pull_request?.merged_at),
        merged_at: item.pull_request?.merged_at ?? null,
        body: (item.body ?? '').slice(0, 300),
        url: item.html_url,
        created_at: item.created_at,
        closed_at: item.closed_at,
      }));
    },
    async upsertRepoFile({
      targetRepo = repo,
      filePath,
      content,
      branch,
      message,
    }) {
      const encoded = filePath.split('/').map(encodeURIComponent).join('/');
      const existing = await request(
        'GET',
        `${API}/repos/${targetRepo}/contents/${encoded}?ref=${encodeURIComponent(branch)}`,
        { allow: [404] }
      );
      return request('PUT', `${API}/repos/${targetRepo}/contents/${encoded}`, {
        body: {
          message,
          content: Buffer.from(content, 'utf8').toString('base64'),
          branch,
          ...(existing.data?.sha ? { sha: existing.data.sha } : {}),
        },
      });
    },
    async ensureBranch({ targetRepo = repo, branch, from = 'main' }) {
      const existing = await request(
        'GET',
        `${API}/repos/${targetRepo}/git/ref/heads/${encodeURIComponent(branch)}`,
        { allow: [404] }
      );
      if (existing.data) return existing.data;
      const base = await request(
        'GET',
        `${API}/repos/${targetRepo}/git/ref/heads/${encodeURIComponent(from)}`
      );
      return request('POST', `${API}/repos/${targetRepo}/git/refs`, {
        body: { ref: `refs/heads/${branch}`, sha: base.data.object.sha },
      }).then(r => r.data);
    },
    async openOrUpdatePull({ targetRepo = repo, head, base = 'main', title, body }) {
      const owner = targetRepo.split('/')[0];
      const existing = await request(
        'GET',
        `${API}/repos/${targetRepo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`
      );
      const open = existing.data?.[0];
      if (open) {
        return request('PATCH', `${API}/repos/${targetRepo}/pulls/${open.number}`, {
          body: { title, body },
        }).then(r => r.data);
      }
      return request('POST', `${API}/repos/${targetRepo}/pulls`, {
        body: { title, body, head, base },
      }).then(r => r.data);
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
    close: (number, pull, reason = 'not_planned') =>
      request('PATCH', `/{repo}/issues/${number}`, {
        body: pull ? { state: 'closed' } : { state: 'closed', state_reason: reason },
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
