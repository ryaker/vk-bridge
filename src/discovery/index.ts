import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, join, basename, dirname } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'
import { VKClient } from '../vk/client.js'
import { loadConfig, type BridgeConfig, type ProjectConfig } from '../config.js'

export interface DiscoveredRepo {
  /** Absolute path to repo root */
  path: string
  /** Directory name (e.g. 'vk-bridge') */
  name: string
  /** 'owner/repo' from git remote, or null */
  githubRemote: string | null
  /** Matched VK project ID, or null */
  vkProjectId: string | null
  /** Already present in config.projects */
  inConfig: boolean
}

/** Extract 'owner/repo' from a git remote URL */
function parseGitHubRemote(repoPath: string): string | null {
  try {
    const remote = execSync('git remote get-url origin', {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe']
    })
      .toString()
      .trim()
    // ssh: git@github.com:owner/repo.git
    // https: https://github.com/owner/repo.git
    const match =
      remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/) ||
      remote.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/**
 * Find git repos up to `maxDepth` levels under `rootDir`.
 * Skips node_modules, .git internals, hidden dirs.
 */
function findGitRepos(rootDir: string, maxDepth = 2): string[] {
  const repos: string[] = []

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return
    let entries: string[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
    } catch {
      return
    }

    for (const name of entries) {
      if (name.startsWith('.') || name === 'node_modules') continue
      const full = join(dir, name)
      if (existsSync(join(full, '.git'))) {
        repos.push(full)
        // Don't descend into a repo — nested repos are unusual
      } else {
        walk(full, depth + 1)
      }
    }
  }

  walk(rootDir, 0)
  return repos
}

/**
 * Fuzzy-match a repo name against a list of VK project names.
 * Returns the best matching project ID or null.
 */
function fuzzyMatchVKProject(
  repoName: string,
  projects: Array<{ id: string; name: string }>
): string | null {
  const needle = repoName.toLowerCase().replace(/[-_]/g, '')
  for (const p of projects) {
    const hay = p.name.toLowerCase().replace(/[-_\s]/g, '')
    if (hay === needle || hay.includes(needle) || needle.includes(hay)) {
      return p.id
    }
  }
  return null
}

function configPath(): string {
  return join(homedir(), '.vk-bridge', 'config.json')
}

export class ProjectDiscovery {
  async scan(): Promise<DiscoveredRepo[]> {
    const config = loadConfig()
    const configuredPaths = new Set(Object.keys(config.projects))

    // Resolve and deduplicate scan dirs
    const scanDirs = config.scan_dirs.map(d =>
      d.startsWith('~/') ? resolve(homedir(), d.slice(2)) : resolve(d)
    )

    // Collect all git repos
    const repoPaths: string[] = []
    for (const dir of scanDirs) {
      repoPaths.push(...findGitRepos(dir))
    }

    // Get VK projects for matching (best-effort — don't fail if VK is down)
    let vkProjects: Array<{ id: string; name: string }> = []
    try {
      const client = new VKClient(config.vk_port)
      const orgs = await client.getOrganizations()
      for (const org of orgs) {
        const projects = await client.listProjects(org.id)
        vkProjects.push(...projects)
      }
    } catch {
      // VK unavailable — continue without matching
    }

    const results: DiscoveredRepo[] = []
    for (const repoPath of repoPaths) {
      const name = basename(repoPath)
      const inConfig = configuredPaths.has(repoPath)
      const githubRemote = parseGitHubRemote(repoPath)

      let vkProjectId: string | null = null
      if (inConfig) {
        vkProjectId = config.projects[repoPath]?.vk_project_id ?? null
      } else {
        vkProjectId = fuzzyMatchVKProject(name, vkProjects)
      }

      results.push({ path: repoPath, name, githubRemote, vkProjectId, inConfig })
    }

    return results
  }

  /**
   * Write newly discovered repos into config.json.
   * Only writes repos that are NOT already in config and have a matched vkProjectId
   * (or if auto_create_projects is true, writes all).
   * Returns count of new entries written.
   */
  syncConfig(repos: DiscoveredRepo[]): number {
    const config = loadConfig()
    const newEntries = repos.filter(r => !r.inConfig && r.vkProjectId !== null)
    if (newEntries.length === 0) return 0

    // Read raw config file to preserve formatting / comments
    const path = configPath()
    let raw: Record<string, unknown> = {}
    if (existsSync(path)) {
      try {
        raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
      } catch {
        raw = {}
      }
    }

    const projects = (raw.projects as Record<string, unknown>) ?? {}
    for (const repo of newEntries) {
      const entry: ProjectConfig = {
        vk_project_id: repo.vkProjectId!,
        github_repo: repo.githubRemote,
        github_token: repo.githubRemote ? '${GITHUB_TOKEN}' : null,
        github_webhook_secret: null,
        auto_create_github_issues: false
      }
      projects[repo.path] = entry
    }
    raw.projects = projects

    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify(raw, null, 2) + '\n')
    return newEntries.length
  }
}
