import { existsSync, readFileSync } from 'fs'
import { resolve, join } from 'path'
import type { VKClient, VKIssue } from '../vk/client.js'
import type { BridgeConfig } from '../config.js'
import { GitHubClient } from '../github/client.js'
import { getProjectConfig } from '../config.js'

export interface SessionInput {
  project_path: string
  branch: string
  worktree_path?: string
}

export interface MatchResult {
  card: VKIssue
  created: boolean
  strategy: 'worktree_metadata' | 'branch_issue_number' | 'branch_pr' | 'fuzzy_title' | 'created_new'

}

/** Resolve project_path → VK project_id using config */
function resolveProjectId(projectPath: string, config: BridgeConfig): string | null {
  const abs = resolve(projectPath)
  const proj = config.projects[abs]
  return proj?.vk_project_id ?? null
}

/** Strategy 1: VK-created worktrees contain .vk-session.json */
function tryWorktreeMetadata(worktreePath?: string): { taskId: string } | null {
  if (!worktreePath) return null
  const metaFile = join(worktreePath, '.vk-session.json')
  if (!existsSync(metaFile)) return null
  try {
    return JSON.parse(readFileSync(metaFile, 'utf-8'))
  } catch {
    return null
  }
}

/** Strategy 2: Extract GitHub issue number from branch name */
function extractIssueNumber(branch: string): number | null {
  const match = branch.match(/(?:fix|feat|perf|bug|chore|refactor|test|arch)\/.*?(\d+)/)
  return match ? parseInt(match[1], 10) : null
}

/** Strategy 4: Fuzzy match branch slug against card titles */
function fuzzyMatch(branch: string, cards: VKIssue[]): VKIssue | null {
  // Convert branch to searchable slug: fix/auth-timeout → auth timeout
  const slug = branch
    .replace(/^(fix|feat|perf|bug|chore|refactor|test|arch)\//, '')
    .replace(/[-_]/g, ' ')
    .toLowerCase()

  const words = slug.split(' ').filter(w => w.length > 3)
  if (words.length === 0) return null

  return cards.find(card => {
    const title = card.title.toLowerCase()
    return words.filter(w => title.includes(w)).length >= Math.ceil(words.length * 0.6)
  }) ?? null
}

/** Priority from branch prefix */
function priorityFromBranch(branch: string): string {
  if (branch.startsWith('bug/') || branch.startsWith('fix/')) return 'high'
  if (branch.startsWith('perf/')) return 'medium'
  if (branch.startsWith('feat/')) return 'medium'
  return 'low'
}

/** Branch slug → readable title */
function branchToTitle(branch: string): string {
  return branch
    .replace(/\//g, ': ')
    .replace(/[-_]/g, ' ')
}

export class CardMatcher {
  constructor(
    private vk: VKClient,
    private config: BridgeConfig
  ) {}

  async matchOrCreate(session: SessionInput): Promise<MatchResult> {
    const projectId = resolveProjectId(session.project_path, this.config)
    if (!projectId) {
      throw new Error(`No VK project configured for ${session.project_path}`)
    }

    const cards = await this.vk.listIssues(projectId)
    const statuses = await this.vk.getStatuses(projectId)

    // Strategy 1: VK worktree metadata
    const meta = tryWorktreeMetadata(session.worktree_path)
    if (meta) {
      const card = cards.find(c => c.id === meta.taskId)
      if (card) return { card, created: false, strategy: 'worktree_metadata' }
    }

    // Strategy 2: Branch → issue number
    const ghNumber = extractIssueNumber(session.branch)
    if (ghNumber) {
      const card = await this.vk.findIssueByGHNumber(projectId, ghNumber)
      if (card) return { card, created: false, strategy: 'branch_issue_number' }
    }

    // Strategy 3: Branch → GitHub PR (only if project has GitHub config)
    if (!ghNumber) {
      const projConfig = getProjectConfig(session.project_path, this.config)
      if (projConfig?.github_repo && projConfig?.github_token) {
        const gh = new GitHubClient(projConfig.github_repo, projConfig.github_token)
        const pr = await gh.findPRForBranch(session.branch).catch(() => null)
        if (pr) {
          // Try to find VK card via linked issue in PR body
          const linkedNum = GitHubClient.extractLinkedIssue(pr.body)
          if (linkedNum) {
            const card = await this.vk.findIssueByGHNumber(projectId, linkedNum)
            if (card) return { card, created: false, strategy: 'branch_pr' }
          }
          // PR exists but no linked issue — create card from PR title
          const card = await this.vk.createIssue({
            project_id: projectId,
            status_id: statuses.in_progress,
            title: pr.title,
            description: `From PR #${pr.number}: ${pr.url}\n\n${pr.body ?? ''}`.trim(),
            priority: priorityFromBranch(session.branch),
            sort_order: Date.now() / 1e10
          })
          return { card, created: true, strategy: 'branch_pr' }
        }
      }
    }

    // Strategy 4: Fuzzy title match
    const fuzzy = fuzzyMatch(session.branch, cards)
    if (fuzzy) return { card: fuzzy, created: false, strategy: 'fuzzy_title' }

    // Strategy 5: Create new card
    const card = await this.vk.createIssue({
      project_id: projectId,
      status_id: statuses.in_progress,
      title: branchToTitle(session.branch),
      description: `Auto-created by vk-bridge\n\nBranch: ${session.branch}\nProject: ${session.project_path}`,
      priority: priorityFromBranch(session.branch),
      sort_order: Date.now() / 1e10
    })

    return { card, created: true, strategy: 'created_new' }
  }
}
