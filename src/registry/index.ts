import { randomUUID } from 'crypto'
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { VKClient, type VKStatusMap } from '../vk/client.js'
import { CardMatcher } from '../matcher/index.js'
import { loadConfig } from '../config.js'

export interface Session {
  id: string
  runtime: 'claude_code' | 'gemini' | 'zora' | 'unknown'
  project_path: string
  branch: string
  worktree_path?: string
  pid?: number
  vk_card_id: string
  vk_card_simple_id: string
  vk_project_id: string
  vk_status_ids: VKStatusMap
  status: 'in_progress' | 'in_review' | 'done' | 'blocked'
  started_at: string
  updated_at: string
}

export interface SessionInput {
  runtime: Session['runtime']
  project_path: string
  branch: string
  worktree_path?: string
  pid?: number
}

interface ActiveSessionFile {
  session_id: string
  vk_card_id: string
  vk_card_simple_id: string
  vk_project_id: string
  vk_status_ids: VKStatusMap
}

function activeDir(): string {
  return join(homedir(), '.vk-bridge', 'active')
}

function activeFilePath(pid: number): string {
  return join(activeDir(), `${pid}.json`)
}

function writeActiveFile(session: Session): void {
  if (session.pid == null) return
  const dir = activeDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const data: ActiveSessionFile = {
    session_id: session.id,
    vk_card_id: session.vk_card_id,
    vk_card_simple_id: session.vk_card_simple_id,
    vk_project_id: session.vk_project_id,
    vk_status_ids: session.vk_status_ids
  }
  writeFileSync(activeFilePath(session.pid), JSON.stringify(data, null, 2))
}

function deleteActiveFile(pid: number): void {
  const path = activeFilePath(pid)
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // ignore
  }
}

const STATUS_TO_VK_KEY: Record<string, keyof VKStatusMap | null> = {
  in_progress: 'in_progress',
  in_review: 'in_review',
  done: 'done',
  blocked: null
}

export class SessionRegistry {
  private sessions: Map<string, Session> = new Map()

  async register(input: SessionInput): Promise<Session> {
    const now = new Date().toISOString()
    const id = randomUUID()

    let vk_card_id = ''
    let vk_card_simple_id = 'UNKNOWN'
    let vk_project_id = ''
    let vk_status_ids: VKStatusMap = {
      backlog: '',
      todo: '',
      in_progress: '',
      in_review: '',
      done: '',
      cancelled: ''
    }

    try {
      const config = loadConfig()
      const client = new VKClient(config.vk_port)
      const matcher = new CardMatcher(client, config)

      const result = await matcher.matchOrCreate({
        project_path: input.project_path,
        branch: input.branch,
        worktree_path: input.worktree_path
      })

      const card = result.card
      vk_project_id = card.project_id
      vk_status_ids = await client.getStatuses(vk_project_id)
      vk_card_id = card.id
      vk_card_simple_id = card.simple_id

      // Move card to in_progress
      if (vk_status_ids.in_progress) {
        await client.updateIssueStatus(card.id, vk_status_ids.in_progress)
      }
    } catch (err) {
      console.error('[vk-bridge] VK unavailable during register:', (err as Error).message)
    }

    const session: Session = {
      id,
      runtime: input.runtime,
      project_path: input.project_path,
      branch: input.branch,
      worktree_path: input.worktree_path,
      pid: input.pid,
      vk_card_id,
      vk_card_simple_id,
      vk_project_id,
      vk_status_ids,
      status: 'in_progress',
      started_at: now,
      updated_at: now
    }

    this.sessions.set(id, session)
    writeActiveFile(session)

    return session
  }

  async update(id: string, patch: { status: Session['status'] }): Promise<Session> {
    const session = this.sessions.get(id)
    if (!session) {
      throw new Error(`Session not found: ${id}`)
    }

    const updated: Session = {
      ...session,
      status: patch.status,
      updated_at: new Date().toISOString()
    }

    this.sessions.set(id, updated)

    // Move VK card if applicable
    const vkKey = STATUS_TO_VK_KEY[patch.status]
    if (vkKey !== null && updated.vk_card_id) {
      const statusId = updated.vk_status_ids[vkKey]
      if (statusId) {
        try {
          const config = loadConfig()
          const client = new VKClient(config.vk_port)
          await client.updateIssueStatus(updated.vk_card_id, statusId)
        } catch (err) {
          console.error('[vk-bridge] VK unavailable during update:', (err as Error).message)
        }
      }
    }

    return updated
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  list(): Session[] {
    return Array.from(this.sessions.values())
  }

  async close(id: string): Promise<void> {
    await this.update(id, { status: 'done' })
    const session = this.sessions.get(id)
    if (session?.pid != null) {
      deleteActiveFile(session.pid)
    }
  }
}
