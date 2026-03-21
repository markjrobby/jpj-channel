#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";
import { spawn } from "child_process";
// ================================================================
// Config
// ================================================================
export const API_BASE = "https://job-alert-api.onrender.com";
export let AUTH_FILE = path.join(os.homedir(), ".jpj-channel-auth.json");
export let MCP_CONFIG_FILE = path.join(os.homedir(), ".claude.json");
export let SETTINGS_FILE = path.join(os.homedir(), ".claude", "settings.json");
/** Override file paths (for testing only) */
export function _setPaths(opts) {
    if (opts.authFile)
        AUTH_FILE = opts.authFile;
    if (opts.mcpConfigFile)
        MCP_CONFIG_FILE = opts.mcpConfigFile;
    if (opts.settingsFile)
        SETTINGS_FILE = opts.settingsFile;
}
// Polling config
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_BACKOFF_MS = 15 * 60 * 1000; // 15 minutes
const BACKOFF_MULTIPLIER = 2;
// ================================================================
// Auth helpers
// ================================================================
export function loadTokens() {
    try {
        if (fs.existsSync(AUTH_FILE)) {
            const data = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
            return data;
        }
    }
    catch { }
    return null;
}
export function saveTokens(tokens) {
    fs.writeFileSync(AUTH_FILE, JSON.stringify(tokens, null, 2), {
        encoding: "utf8",
        mode: 0o600, // Owner read/write only — tokens are sensitive
    });
}
async function exchangePairingCode(code) {
    const res = await fetch(`${API_BASE}/api/channel/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
    });
    if (!res.ok) {
        const err = await res.text();
        console.error(`Pairing failed (${res.status}): ${err}`);
        return null;
    }
    const data = await res.json();
    const tokens = {
        session_token: data.session_token,
        refresh_token: data.refresh_token,
        telegram_id: data.telegram_id,
        expires_at: Date.now() + data.expires_in * 1000,
    };
    saveTokens(tokens);
    return tokens;
}
export async function refreshSession(tokens) {
    const res = await fetch(`${API_BASE}/api/channel/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    });
    if (!res.ok)
        return null;
    const data = await res.json();
    tokens.session_token = data.session_token;
    tokens.refresh_token = data.refresh_token; // Rotated refresh token
    tokens.expires_at = Date.now() + data.expires_in * 1000;
    saveTokens(tokens);
    return tokens;
}
async function getValidTokens() {
    let tokens = loadTokens();
    if (!tokens)
        return null;
    // Refresh if expired or expiring within 5 minutes
    if (Date.now() > tokens.expires_at - 5 * 60 * 1000) {
        tokens = await refreshSession(tokens);
    }
    return tokens;
}
// ================================================================
// API helpers
// ================================================================
async function fetchFeed(tokens) {
    const res = await fetch(`${API_BASE}/api/channel/feed`, {
        headers: { Authorization: `Bearer ${tokens.session_token}` },
    });
    if (res.status === 401) {
        // Try refresh
        const refreshed = await refreshSession(tokens);
        if (!refreshed)
            throw new Error("Session expired. Run `npx github:markjrobby/jpj-channel` to re-pair.");
        const retry = await fetch(`${API_BASE}/api/channel/feed`, {
            headers: { Authorization: `Bearer ${refreshed.session_token}` },
        });
        if (!retry.ok)
            throw new Error(`Feed request failed: ${retry.status}`);
        return retry.json();
    }
    if (!res.ok)
        throw new Error(`Feed request failed: ${res.status}`);
    return res.json();
}
async function submitMatches(tokens, batchId, matches) {
    const res = await fetch(`${API_BASE}/api/channel/matches`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${tokens.session_token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ batch_id: batchId, matches }),
    });
    if (res.status === 401) {
        const refreshed = await refreshSession(tokens);
        if (!refreshed)
            throw new Error("Session expired. Re-pair required.");
        const retry = await fetch(`${API_BASE}/api/channel/matches`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${refreshed.session_token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ batch_id: batchId, matches }),
        });
        if (!retry.ok)
            throw new Error(`Submit failed: ${retry.status}`);
        return retry.json();
    }
    if (!res.ok)
        throw new Error(`Submit failed: ${res.status}`);
    return res.json();
}
// ================================================================
// CLI: Pairing flow
// ================================================================
function prompt(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr, // Use stderr so it doesn't interfere with MCP stdio
    });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}
export function installMcpConfig() {
    let config = {};
    if (fs.existsSync(MCP_CONFIG_FILE)) {
        try {
            config = JSON.parse(fs.readFileSync(MCP_CONFIG_FILE, "utf8"));
        }
        catch { }
    }
    if (!config.mcpServers)
        config.mcpServers = {};
    config.mcpServers["jpj"] = {
        command: "npx",
        args: ["github:markjrobby/jpj-channel"],
    };
    fs.writeFileSync(MCP_CONFIG_FILE, JSON.stringify(config, null, 2), {
        encoding: "utf8",
        mode: 0o600,
    });
}
const JPJ_TOOLS = ["mcp__jpj__check_jobs", "mcp__jpj__submit_scores"];
export function toolPermissionsInstalled() {
    try {
        if (!fs.existsSync(SETTINGS_FILE))
            return false;
        const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
        const allow = settings?.permissions?.allow ?? [];
        return JPJ_TOOLS.every((t) => allow.includes(t));
    }
    catch {
        return false;
    }
}
export function installToolPermissions() {
    const dir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    let settings = {};
    if (fs.existsSync(SETTINGS_FILE)) {
        try {
            settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
        }
        catch { }
    }
    if (!settings.permissions)
        settings.permissions = {};
    if (!Array.isArray(settings.permissions.allow))
        settings.permissions.allow = [];
    for (const tool of JPJ_TOOLS) {
        if (!settings.permissions.allow.includes(tool)) {
            settings.permissions.allow.push(tool);
        }
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), {
        encoding: "utf8",
        mode: 0o600,
    });
}
async function runPairingFlow() {
    console.error("");
    console.error("  JPJ Channel — AI-Powered Job Scoring");
    console.error("  =====================================");
    console.error("");
    console.error("  Step 1: Send /pair to the JPJ Telegram bot");
    console.error("  Step 2: Enter the 6-digit code below");
    console.error("");
    const code = await prompt("  Pairing code: ");
    if (!/^\d{6}$/.test(code)) {
        console.error("  Invalid code. Must be 6 digits.");
        return false;
    }
    console.error("  Pairing...");
    const tokens = await exchangePairingCode(code);
    if (!tokens) {
        console.error("  Pairing failed. Code may be expired — send /pair again.");
        return false;
    }
    console.error(`  ✓ Paired successfully (Telegram ID: ${tokens.telegram_id})`);
    console.error("");
    // Install MCP config
    installMcpConfig();
    console.error("  ✓ MCP server config written to ~/.claude.json");
    console.error("");
    // Tool permissions
    if (!toolPermissionsInstalled()) {
        console.error("  ┌─────────────────────────────────────────────┐");
        console.error("  │  Tool Permissions                           │");
        console.error("  └─────────────────────────────────────────────┘");
        console.error("");
        console.error("  JPJ needs one tool to submit scores:");
        console.error("");
        console.error("    ✓ submit_scores  — Sends scores back, triggers Telegram alerts");
        console.error("    ✓ check_jobs     — Manual fallback to fetch jobs (read-only)");
        console.error("");
        console.error("  Allowing these means Claude Code won't ask for");
        console.error("  approval each time it scores jobs for you.");
        console.error("");
        const answer = await prompt("  Allow these tools? (y/n): ");
        if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
            installToolPermissions();
            console.error("  ✓ Tool permissions saved to ~/.claude/settings.json");
        }
        else {
            console.error("  Skipped. You'll be prompted each time Claude uses JPJ tools.");
        }
        console.error("");
    }
    console.error("  Done! JPJ is now connected to Claude Code.");
    console.error("");
    const startNow = await prompt("  Start scoring jobs now? (y/n): ");
    if (startNow.toLowerCase() === "y" || startNow.toLowerCase() === "yes") {
        console.error("");
        console.error("  Launching Claude Code with Remote Control...");
        if (process.platform === "darwin") {
            console.error("  (caffeinate will keep your Mac awake)");
        }
        console.error("");
        launchRemoteControl();
    }
    else {
        // Offer auto-start on login
        if (process.platform === "darwin") {
            const autoStart = await prompt("  Start automatically on login instead? (y/n): ");
            if (autoStart.toLowerCase() === "y" || autoStart.toLowerCase() === "yes") {
                installLaunchAgent();
                console.error("  ✓ Launch Agent installed — JPJ will start on login");
                console.error("");
                console.error("  To remove: launchctl unload ~/Library/LaunchAgents/com.jpj.channel.plist");
            }
            else {
                console.error("");
                console.error("  To start later, run:");
                console.error("    claude remote-control --name \"JPJ Job Scoring\"");
            }
        }
        else {
            console.error("");
            console.error("  To start later, run:");
            console.error("    claude remote-control --name \"JPJ Job Scoring\"");
        }
        console.error("");
    }
    return true;
}
// ================================================================
// Launch helpers
// ================================================================
function launchRemoteControl() {
    const args = process.platform === "darwin"
        ? ["caffeinate", "-i", "claude", "remote-control", "--name", "JPJ Job Scoring"]
        : ["claude", "remote-control", "--name", "JPJ Job Scoring"];
    const cmd = args.shift();
    const child = spawn(cmd, args, {
        stdio: "inherit",
        shell: true,
        detached: true,
    });
    child.unref();
    child.on("error", () => {
        console.error("  Could not launch Claude Code.");
        console.error("  Run manually: claude remote-control --name \"JPJ Job Scoring\"");
        console.error("");
    });
}
const LAUNCH_AGENT_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.jpj.channel</string>
  <key>ProgramArguments</key>
  <array>
    <string>claude</string>
    <string>remote-control</string>
    <string>--name</string>
    <string>JPJ Job Scoring</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardErrorPath</key>
  <string>${os.homedir()}/Library/Logs/jpj-channel.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>`;
const LAUNCH_AGENT_DIR = path.join(os.homedir(), "Library", "LaunchAgents");
const LAUNCH_AGENT_FILE = path.join(LAUNCH_AGENT_DIR, "com.jpj.channel.plist");
export function installLaunchAgent() {
    if (!fs.existsSync(LAUNCH_AGENT_DIR)) {
        fs.mkdirSync(LAUNCH_AGENT_DIR, { recursive: true });
    }
    fs.writeFileSync(LAUNCH_AGENT_FILE, LAUNCH_AGENT_PLIST, { encoding: "utf8" });
}
// ================================================================
// Channel: Polling loop
// ================================================================
function formatJobsNotification(feed) {
    const lines = [];
    lines.push(`batch_id: ${feed.batch_id}`);
    lines.push(`ai_threshold: ${feed.ai_threshold}`);
    lines.push(`job_count: ${feed.jobs.length}`);
    lines.push("");
    lines.push("=== RESUME ===");
    lines.push(typeof feed.resume === "string" ? feed.resume : JSON.stringify(feed.resume, null, 2));
    lines.push("");
    lines.push("=== JOBS ===");
    for (const job of feed.jobs) {
        lines.push(`--- Job ID: ${job.job_id} ---`);
        lines.push(`Title: ${job.title}`);
        lines.push(`Company: ${job.company}`);
        if (job.location)
            lines.push(`Location: ${job.location}`);
        if (job.posted_date)
            lines.push(`Posted: ${job.posted_date}`);
        if (job.url)
            lines.push(`URL: ${job.url}`);
        lines.push("");
        lines.push(job.description || "");
        lines.push("");
    }
    return lines.join("\n");
}
async function startPollingLoop(server) {
    let consecutiveErrors = 0;
    function getNextDelay() {
        if (consecutiveErrors === 0)
            return POLL_INTERVAL_MS;
        return Math.min(POLL_INTERVAL_MS * Math.pow(BACKOFF_MULTIPLIER, consecutiveErrors), MAX_BACKOFF_MS);
    }
    async function poll() {
        try {
            const tokens = await getValidTokens();
            if (!tokens) {
                console.error("JPJ: No valid tokens — pairing required. Stopping poll.");
                return; // Stop polling, user needs to re-pair
            }
            const feed = await fetchFeed(tokens);
            if (feed.jobs && feed.jobs.length > 0) {
                console.error(`JPJ: ${feed.jobs.length} new jobs — pushing to Claude`);
                await server.notification({
                    method: "notifications/claude/channel",
                    params: {
                        content: formatJobsNotification(feed),
                        meta: {
                            batch_id: feed.batch_id,
                            job_count: String(feed.jobs.length),
                            ai_threshold: String(feed.ai_threshold),
                        },
                    },
                });
                consecutiveErrors = 0;
            }
            else {
                console.error("JPJ: No pending jobs");
                consecutiveErrors = 0;
            }
        }
        catch (e) {
            consecutiveErrors++;
            console.error(`JPJ: Poll error (attempt ${consecutiveErrors}): ${e.message}`);
        }
        // Schedule next poll
        const delay = getNextDelay();
        console.error(`JPJ: Next poll in ${Math.round(delay / 1000)}s`);
        setTimeout(poll, delay);
    }
    // First poll after a short delay to let the connection settle
    setTimeout(poll, 5000);
}
// ================================================================
// MCP Server (Channel)
// ================================================================
const CHANNEL_INSTRUCTIONS = `You are connected to JPJ (JustPostedJobs), a job alert channel.

New jobs arrive automatically as <channel> events. When you receive one:

1. Read the resume and jobs from the notification
2. Score each job 0-100 based on fit with the resume
3. Weight transferable skills and adjacent experience — don't penalise heavily for unfamiliar domains if core competencies align
4. For borderline jobs (within 10 points of the threshold): lean toward sending, and explain why in match_reason
5. Call submit_scores with the batch_id and all scores

Use action "send" for jobs at or above ai_threshold, "skip" otherwise.
Each match needs: job_id, score (0-100), action ("send" or "skip"), match_reason (1-2 sentences, max 300 chars).

Jobs you mark "send" are delivered as Telegram alerts. Jobs you "skip" are silently filtered.`;
function createServer() {
    const server = new Server({ name: "jpj", version: "2.0.0" }, {
        capabilities: {
            experimental: { "claude/channel": {} },
            tools: {},
        },
        instructions: CHANNEL_INSTRUCTIONS,
    });
    // List tools
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "check_jobs",
                description: "Manual fallback: fetch pending jobs from JPJ. Normally jobs are pushed automatically via channel notifications. Use this only if you need to manually check for jobs.",
                inputSchema: {
                    type: "object",
                    properties: {},
                    required: [],
                },
            },
            {
                name: "submit_scores",
                description: "Submit job scores back to JPJ. Jobs scoring above the user's threshold will be sent as Telegram alerts. Each match needs: job_id, score (0-100), action ('send' or 'skip'), and match_reason (1-2 sentences).",
                inputSchema: {
                    type: "object",
                    properties: {
                        batch_id: {
                            type: "string",
                            description: "The batch_id from the channel notification or check_jobs response",
                        },
                        matches: {
                            type: "array",
                            description: "Array of scored jobs",
                            items: {
                                type: "object",
                                properties: {
                                    job_id: { type: "number", description: "Job ID from the feed" },
                                    score: {
                                        type: "number",
                                        description: "Fit score 0-100. Consider skills match, experience level, and role alignment.",
                                    },
                                    action: {
                                        type: "string",
                                        enum: ["send", "skip"],
                                        description: "send = alert user on Telegram, skip = don't alert",
                                    },
                                    match_reason: {
                                        type: "string",
                                        maxLength: 300,
                                        description: "1-2 sentence explanation of why this is/isn't a good fit (max 300 chars)",
                                    },
                                },
                                required: ["job_id", "score", "action", "match_reason"],
                            },
                        },
                    },
                    required: ["batch_id", "matches"],
                },
            },
        ],
    }));
    // Handle tool calls
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const tokens = await getValidTokens();
        if (!tokens) {
            return {
                content: [
                    {
                        type: "text",
                        text: "Not paired yet. Run `npx github:markjrobby/jpj-channel` in your terminal to pair with JPJ.",
                    },
                ],
            };
        }
        if (name === "check_jobs") {
            try {
                const feed = await fetchFeed(tokens);
                if (!feed.jobs || feed.jobs.length === 0) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "No pending jobs to score right now.",
                            },
                        ],
                    };
                }
                const response = {
                    batch_id: feed.batch_id,
                    ai_threshold: feed.ai_threshold,
                    rubric_version: feed.rubric_version,
                    resume: feed.resume,
                    job_count: feed.jobs.length,
                    jobs: feed.jobs,
                    instructions: `Score each job 0-100 based on fit with the resume above. ` +
                        `Weight transferable skills and adjacent experience — don't penalise heavily for unfamiliar domains if core competencies align. ` +
                        `For borderline jobs (score ${feed.ai_threshold - 10}-${feed.ai_threshold - 1}): lean toward sending, but set action to "send" and explain in match_reason why it's worth a look despite the lower score (e.g. "Borderline — scored below threshold but [specific reason]"). ` +
                        `Use action "send" for score >= ${feed.ai_threshold} OR for borderline sends as described above, "skip" otherwise. ` +
                        `Then call submit_scores with the batch_id and all scores.`,
                };
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(response, null, 2),
                        },
                    ],
                };
            }
            catch (e) {
                return {
                    content: [{ type: "text", text: `Error fetching jobs: ${e.message}` }],
                };
            }
        }
        if (name === "submit_scores") {
            try {
                const result = await submitMatches(tokens, args.batch_id, args.matches);
                return {
                    content: [
                        {
                            type: "text",
                            text: `Submitted ${result.received} scores. ${result.alerts_queued} alerts will be sent to Telegram.`,
                        },
                    ],
                };
            }
            catch (e) {
                return {
                    content: [{ type: "text", text: `Error submitting scores: ${e.message}` }],
                };
            }
        }
        return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
        };
    });
    return server;
}
// ================================================================
// Main
// ================================================================
async function isSessionValid(tokens) {
    /** Check if stored tokens are still valid by hitting the API. */
    try {
        const res = await fetch(`${API_BASE}/api/channel/feed`, {
            headers: { Authorization: `Bearer ${tokens.session_token}` },
        });
        if (res.status === 401) {
            // Try refresh
            const refreshed = await refreshSession(tokens);
            return refreshed !== null;
        }
        return res.ok;
    }
    catch {
        return false;
    }
}
function isInteractiveTerminal() {
    /** Detect if running in a terminal (user ran npx) vs as MCP server (Claude Code spawned). */
    return process.stdin.isTTY === true;
}
async function main() {
    const args = process.argv.slice(2);
    const wantsPair = args.includes("--pair");
    const tokens = loadTokens();
    // If running interactively (user typed npx), show pairing flow
    if (isInteractiveTerminal()) {
        if (!tokens || wantsPair) {
            // No tokens or explicit --pair: run pairing
            const success = await runPairingFlow();
            if (!success)
                process.exit(1);
            process.exit(0);
        }
        // Tokens exist — verify they still work
        console.error("");
        console.error("  JPJ Channel — checking session...");
        const valid = await isSessionValid(tokens);
        if (!valid) {
            console.error("  Session expired or revoked. Let's re-pair.");
            console.error("");
            const success = await runPairingFlow();
            if (!success)
                process.exit(1);
            process.exit(0);
        }
        console.error("  ✓ Already paired and session is valid.");
        console.error("  ✓ MCP server is configured in ~/.claude.json");
        if (!toolPermissionsInstalled()) {
            console.error("");
            console.error("  Tool permissions not yet configured.");
            console.error("  JPJ needs these tools to run without approval prompts:");
            console.error("");
            console.error("    ✓ submit_scores  — Sends scores back, triggers Telegram alerts");
            console.error("    ✓ check_jobs     — Manual fallback to fetch jobs (read-only)");
            console.error("");
            const answer = await prompt("  Allow these tools? (y/n): ");
            if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
                installToolPermissions();
                console.error("  ✓ Tool permissions saved to ~/.claude/settings.json");
            }
            else {
                console.error("  Skipped. You'll be prompted each time Claude uses JPJ tools.");
            }
        }
        else {
            console.error("  ✓ Tool permissions configured.");
        }
        console.error("");
        console.error("  Jobs are scored automatically while Claude Code is running.");
        console.error("  To start:    claude remote-control --name \"JPJ Job Scoring\"");
        console.error("  To re-pair:  npx github:markjrobby/jpj-channel --pair");
        console.error("");
        process.exit(0);
    }
    // Non-interactive: launched by Claude Code as MCP server + channel
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("JPJ channel running — polling every 5 minutes");
    // Start the polling loop to push jobs as channel notifications
    await startPollingLoop(server);
}
// Only run main when executed directly (not when imported for testing)
// npx resolves argv[1] to the bin symlink (e.g. "jpj-channel"), not "index.js"
const isDirectRun = process.argv[1]?.endsWith("index.js") ||
    process.argv[1]?.endsWith("index.ts") ||
    process.argv[1]?.endsWith("jpj-channel");
if (isDirectRun) {
    main().catch((e) => {
        console.error("Fatal error:", e);
        process.exit(1);
    });
}
