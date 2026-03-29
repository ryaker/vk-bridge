const GITHUB_API = 'https://api.github.com'

export interface GitHubIssue {
  number: number
  title: string
  body?: string
  url: string
  state: 'open' | 'closed'
  labels: string[]
}

export interface GitHubPR {
  number: number
  title: string
  body: string | null
  url: string
  head: { ref: string }
  state: 'open' | 'closed'
  merged: boolean
}

export interface GitHubComment {
  id: number
  body: string
  url: string
}

export class GitHubClient {
  constructor(
    private repo: string,
    private token: string
  ) {}

  private async request<T>(path: string, opts: RequestInit = {}): Promise<T> {
    const url = `${GITHUB_API}/repos/${this.repo}${path}`
    const res = await fetch(url, {
      ...opts,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        ...(opts.headers ?? {})
      }
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`GitHub ${opts.method ?? 'GET'} ${path} → ${res.status}: ${text}`)
    }
    if (res.status === 204) return undefined as unknown as T
    return res.json() as Promise<T>
  }

  private mapIssue(raw: Record<string, unknown>): GitHubIssue {
    return {
      number: raw.number as number,
      title: raw.title as string,
      body: (raw.body as string | null) ?? undefined,
      url: raw.html_url as string,
      state: raw.state as 'open' | 'closed',
      labels: ((raw.labels as Array<{ name: string }>) ?? []).map(l => l.name)
    }
  }

  async createIssue(title: string, body?: string): Promise<GitHubIssue> {
    const raw = await this.request<Record<string, unknown>>('/issues', {
      method: 'POST',
      body: JSON.stringify({ title, body })
    })
    return this.mapIssue(raw)
  }

  async getIssue(number: number): Promise<GitHubIssue> {
    const raw = await this.request<Record<string, unknown>>(`/issues/${number}`)
    return this.mapIssue(raw)
  }

  async closeIssue(number: number, reason: 'completed' | 'not_planned' = 'completed'): Promise<GitHubIssue> {
    const raw = await this.request<Record<string, unknown>>(`/issues/${number}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed', state_reason: reason })
    })
    return this.mapIssue(raw)
  }

  async reopenIssue(number: number): Promise<GitHubIssue> {
    const raw = await this.request<Record<string, unknown>>(`/issues/${number}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'open' })
    })
    return this.mapIssue(raw)
  }

  async addComment(number: number, body: string): Promise<GitHubComment> {
    return this.request<GitHubComment>(`/issues/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body })
    })
  }

  async addLabel(number: number, label: string): Promise<void> {
    await this.request(`/issues/${number}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labels: [label] })
    })
  }

  async ensureLabel(name: string, color = 'ededed'): Promise<void> {
    // Create label if it doesn't exist (silently ignore 422 = already exists)
    const res = await fetch(`${GITHUB_API}/repos/${this.repo}/labels`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name, color })
    })
    // 422 = already exists — that's fine
    if (!res.ok && res.status !== 422) {
      const text = await res.text().catch(() => '')
      throw new Error(`GitHub POST /labels → ${res.status}: ${text}`)
    }
  }

  async listOpenIssues(): Promise<GitHubIssue[]> {
    const raw = await this.request<Array<Record<string, unknown>>>('/issues?state=open&per_page=100')
    // Filter out pull requests (GitHub returns PRs in issues endpoint)
    return raw.filter(r => !r.pull_request).map(r => this.mapIssue(r))
  }

  /** Find an open PR for the given branch name. Returns null if none or on error. */
  async findPRForBranch(branch: string): Promise<GitHubPR | null> {
    try {
      const raw = await this.request<Array<Record<string, unknown>>>(
        `/pulls?state=open&head=${encodeURIComponent(this.repo.split('/')[0])}:${encodeURIComponent(branch)}&per_page=5`
      )
      if (!raw.length) return null
      const pr = raw[0]
      return {
        number: pr.number as number,
        title: pr.title as string,
        body: (pr.body as string | null) ?? null,
        url: pr.html_url as string,
        head: { ref: (pr.head as Record<string, string>).ref },
        state: pr.state as 'open' | 'closed',
        merged: !!(pr.merged as boolean)
      }
    } catch {
      return null
    }
  }

  /** Parse 'Closes #NNN', 'Fixes #NNN', 'Resolves #NNN' from PR body */
  static extractLinkedIssue(prBody: string | null | undefined): number | null {
    if (!prBody) return null
    const match = prBody.match(/(?:closes|fixes|resolves)\s+#(\d+)/i)
    return match ? parseInt(match[1], 10) : null
  }
}
