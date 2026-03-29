# vk-bridge — Spec

**Status**: Design / pre-implementation
**Date**: 2026-03-28
**Goal**: Universal work tracking layer that makes Vibe Kanban the single pane of glass for all agent work across all projects, regardless of how or where agents start.

---

## Problem Statement

Vibe Kanban is designed for humans to create tasks and then start agents from the UI. That is the minority case for this workflow. The majority case is:

- Agents started from terminal conversations (`claude` in a project dir)
- Agents started from background parallel worktrees
- Agents started by Zora receiving a task from AgentBus
- Agents started by Gemini CLI
- Work that has no GitHub issue yet
- Projects with no issue tracker at all

The result: VK board is always stale, manual to update, and covers maybe 20% of actual in-flight work. GitHub and VK drift apart. You spend time reconciling instead of working.

---

## What vk-bridge Is

A **sidecar service** that runs alongside the VK local server and provides:

1. **Universal Agent Registry** — every agent session registers here regardless of runtime or origin
2. **Card Matcher** — maps any session to the right VK card, creating one if needed
3. **GitHub Bridge** — true bidirectional sync via webhooks, not polling
4. **Project Discovery** — auto-scans `~/Dev`, registers repos with VK
5. **Terminal CLI** (`vkb`) — create/manage cards without the UI

It is NOT a VK fork. It uses VK's existing `/api/remote/*` endpoints as a client. After it's working, the most useful pieces (external session API, card change webhooks) get contributed upstream to VK OSS.

---

## System Map

```
┌──────────────────────────────────────────────────────────────┐
│                       vk-bridge :3334                         │
│                                                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐  │
│  │  Agent Registry  │  │  GitHub Bridge  │  │  Project    │  │
│  │  + Card Matcher  │  │  (bidirectional)│  │  Discovery  │  │
│  └────────┬─────────┘  └───────┬─────────┘  └──────┬──────┘  │
│           │                    │                    │         │
│  ┌────────┴────────────────────┴────────────────────┴──────┐  │
│  │                      Event Bus                          │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │              Terminal CLI  (vkb)                        │  │
│  └─────────────────────────────────────────────────────────┘  │
└──────────┬─────────────────────────┬─────────────────────────┘
           │                         │
     VK :3333                  GitHub API
     /api/remote/*             + Webhooks
```

```
Agents                              vk-bridge
──────                              ─────────
Claude Code (VK-started)   ──┐
Claude Code (terminal)     ──┤
Claude Code (worktree)     ──┼──► POST /sessions ──► Card Matcher ──► VK card
Gemini CLI (wrapped)       ──┤                            │
Zora task                  ──┘                    find | create | update
```

---

## Component 1: Agent Registry

### Registration

Any agent session — regardless of runtime or origin — registers on start:

```
POST /sessions
{
  "runtime": "claude_code" | "gemini" | "zora" | "unknown",
  "project_path": "/Users/ryaker/Dev/SparrowDB",
  "branch": "fix/issue-309",
  "worktree_path": "/Users/ryaker/Dev/SparrowDB/.claude/worktrees/agent-abc/",
  "pid": 12345
}
→ {
  "session_id": "sess-uuid",
  "vk_card_id": "card-uuid",
  "vk_card_simple_id": "RYA-27",
  "vk_project_id": "01e6f151...",
  "vk_status_ids": { "todo": "...", "in_progress": "...", "in_review": "...", "done": "..." }
}
```

Bridge immediately moves the card to In Progress on successful registration.

### Status updates

```
PATCH /sessions/{session_id}
{ "status": "in_progress" | "in_review" | "done" | "blocked" }
```

### Listing

```
GET /sessions
→ [ { session_id, runtime, project_path, branch, vk_card_simple_id, status, started_at } ]
```

### Session end

Called by hook on agent exit. Bridge moves card to the right column based on git state:
- Unpushed changes → leaves In Progress
- Branch pushed, no PR → In Review
- PR open → In Review
- PR merged → Done

---

## Component 2: Card Matcher

Given `{ project_path, branch }`, finds or creates the right VK card. Priority order:

**1. VK worktree metadata** (exact match, no guessing)
VK writes a `.vk-session.json` in every worktree it creates. If the session is inside a VK worktree, read it directly.

**2. Branch → issue number**
Regex: `/(fix|feat|perf|bug|chore|refactor|test|arch)\/.*?(\d+)/`
Extracts issue number → search VK board for card with `#NNN` in title.

**3. Branch → GitHub PR**
Check if branch has an open PR on GitHub → find VK card linked to that PR body/title, or create card from PR data.

**4. Branch name fuzzy match**
Search VK board cards for title similar to branch slug (e.g., `fix/auth-timeout` → card "Fix auth timeout").

**5. Create new card**
Branch name → card title (slugified), project auto-detected from path, status: In Progress immediately.

### Project detection from path

Bridge config maps paths to VK project IDs. If not in config: scan VK's registered repos, match by path. If still no match: offer to create a new VK project for this repo.

---

## Component 3: GitHub Bridge

### GitHub → VK (webhook-driven)

Receive `POST /github/webhook` from GitHub:

| GitHub event | VK action |
|---|---|
| Issue opened | Create card in Backlog |
| Issue assigned to owner | Move to Todo |
| Issue closed (merged) | Move to Done *unless agent owns it* |
| Issue closed (not merged) | Move to Cancelled |
| PR opened for issue | Move to In Review |
| PR merged | Move to Done |
| Issue reopened | Move back to Todo |

**Agent-owned cards are sovereign.** If a card is In Progress or In Review, GitHub events are queued, not applied. Applied when agent releases the card.

### VK → GitHub (polling VK for changes)

Poll VK every 5 minutes for card state changes (until upstream webhook API exists):

| VK event | GitHub action |
|---|---|
| New card created (if `auto_create_github_issues: true`) | Create GitHub issue |
| Card moved to Done | Close GitHub issue + comment with branch/PR |
| Card moved to Cancelled | Close GitHub issue with `wontfix` label |
| Card description updated | Sync to GitHub issue body |
| Card moved to In Review | Comment on GH issue with PR link |

### Conflict resolution

- Agent-owned (In Progress / In Review): agent wins
- Non-agent cards: last-write-wins by timestamp
- Both updated simultaneously: GitHub is advisory, VK is authoritative for non-agent cards

---

## Component 4: Project Discovery

On startup, scans configured `scan_dirs` (default: `~/Dev`) for git repos.

For each repo found:

1. Is it registered in VK? → link it in bridge config
2. Is it not registered? → call `POST /api/repos` to register with VK
3. Does it have a GitHub remote? → extract `owner/repo` for GH bridge
4. Does it have a VK project? → optionally auto-create project

Discovery runs on startup and on `vkb scan`. Never auto-creates projects without user confirmation (or explicit `auto_create_projects: true` in config).

---

## Component 5: Terminal CLI (`vkb`)

```bash
# Create a card
vkb new "Fix authentication timeout" --priority high
vkb new "Fix authentication timeout" --project SparrowDB --github
# → Creates VK card, optionally creates GH issue, prints RYA-50

# Start working (optionally creates worktree + starts agent)
vkb start RYA-50
vkb start RYA-50 --worktree  # also creates worktree + launches claude

# Update your card
vkb review   # move current project's In Progress card to In Review
vkb done     # move to Done

# See what's happening
vkb status            # In Progress cards for current git repo
vkb sessions          # all active agent sessions bridge knows about
vkb board             # full board summary (all columns)

# Sync
vkb sync              # manual GitHub ↔ VK sync for current project
vkb sync --all        # all projects

# Discovery
vkb scan              # re-scan ~/Dev for new repos
```

`vkb` detects current project from `$PWD` git root.

---

## Hook Adapters

### Claude Code (global — all projects)

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": ".*",
      "hooks": [{ "type": "command", "command": "~/.vk-bridge/hooks/claude-start.sh" }]
    }],
    "Stop": [{
      "matcher": ".*",
      "hooks": [{ "type": "command", "command": "~/.vk-bridge/hooks/claude-stop.sh" }]
    }],
    "UserPromptSubmit": [{
      "matcher": ".*",
      "hooks": [{ "type": "command", "command": "~/.vk-bridge/hooks/claude-context.sh" }]
    }]
  }
}
```

**`claude-start.sh`**: calls `POST /sessions`, writes `{ session_id, vk_card_id, vk_status_ids }` to `~/.vk-bridge/active/{pid}.json`

**`claude-stop.sh`**: reads active file, calls `PATCH /sessions/{id}`, cleans up

**`claude-context.sh`**: reads active file, outputs card status as context injection so agent always knows its VK card without asking. Example output injected:
```
[VK] Card RYA-27 (#309 bug(csr): n_nodes overcounts) — In Progress
     Move with: vkb review | vkb done
```

### Gemini CLI

Wrap in `~/.zshrc`:
```bash
gemini() {
  local SESS=$(curl -s -X POST localhost:3334/sessions \
    -H "Content-Type: application/json" \
    -d "{\"runtime\":\"gemini\",\"project_path\":\"$PWD\",\"branch\":\"$(git rev-parse --abbrev-ref HEAD 2>/dev/null)\"}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['session_id'])")
  command gemini "$@"
  local EXIT=$?
  curl -s -X PATCH "localhost:3334/sessions/$SESS" \
    -H "Content-Type: application/json" \
    -d '{"status":"done"}' > /dev/null
  return $EXIT
}
```

### Zora

Middleware in task handler (`src/zora/task-handler.ts`):
```typescript
// On task start
await fetch('http://localhost:3334/sessions', {
  method: 'POST',
  body: JSON.stringify({ runtime: 'zora', project_path: task.projectPath, branch: task.branch })
})

// On task complete
await fetch(`http://localhost:3334/sessions/${sessionId}`, {
  method: 'PATCH',
  body: JSON.stringify({ status: 'done' })
})
```

### Parallel Worktrees (existing `parallel-worktree-setup` skill)

No changes needed. Those sessions are Claude Code — they get the global `SessionStart` hook automatically. Bridge picks them up.

---

## Config File

`~/.vk-bridge/config.json`:

```json
{
  "vk_port": 3333,
  "bridge_port": 3334,
  "scan_dirs": ["~/Dev"],
  "auto_register_repos": true,
  "auto_create_projects": false,
  "projects": {
    "~/Dev/SparrowDB": {
      "vk_project_id": "01e6f151-71e8-4fd4-985e-25d78dcc4d3f",
      "github_repo": "ryaker/SparrowDB",
      "github_token": "${GITHUB_TOKEN}",
      "github_webhook_secret": "${VK_BRIDGE_WEBHOOK_SECRET}",
      "auto_create_github_issues": false
    },
    "~/Dev/agent-bus": {
      "vk_project_id": "9327397d-e495-43a2-a12e-2df0c321bcf0",
      "github_repo": "ryaker/agent-bus",
      "github_token": "${GITHUB_TOKEN}",
      "auto_create_github_issues": true
    },
    "~/Dev/abundancecoach.ai": {
      "vk_project_id": null,
      "github_repo": null,
      "auto_create_github_issues": false
    }
  }
}
```

Active session files: `~/.vk-bridge/active/{pid}.json`
Logs: `~/.vk-bridge/logs/bridge.log`

---

## Upstream VK Contributions (Phase 5)

Two PRs to contribute to `github.com/BloopAI/vibe-kanban`:

### PR 1: External Session Registration API

```
POST /api/sessions/external
{
  "executor": "claude_code" | "gemini" | "custom",
  "worktree_path": "...",
  "branch": "...",
  "repo_id": "...",
  "task_id": "..."   // optional — if known
}
→ { session_id, workspace_id }
```

Lets VK display and track externally-started sessions the same way it tracks its own. Shows up in the UI session list.

### PR 2: Card Change Webhooks

```
POST /api/webhooks
{
  "url": "http://localhost:3334/vk-events",
  "events": ["task.status_changed", "task.created", "task.deleted", "task.updated"],
  "project_id": "..."  // optional — omit for all projects
}
```

Fires when cards change. Eliminates 5-minute polling for VK → GitHub sync. Makes everything real-time.

These are genuinely useful for any integration, not just this project — good upstream story.

---

## Phased Implementation

### Phase 1 — Agent Registry + Claude Code Hooks
*Foundation. Makes every Claude Code session visible.*

- [ ] vk-bridge service boots, reads config
- [ ] `POST /sessions` endpoint + Card Matcher (branch → issue number heuristic first)
- [ ] `PATCH /sessions/{id}` endpoint
- [ ] `GET /sessions` endpoint
- [ ] `claude-start.sh`, `claude-stop.sh`, `claude-context.sh` hooks
- [ ] Install hooks into `~/.claude/settings.json`
- [ ] Active session files in `~/.vk-bridge/active/`
- [ ] Logging to `~/.vk-bridge/logs/`

**Done when**: Start `claude` in any `~/Dev` project, VK card appears In Progress automatically.

### Phase 2 — GitHub Bidirectional Sync
*Makes GitHub and VK stay in sync without the cron band-aid.*

- [ ] GitHub webhook receiver (`POST /github/webhook` with HMAC verification)
- [ ] Issue opened → Backlog card
- [ ] Issue closed → Done card (agent-ownership check)
- [ ] PR opened → In Review card
- [ ] PR merged → Done card
- [ ] VK → GitHub polling (5 min) for card changes
- [ ] Card done → close GH issue
- [ ] Config: `auto_create_github_issues` per project
- [ ] Replace SparrowDB `vk-sync.py` cron with this

**Done when**: Open a GitHub issue, it appears in VK. Merge a PR, card moves to Done. No cron.

### Phase 3 — Project Discovery + CLI
*Makes the whole `~/Dev` tree visible, terminal-first workflows.*

- [ ] `scan_dirs` scanning on startup
- [ ] Auto-register repos with VK
- [ ] `vkb` CLI: `new`, `start`, `review`, `done`, `status`, `sessions`, `sync`, `scan`
- [ ] `vkb` detects project from `$PWD`
- [ ] Install `vkb` to PATH

**Done when**: `vkb new "some task"` from any project dir creates a VK card.

### Phase 4 — Gemini + Zora Adapters
*Covers the non-Claude-Code runtimes.*

- [ ] Gemini shell wrapper
- [ ] Zora middleware
- [ ] Card Matcher improvements: VK worktree metadata, fuzzy match

**Done when**: Gemini and Zora sessions show up in VK alongside Claude Code sessions.

### Phase 5 — VK Upstream Contributions
*Make this less of a hack, contribute back.*

- [ ] PR: External Session Registration API
- [ ] PR: Card Change Webhooks
- [ ] Replace polling with webhooks once merged

---

## What This Replaces

| Current | Replaced by |
|---|---|
| `vk-sync.py` cron (hourly, GitHub→VK only) | Phase 2 GitHub bridge (real-time, bidirectional) |
| Manual card creation in VK UI | Phase 1 auto-registration + Phase 3 `vkb new` |
| Agents forgetting to update cards | Phase 1 hooks (autonomous) |
| Only SparrowDB tracked | Phase 3 all `~/Dev` projects |
| Only GitHub-issue-linked agents | Phase 1 any agent, any origin |
| Band-aid `vk-sync.py` in SparrowDB/scripts | Delete it |

---

## Open Questions

1. **Auto-create GitHub issues from VK cards?** Off by default, opt-in per project. When an agent creates a card via `vkb new` in a GH-configured project, does it auto-open a GH issue? Probably opt-in flag: `vkb new "..." --github`.

2. **What if an agent session has no matchable project?** (e.g., `claude` run in `~/` or a non-`~/Dev` path) → Create a catch-all "Misc" VK project, or skip registration with a warning.

3. **Gemini CLI — is it worth the wrapper complexity?** If Gemini sessions are infrequent, Phase 4 can wait. Claude Code covers 90% of sessions.

4. **Session that spans multiple cards?** Rare but possible (agent pivots to a different issue). Handled by: agent explicitly calls `PATCH /sessions/{id}` with `{ "vk_card_id": "new-card-id" }` to reassign.

5. **VK project for projects with no GH and no VK project yet?** `auto_create_projects: false` means user confirms via `vkb scan` output. Don't silently create.
