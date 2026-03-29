export interface Session {
  id: string
  agentId: string
  status: 'active' | 'idle' | 'closed'
  createdAt: Date
  updatedAt: Date
}

export class SessionRegistry {
  private sessions: Map<string, Session> = new Map()

  register(_agentId: string): Session {
    throw new Error('not implemented')
  }

  get(_id: string): Session | undefined {
    throw new Error('not implemented')
  }

  update(_id: string, _patch: Partial<Session>): Session {
    throw new Error('not implemented')
  }

  list(): Session[] {
    return Array.from(this.sessions.values())
  }

  close(_id: string): void {
    throw new Error('not implemented')
  }
}
