#!/usr/bin/env bash
# Called by Claude Code SessionStart hook
# Env vars provided by Claude Code: CLAUDE_PROJECT_DIR, CLAUDE_SESSION_ID

set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
BRANCH=$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
PID=$$

# Register with vk-bridge
RESPONSE=$(curl -sf -X POST http://localhost:3334/sessions \
  -H "Content-Type: application/json" \
  -d "{\"runtime\":\"claude_code\",\"project_path\":\"$PROJECT_DIR\",\"branch\":\"$BRANCH\",\"pid\":$PID}" \
  2>/dev/null) || {
  # vk-bridge not running — silently exit (non-blocking)
  exit 0
}

SESSION_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['session_id'])" 2>/dev/null || echo "")
CARD_SIMPLE=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['vk_card_simple_id'])" 2>/dev/null || echo "")

if [ -n "$SESSION_ID" ]; then
  mkdir -p ~/.vk-bridge/active
  echo "$RESPONSE" > ~/.vk-bridge/active/${PID}.json
  # Output context injection for Claude — this goes into the system prompt
  echo "[VK] Registered as $CARD_SIMPLE (session $SESSION_ID)"
  echo "[VK] Move with: vkb review | vkb done"
fi
