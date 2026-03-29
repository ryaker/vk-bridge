export interface VKCard {
  id: string
  title: string
  description?: string
  status: string
  projectId: string
}

export interface VKProject {
  id: string
  name: string
  cards: VKCard[]
}

export class VKClient {
  private baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  async getProjects(): Promise<VKProject[]> {
    throw new Error('not implemented')
  }

  async getProject(_id: string): Promise<VKProject> {
    throw new Error('not implemented')
  }

  async getCards(_projectId: string): Promise<VKCard[]> {
    throw new Error('not implemented')
  }

  async createCard(_projectId: string, _title: string, _description?: string): Promise<VKCard> {
    throw new Error('not implemented')
  }

  async updateCard(_cardId: string, _patch: Partial<VKCard>): Promise<VKCard> {
    throw new Error('not implemented')
  }

  async healthCheck(): Promise<boolean> {
    throw new Error('not implemented')
  }

  getBaseUrl(): string {
    return this.baseUrl
  }
}
