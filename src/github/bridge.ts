export interface GitHubIssue {
  number: number
  title: string
  body?: string
  url: string
  state: 'open' | 'closed'
}

export interface GitHubBridgeOptions {
  repo: string
  token: string
}

export class GitHubBridge {
  private repo: string
  private token: string

  constructor(options: GitHubBridgeOptions) {
    this.repo = options.repo
    this.token = options.token
  }

  async createIssue(_title: string, _body?: string): Promise<GitHubIssue> {
    throw new Error('not implemented')
  }

  async getIssue(_number: number): Promise<GitHubIssue> {
    throw new Error('not implemented')
  }

  async closeIssue(_number: number): Promise<GitHubIssue> {
    throw new Error('not implemented')
  }

  async listOpenIssues(): Promise<GitHubIssue[]> {
    throw new Error('not implemented')
  }

  getRepo(): string {
    return this.repo
  }

  hasToken(): boolean {
    return this.token.length > 0
  }
}
