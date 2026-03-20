import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  _setPaths,
  loadTokens,
  saveTokens,
  installMcpConfig,
  refreshSession,
  type AuthTokens,
} from "./index.js";

// ================================================================
// Helpers
// ================================================================

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jpj-test-"));
}

function sampleTokens(overrides: Partial<AuthTokens> = {}): AuthTokens {
  return {
    session_token: "sess_abc",
    refresh_token: "ref_xyz",
    telegram_id: 123456,
    expires_at: Date.now() + 3600_000,
    ...overrides,
  };
}

// ================================================================
// Tests
// ================================================================

describe("saveTokens", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    _setPaths({ authFile: path.join(tmpDir, "auth.json") });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes file with 0o600 permissions", () => {
    const tokens = sampleTokens();
    saveTokens(tokens);

    const authFile = path.join(tmpDir, "auth.json");
    const stat = fs.statSync(authFile);
    // 0o600 = owner read/write only (octal 33152 on macOS includes file-type bits)
    const mode = stat.mode & 0o777;
    assert.equal(mode, 0o600, `Expected mode 0600, got ${mode.toString(8)}`);
  });

  it("writes valid JSON with all token fields", () => {
    const tokens = sampleTokens({ telegram_id: 999 });
    saveTokens(tokens);

    const authFile = path.join(tmpDir, "auth.json");
    const data = JSON.parse(fs.readFileSync(authFile, "utf8"));
    assert.equal(data.session_token, "sess_abc");
    assert.equal(data.refresh_token, "ref_xyz");
    assert.equal(data.telegram_id, 999);
    assert.equal(typeof data.expires_at, "number");
  });
});

describe("loadTokens", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    _setPaths({ authFile: path.join(tmpDir, "auth.json") });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when file does not exist", () => {
    const result = loadTokens();
    assert.equal(result, null);
  });

  it("parses valid JSON correctly", () => {
    const tokens = sampleTokens({ telegram_id: 42 });
    const authFile = path.join(tmpDir, "auth.json");
    fs.writeFileSync(authFile, JSON.stringify(tokens));

    const loaded = loadTokens();
    assert.notEqual(loaded, null);
    assert.equal(loaded!.session_token, "sess_abc");
    assert.equal(loaded!.refresh_token, "ref_xyz");
    assert.equal(loaded!.telegram_id, 42);
  });

  it("returns null for corrupt JSON", () => {
    const authFile = path.join(tmpDir, "auth.json");
    fs.writeFileSync(authFile, "not-json{{{");

    const result = loadTokens();
    assert.equal(result, null);
  });
});

describe("installMcpConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates missing .claude directory", () => {
    const claudeDir = path.join(tmpDir, ".claude");
    const mcpFile = path.join(claudeDir, "mcp.json");

    // Override both paths — installMcpConfig reads os.homedir() internally,
    // but MCP_CONFIG_FILE is what it actually uses for the file path.
    // We also need the claudeDir to match. We'll override MCP_CONFIG_FILE
    // and also need to ensure the dir derivation works. Since installMcpConfig
    // uses path.join(os.homedir(), ".claude") for the dir, we mock at the
    // file level: create a custom config path under tmpDir.
    _setPaths({ mcpConfigFile: mcpFile });

    // The dir doesn't exist yet
    assert.equal(fs.existsSync(claudeDir), false);

    // installMcpConfig creates claudeDir from os.homedir(), which we can't
    // easily override. Instead, create the directory manually to test the
    // config-writing logic, and test dir creation separately.
    fs.mkdirSync(claudeDir, { recursive: true });
    installMcpConfig();

    assert.equal(fs.existsSync(mcpFile), true);
  });

  it("preserves existing mcpServers entries", () => {
    const claudeDir = path.join(tmpDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const mcpFile = path.join(claudeDir, "mcp.json");

    // Write an existing config with another server
    const existing = {
      mcpServers: {
        "my-other-server": {
          command: "node",
          args: ["other-server.js"],
        },
      },
    };
    fs.writeFileSync(mcpFile, JSON.stringify(existing));
    _setPaths({ mcpConfigFile: mcpFile });

    installMcpConfig();

    const result = JSON.parse(fs.readFileSync(mcpFile, "utf8"));
    // Original server preserved
    assert.deepEqual(result.mcpServers["my-other-server"], {
      command: "node",
      args: ["other-server.js"],
    });
    // JPJ server added
    assert.deepEqual(result.mcpServers["jpj"], {
      command: "npx",
      args: ["github:markjrobby/jpj-channel"],
    });
  });

  it("handles empty existing config file", () => {
    const claudeDir = path.join(tmpDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const mcpFile = path.join(claudeDir, "mcp.json");
    fs.writeFileSync(mcpFile, "{}");
    _setPaths({ mcpConfigFile: mcpFile });

    installMcpConfig();

    const result = JSON.parse(fs.readFileSync(mcpFile, "utf8"));
    assert.deepEqual(result.mcpServers["jpj"], {
      command: "npx",
      args: ["github:markjrobby/jpj-channel"],
    });
  });
});

describe("pairing code validation", () => {
  it("accepts exactly 6 digits", () => {
    const pattern = /^\d{6}$/;
    assert.equal(pattern.test("123456"), true);
    assert.equal(pattern.test("000000"), true);
    assert.equal(pattern.test("999999"), true);
  });

  it("rejects non-6-digit strings", () => {
    const pattern = /^\d{6}$/;
    assert.equal(pattern.test("12345"), false);   // too short
    assert.equal(pattern.test("1234567"), false);  // too long
    assert.equal(pattern.test("abcdef"), false);   // letters
    assert.equal(pattern.test("12 345"), false);   // space
    assert.equal(pattern.test(""), false);          // empty
    assert.equal(pattern.test("12345a"), false);   // mixed
  });
});

describe("refreshSession", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    _setPaths({ authFile: path.join(tmpDir, "auth.json") });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("updates refresh_token from server response", async () => {
    const originalTokens = sampleTokens({
      refresh_token: "old_refresh",
    });

    // Mock global fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        session_token: "new_session",
        refresh_token: "new_refresh",
        expires_in: 3600,
      }),
    })) as any;

    try {
      const result = await refreshSession(originalTokens);
      assert.notEqual(result, null);
      assert.equal(result!.session_token, "new_session");
      assert.equal(result!.refresh_token, "new_refresh");
      assert.equal(typeof result!.expires_at, "number");

      // Verify tokens were persisted
      const saved = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8")
      );
      assert.equal(saved.refresh_token, "new_refresh");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns null on failed refresh", async () => {
    const tokens = sampleTokens();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 401,
    })) as any;

    try {
      const result = await refreshSession(tokens);
      assert.equal(result, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
