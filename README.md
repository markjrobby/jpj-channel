# JPJ Channel

AI-powered job scoring for [JustPostedJobs](https://t.me/justpostedjobs) via Claude Code.

Jobs matching your filters are scored by Claude against your resume. High-fit jobs are sent as alerts on the JPJ Telegram bot.

## Setup

### 1. Get a pairing code

Send `/pair` to the [JPJ Telegram bot](https://t.me/justpostedjobs_bot).

### 2. Run the pairing command

```bash
npx github:markjrobby/jpj-channel
```

Enter the 6-digit code when prompted. This stores your auth tokens locally and configures Claude Code automatically.

### 3. Use it

In Claude Code, ask:

> "Check my JPJ jobs and score them"

Claude will fetch pending jobs, score each one against your resume, and submit the results. High-scoring jobs are sent as Telegram alerts.

## How it works

- JPJ holds jobs matching your filters instead of sending them immediately
- This MCP server exposes `check_jobs` and `submit_scores` tools to Claude Code
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
| `check_jobs` | Fetch pending jobs + your resume for scoring |
| `submit_scores` | Submit scores back to JPJ, triggering Telegram alerts |
