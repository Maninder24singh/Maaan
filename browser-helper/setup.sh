#!/usr/bin/env bash
# One-time setup. Run:  bash setup.sh
set -e
cd "$(dirname "$0")"

echo "1/3  Installing the browser tool (Playwright)..."
npm init -y >/dev/null 2>&1 || true
npm install playwright @playwright/mcp
npx playwright install chromium

echo "2/3  Installing the AI helper (Gemini CLI, uses your Google AI Pro login)..."
npm install -g @google/gemini-cli

echo "3/3  Giving the AI helper a browser (separate profile, NOT your main Chrome)..."
mkdir -p "$HOME/agent-profile"
gemini mcp add playwright npx @playwright/mcp@latest --user-data-dir "$HOME/agent-profile" || \
  echo "(!) Could not add the browser tool automatically. See README.md, section 'If setup step 3 fails'."

echo
echo "Done. Next: run  gemini  once, choose 'Login with Google', sign in with your AI Pro account."
