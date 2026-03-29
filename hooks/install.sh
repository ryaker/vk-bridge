#!/usr/bin/env bash
# Install vk-bridge hooks into ~/.claude/settings.json

set -euo pipefail

HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
SETTINGS_FILE=~/.claude/settings.json

echo "Installing vk-bridge Claude Code hooks..."
echo "  Hook scripts: $HOOKS_DIR"
echo "  Settings file: $SETTINGS_FILE"

# Ensure settings file exists
if [ ! -f "$SETTINGS_FILE" ]; then
  echo "{}" > "$SETTINGS_FILE"
fi

# Use python3 to safely merge hooks into settings.json
python3 << PYEOF
import json, os

settings_path = os.path.expanduser("$SETTINGS_FILE")
hooks_dir = "$HOOKS_DIR"

with open(settings_path) as f:
    settings = json.load(f)

new_hooks = {
    "SessionStart": [{
        "matcher": ".*",
        "hooks": [{"type": "command", "command": f"{hooks_dir}/claude-start.sh"}]
    }],
    "Stop": [{
        "matcher": ".*",
        "hooks": [{"type": "command", "command": f"{hooks_dir}/claude-stop.sh"}]
    }],
    "UserPromptSubmit": [{
        "matcher": ".*",
        "hooks": [{"type": "command", "command": f"{hooks_dir}/claude-context.sh"}]
    }]
}

# Merge: add vk-bridge hooks without removing existing ones
existing = settings.get("hooks", {})
for event, hook_list in new_hooks.items():
    if event not in existing:
        existing[event] = hook_list
    else:
        # Check if vk-bridge hook already present
        vkb_commands = {h["hooks"][0]["command"] for h in hook_list}
        already = any(
            h["hooks"][0]["command"] in vkb_commands
            for h in existing[event]
            if h.get("hooks")
        )
        if not already:
            existing[event].extend(hook_list)

settings["hooks"] = existing

with open(settings_path, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")

print("✓ Hooks installed into", settings_path)
PYEOF

# Offer Gemini wrapper install
echo ""
echo "Gemini CLI wrapper (optional):"
echo "  To track Gemini sessions, add this to your ~/.zshrc:"
echo "    source $HOOKS_DIR/gemini-wrapper.sh"
echo ""
ZSHRC="${HOME}/.zshrc"
if [ -f "$ZSHRC" ]; then
  if grep -q "gemini-wrapper.sh" "$ZSHRC"; then
    echo "  ✓ Gemini wrapper already in $ZSHRC"
  else
    read -r -p "  Add Gemini wrapper to $ZSHRC now? [y/N] " REPLY
    if [[ "$REPLY" =~ ^[Yy]$ ]]; then
      echo "" >> "$ZSHRC"
      echo "# vk-bridge Gemini wrapper" >> "$ZSHRC"
      echo "source $HOOKS_DIR/gemini-wrapper.sh" >> "$ZSHRC"
      echo "  ✓ Added to $ZSHRC (restart your shell or run: source ~/.zshrc)"
    fi
  fi
fi
