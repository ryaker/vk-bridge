import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { resolve } from 'path'

export interface ProjectConfig {
  vk_project_id: string | null
  github_repo: string | null
  github_token: string | null
  github_webhook_secret: string | null
  auto_create_github_issues: boolean
}

export interface BridgeConfig {
  vk_port: number
  bridge_port: number
  scan_dirs: string[]
  auto_register_repos: boolean
  auto_create_projects: boolean
  projects: Record<string, ProjectConfig>
}

const DEFAULTS: BridgeConfig = {
  vk_port: 3333,
  bridge_port: 3334,
  scan_dirs: ['~/Dev'],
  auto_register_repos: true,
  auto_create_projects: false,
  projects: {}
}

/** Expand ~ to home directory */
function expandPath(p: string): string {
  return p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : resolve(p)
}

/** Substitute ${VAR} with process.env values */
function expandEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '')
}

/** Recursively expand env vars in any string values of an object */
function expandEnvInObject(obj: unknown): unknown {
  if (typeof obj === 'string') return expandEnv(obj)
  if (Array.isArray(obj)) return obj.map(expandEnvInObject)
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, expandEnvInObject(v)])
    )
  }
  return obj
}

export function loadConfig(configPath?: string): BridgeConfig {
  const path = configPath ?? expandPath('~/.vk-bridge/config.json')

  if (!existsSync(path)) {
    return {
      ...DEFAULTS,
      scan_dirs: DEFAULTS.scan_dirs.map(expandPath)
    }
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (e) {
    throw new Error(`Failed to parse config at ${path}: ${(e as Error).message}`)
  }

  const merged = { ...DEFAULTS, ...(raw as Partial<BridgeConfig>) }

  // Expand env vars throughout
  const expanded = expandEnvInObject(merged) as BridgeConfig

  // Expand paths in scan_dirs and project keys
  expanded.scan_dirs = expanded.scan_dirs.map(expandPath)
  const expandedProjects: Record<string, ProjectConfig> = {}
  for (const [key, val] of Object.entries(expanded.projects)) {
    expandedProjects[expandPath(key)] = val
  }
  expanded.projects = expandedProjects

  return expanded
}

/** Get project config for a given repo path. Returns null if not configured. */
export function getProjectConfig(repoPath: string, config: BridgeConfig): ProjectConfig | null {
  const abs = resolve(repoPath)
  return config.projects[abs] ?? null
}
