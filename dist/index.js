#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";
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
        console.error("  JPJ needs two tools to run automatically:");
        console.error("");
        console.error("    ✓ check_jobs     — Fetches new jobs + your resume (read-only)");
        console.error("    ✓ submit_scores  — Sends scores back, triggers Telegram alerts");
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
    console.error("  Restart Claude Code, then ask Claude to check your jobs.");
    console.error("");
    return true;
}
// ================================================================
// MCP Server
// ================================================================
function createServer() {
    const server = new Server({ name: "jpj", version: "1.0.0" }, { capabilities: { tools: {} } });
    // List tools
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "check_jobs",
                description: "Fetch pending jobs from JPJ that need scoring. Returns jobs with titles, companies, descriptions, and the user's resume for comparison. Score each job 0-100 for fit.",
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
                            description: "The batch_id from check_jobs response",
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
                                text: "No pending jobs to score right now. Check back later.",
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
                        `Use action "send" for score >= ${feed.ai_threshold}, "skip" otherwise. ` +
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
        console.error("  MCP server is configured in ~/.claude.json");
        if (!toolPermissionsInstalled()) {
            console.error("");
            console.error("  Tool permissions not yet configured.");
            console.error("  JPJ needs two tools to run without approval prompts:");
            console.error("");
            console.error("    ✓ check_jobs     — Fetches new jobs + your resume (read-only)");
            console.error("    ✓ submit_scores  — Sends scores back, triggers Telegram alerts");
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
        console.error("  Restart Claude Code, then ask Claude to check your jobs.");
        console.error("  To re-pair: npx github:markjrobby/jpj-channel --pair");
        console.error("");
        process.exit(0);
    }
    // Non-interactive: launched by Claude Code as MCP server
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("JPJ MCP server running");
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
