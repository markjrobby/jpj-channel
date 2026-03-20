import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { _setPaths, loadTokens, saveTokens, installMcpConfig, refreshSession, } from "./index.js";
// ================================================================
// Helpers
// ================================================================
function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "jpj-test-"));
}
function sampleTokens(overrides = {}) {
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
    let tmpDir;
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
    let tmpDir;
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
        assert.equal(loaded.session_token, "sess_abc");
        assert.equal(loaded.refresh_token, "ref_xyz");
        assert.equal(loaded.telegram_id, 42);
    });
    it("returns null for corrupt JSON", () => {
        const authFile = path.join(tmpDir, "auth.json");
        fs.writeFileSync(authFile, "not-json{{{");
        const result = loadTokens();
        assert.equal(result, null);
    });
});
describe("installMcpConfig", () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = makeTmpDir();
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    it("creates config file when it does not exist", () => {
        const mcpFile = path.join(tmpDir, ".claude.json");
        _setPaths({ mcpConfigFile: mcpFile });
        assert.equal(fs.existsSync(mcpFile), false);
        installMcpConfig();
        assert.equal(fs.existsSync(mcpFile), true);
        const result = JSON.parse(fs.readFileSync(mcpFile, "utf8"));
        assert.deepEqual(result.mcpServers["jpj"], {
            command: "npx",
            args: ["github:markjrobby/jpj-channel"],
        });
    });
    it("preserves existing mcpServers entries", () => {
        const mcpFile = path.join(tmpDir, ".claude.json");
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
    it("preserves non-MCP settings in claude.json", () => {
        const mcpFile = path.join(tmpDir, ".claude.json");
        const existing = { numStartups: 100, theme: "dark" };
        fs.writeFileSync(mcpFile, JSON.stringify(existing));
        _setPaths({ mcpConfigFile: mcpFile });
        installMcpConfig();
        const result = JSON.parse(fs.readFileSync(mcpFile, "utf8"));
        assert.equal(result.numStartups, 100);
        assert.equal(result.theme, "dark");
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
        assert.equal(pattern.test("12345"), false); // too short
        assert.equal(pattern.test("1234567"), false); // too long
        assert.equal(pattern.test("abcdef"), false); // letters
        assert.equal(pattern.test("12 345"), false); // space
        assert.equal(pattern.test(""), false); // empty
        assert.equal(pattern.test("12345a"), false); // mixed
    });
});
describe("refreshSession", () => {
    let tmpDir;
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
        }));
        try {
            const result = await refreshSession(originalTokens);
            assert.notEqual(result, null);
            assert.equal(result.session_token, "new_session");
            assert.equal(result.refresh_token, "new_refresh");
            assert.equal(typeof result.expires_at, "number");
            // Verify tokens were persisted
            const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf8"));
            assert.equal(saved.refresh_token, "new_refresh");
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    it("returns null on failed refresh", async () => {
        const tokens = sampleTokens();
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () => ({
            ok: false,
            status: 401,
        }));
        try {
            const result = await refreshSession(tokens);
            assert.equal(result, null);
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
});
