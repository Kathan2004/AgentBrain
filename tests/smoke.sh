#!/usr/bin/env bash
# End-to-end smoke test of the CLI in a throwaway Git repo.
set -euo pipefail

CLI="$(cd "$(dirname "$0")/.." && pwd)/dist/cli/main.js"
ab() { node "$CLI" "$@"; }

REPO="$(mktemp -d)"
trap 'rm -rf "$REPO"' EXIT
cd "$REPO"
git init -q -b main
echo demo > README.md
git add -A && git -c user.name=t -c user.email=t@t commit -qm init

ab init
ab task create "Build login"
ab task update --agent claude-code --done "Build login" --todo "Add tests" --decision "Use JWT" --next "Add tests"
echo "export {}" > auth.ts
ab status
ab handoff --reason "session ended"
ab resume --agent codex
ab task list
find .agentbrain -type f | sort
