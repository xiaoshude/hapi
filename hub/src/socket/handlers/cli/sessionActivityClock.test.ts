import { describe, expect, it, mock, spyOn } from 'bun:test'
import { Store } from '../../../store'
import type { CliSocketWithData } from '../../socketTypes'
import { registerCliHandlers } from './index'

class FakeCliSocket {
    readonly handlers = new Map<string, (data: unknown, ack?: (response: unknown) => void) => void>()
    readonly emitted: Array<{ event: string; data: unknown }> = []
    readonly rooms: string[] = []
    data: { namespace?: string } = {}
    handshake = { auth: {} as Record<string, unknown> }

    on(event: string, handler: (data: unknown, ack?: (response: unknown) => void) => void): this {
        this.handlers.set(event, handler)
        return this
    }

    join(room: string): this {
        this.rooms.push(room)
        return this
    }

    emit(event: string, data: unknown): this {
        this.emitted.push({ event, data })
        return this
    }

    to(): { emit: (event: string, data: unknown) => void } {
        return { emit: () => {} }
    }

    trigger(event: string, data: unknown, ack?: (response: unknown) => void): void {
        this.handlers.get(event)?.(data, ack)
    }
}

const anyRegistry = new Proxy({}, { get: () => () => {} }) as never
const fakeIo = { of: () => ({ to: () => ({ emit: () => {} }) }) } as never

describe('CLI bookkeeping does not count as conversation activity', () => {
    for (const event of ['update-metadata', 'update-state']) {
        it(`${event} preserves conversation time while persisting and broadcasting state`, () => {
            const store = new Store(':memory:')
            const clock = spyOn(Date, 'now').mockReturnValue(1_000_000)
            try {
                const session = store.sessions.getOrCreateSession('clock', { host: 'test' }, null, 'default')
                const socket = new FakeCliSocket()
                socket.data = { namespace: 'default' }
                const events: any[] = []
                registerCliHandlers(socket as unknown as CliSocketWithData, {
                    io: fakeIo, store, rpcRegistry: anyRegistry, terminalRegistry: anyRegistry,
                    onWebappEvent: event => events.push(event),
                    onSessionActivity: (id, at) => { store.sessions.touchSessionUpdatedAt(id, at, 'default') }
                })
                clock.mockReturnValue(1_000_000 + 86_400_000)
                let ack: any
                socket.trigger(event, {
                    sid: session.id, expectedVersion: 1,
                    ...(event === 'update-metadata'
                        ? { metadata: { host: 'test', lifecycleState: 'running' } }
                        : { agentState: { controlledByUser: false, requests: {} } })
                }, result => { ack = result })
                expect(ack.result).toBe('success')
                expect(ack.version).toBe(2)
                expect(store.sessions.getSession(session.id)!.updatedAt).toBe(session.updatedAt)
                expect(events.at(-1).data.updatedAt).toBe(session.updatedAt)
                // Version conflict semantics remain intact after reconnect replay.
                socket.trigger(event, {
                    sid: session.id, expectedVersion: 1,
                    ...(event === 'update-metadata' ? { metadata: {} } : { agentState: {} })
                }, result => { ack = result })
                expect(ack.result).toBe('version-mismatch')
                expect(store.sessions.getSession(session.id)!.updatedAt).toBe(session.updatedAt)
                // Real conversation still advances the same clock through the message handler.
                socket.trigger('message', {
                    sid: session.id, localId: 'new-human-turn',
                    message: { role: 'user', content: { type: 'text', text: 'hello' } }
                })
                expect(store.sessions.getSession(session.id)!.updatedAt).toBe(Date.now())
            } finally {
                clock.mockRestore()
                store.close()
            }
        })
    }
})
