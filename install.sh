#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="work-together"

if ! command -v node >/dev/null 2>&1; then
  echo "[work-together] Node.js is required. Please install Node.js v18 or newer." >&2
  exit 1
fi

NODE_VERSION="$(node -v | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
if (( NODE_MAJOR < 18 )); then
  echo "[work-together] Node.js v18+ required, found v${NODE_VERSION}." >&2
  exit 1
fi

echo "[work-together] Removing any existing global installation..."
npm uninstall -g "${PROJECT_NAME}" >/dev/null 2>&1 || true

echo "[work-together] Installing CLI globally via npm..."
npm install -g "$SCRIPT_DIR" >/dev/null

GLOBAL_BIN="$(npm bin -g)"
TARGET_LINK="/usr/local/bin/${PROJECT_NAME}"
if [ -x "${GLOBAL_BIN}/${PROJECT_NAME}" ]; then
  rm -f "${TARGET_LINK}" 2>/dev/null || true
  ln -sf "${GLOBAL_BIN}/${PROJECT_NAME}" "${TARGET_LINK}" 2>/dev/null || true
fi

CONFIG_DIR="${HOME}/.work-together"
CONFIG_FILE="${CONFIG_DIR}/config.json"
mkdir -p "${CONFIG_DIR}"

if [ ! -f "${CONFIG_FILE}" ]; then
  cat <<JSON >"${CONFIG_FILE}"
{
  "defaultAgents": ["claude", "codex"],
  "apiKeys": {
    "claude": null,
    "codex": null,
    "opencode": null
  },
  "preferences": {
    "colorScheme": "default",
    "updateFrequencyMs": 1000,
    "actionTimeoutMs": 300000
  }
}
JSON
  echo "[work-together] Created default config at ${CONFIG_FILE}."
else
  echo "[work-together] Config already exists at ${CONFIG_FILE}."
fi

echo "[work-together] Remember to export your API keys before running the CLI:"
echo "  export ANTHROPIC_API_KEY=your_key"
echo "  export OPENAI_API_KEY=your_key"
echo "  export OPENCODE_API_KEY=your_key"

echo "[work-together] Installation complete. Run 'work-together' to launch the CLI."
