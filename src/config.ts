export interface ProjectConfig {
  vk_project_id: string | null
  github_repo: string | null
  github_token: string | null
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

export function loadConfig(): BridgeConfig {
  return {
    vk_port: 3333,
    bridge_port: 3334,
    scan_dirs: [],
    auto_register_repos: false,
    auto_create_projects: false,
    projects: {},
  }
}
