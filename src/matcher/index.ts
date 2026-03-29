export interface MatchContext {
  sessionId: string
  agentId: string
  title?: string
  description?: string
  tags?: string[]
}

export interface MatchResult {
  cardId: string
  projectId: string
  created: boolean
}

export class CardMatcher {
  matchOrCreate(_context: MatchContext): Promise<MatchResult> {
    throw new Error('not implemented')
  }

  findBySession(_sessionId: string): Promise<MatchResult | null> {
    throw new Error('not implemented')
  }

  findByTitle(_title: string, _projectId?: string): Promise<MatchResult | null> {
    throw new Error('not implemented')
  }
}
