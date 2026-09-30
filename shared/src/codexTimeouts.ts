/** Timeout budgets for Codex app-server operations and their HAPI callers. */
export const CODEX_INTERACTIVE_REQUEST_TIMEOUT_MS = 20_000
export const CODEX_STEER_TURN_LOOKUP_TIMEOUT_MS = 5_000
export const CODEX_STEER_RPC_TIMEOUT_MS = 120_000
export const CODEX_HISTORY_REQUEST_TIMEOUT_MS = 61 * 60_000
export const CODEX_RESUME_WEBHOOK_TIMEOUT_MS = 63 * 60_000
export const CODEX_RESUME_RPC_TIMEOUT_MS = 65 * 60_000

// Fresh starts scan skills and initialize native state; they are not interactive RPCs.
export const CODEX_START_REQUEST_TIMEOUT_MS = 60_000
export const CODEX_START_WEBHOOK_TIMEOUT_MS = CODEX_START_REQUEST_TIMEOUT_MS + 60_000
export const CODEX_START_RPC_TIMEOUT_MS = CODEX_START_WEBHOOK_TIMEOUT_MS + 30_000
