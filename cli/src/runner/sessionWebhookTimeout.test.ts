import { describe, expect, it } from 'vitest';
import {
    CODEX_HISTORY_REQUEST_TIMEOUT_MS,
    CODEX_RESUME_LAYER_HEADROOM_MS,
    CODEX_RESUME_RPC_TIMEOUT_MS,
    CODEX_RESUME_WEBHOOK_TIMEOUT_MS
} from '@hapi/protocol/codexTimeouts';
import { resolveSessionWebhookTimeoutMs } from './sessionWebhookTimeout';

describe('resolveSessionWebhookTimeoutMs', () => {
    it('preserves the configured timeout for ordinary spawns', () => {
        expect(resolveSessionWebhookTimeoutMs(
            { agent: 'claude' },
            { HAPI_RUNNER_WEBHOOK_TIMEOUT_MS: '120000' }
        )).toBe(120_000);
    });

    it('gives Codex history resumes a separate bounded startup budget', () => {
        expect(resolveSessionWebhookTimeoutMs(
            { agent: 'codex', resumeSessionId: 'thread-1' },
            { HAPI_RUNNER_WEBHOOK_TIMEOUT_MS: '120000' }
        )).toBe(CODEX_RESUME_WEBHOOK_TIMEOUT_MS);
    });

    it('keeps the fixed resume budget aligned when the global override is longer than Hub RPC', () => {
        expect(resolveSessionWebhookTimeoutMs(
            { agent: 'codex', resumeSessionId: 'thread-1' },
            { HAPI_RUNNER_WEBHOOK_TIMEOUT_MS: String(CODEX_RESUME_RPC_TIMEOUT_MS + 60_000) }
        )).toBe(CODEX_RESUME_WEBHOOK_TIMEOUT_MS);
    });

    it('uses the configured override for a new Codex session without a resume', () => {
        expect(resolveSessionWebhookTimeoutMs(
            { agent: 'codex' },
            { HAPI_RUNNER_WEBHOOK_TIMEOUT_MS: '120000' }
        )).toBe(120_000);
    });

    it('keeps at least two minutes of Runner headroom above the history RPC timeout', () => {
        expect(CODEX_RESUME_WEBHOOK_TIMEOUT_MS).toBe(
            CODEX_HISTORY_REQUEST_TIMEOUT_MS + CODEX_RESUME_LAYER_HEADROOM_MS
        );
    });

    it('keeps at least two minutes of Hub RPC headroom above the Runner timeout', () => {
        expect(CODEX_RESUME_RPC_TIMEOUT_MS).toBe(
            CODEX_RESUME_WEBHOOK_TIMEOUT_MS + CODEX_RESUME_LAYER_HEADROOM_MS
        );
    });
});
