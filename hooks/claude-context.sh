#!/usr/bin/env bash
# Called by Claude Code UserPromptSubmit hook
# Outputs VK card context that gets injected into system prompt

PID=$$
ACTIVE_FILE=~/.vk-bridge/active/${PID}.json

if [ ! -f "$ACTIVE_FILE" ]; then
  exit 0
fi

SESSION_ID=$(python3 -c "import sys,json; d=json.load(open('$ACTIVE_FILE')); print(d.get('session_id',''))" 2>/dev/null || echo "")
CARD_SIMPLE=$(python3 -c "import sys,json; d=json.load(open('$ACTIVE_FILE')); print(d.get('vk_card_simple_id',''))" 2>/dev/null || echo "")

if [ -n "$SESSION_ID" ] && [ -n "$CARD_SIMPLE" ]; then
  # Fetch current card title from vk-bridge
  CARD_INFO=$(curl -sf "http://localhost:3334/sessions/$SESSION_ID" 2>/dev/null || echo "")
  if [ -n "$CARD_INFO" ]; then
    CARD_STATUS=$(echo "$CARD_INFO" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
    echo "[VK] Card $CARD_SIMPLE — $CARD_STATUS | Move: vkb review | vkb done"
  fi
fi
