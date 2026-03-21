# JPJ Channel

AI-powered job scoring for [JustPostedJobs](https://t.me/justpostedjobs) via Claude Code.

Jobs matching your filters are automatically pushed to Claude, scored against your resume, and only the best matches are sent as Telegram alerts.

> **This is open-source.** You can review every line of code before installing — see [`src/index.ts`](src/index.ts). For details on what data is sent where, see [Privacy & data](#privacy--data).

## Setup

### 1. Get a pairing code

Send `/pair` to the [JPJ Telegram bot](https://t.me/justpostedjobs_bot).

### 2. Run the pairing command

```bash
npx github:markjrobby/jpj-channel
```

Enter the 6-digit code when prompted. This stores your auth tokens locally and configures Claude Code automatically.

### 3. That's it

Jobs are scored automatically while Claude Code is running. No commands to run — just leave Claude Code open.

## How it works

- JPJ holds jobs matching your filters instead of sending them immediately
- This MCP server runs as a Claude Code **channel** — it polls for new jobs every 5 minutes
- When jobs arrive, they're pushed directly into your Claude Code session
- Claude evaluates each job against your resume and scores it 0-100
- Jobs above your threshold are sent as alerts on the JPJ Telegram bot
- Jobs not scored within 24 hours are sent as normal (unscored) alerts

## Re-pairing

To re-pair with a new code:

```bash
npx github:markjrobby/jpj-channel --pair
```

## Tools

| Tool | Description |
|------|-------------|
| `check_jobs` | Manual fallback to fetch pending jobs (normally pushed automatically) |
| `submit_scores` | Submit scores back to JPJ, triggering Telegram alerts |

## Privacy & data

This is fully open-source — you're reading it. Here's exactly what data goes where.

**What stays on your machine:**
- Your auth tokens (`~/.jpj-channel-auth.json`, owner-read-only)
- Your Claude Code conversations and files
- All scoring happens locally in your Claude Code session

**What's sent to the JPJ server (`job-alert-api.onrender.com`):**
- `check_jobs` / polling — your session token. Server returns your resume + pending jobs.
- `submit_scores` — batch ID, job IDs, scores (0-100), actions (send/skip), match reasons (1-2 sentences). This triggers Telegram alerts for jobs you marked "send".

**What's stored on the server:**
- Your resume (uploaded via the Telegram bot, used for matching)
- Your job filter preferences
- Scores and match reasons you submit

**What's NOT sent or stored:**
- Your Claude Code conversation history
- Your codebase or files
- Any data from other MCP servers

**Your data, your control:**
- Send `/delete` to [@justpostedjobs_bot](https://t.me/justpostedjobs_bot) to delete your resume and all AI matching data
- Uninstall anytime: `claude mcp remove jpj`

## Requirements

- Claude Code v2.1.80+ with channels enabled
