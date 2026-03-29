import { readFileSync, existsSync } from 'fs'

export interface VKOrg {
  id: string
  name: string
}

export interface VKProject {
  id: string
  name: string
}

export interface VKStatus {
  id: string
  name: string
  project_id: string
}

export interface VKIssue {
  id: string
  simple_id: string
  title: string
  description: string | null
  status_id: string
  priority: string
  sort_order: number
  project_id: string
}

export interface VKStatusMap {
  backlog: string
  todo: string
  in_progress: string
  in_review: string
  done: string
  cancelled: string
}

const VK_PORT_FILE = '/var/folders/b5/d07g827s1l9fw40nk5l421xm0000gn/T/vibe-kanban/vibe-kanban.port'

export class VKClient {
  private port: number

  constructor(fallbackPort = 3333) {
    this.port = this.detectPort(fallbackPort)
  }

  private detectPort(fallback: number): number {
    try {
      if (existsSync(VK_PORT_FILE)) {
        const data = JSON.parse(readFileSync(VK_PORT_FILE, 'utf-8'))
        return data.main_port ?? fallback
      }
    } catch {}
    return fallback
  }

  private url(path: string): string {
    return `http://localhost:${this.port}/api${path}`
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(this.url(path))
    if (!res.ok) throw new Error(`VK GET ${path} → ${res.status}`)
    return res.json() as Promise<T>
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) throw new Error(`VK POST ${path} → ${res.status}`)
    return res.json() as Promise<T>
  }

  private async patch<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) throw new Error(`VK PATCH ${path} → ${res.status}`)
    return res.json() as Promise<T>
  }

  async getOrganizations(): Promise<VKOrg[]> {
    const r = await this.get<{ data: { organizations: VKOrg[] } }>('/organizations')
    return r.data.organizations
  }

  async listProjects(orgId: string): Promise<VKProject[]> {
    const r = await this.get<{ data: { projects: VKProject[] } }>(`/remote/projects?organization_id=${orgId}`)
    return r.data.projects
  }

  async listIssues(projectId: string): Promise<VKIssue[]> {
    const r = await this.get<{ data: { issues: VKIssue[] } }>(`/remote/issues?project_id=${projectId}`)
    return r.data.issues
  }

  async getStatuses(projectId: string): Promise<VKStatusMap> {
    const r = await this.get<{ data: { project_statuses: VKStatus[] } }>(`/remote/project-statuses?project_id=${projectId}`)
    const map: Record<string, string> = {}
    for (const s of r.data.project_statuses) {
      map[s.name.toLowerCase().replace(/ /g, '_')] = s.id
    }
    return {
      backlog: map['backlog'] ?? '',
      todo: map['to_do'] ?? '',
      in_progress: map['in_progress'] ?? '',
      in_review: map['in_review'] ?? '',
      done: map['done'] ?? '',
      cancelled: map['cancelled'] ?? ''
    }
  }

  async createIssue(params: {
    project_id: string
    status_id: string
    title: string
    description?: string
    priority?: string
    sort_order?: number
  }): Promise<VKIssue> {
    const r = await this.post<{ data: { data: VKIssue } }>('/remote/issues', {
      ...params,
      priority: params.priority ?? 'medium',
      sort_order: params.sort_order ?? 1.0,
      extension_metadata: {}
    })
    return r.data.data
  }

  async updateIssueStatus(issueId: string, statusId: string): Promise<VKIssue> {
    const r = await this.patch<{ data: { data: VKIssue } }>(`/remote/issues/${issueId}`, { status_id: statusId })
    return r.data.data
  }

  async findIssueByGHNumber(projectId: string, ghNumber: number): Promise<VKIssue | null> {
    const issues = await this.listIssues(projectId)
    return issues.find(i => i.title.startsWith(`#${ghNumber} `)) ?? null
  }

  async isConnected(): Promise<boolean> {
    try {
      await this.getOrganizations()
      return true
    } catch {
      return false
    }
  }
}
