#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";

// ================================================================
// Config
// ================================================================

export const API_BASE = "https://job-alert-api.onrender.com";
export let AUTH_FILE = path.join(os.homedir(), ".jpj-channel-auth.json");
export let MCP_CONFIG_FILE = path.join(os.homedir(), ".claude", "mcp.json");

/** Override file paths (for testing only) */
export function _setPaths(opts: { authFile?: string; mcpConfigFile?: string }) {
  if (opts.authFile) AUTH_FILE = opts.authFile;
  if (opts.mcpConfigFile) MCP_CONFIG_FILE = opts.mcpConfigFile;
}

export interface AuthTokens {
  session_token: string;
  refresh_token: string;
  telegram_id: number;
  expires_at: number; // unix timestamp
}

// ================================================================
// Auth helpers
// ================================================================

export function loadTokens(): AuthTokens | null {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const data = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
      return data as AuthTokens;
    }
  } catch {}
  return null;
}

export function saveTokens(tokens: AuthTokens): void {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(tokens, null, 2), {
    encoding: "utf8",
    mode: 0o600, // Owner read/write only — tokens are sensitive
  });
}

async function exchangePairingCode(code: string): Promise<AuthTokens | null> {
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
  const tokens: AuthTokens = {
    session_token: data.session_token,
    refresh_token: data.refresh_token,
    telegram_id: data.telegram_id,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  saveTokens(tokens);
  return tokens;
}

export async function refreshSession(tokens: AuthTokens): Promise<AuthTokens | null> {
  const res = await fetch(`${API_BASE}/api/channel/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: tokens.refresh_token }),
  });

  if (!res.ok) return null;

  const data = await res.json();
  tokens.session_token = data.session_token;
  tokens.refresh_token = data.refresh_token; // Rotated refresh token
  tokens.expires_at = Date.now() + data.expires_in * 1000;
  saveTokens(tokens);
  return tokens;
}

async function getValidTokens(): Promise<AuthTokens | null> {
  let tokens = loadTokens();
  if (!tokens) return null;

  // Refresh if expired or expiring within 5 minutes
  if (Date.now() > tokens.expires_at - 5 * 60 * 1000) {
    tokens = await refreshSession(tokens);
  }
  return tokens;
}

// ================================================================
// API helpers
// ================================================================

async function fetchFeed(tokens: AuthTokens): Promise<any> {
  const res = await fetch(`${API_BASE}/api/channel/feed`, {
    headers: { Authorization: `Bearer ${tokens.session_token}` },
  });

  if (res.status === 401) {
    // Try refresh
    const refreshed = await refreshSession(tokens);
    if (!refreshed) throw new Error("Session expired. Run `npx github:markjrobby/jpj-channel` to re-pair.");

    const retry = await fetch(`${API_BASE}/api/channel/feed`, {
      headers: { Authorization: `Bearer ${refreshed.session_token}` },
    });
    if (!retry.ok) throw new Error(`Feed request failed: ${retry.status}`);
    return retry.json();
  }

  if (!res.ok) throw new Error(`Feed request failed: ${res.status}`);
  return res.json();
}

async function submitMatches(
  tokens: AuthTokens,
  batchId: string,
  matches: any[]
): Promise<any> {
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
    if (!refreshed) throw new Error("Session expired. Re-pair required.");

    const retry = await fetch(`${API_BASE}/api/channel/matches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${refreshed.session_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ batch_id: batchId, matches }),
    });
    if (!retry.ok) throw new Error(`Submit failed: ${retry.status}`);
    return retry.json();
  }

  if (!res.ok) throw new Error(`Submit failed: ${res.status}`);
  return res.json();
}

// ================================================================
// CLI: Pairing flow
// ================================================================

function prompt(question: string): Promise<string> {
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

export function installMcpConfig(): void {
  const claudeDir = path.join(os.homedir(), ".claude");
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  let config: any = {};
  if (fs.existsSync(MCP_CONFIG_FILE)) {
    try {
      config = JSON.parse(fs.readFileSync(MCP_CONFIG_FILE, "utf8"));
    } catch {}
  }

  if (!config.mcpServers) config.mcpServers = {};

  config.mcpServers["jpj"] = {
    command: "npx",
    args: ["github:markjrobby/jpj-channel"],
  };

  fs.writeFileSync(MCP_CONFIG_FILE, JSON.stringify(config, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function runPairingFlow(): Promise<boolean> {
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

  console.error(`  Paired successfully (Telegram ID: ${tokens.telegram_id})`);
  console.error("");

  // Install MCP config
  installMcpConfig();
  console.error("  MCP server config written to ~/.claude/mcp.json");
  console.error("");
  console.error("  Done! JPJ is now connected to Claude Code.");
  console.error("  Restart Claude Code, then ask Claude to check your jobs.");
  console.error("");

  return true;
}

// ================================================================
// MCP Server
// ================================================================

function createServer(): Server {
  const server = new Server(
    { name: "jpj", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "check_jobs",
        description:
          "Fetch pending jobs from JPJ that need scoring. Returns jobs with titles, companies, descriptions, and the user's resume for comparison. Score each job 0-100 for fit.",
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: [],
        },
      },
      {
        name: "submit_scores",
        description:
          "Submit job scores back to JPJ. Jobs scoring above the user's threshold will be sent as Telegram alerts. Each match needs: job_id, score (0-100), action ('send' or 'skip'), and match_reason (1-2 sentences).",
        inputSchema: {
          type: "object" as const,
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
                    description: "1-2 sentence explanation of why this is/isn't a good fit",
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
            type: "text" as const,
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
                type: "text" as const,
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
          instructions:
            `Score each job 0-100 based on fit with the resume above. ` +
            `Use action "send" for score >= ${feed.ai_threshold}, "skip" otherwise. ` +
            `Then call submit_scores with the batch_id and all scores.`,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Error fetching jobs: ${e.message}` }],
        };
      }
    }

    if (name === "submit_scores") {
      try {
        const result = await submitMatches(
          tokens,
          args!.batch_id as string,
          args!.matches as any[]
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Submitted ${result.received} scores. ${result.alerts_queued} alerts will be sent to Telegram.`,
            },
          ],
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Error submitting scores: ${e.message}` }],
        };
      }
    }

    return {
      content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
    };
  });

  return server;
}

// ================================================================
// Main
// ================================================================

async function main() {
  const args = process.argv.slice(2);

  // If no tokens exist, run pairing flow
  const tokens = loadTokens();

  if (!tokens || args.includes("--pair")) {
    const success = await runPairingFlow();
    if (!success) process.exit(1);
    if (args.includes("--pair")) process.exit(0);
    // After pairing in non-pair mode, continue to start server
  }

  // Start MCP server
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("JPJ MCP server running");
}

// Only run main when executed directly (not when imported for testing)
const isDirectRun =
  process.argv[1]?.endsWith("index.js") ||
  process.argv[1]?.endsWith("index.ts");

if (isDirectRun) {
  main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
}
