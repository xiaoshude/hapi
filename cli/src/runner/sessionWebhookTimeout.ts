import type { SpawnSessionOptions } from '@/modules/common/rpcTypes';
import { CODEX_RESUME_WEBHOOK_TIMEOUT_MS } from '@hapi/protocol/codexTimeouts';

const DEFAULT_WEBHOOK_TIMEOUT_MS = 15_000;

function parsePositiveTimeout(value: string | undefined): number | null {
    const timeoutMs = Number(value);
    return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;
}

export function resolveSessionWebhookTimeoutMs(
    options: Pick<SpawnSessionOptions, 'agent' | 'resumeSessionId'>,
    env: NodeJS.ProcessEnv = process.env
): number {
    const globalTimeoutMs = parsePositiveTimeout(env.HAPI_RUNNER_WEBHOOK_TIMEOUT_MS)
        ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
    if (options.agent !== 'codex' || !options.resumeSessionId) return globalTimeoutMs;

    // This shared budget is derived to remain below Hub's resume RPC deadline.
    // Generic Runner overrides apply to ordinary spawns, not Codex resumes.
    return CODEX_RESUME_WEBHOOK_TIMEOUT_MS;
}
