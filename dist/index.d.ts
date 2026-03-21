#!/usr/bin/env node
export declare const API_BASE = "https://job-alert-api.onrender.com";
export declare let AUTH_FILE: string;
export declare let MCP_CONFIG_FILE: string;
export declare let SETTINGS_FILE: string;
/** Override file paths (for testing only) */
export declare function _setPaths(opts: {
    authFile?: string;
    mcpConfigFile?: string;
    settingsFile?: string;
}): void;
export interface AuthTokens {
    session_token: string;
    refresh_token: string;
    telegram_id: number;
    expires_at: number;
}
export declare function loadTokens(): AuthTokens | null;
export declare function saveTokens(tokens: AuthTokens): void;
export declare function refreshSession(tokens: AuthTokens): Promise<AuthTokens | null>;
export declare function installMcpConfig(): void;
export declare function toolPermissionsInstalled(): boolean;
export declare function installToolPermissions(): void;
export declare function installLaunchAgent(): void;
