import { GitHubClient } from './client.js'
import { VKClient, type VKIssue } from '../vk/client.js'
import { loadConfig } from '../config.js'

const POLL_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

interface CardSnapshot {
  status_id: string
  title: string
}

/**
 * Extract GitHub issue number from a VK card title.
 * Card titles created by vk-bridge follow the pattern: '#NNN Title'
 */
function extractGHNumber(title: string): number | null {
  const match = title.match(/^#(\d+)\s/)
  return match ? parseInt(match[1], 10) : null
}

export class VKGitHubPoller {
  /** Last known status_id per VK card id — used to detect changes */
  private snapshots: Map<string, CardSnapshot> = new Map()
  private timer: ReturnType<typeof setInterval> | null = null

  start(): void {
    if (this.timer) return
    // Initial poll after a short delay to let the server finish booting
    setTimeout(() => void this.poll(), 5000)
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS)
    console.log('[vk-bridge] poller started (interval: 5m)')
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async poll(): Promise<void> {
    const config = loadConfig()
    const vkClient = new VKClient(config.vk_port)

    for (const [projectPath, proj] of Object.entries(config.projects)) {
      if (!proj.vk_project_id || !proj.github_repo || !proj.github_token) continue

      try {
        await this.pollProject({
          projectPath,
          vkProjectId: proj.vk_project_id,
          githubRepo: proj.github_repo,
          githubToken: proj.github_token,
          autoCreateIssues: proj.auto_create_github_issues,
          vkClient
        })
      } catch (err) {
        console.error(`[vk-bridge] poller error for ${projectPath}:`, (err as Error).message)
      }
    }
  }

  private async pollProject(opts: {
    projectPath: string
    vkProjectId: string
    githubRepo: string
    githubToken: string
    autoCreateIssues: boolean
    vkClient: VKClient
  }): Promise<void> {
    const { vkProjectId, githubRepo, githubToken, autoCreateIssues, vkClient } = opts
    const gh = new GitHubClient(githubRepo, githubToken)
    const statuses = await vkClient.getStatuses(vkProjectId)
    const cards = await vkClient.listIssues(vkProjectId)

    for (const card of cards) {
      const prev = this.snapshots.get(card.id)
      const curr: CardSnapshot = { status_id: card.status_id, title: card.title }

      if (!prev) {
        this.snapshots.set(card.id, curr)
        // First time seeing this card — handle auto_create_github_issues
        if (autoCreateIssues) {
          const ghNum = extractGHNumber(card.title)
          if (!ghNum) {
            // No GH issue yet — create one
            await this.createGHIssue(card, gh)
          }
        }
        continue
      }

      // Detect status change
      if (prev.status_id !== card.status_id) {
        this.snapshots.set(card.id, curr)
        await this.handleCardStatusChange(card, statuses, gh)
      }
    }
  }

  private async handleCardStatusChange(
    card: VKIssue,
    statuses: { done: string; cancelled: string; in_review: string },
    gh: GitHubClient
  ): Promise<void> {
    const ghNumber = extractGHNumber(card.title)
    if (!ghNumber) return // Not a GH-linked card

    if (card.status_id === statuses.done) {
      try {
        await gh.closeIssue(ghNumber, 'completed')
        await gh.addComment(
          ghNumber,
          `✅ Resolved via Vibe Kanban (card ${card.simple_id})`
        )
        console.log(`[vk-bridge] poller: closed GH #${ghNumber} (card ${card.simple_id} → Done)`)
      } catch (err) {
        console.error(`[vk-bridge] poller: failed to close GH #${ghNumber}:`, (err as Error).message)
      }
      return
    }

    if (card.status_id === statuses.cancelled) {
      try {
        await gh.closeIssue(ghNumber, 'not_planned')
        await gh.ensureLabel('wontfix')
        await gh.addLabel(ghNumber, 'wontfix')
        console.log(`[vk-bridge] poller: closed GH #${ghNumber} as wontfix (card ${card.simple_id} → Cancelled)`)
      } catch (err) {
        console.error(`[vk-bridge] poller: failed to cancel GH #${ghNumber}:`, (err as Error).message)
      }
      return
    }

    if (card.status_id === statuses.in_review) {
      try {
        await gh.addComment(
          ghNumber,
          `🔍 In review — see Vibe Kanban card ${card.simple_id}`
        )
        console.log(`[vk-bridge] poller: commented GH #${ghNumber} (card ${card.simple_id} → In Review)`)
      } catch (err) {
        console.error(`[vk-bridge] poller: failed to comment GH #${ghNumber}:`, (err as Error).message)
      }
    }
  }

  private async createGHIssue(card: VKIssue, gh: GitHubClient): Promise<void> {
    try {
      const issue = await gh.createIssue(
        card.title,
        card.description ?? undefined
      )
      console.log(`[vk-bridge] poller: created GH #${issue.number} for card ${card.simple_id}`)
    } catch (err) {
      console.error(`[vk-bridge] poller: failed to create GH issue for ${card.simple_id}:`, (err as Error).message)
    }
  }
}
