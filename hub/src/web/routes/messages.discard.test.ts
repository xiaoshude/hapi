import { expect, it } from 'bun:test'
import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createMessagesRoutes } from './messages'

function fixture(denied?: 'old' | 'observer', active = true) {
    const old = randomUUID(), observer = randomUUID(), calls: unknown[][] = []
    const app = new Hono<WebAppEnv>()
    const engine = { resolveSessionAccess: (id: string, namespace: string) => {
        expect(namespace).toBe('test')
        if (id === (denied === 'old' ? old : denied === 'observer' ? observer : 'denied')) return { ok: false, reason: 'access-denied' }
        return { ok: true, sessionId: id, session: { id, active: id === observer && active } }
    }, getOfflineDiscardInfo: () => ({ status: 'indeterminate', expectedSnapshotSha256: 'a'.repeat(64) }),
    discardOfflineIndeterminateMessage: async (...args: unknown[]) => { calls.push(args); return { status: 'busy', localId: 'local', code: 'NATIVE_PROOF_UNAVAILABLE' } }
    } as unknown as SyncEngine
    app.use('*', async (c, next) => { c.set('namespace', 'test'); await next() })
    app.route('/api', createMessagesRoutes(() => engine))
    const url = `/api/sessions/${old}/messages/local/discard-offline`
    const body = { confirm: 'discard-offline-indeterminate', observerSessionId: observer, expectedSnapshotSha256: 'a'.repeat(64) }
    return { app, url, body, calls, old, observer }
}

it('requires explicit confirmation and a reviewed snapshot digest', async () => {
    for (const field of ['confirm', 'observerSessionId', 'expectedSnapshotSha256']) {
        const f = fixture(); const body = { ...f.body } as Record<string, unknown>; delete body[field]
        expect((await f.app.request(f.url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })).status).toBe(400)
        expect(f.calls).toHaveLength(0)
    }
})
it('guards both original and witness namespaces', async () => {
    for (const denied of ['old', 'observer'] as const) {
        const f = fixture(denied)
        expect((await f.app.request(f.url, { method: 'POST', body: JSON.stringify(f.body), headers: { 'Content-Type': 'application/json' } })).status).toBe(403)
        expect(f.calls).toHaveLength(0)
    }
})
it('requires an active witness and caps request bytes', async () => {
    const f = fixture(undefined, false)
    expect((await f.app.request(f.url, { method: 'POST', body: JSON.stringify(f.body) })).status).toBe(409)
    expect(f.calls).toHaveLength(0)
    expect((await f.app.request(f.url, { method: 'POST', body: ' '.repeat(4097) })).status).toBe(413)
})
it('returns a bounded descriptor and proof refusal rather than ordinary cancellation', async () => {
    const f = fixture()
    expect(await (await f.app.request(f.url)).json()).toEqual({ status: 'indeterminate', expectedSnapshotSha256: 'a'.repeat(64) })
    const result = await f.app.request(f.url, { method: 'POST', body: JSON.stringify(f.body) })
    expect(result.status).toBe(409)
    expect(f.calls).toEqual([[f.old, 'local', f.observer, 'a'.repeat(64)]])
})
