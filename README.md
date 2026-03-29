# vk-bridge

Universal agent tracking layer for Vibe Kanban.

Makes VK the single pane of glass for all agent work across all projects — regardless of how or where agents start.

## The Problem

VK is designed for humans to create tasks then start agents from the UI. Most actual agent work starts elsewhere: terminal conversations, background worktrees, Zora tasks, Gemini sessions. Result: VK board is always stale and covers ~20% of real in-flight work.

## What This Does

- **Any agent session** (Claude Code, Gemini, Zora) auto-registers and gets a VK card
- **Any origin** (VK dashboard, terminal, parallel worktree, AgentBus) is tracked
- **Bidirectional GitHub sync** — issues appear in VK, merged PRs close VK cards
- **All `~/Dev` projects** — not just ones with GitHub issues
- **Terminal CLI** (`vkb`) — create/manage cards without the UI

## Docs

- [`SPEC.md`](./SPEC.md) — full architecture and implementation spec

## Status

Pre-implementation. See SPEC.md Phase 1 for starting point.
