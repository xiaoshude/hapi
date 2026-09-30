import { describe, expect, it } from 'vitest';
import { CODEX_HISTORY_REQUEST_TIMEOUT_MS, CODEX_RESUME_RPC_TIMEOUT_MS, CODEX_RESUME_WEBHOOK_TIMEOUT_MS } from '@hapi/protocol/codexTimeouts';
import { resolveSessionWebhookTimeoutMs } from './sessionWebhookTimeout';

describe('resolveSessionWebhookTimeoutMs', () => {
    it('gives fresh Codex startup headroom over native initialization and thread creation', () => {
        expect(resolveSessionWebhookTimeoutMs({ agent: 'codex' }, {})).toBe(120_000);
        expect(resolveSessionWebhookTimeoutMs({ agent: 'codex' }, { HAPI_RUNNER_WEBHOOK_TIMEOUT_MS: '5000' })).toBe(120_000);
        expect(resolveSessionWebhookTimeoutMs({ agent: 'codex' }, { HAPI_RUNNER_WEBHOOK_TIMEOUT_MS: '180000' })).toBe(180_000);
    });
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

    it('preserves a longer global budget for Codex history resumes', () => {
        expect(resolveSessionWebhookTimeoutMs(
            { agent: 'codex', resumeSessionId: 'thread-1' },
            { HAPI_RUNNER_WEBHOOK_TIMEOUT_MS: String(CODEX_RESUME_WEBHOOK_TIMEOUT_MS + 60_000) }
        )).toBe(CODEX_RESUME_WEBHOOK_TIMEOUT_MS + 60_000);
    });

    it('allows a Codex-specific override without shortening the global budget', () => {
        expect(resolveSessionWebhookTimeoutMs(
            { agent: 'codex', resumeSessionId: 'thread-1' },
            {
                HAPI_RUNNER_WEBHOOK_TIMEOUT_MS: '120000',
                HAPI_RUNNER_CODEX_RESUME_WEBHOOK_TIMEOUT_MS: String(CODEX_RESUME_WEBHOOK_TIMEOUT_MS + 60_000)
            }
        )).toBe(CODEX_RESUME_WEBHOOK_TIMEOUT_MS + 60_000);
    });

    it('does not let a shorter Codex-specific value undercut the shared history budget', () => {
        expect(resolveSessionWebhookTimeoutMs(
            { agent: 'codex', resumeSessionId: 'thread-1' },
            {
                HAPI_RUNNER_WEBHOOK_TIMEOUT_MS: '120000',
                HAPI_RUNNER_CODEX_RESUME_WEBHOOK_TIMEOUT_MS: '420000'
            }
        )).toBe(CODEX_RESUME_WEBHOOK_TIMEOUT_MS);
    });

    it('does not let a shorter Codex-specific value undercut the global timeout', () => {
        expect(resolveSessionWebhookTimeoutMs(
            { agent: 'codex', resumeSessionId: 'thread-1' },
            {
                HAPI_RUNNER_WEBHOOK_TIMEOUT_MS: String(CODEX_RESUME_WEBHOOK_TIMEOUT_MS + 60_000),
                HAPI_RUNNER_CODEX_RESUME_WEBHOOK_TIMEOUT_MS: '420000'
            }
        )).toBe(CODEX_RESUME_WEBHOOK_TIMEOUT_MS + 60_000);
    });

    it('keeps at least two minutes of Runner headroom above the history RPC timeout', () => {
        expect(CODEX_RESUME_WEBHOOK_TIMEOUT_MS).toBeGreaterThanOrEqual(
            CODEX_HISTORY_REQUEST_TIMEOUT_MS + 2 * 60_000
        );
    });

    it('keeps at least two minutes of Hub RPC headroom above the Runner timeout', () => {
        expect(CODEX_RESUME_RPC_TIMEOUT_MS).toBeGreaterThanOrEqual(
            CODEX_RESUME_WEBHOOK_TIMEOUT_MS + 2 * 60_000
        );
    });
});
