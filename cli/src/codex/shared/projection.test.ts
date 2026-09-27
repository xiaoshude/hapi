import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import { SharedCodexProjection, inputText } from './projection';
import { codexPlanProposalId } from './plan';

describe('shared history projection', () => {
    it.each([undefined, 'root'])('persists proposals without approval and replays the same IDs (parent: %s)', async parentThreadId => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {}, parentThreadId);
        const item = { id: 'plan', type: 'plan', text: '# Final plan' };
        const params = { threadId: 'thread', turnId: 'turn', item };
        await projection.notification('item/completed', { ...params, item: { id: 'before', type: 'agentMessage', text: 'Preface' } });
        await projection.notification('item/started', params);
        await projection.notification('item/plan/delta', { ...params, itemId: 'plan', delta: '# Provisional' });
        await projection.notification('item/completed', params);
        await projection.notification('item/completed', params);
        await projection.notification('item/completed', { ...params, item: { id: 'after', type: 'agentMessage', text: 'Postscript' } });
        expect(send).toHaveBeenCalledTimes(4);
        const bodies = send.mock.calls.map(([body]) => parentThreadId ? body.message : body);
        const callId = codexPlanProposalId('thread', 'turn', 'plan');
        expect(bodies).toEqual([
            expect.objectContaining({ type: 'message', message: 'Preface' }),
            expect.objectContaining({ type: 'tool-call', name: 'ExitPlanMode', callId, input: { plan: '# Final plan' } }),
            expect.objectContaining({ type: 'tool-call-result', callId, output: null }),
            expect.objectContaining({ type: 'message', message: 'Postscript' })
        ]);
        const original = send.mock.calls.slice(1, 3);
        projection.reset(); send.mockClear();
        await projection.history({ turns: [{ id: 'turn', status: 'completed', items: [item] }] });
        expect(send.mock.calls).toEqual(original);
    });

    it('waits for final proposal content after an active snapshot', async () => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        await projection.history({ turns: [{ id: 'turn', status: 'inProgress', items: [{ id: 'plan', type: 'plan', text: 'partial' }] }] });
        expect(send).not.toHaveBeenCalled();
        await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'plan', type: 'plan', text: 'final' } });
        expect(send.mock.calls[0][0]).toMatchObject({ input: { plan: 'final' } });
        expect(send.mock.calls[1][0]).toMatchObject({ output: null });
    });

    it('does not treat persisted fork locators as delivery acknowledgements after reconnect', async () => {
        let metadata: Record<string, unknown> = { conversationHistoryTurns: { local: 'turn' } };
        const user = vi.fn(() => true);
        const committed = vi.fn(async () => {});
        const session = {
            getMetadata: () => metadata,
            updateMetadata: vi.fn((handler: (value: Record<string, unknown>) => Record<string, unknown>) => {
                metadata = handler(metadata);
            }),
            sendAgentMessage: vi.fn(),
            sendUserMessage: user
        } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', committed);
        const snapshot = {
            turns: [{
                id: 'turn', status: 'completed',
                items: [{ id: 'item', type: 'userMessage', clientId: 'local', content: [{ type: 'text', text: 'prompt' }] }]
            }]
        };

        await projection.history(snapshot);
        projection.reset();
        await projection.history(snapshot);

        expect(user).toHaveBeenCalledTimes(2);
        expect(committed).toHaveBeenCalledTimes(2);
    });

    it('drops an in-flight old-generation user projection after reset', async () => {
        let release!: () => void;
        let entered!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const enteredCommit = new Promise<void>(resolve => { entered = resolve; });
        const user = vi.fn(() => true);
        const committed = vi.fn(async () => {
            entered();
            await blocked;
        });
        const session = {
            getMetadata: () => ({}),
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendUserMessage: user
        } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', committed);
        const item = { id: 'user-item', type: 'userMessage', clientId: 'local', content: [{ type: 'text', text: 'prompt' }] };
        const notification = projection.notification('item/completed', { threadId: 'thread', turnId: 'turn', item });
        await enteredCommit;
        projection.reset();
        release();
        await notification;

        await projection.history({ turns: [{ id: 'turn', status: 'completed', items: [item] }] });
        expect(user).toHaveBeenCalledTimes(2);
    });

    it('projects a 38k-item history with one metadata snapshot and one user delivery per local id', async () => {
        let metadata: Record<string, unknown> = {};
        const updateMetadata = vi.fn((handler: (value: Record<string, unknown>) => Record<string, unknown>) => {
            metadata = handler(metadata);
        });
        const send = vi.fn();
        const user = vi.fn(() => true);
        const committed = vi.fn(async () => {});
        const session = {
            getMetadata: () => metadata,
            updateMetadata,
            sendAgentMessage: send,
            sendUserMessage: user
        } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', committed);
        const turns: unknown[] = Array.from({ length: 38_000 }, (_, index) => index % 2 === 0
            ? { id: `turn-${index}`, status: 'completed', items: [{
                id: `user-item-${index}`, type: 'userMessage', clientId: `user-${index}`,
                content: [{ type: 'text', text: `prompt-${index}` }]
            }] }
            : { id: `turn-${index}`, status: 'completed', items: [{
                id: `assistant-item-${index}`, type: 'agentMessage', text: `reply-${index}`
            }] });
        turns.push({
            id: 'active', status: 'inProgress', items: [
                { id: 'active-user-item', type: 'userMessage', clientId: 'active-user', content: [{ type: 'text', text: 'active prompt' }] },
                { id: 'active-assistant-item', type: 'agentMessage', text: 'partial' }
            ]
        });

        await projection.history({ turns });

        expect(updateMetadata).toHaveBeenCalledTimes(1);
        expect(Object.keys(metadata.conversationHistoryTurns as Record<string, string>)).toHaveLength(19_001);
        expect(user).toHaveBeenCalledTimes(19_001);
        expect(committed).toHaveBeenCalledTimes(19_001);

        await projection.notification('item/completed', {
            threadId: 'thread',
            turnId: 'active',
            item: { id: 'active-assistant-item', type: 'agentMessage', text: 'final' }
        });
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'message', message: 'final' }), expect.any(String));
    }, 30_000);

    it('preserves a final notification that arrives while an active history snapshot is replaying', async () => {
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const send = vi.fn();
        const committed = vi.fn(async (id: string) => {
            if (id === 'active-user') await blocked;
        });
        const session = {
            getMetadata: () => ({}),
            updateMetadata: vi.fn(),
            sendAgentMessage: send,
            sendUserMessage: vi.fn(() => true)
        } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', committed);
        const replay = projection.history({
            turns: [{
                id: 'active', status: 'inProgress', items: [
                    { id: 'active-user-item', type: 'userMessage', clientId: 'active-user', content: [{ type: 'text', text: 'prompt' }] },
                    { id: 'active-assistant-item', type: 'agentMessage', text: 'partial' }
                ]
            }]
        });
        await vi.waitFor(() => expect(committed).toHaveBeenCalledWith('active-user'));

        await projection.notification('item/completed', {
            threadId: 'thread',
            turnId: 'active',
            item: { id: 'active-assistant-item', type: 'agentMessage', text: 'final' }
        });
        release();
        await replay;

        const finals = send.mock.calls.filter(([body]) => body.type === 'message' && body.message === 'final');
        expect(finals).toHaveLength(1);
    });

    it.each([undefined, 'root'])('emits canonical error flags for tools (parent: %s)', async parentThreadId => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {}, parentThreadId);
        for (const failed of [true, false]) {
            for (const type of ['mcpToolCall', 'collabAgentToolCall']) {
                const item = { id: `${type}-${failed}`, type, server: 'test', tool: 'spawnAgent',
                    status: failed ? 'failed' : 'completed', error: failed ? { message: 'failed' } : null,
                    result: { Ok: 'done' } };
                await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn', item });
                const body = send.mock.lastCall?.[0];
                const result = parentThreadId ? body.message : body;
                expect(result).toMatchObject({ type: 'tool-call-result', is_error: failed });
                expect(result).not.toHaveProperty('isError');
            }
        }
    });
    it('keeps each turn model through settings changes, reconnect replay and rerouting', async () => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        await projection.notification('turn/started', { threadId: 'thread', turn: { id: 'old' } }, 'model-a');
        await projection.notification('turn/started', { threadId: 'thread', turn: { id: 'new' } }, 'model-b');
        projection.reset();
        // A replayed start must not rewrite the executing model either.
        await projection.notification('turn/started', { threadId: 'thread', turn: { id: 'old' } }, 'model-b');
        const usage = async (turnId: string) => projection.notification('thread/tokenUsage/updated', {
            threadId: 'thread', turnId, tokenUsage: { last: { inputTokens: 12, outputTokens: 3 } }
        }, 'model-b');
        await usage('old');
        await projection.notification('model/rerouted', { threadId: 'thread', turnId: 'new', fromModel: 'model-b', toModel: 'model-c', reason: 'test' });
        await usage('new');
        const events = send.mock.calls.map(([body]) => body).filter(body => body.type === 'token_count');
        expect(events.map(body => body.model)).toEqual(['model-a', 'model-c']);
    });
    it('keeps image-only native inputs visible without embedding data URLs', () => {
        expect(inputText([{ type: 'image', url: 'data:image/png;base64,large' }])).toBe('[Image]');
        expect(inputText([{ type: 'localImage', path: '/tmp/image.png' }])).toBe('[Image: /tmp/image.png]');
    });
    it('replays after hub reconnect using the same durable local id', async () => {
        const send = vi.fn(); const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        const snapshot = { turns: [{ id: 'turn', status: 'completed', items: [{ id: 'item', type: 'agentMessage', text: 'complete' }] }] };
        await projection.history(snapshot); projection.reset(); await projection.history(snapshot);
        expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
    });
    it('does not settle an active snapshot under the final message id', async () => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        await projection.history({ turns: [{ id: 'turn', status: 'inProgress', items: [{ id: 'item', type: 'agentMessage', text: 'partial' }] }] });
        expect(send).not.toHaveBeenCalled();
        await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'item', type: 'agentMessage', text: 'complete' } });
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'message', message: 'complete' }), expect.any(String));
    });
    it('routes descendant answers into a scoped agent trace, not a root message', async () => {
        const send = vi.fn(); const user = vi.fn(); const committed = vi.fn(async () => {});
        const session = { getMetadata: () => ({}), sendAgentMessage: send, sendUserMessage: user } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'child', committed, 'root');
        await projection.notification('item/completed', { threadId: 'child', turnId: 'turn', item: { id: 'item', type: 'agentMessage', text: 'child answer' } });
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent-run-trace', agentId: 'child', message: expect.objectContaining({ message: 'child answer' }) }), expect.any(String));
        await projection.notification('item/completed', { threadId: 'child', turnId: 'turn', item: { id: 'prompt', type: 'userMessage', content: [{ type: 'text', text: 'child prompt' }], clientId: 'cid' } });
        expect(user).not.toHaveBeenCalled(); expect(committed).not.toHaveBeenCalled();
    });

    it('does not commit a native user item when outbound delivery is rejected', async () => {
        const send = vi.fn(); const user = vi.fn(() => false); const committed = vi.fn(async () => {});
        const session = { getMetadata: () => ({}), sendAgentMessage: send, sendUserMessage: user, updateMetadata: vi.fn() } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', committed);

        await expect(projection.notification('item/completed', {
            threadId: 'thread',
            turnId: 'turn',
            item: { id: 'prompt', type: 'userMessage', content: [{ type: 'text', text: 'prompt' }], clientId: 'local' }
        })).rejects.toThrow('Failed to deliver Codex user message local');

        expect(user).toHaveBeenCalledWith('prompt', undefined, 'local');
        expect(committed).not.toHaveBeenCalled();

        user.mockReturnValueOnce(true);
        await projection.notification('item/completed', {
            threadId: 'thread',
            turnId: 'turn',
            item: { id: 'prompt', type: 'userMessage', content: [{ type: 'text', text: 'prompt' }], clientId: 'local' }
        });
        expect(committed).toHaveBeenCalledWith('local');
    });
});
