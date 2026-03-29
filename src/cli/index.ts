#!/usr/bin/env node
import { execSync } from 'child_process'

const BRIDGE = 'http://localhost:3334'

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BRIDGE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`vk-bridge ${method} ${path} → ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

async function checkBridge(): Promise<void> {
  try {
    await fetch(`${BRIDGE}/health`)
  } catch {
    console.error('vkb: bridge is not running. Start it with: npm run dev')
    process.exit(1)
  }
}

// ─── Git helpers ─────────────────────────────────────────────────────────────

function gitRoot(): string | null {
  try {
    return execSync('git rev-parse --show-toplevel', { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim()
  } catch {
    return null
  }
}

function gitBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim()
  } catch {
    return 'main'
  }
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function col(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width - 1) + '…' : s.padEnd(width)
}

function statusBadge(status: string): string {
  const badges: Record<string, string> = {
    in_progress: '▶ In Progress',
    in_review:   '⏸ In Review ',
    done:        '✓ Done       ',
    blocked:     '✗ Blocked    ',
  }
  return badges[status] ?? status
}

// ─── Commands ────────────────────────────────────────────────────────────────

interface Session {
  id: string
  runtime: string
  project_path: string
  branch: string
  vk_card_simple_id: string
  status: string
  started_at: string
}

interface VKCard {
  id: string
  simple_id: string
  title: string
  status_id: string
}

async function cmdNew(args: string[]): Promise<void> {
  await checkBridge()
  const githubFlag = args.includes('--github')
  const titleArgs = args.filter(a => !a.startsWith('--'))
  const title = titleArgs.join(' ')
  if (!title) {
    console.error('Usage: vkb new "Card title" [--github]')
    process.exit(1)
  }

  const root = gitRoot()
  const branch = gitBranch()

  if (!root) {
    console.error('vkb: not inside a git repo')
    process.exit(1)
  }

  const result = await api<{
    session_id: string
    vk_card_id: string
    vk_card_simple_id: string
  }>('POST', '/sessions', {
    runtime: 'unknown',
    project_path: root,
    branch,
    _title_override: title,
    _github: githubFlag
  })

  console.log(`Created: ${result.vk_card_simple_id}`)
}

async function cmdStatus(): Promise<void> {
  await checkBridge()
  const root = gitRoot()

  const { sessions } = await api<{ sessions: Session[] }>('GET', '/sessions')
  const relevant = root
    ? sessions.filter(s => s.project_path === root && s.status === 'in_progress')
    : sessions.filter(s => s.status === 'in_progress')

  if (relevant.length === 0) {
    console.log('No active sessions' + (root ? ` for ${root}` : ''))
    return
  }

  console.log(`\n  ${col('Card', 10)} ${col('Branch', 28)} ${col('Runtime', 12)} Started`)
  console.log(`  ${'-'.repeat(70)}`)
  for (const s of relevant) {
    const age = formatAge(s.started_at)
    console.log(`  ${col(s.vk_card_simple_id, 10)} ${col(s.branch, 28)} ${col(s.runtime, 12)} ${age}`)
  }
  console.log()
}

async function cmdSessions(): Promise<void> {
  await checkBridge()
  const { sessions } = await api<{ sessions: Session[] }>('GET', '/sessions')

  if (sessions.length === 0) {
    console.log('No sessions registered')
    return
  }

  console.log(`\n  ${col('Card', 10)} ${col('Status', 16)} ${col('Branch', 28)} ${col('Project', 24)}`)
  console.log(`  ${'-'.repeat(82)}`)
  for (const s of sessions) {
    const project = s.project_path.split('/').slice(-2).join('/')
    console.log(
      `  ${col(s.vk_card_simple_id, 10)} ${col(statusBadge(s.status), 16)} ${col(s.branch, 28)} ${col(project, 24)}`
    )
  }
  console.log()
}

async function cmdMove(targetStatus: 'in_review' | 'done'): Promise<void> {
  await checkBridge()
  const root = gitRoot()
  if (!root) {
    console.error('vkb: not inside a git repo')
    process.exit(1)
  }

  const { sessions } = await api<{ sessions: Session[] }>('GET', '/sessions')
  const active = sessions.find(
    s => s.project_path === root && s.status === 'in_progress'
  )

  if (!active) {
    console.error(`vkb: no in-progress session found for ${root}`)
    process.exit(1)
  }

  await api('PATCH', `/sessions/${active.id}`, { status: targetStatus })
  const label = targetStatus === 'in_review' ? 'In Review' : 'Done'
  console.log(`${active.vk_card_simple_id} → ${label}`)
}

async function cmdStart(args: string[]): Promise<void> {
  await checkBridge()
  const cardId = args[0]
  if (!cardId) {
    console.error('Usage: vkb start <card-id>  e.g. vkb start RYA-50')
    process.exit(1)
  }

  const { sessions } = await api<{ sessions: Session[] }>('GET', '/sessions')
  const session = sessions.find(
    s => s.vk_card_simple_id.toUpperCase() === cardId.toUpperCase()
  )

  if (!session) {
    console.error(`vkb: no session found for card ${cardId}`)
    console.error('       (session must be registered first via the hooks or POST /sessions)')
    process.exit(1)
  }

  await api('PATCH', `/sessions/${session.id}`, { status: 'in_progress' })
  console.log(`${session.vk_card_simple_id} → In Progress`)
}

async function cmdSync(args: string[]): Promise<void> {
  await checkBridge()
  const all = args.includes('--all')
  // Trigger a poller cycle by calling the health endpoint — poller runs autonomously
  // For now, report what would be synced
  const health = await api<{ ok: boolean; vk_connected: boolean }>('GET', '/health')
  if (!health.vk_connected) {
    console.error('vkb: VK is not connected')
    process.exit(1)
  }
  console.log(`Sync ${all ? 'all projects' : 'current project'}: poller will run within 5 minutes`)
  console.log('To force an immediate sync, restart the bridge.')
}

async function cmdBoard(): Promise<void> {
  await checkBridge()
  const { sessions } = await api<{ sessions: Session[] }>('GET', '/sessions')

  const byStatus: Record<string, Session[]> = {
    in_progress: [],
    in_review: [],
    done: [],
    blocked: []
  }
  for (const s of sessions) {
    if (byStatus[s.status]) byStatus[s.status].push(s)
  }

  const columns = [
    { key: 'in_progress', label: '▶ In Progress' },
    { key: 'in_review',   label: '⏸ In Review' },
    { key: 'done',        label: '✓ Done' },
    { key: 'blocked',     label: '✗ Blocked' },
  ]

  console.log()
  for (const { key, label } of columns) {
    const cards = byStatus[key]
    console.log(`  ${label} (${cards.length})`)
    for (const s of cards) {
      const project = s.project_path.split('/').pop() ?? ''
      console.log(`    ${col(s.vk_card_simple_id, 10)} ${col(s.branch, 30)} ${project}`)
    }
    console.log()
  }
}

async function cmdScan(): Promise<void> {
  await checkBridge()
  console.log('Scanning ~/Dev for git repos…\n')

  // Call discovery via bridge health to confirm it's up, then
  // run discovery locally (discovery module is server-side, but we can
  // show the result by reading what the server would log)
  const health = await api<{ ok: boolean; vk_connected: boolean }>('GET', '/health')
  const vkStatus = health.vk_connected ? '✓ connected' : '✗ disconnected'
  console.log(`  VK: ${vkStatus}`)

  // Import discovery dynamically so CLI can run independently
  const { ProjectDiscovery } = await import('../discovery/index.js')
  const d = new ProjectDiscovery()
  const repos = await d.scan()

  const untracked = repos.filter(r => !r.inConfig)
  const tracked = repos.filter(r => r.inConfig)

  console.log(`\n  Found ${repos.length} repo(s): ${tracked.length} tracked, ${untracked.length} new\n`)

  if (untracked.length > 0) {
    console.log('  New repos:')
    console.log(`  ${col('Repo', 22)} ${col('VK Match', 14)} ${col('GitHub Remote', 30)}`)
    console.log(`  ${'-'.repeat(68)}`)
    for (const r of untracked) {
      const vk = r.vkProjectId ? '✓ matched' : '✗ no match'
      const gh = r.githubRemote ?? '—'
      console.log(`  ${col(r.name, 22)} ${col(vk, 14)} ${col(gh, 30)}`)
    }

    const matched = untracked.filter(r => r.vkProjectId !== null)
    if (matched.length > 0) {
      const written = d.syncConfig(untracked)
      console.log(`\n  Auto-registered ${written} repo(s) → ~/.vk-bridge/config.json`)
    }
    const unmatched = untracked.filter(r => r.vkProjectId === null)
    if (unmatched.length > 0) {
      console.log(`\n  ${unmatched.length} repo(s) have no VK project — create projects in VK then run 'vkb scan' again`)
    }
  }
  console.log()
}

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function printHelp(): void {
  console.log(`
  vkb — Vibe Kanban bridge CLI

  Commands:
    vkb new "title" [--github]   Create a VK card (+ GH issue if --github)
    vkb start <card-id>          Move a card to In Progress
    vkb review                   Move current project's active card to In Review
    vkb done                     Move current project's active card to Done
    vkb status                   Show In Progress cards for current project
    vkb sessions                 Show all active sessions
    vkb board                    Full board summary
    vkb sync [--all]             Trigger VK ↔ GitHub sync
    vkb scan                     Re-scan ~/Dev for new repos

  vkb detects current project from $PWD (git root).
  Bridge must be running: npm run dev
`)
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const [, , cmd, ...rest] = process.argv

async function main(): Promise<void> {
  switch (cmd) {
    case 'new':     return cmdNew(rest)
    case 'start':   return cmdStart(rest)
    case 'review':  return cmdMove('in_review')
    case 'done':    return cmdMove('done')
    case 'status':  return cmdStatus()
    case 'sessions': return cmdSessions()
    case 'board':   return cmdBoard()
    case 'sync':    return cmdSync(rest)
    case 'scan':    return cmdScan()
    case '--help':
    case '-h':
    case 'help':
    case undefined: return printHelp()
    default:
      console.error(`vkb: unknown command '${cmd}'. Run 'vkb help' for usage.`)
      process.exit(1)
  }
}

main().catch(err => {
  console.error('vkb:', (err as Error).message)
  process.exit(1)
})
