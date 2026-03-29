#!/usr/bin/env bash
# vk-bridge Gemini wrapper
# Registers the Gemini session with vk-bridge on start and marks it done on exit.
# Add to ~/.zshrc:
#   source ~/.vk-bridge/hooks/gemini-wrapper.sh

BRIDGE_URL="${VK_BRIDGE_URL:-http://localhost:3334}"

gemini() {
  local PROJECT_PATH BRANCH SESSION_ID EXIT_CODE

  PROJECT_PATH="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")"

  # Register session — capture session_id, ignore errors if bridge is down
  SESSION_ID="$(curl -sf -X POST "${BRIDGE_URL}/sessions" \
    -H "Content-Type: application/json" \
    -d "{\"runtime\":\"gemini\",\"project_path\":\"${PROJECT_PATH}\",\"branch\":\"${BRANCH}\"}" \
    2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null || true)"

  # Run Gemini
  command gemini "$@"
  EXIT_CODE=$?

  # Update status on exit
  if [ -n "$SESSION_ID" ]; then
    local STATUS="done"
    [ $EXIT_CODE -ne 0 ] && STATUS="blocked"
    curl -sf -X PATCH "${BRIDGE_URL}/sessions/${SESSION_ID}" \
      -H "Content-Type: application/json" \
      -d "{\"status\":\"${STATUS}\"}" > /dev/null 2>&1 || true
  fi

  return $EXIT_CODE
}
