import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Store } from './index'
import { discardIndeterminateMessage, getMessageDiscardSnapshot } from './messages'

describe('exact offline indeterminate row CAS', () => {
    for (const column of ['content', 'seq', 'local_id', 'created_at', 'scheduled_at', 'delivery_state', 'invoked_at']) {
        it(`refuses a concurrent ${column} change`, () => {
            const store = new Store(':memory:')
            const session = store.sessions.getOrCreateSession('old', {}, null, 'test')
            const message = store.messages.addMessage(session.id, { role: 'user', content: { text: 'old' } }, 'local')
            store.messages.setMessagesDeliveryState(session.id, ['local'], 'indeterminate')
            const db = (store as unknown as { db: Database }).db
            const snapshot = getMessageDiscardSnapshot(db, session.id, message.id)!
            const value = column === 'content' ? JSON.stringify({ role: 'user', content: { text: 'new' } })
                : column === 'local_id' ? 'other-local' : column === 'delivery_state' ? 'dispatching' : 1234567
            db.prepare(`UPDATE messages SET ${column} = ? WHERE id = ?`).run(value, message.id)
            expect(discardIndeterminateMessage(db, snapshot)).toBe(false)
            expect(store.messages.getMessageEpoch(session.id)).toBe(0)
            expect(getMessageDiscardSnapshot(db, session.id, message.id)).not.toBeNull()
            store.close()
        })
    }
    it('uses original text storage bytes and deletes only once', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('legacy', {}, null, 'test')
        const message = store.messages.addMessage(session.id, { role: 'user', content: { text: 'old' } }, 'local')
        const db = (store as unknown as { db: Database }).db
        const content = '{ "role": "user", "content": {"text":"old"} }'
        db.prepare("UPDATE messages SET content = ?, delivery_state = 'indeterminate' WHERE id = ?").run(content, message.id)
        const snapshot = getMessageDiscardSnapshot(db, session.id, message.id)!
        expect(snapshot.contentStorage).toBe('text')
        expect(Buffer.from(snapshot.contentBase64, 'base64').toString()).toBe(content)
        expect(discardIndeterminateMessage(db, snapshot)).toBe(true)
        expect(discardIndeterminateMessage(db, snapshot)).toBe(false)
        expect(store.messages.getMessageEpoch(session.id)).toBe(1)
        store.close()
    })
})
