import { createHmac } from 'crypto'
import { GitHubClient } from './client.js'
import { VKClient, type VKStatusMap } from '../vk/client.js'
import { loadConfig, getProjectConfig } from '../config.js'
import type { SessionRegistry } from '../registry/index.js'

// ─── Payload shapes ────────────────────────────────────────────────────────

interface GHIssueMini {
  number: number
  title: string
  body: string | null
  html_url: string
  state: 'open' | 'closed'
  state_reason: string | null
}

interface GHPRMini {
  number: number
  title: string
  body: string | null
  html_url: string
  merged: boolean
  head: { ref: string }
}

interface GHRepoMini {
  full_name: string
}

interface IssuesPayload {
  action: string
  issue: GHIssueMini
  repository: GHRepoMini
}

interface PRPayload {
  action: string
  pull_request: GHPRMini
  repository: GHRepoMini
}

type WebhookPayload = IssuesPayload | PRPayload | Record<string, unknown>

// ─── HMAC verification ─────────────────────────────────────────────────────

export function verifySignature(body: string, signature: string, secret: string): boolean {
  if (!signature.startsWith('sha256=')) return false
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
  // Constant-time comparison
  if (expected.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  return diff === 0
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Find project config matching the incoming repo (e.g. 'ryaker/vk-bridge') */
function findProjectForRepo(repoFullName: string): {
  projectPath: string
  vkProjectId: string
  ghClient: GitHubClient
} | null {
  const config = loadConfig()
  for (const [projectPath, proj] of Object.entries(config.projects)) {
    if (proj.github_repo === repoFullName && proj.vk_project_id && proj.github_token) {
      return {
        projectPath,
        vkProjectId: proj.vk_project_id,
        ghClient: new GitHubClient(repoFullName, proj.github_token)
      }
    }
  }
  return null
}

/** Get VK status map for a project, cached per call */
async function getStatuses(client: VKClient, projectId: string): Promise<VKStatusMap> {
  return client.getStatuses(projectId)
}

/** Move a VK card to a given status key, if the card isn't agent-owned */
async function moveCard(
  vkCardId: string,
  statusKey: keyof VKStatusMap,
  statuses: VKStatusMap,
  registry: SessionRegistry,
  deferPayload?: { eventType: string; payload: unknown }
): Promise<'moved' | 'deferred' | 'noop'> {
  const statusId = statuses[statusKey]
  if (!statusId) return 'noop'

  if (registry.isAgentOwned(vkCardId)) {
    if (deferPayload) {
      registry.deferEvent(vkCardId, deferPayload.eventType, deferPayload.payload)
    }
    return 'deferred'
  }

  const config = loadConfig()
  const client = new VKClient(config.vk_port)
  await client.updateIssueStatus(vkCardId, statusId)
  return 'moved'
}

// ─── Event handlers ────────────────────────────────────────────────────────

async function handleIssuesEvent(
  payload: IssuesPayload,
  registry: SessionRegistry
): Promise<string> {
  const { action, issue, repository } = payload
  const match = findProjectForRepo(repository.full_name)
  if (!match) return `no project configured for ${repository.full_name}`

  const config = loadConfig()
  const vkClient = new VKClient(config.vk_port)
  const statuses = await getStatuses(vkClient, match.vkProjectId)

  // Find existing VK card for this issue
  const vkCard = await vkClient.findIssueByGHNumber(match.vkProjectId, issue.number)

  if (action === 'opened') {
    if (vkCard) return `card already exists: ${vkCard.simple_id}`
    // Create new card in Backlog
    await vkClient.createIssue({
      project_id: match.vkProjectId,
      status_id: statuses.backlog,
      title: `#${issue.number} ${issue.title}`,
      description: issue.body ?? undefined,
      priority: 'medium'
    })
    return `created backlog card for #${issue.number}`
  }

  if (!vkCard) return `no VK card found for #${issue.number}`

  if (action === 'assigned') {
    const result = await moveCard(vkCard.id, 'todo', statuses, registry, {
      eventType: `issues.${action}`,
      payload
    })
    return `issues.assigned → todo: ${result}`
  }

  if (action === 'closed') {
    // closed with state_reason 'completed' or 'merged' → Done; otherwise → Cancelled
    const reason = issue.state_reason
    const targetKey: keyof VKStatusMap = reason === 'not_planned' ? 'cancelled' : 'done'
    const result = await moveCard(vkCard.id, targetKey, statuses, registry, {
      eventType: `issues.${action}`,
      payload
    })
    return `issues.closed → ${targetKey}: ${result}`
  }

  if (action === 'reopened') {
    const result = await moveCard(vkCard.id, 'todo', statuses, registry, {
      eventType: `issues.${action}`,
      payload
    })
    return `issues.reopened → todo: ${result}`
  }

  return `unhandled issues action: ${action}`
}

async function handlePREvent(
  payload: PRPayload,
  registry: SessionRegistry
): Promise<string> {
  const { action, pull_request: pr, repository } = payload
  const match = findProjectForRepo(repository.full_name)
  if (!match) return `no project configured for ${repository.full_name}`

  // Only care about opened and closed+merged
  if (action !== 'opened' && !(action === 'closed' && pr.merged)) {
    return `ignored pull_request.${action}`
  }

  // Find linked issue from PR body
  const issueNumber = GitHubClient.extractLinkedIssue(pr.body)
  if (!issueNumber) return `no linked issue found in PR #${pr.number}`

  const config = loadConfig()
  const vkClient = new VKClient(config.vk_port)
  const statuses = await getStatuses(vkClient, match.vkProjectId)
  const vkCard = await vkClient.findIssueByGHNumber(match.vkProjectId, issueNumber)
  if (!vkCard) return `no VK card found for #${issueNumber}`

  if (action === 'opened') {
    const result = await moveCard(vkCard.id, 'in_review', statuses, registry, {
      eventType: 'pull_request.opened',
      payload
    })
    return `pull_request.opened → in_review: ${result}`
  }

  // closed + merged
  const result = await moveCard(vkCard.id, 'done', statuses, registry, {
    eventType: 'pull_request.merged',
    payload
  })
  return `pull_request.merged → done: ${result}`
}

// ─── Main dispatcher ────────────────────────────────────────────────────────

export async function handleWebhook(
  eventType: string,
  payload: WebhookPayload,
  registry: SessionRegistry
): Promise<string> {
  try {
    if (eventType === 'issues') {
      return await handleIssuesEvent(payload as IssuesPayload, registry)
    }
    if (eventType === 'pull_request') {
      return await handlePREvent(payload as PRPayload, registry)
    }
    return `ignored event: ${eventType}`
  } catch (err) {
    const msg = (err as Error).message
    console.error(`[vk-bridge] webhook error (${eventType}):`, msg)
    throw err
  }
}
