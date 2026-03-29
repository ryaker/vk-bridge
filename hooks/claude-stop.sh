#!/usr/bin/env bash
# Called by Claude Code Stop hook

set -euo pipefail

PID=$$
ACTIVE_FILE=~/.vk-bridge/active/${PID}.json

if [ ! -f "$ACTIVE_FILE" ]; then
  exit 0
fi

SESSION_ID=$(python3 -c "import sys,json; d=json.load(open('$ACTIVE_FILE')); print(d['session_id'])" 2>/dev/null || echo "")

if [ -n "$SESSION_ID" ]; then
  # Determine status from git state
  PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
  BRANCH=$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

  # Check if branch has upstream
  HAS_UPSTREAM=$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo "")

  if [ -n "$HAS_UPSTREAM" ]; then
    STATUS="in_review"
  else
    STATUS="in_progress"
  fi

  curl -sf -X PATCH "http://localhost:3334/sessions/$SESSION_ID" \
    -H "Content-Type: application/json" \
    -d "{\"status\":\"$STATUS\"}" \
    > /dev/null 2>&1 || true
fi

rm -f "$ACTIVE_FILE"
