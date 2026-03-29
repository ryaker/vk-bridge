# vk-bridge

> Your Vibe Kanban board, actually up to date.

If you use Claude Code (or OpenCode, Gemini CLI, etc.) from the terminal, your Kanban board is lying to you. Cards sit in Backlog while agents are deep into `fix/auth-timeout`. PRs merge without the board moving. You end up with three browser tabs open reconciling state that should reconcile itself.

vk-bridge fixes that.

---

## What it does

A sidecar service that runs alongside [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) and makes it the single pane of glass for **all** agent work — not just sessions you started from the VK UI.

```
You type: claude
vk-bridge: registered sess-abc → card RYA-27 (In Progress) ✓

You push a branch, open a PR
vk-bridge: card RYA-27 → In Review ✓

PR merges
vk-bridge: card RYA-27 → Done, GH issue closed ✓
```

No UI clicks. No manual card moves. No cron job.

---

## The problem it solves

VK is designed for humans to create tasks then launch agents from the UI. In practice, most AI coding sessions start differently:

- `claude` from a terminal in any project dir
- Parallel worktrees running background agents
- A Gemini CLI session or Zora task
- Work with no GitHub issue yet

None of these show up on the board. vk-bridge makes all of them visible.

---

## Features

**Agent auto-registration** — any Claude Code session registers on start via a global `SessionStart` hook. One install, works across every project.

**Card matching** — vk-bridge finds the right VK card for a session using a priority chain:
1. VK worktree metadata (exact match, zero guessing)
2. Issue number in branch name (`fix/issue-309` → card `#309`)
3. Open PR linked to the branch
4. Fuzzy title match (`fix/auth-timeout` → card "Fix auth timeout")
5. Creates a new card if nothing matches

**Bidirectional GitHub sync** — webhook-driven, not polling:
- Issue opened → Backlog card
- PR opened → In Review
- PR merged → Done, GH issue closed
- VK card moved to Done → GH issue closed

**Agent sovereignty** — cards owned by a live session are protected. GitHub events queue up and apply when the agent releases the card, not while it's mid-task.

**VK → GitHub sync** — 5-min poller pushes card state changes back: Done closes the issue, Cancelled marks wontfix, In Review adds a comment.

---

## Quick start

```bash
git clone https://github.com/ryaker/vk-bridge
cd vk-bridge
npm install

# Install global Claude Code hooks (one-time setup)
npm run install-hooks

# Install the vkb CLI to your PATH
npm run install-vkb

# Start the bridge
npm run dev
```

After `install-hooks`, every `claude` session — in any project — auto-registers and gets a VK card. You'll see the card move to In Progress the moment Claude starts working.

```bash
# Check what's in flight
vkb status

# Move the current card when you're done
vkb review
vkb done

# See all active agent sessions
vkb sessions

# Scan ~/Dev for new repos and link them to VK
vkb scan
```

---

## Config

`~/.vk-bridge/config.json` — created with defaults on first run:

```json
{
  "vk_port": 3333,
  "bridge_port": 3334,
  "scan_dirs": ["~/Dev"],
  "auto_register_repos": true,
  "auto_create_projects": false,
  "projects": {
    "~/Dev/my-app": {
      "vk_project_id": "01e6f151-...",
      "github_repo": "you/my-app",
      "github_token": "${GITHUB_TOKEN}",
      "github_webhook_secret": "${VK_BRIDGE_WEBHOOK_SECRET}",
      "auto_create_github_issues": false
    }
  }
}
```

`github_token` and `github_webhook_secret` can be env var references (`${VAR}`) — they're never stored in plaintext.

---

## GitHub webhooks

To get real-time GitHub → VK sync (instead of waiting for the poller):

1. Go to your repo → Settings → Webhooks → Add webhook
2. Payload URL: `https://your-tunnel/github/webhook` (or `localhost:3334/github/webhook` via ngrok/cloudflare)
3. Content type: `application/json`
4. Secret: set `VK_BRIDGE_WEBHOOK_SECRET` in your env, use the same value here
5. Events: Issues, Pull requests

---

## API

The bridge exposes a REST API at `:3334`:

```
POST   /sessions              Register agent session
PATCH  /sessions/:id          Update session status
GET    /sessions              List active sessions
GET    /sessions/:id          Get session details
POST   /github/webhook        Receive GitHub events
GET    /health                Health check + VK connectivity
```

### Register a session manually

```bash
curl -s -X POST localhost:3334/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "runtime": "claude_code",
    "project_path": "/Users/you/Dev/my-app",
    "branch": "fix/issue-42"
  }'
```

Response includes `session_id`, `vk_card_id`, and `vk_card_simple_id` (e.g. `RYA-42`).

### Wrap any CLI tool

```bash
# Gemini wrapper — add to ~/.zshrc
gemini() {
  local SESS=$(curl -s -X POST localhost:3334/sessions \
    -H "Content-Type: application/json" \
    -d "{\"runtime\":\"gemini\",\"project_path\":\"$PWD\",\"branch\":\"$(git rev-parse --abbrev-ref HEAD 2>/dev/null)\"}" \
    | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).session_id))")
  command gemini "$@"
  curl -s -X PATCH "localhost:3334/sessions/$SESS" \
    -H "Content-Type: application/json" \
    -d '{"status":"done"}' > /dev/null
}
```

---

## How the hooks work

`npm run install-hooks` adds three hooks to `~/.claude/settings.json`:

| Hook | What it does |
|------|-------------|
| `SessionStart` | Calls `POST /sessions`, writes `~/.vk-bridge/active/{pid}.json` |
| `Stop` | Calls `PATCH /sessions/{id}` with final status, cleans up |
| `UserPromptSubmit` | Injects current card info as context so Claude always knows its VK card |

The context injection means Claude sees something like this at the start of each prompt:

```
[VK] Card RYA-27 (#309 fix: auth timeout) — In Progress
     Move with: vkb review | vkb done
```

---

## Status

| Phase | Status | What |
|-------|--------|------|
| Phase 1 | ✅ Done | Agent registry, Card Matcher, Claude Code hooks |
| Phase 2 | ✅ Done | GitHub bidirectional sync (webhooks + poller) |
| Phase 3 | ✅ Done | Project Discovery, `vkb` CLI |
| Phase 4 | Planned | Gemini + Zora adapters |
| Phase 5 | Planned | Contribute External Session API + webhooks upstream to VK |

---

## Architecture

```
Agents                              vk-bridge :3334
──────                              ───────────────
Claude Code (VK-started)   ──┐
Claude Code (terminal)     ──┤
Claude Code (worktree)     ──┼──► POST /sessions ──► Card Matcher ──► VK card
Gemini CLI (wrapped)       ──┤                            │
Zora task                  ──┘                    find | create | update
                                                         │
GitHub webhooks ────────────────────────────────────────►│
                                                  GitHub Bridge
VK card changes ────────────────────────────► 5-min poller → GitHub
```

---

## Contributing

Bug reports, ideas, and PRs welcome. The end goal (Phase 5) is contributing the External Session Registration API and Card Change Webhooks upstream to VK itself — making this kind of integration first-class rather than a sidecar.
