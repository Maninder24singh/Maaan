# Browser Helper (easy version)

Tell the AI what site to open and what to do. Teach it once, it repeats.
Uses your **Google AI Pro** login. No API key.

## Setup (once, 3 steps)

Needs Node.js 20+ (https://nodejs.org).

```bash
cd browser-helper
bash setup.sh
gemini
```

In `gemini`, pick **Login with Google** and sign in. Then type `/quit`.

## Use it

**1. Ask the AI to do something now**

```bash
./go "open youtube and search lo-fi music"
```

It asks your OK before using the browser tool. Say yes.

**2. Teach it once, then repeat for free**

```bash
./teach youtube https://youtube.com     # do the task by hand, close the window
./replay youtube                         # it repeats your steps
./replay                                 # list what you taught
```

## ChatGPT chat box

```bash
./chatgpt --login                      # once: log in by hand, close the window
./chatgpt "give me 3 dinner ideas"     # types it in the chat box, prints the reply
```

Uses its own folder `~/chatgpt-profile`. May hit "verify you are human" checks.
Automating the ChatGPT website can go against OpenAI's terms. Use a spare account.
If it says "Chat box not found", ChatGPT changed its page; the line to fix is `#prompt-textarea` in `chatgpt.js`.

## Safety (read this one)

- The browser uses its own folder `~/agent-profile`, NOT your main Chrome. It cannot see your other logins.
- Log in to a site inside that browser only if you are okay with the AI using that account.
- The AI is told to stop and ask before money, passwords, deleting, or sending.
- Keep your money sites (bank, shopping) out of this browser for now.

## If setup step 3 fails

Gemini CLI versions differ. Add the browser tool by hand: run `gemini`, type `/mcp`,
and check that `playwright` is listed. If not, create `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--user-data-dir", "/home/YOURNAME/agent-profile"]
    }
  }
}
```

## Use Claude instead (if your plan is Claude Pro)

```bash
npm install -g @anthropic-ai/claude-code
claude mcp add playwright -- npx @playwright/mcp@latest --user-data-dir ~/agent-profile
ENGINE=claude ./go "open youtube and search lo-fi music"
```
