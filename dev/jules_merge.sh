#!/bin/bash

# Usage: ./dev/jules_merge.sh {bot|modules|REPO_NAME} [FROM_BRANCH] [TO_BRANCH]
# Examples:
#   ./dev/jules_merge.sh bot dev main
#   ./dev/jules_merge.sh modules dev main
#   ./dev/jules_merge.sh cfuser0x11/krupez-bot dev main

TARGET="$1"
FROM_BRANCH="${2:-dev}"
TO_BRANCH="${3:-main}"

if [ -z "$TARGET" ]; then
  echo "Usage: $0 {bot|modules|owner/repo} [FROM_BRANCH] [TO_BRANCH]"
  echo "Examples:"
  echo "  $0 bot dev main"
  echo "  $0 modules dev main"
  exit 1
fi

case "$TARGET" in
  bot)
    REPO="cfuser0x11/krupez-bot"
    ;;
  modules)
    REPO="cfuser0x11/krupez-modules"
    ;;
  *)
    REPO="$TARGET"
    ;;
esac

echo "Sending Jules merge request for repository '$REPO': '$FROM_BRANCH' -> '$TO_BRANCH'..."

node -e "
const { spawn } = require('child_process');
const proc = spawn('npx', ['-y', '@google/jules-mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });

proc.stdout.on('data', d => {
  const str = d.toString();
  if (str.includes('Session created') || str.includes('result')) {
    try {
      const json = JSON.parse(str);
      if (json.result && json.result.content) {
        console.log('\x1b[32m[Jules MCP]\x1b[0m', json.result.content[0].text);
        return;
      }
    } catch(e) {}
    console.log('\x1b[32m[Jules MCP]\x1b[0m', str.trim());
  }
});

const req = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: {
    name: 'create_session',
    arguments: {
      prompt: 'Create a Pull Request to merge the ' + process.argv[2] + ' branch into the ' + process.argv[3] + ' branch for repository ' + process.argv[1] + '. Include all commit history and comments from ' + process.argv[2] + ', resolve any merge conflicts in favor of ' + process.argv[2] + ', and submit the PR.',
      repo: process.argv[1],
      branch: process.argv[3],
      title: 'PR: Merge ' + process.argv[2] + ' into ' + process.argv[3],
      autoPr: true
    }
  }
}) + '\n';

setTimeout(() => {
  proc.stdin.write(req);
}, 1000);

setTimeout(() => proc.kill(), 6000);
" "$REPO" "$FROM_BRANCH" "$TO_BRANCH"
