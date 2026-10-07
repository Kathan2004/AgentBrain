#!/usr/bin/env bash
# End-to-end smoke test of the CLI in a throwaway Git repo.
set -euo pipefail

CLI="$(cd "$(dirname "$0")/.." && pwd)/dist/cli/main.js"
ab() { node "$CLI" "$@"; }

REPO="$(mktemp -d)"
BIN="$(mktemp -d)"
trap 'rm -rf "$REPO" "$BIN"' EXIT
printf '#!/usr/bin/env bash\nexec node "%s" "$@"\n' "$CLI" > "$BIN/agentbrain"
chmod +x "$BIN/agentbrain"
export PATH="$BIN:$PATH"

cd "$REPO"
git init -q -b main
echo demo > README.md
git add -A && git -c user.name=t -c user.email=t@t commit -qm init

ab init
ab task create "Build login"
ab rules
ab task update --agent claude-code --done "Build login" --todo "Add tests" --decision "Use JWT" --next "Add tests"
echo "export {}" > auth.ts
ab checkpoint
ab handoff --reason "session ended"

# A stand-in agent that reads the brief and records progress like a real one would.
ab run --agent stub -- bash -c 'grep -q "Use JWT" "$AGENTBRAIN_PROMPT_FILE" && agentbrain task update --done "Add tests" --status review'

ab status
ab agents
find .agentbrain -type f | sort
