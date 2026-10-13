import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { exec } from 'node:child_process'
import { Store } from '../store'
import { MessageService } from './messageService'
import type { Session, SyncEvent } from '@hapi/protocol/types'
import type { Server } from 'socket.io'
import type { EventPublisher } from './eventPublisher'
import { OfflineDiscardRefused, snapshotDigest,
    type OfflineDiscardExecutor } from './offlineMessageDiscard'
import { createRemoteOfflineDiscardExecutor, offlineProofCommand, type ProofRequest, type ProofPhase } from './remoteOfflineDiscard'
import { OFFLINE_NATIVE_PROOF_SOURCE } from './offlineNativeProofSource'

function messageFixture(executor: OfflineDiscardExecutor | null) {
    const store = new Store(':memory:')
    const old = store.sessions.getOrCreateSession('old', {}, null, 'test')
    const witness = store.sessions.getOrCreateSession('witness', {}, null, 'test')
    const machineId = randomUUID()
    const session = (id: string, active: boolean) => ({ id, namespace: 'test', active,
        metadata: { flavor: 'codex', codexSessionId: randomUUID(), hostPid: process.ppid, machineId,
            capabilities: { concurrentClients: true } } }) as Session
    const target = session(old.id, false), observer = session(witness.id, true)
    const message = store.messages.addMessage(old.id, { role: 'user', content: { type: 'text', text: 'unknown old input' } }, 'old-local')
    store.messages.setMessagesDeliveryState(old.id, ['old-local'], 'indeterminate')
    const events: SyncEvent[] = []
    const rooms = new Map<string, Set<string>>()
    const io = { of: () => ({ adapter: { rooms }, to: () => { throw new Error('Must not emit native cancel/retry') } }) } as unknown as Server
    const service = new MessageService(store, io, { emit: (e: SyncEvent) => { events.push(e) } } as unknown as EventPublisher, undefined, executor)
    const snapshot = store.messages.getDiscardSnapshot(old.id, message.id)!
    let current = true
    return { store, target, observer, message, events, rooms, service, snapshot,
        expire: () => { current = false },
        discard: (digest = snapshotDigest(snapshot)) => service.discardOfflineIndeterminateMessage(
            old.id, message.id, digest, target, observer, () => current) }
}

describe('explicit offline discard and ordinary cancel separation', () => {
    it('ordinary offline cancel still preserves an unknown shared message', async () => {
        const f = messageFixture(async (_, commit) => commit())
        f.store.sessions.updateSessionMetadata(f.target.id, f.target.metadata,
            f.store.sessions.getSession(f.target.id)!.metadataVersion, 'test')
        const result = await f.service.cancelQueuedMessage(f.target.id, f.message.id)
        expect(result.status).toBe('busy')
        expect(f.store.messages.lookupQueuedMessage(f.target.id, f.message.id).status).toBe('indeterminate')
        expect(f.events.some(e => e.type === 'message-cancelled')).toBe(false)
        f.store.close()
    })

    it('requires proof, deletes only the bound row and never asserts consumption', async () => {
        let proofs = 0
        const f = messageFixture(async (_, commit) => { proofs++; return commit() })
        const other = f.store.messages.addMessage(f.target.id, { role: 'user', content: { type: 'text', text: 'other' } }, 'other')
        expect((await f.discard()).status).toBe('cancelled')
        expect((await f.discard()).status).toBe('cancelled')
        expect(proofs).toBe(1)
        expect(f.store.messages.getDiscardSnapshot(f.target.id, other.id)).not.toBeNull()
        expect(f.events.map(e => e.type)).toEqual(['message-cancelled'])
        expect(f.store.messages.getMessageEpoch(f.target.id)).toBe(1)
        f.store.close()
    })

    for (const condition of ['old-active', 'observer-inactive', 'namespace', 'machine', 'capability', 'connected', 'stale-guard', 'snapshot']) {
        it(`refuses ${condition} before running local proof`, async () => {
            let proofs = 0
            const f = messageFixture(async (_, commit) => { proofs++; return commit() })
            if (condition === 'old-active') f.target.active = true
            if (condition === 'observer-inactive') f.observer.active = false
            if (condition === 'namespace') f.observer.namespace = 'other'
            if (condition === 'machine') f.observer.metadata!.machineId = 'remote'
            if (condition === 'capability') f.observer.metadata!.capabilities!.concurrentClients = false
            if (condition === 'connected') f.rooms.set(`session:${f.target.id}`, new Set(['live']))
            if (condition === 'stale-guard') f.expire()
            const result = await f.discard(condition === 'snapshot' ? '0'.repeat(64) : undefined)
            expect(result.status).toBe('busy'); expect(proofs).toBe(0)
            expect(f.store.messages.lookupQueuedMessage(f.target.id, f.message.id).status).toBe('indeterminate')
            f.store.close()
        })
    }

    for (const race of ['invoked', 'queued', 'connected', 'stale-guard', 'encoded-content']) {
        it(`preserves a row changed during proof: ${race}`, async () => {
            let f: ReturnType<typeof messageFixture>
            f = messageFixture(async (_, commit) => {
                if (race === 'invoked') f.store.messages.markMessagesInvoked(f.target.id, ['old-local'], Date.now())
                if (race === 'queued') f.store.messages.setMessagesDeliveryState(f.target.id, ['old-local'], 'queued')
                if (race === 'connected') f.rooms.set(`session:${f.target.id}`, new Set(['live']))
                if (race === 'stale-guard') f.expire()
                if (race === 'encoded-content') (f.store.messages as any).db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(JSON.stringify({ role: 'user', content: { text: 'changed' } }), f.message.id)
                return commit()
            })
            expect((await f.discard()).status).toBe(race === 'invoked' ? 'invoked' : 'busy')
            expect(f.store.messages.getDiscardSnapshot(f.target.id, f.message.id)).not.toBeNull()
            expect(f.events).toHaveLength(0)
            f.store.close()
        })
    }

    it('keeps the row when native proof or durable audit is unavailable', async () => {
        const f = messageFixture(async () => { throw new OfflineDiscardRefused('NATIVE_PROOF_UNAVAILABLE') })
        expect(await f.discard()).toEqual({ status: 'busy', localId: 'old-local', code: 'NATIVE_PROOF_UNAVAILABLE' })
        expect(f.store.messages.lookupQueuedMessage(f.target.id, f.message.id).status).toBe('indeterminate')
        f.store.close()
    })
})

// All paths, registry, ownership lease, writer lock and socket are synthetic and isolated.
const ENGINE_FIXTURE = String.raw`
import os,sys,json,socket,struct,base64,hashlib,fcntl
r=json.loads(sys.argv[1]);s=socket.socket(socket.AF_UNIX);s.bind(r['socket']);os.chmod(r['socket'],0o600);s.listen(1)
if r['mode']=='writer':
    f=open(r['writer'],'w');fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
print('ready',flush=True)
c,_=s.accept();b=b''
while b'\r\n\r\n' not in b:b+=c.recv(4096)
key=[x.split(b':',1)[1].strip() for x in b.split(b'\r\n') if x.lower().startswith(b'sec-websocket-key:')][0]
accept=base64.b64encode(hashlib.sha1(key+b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest())
c.sendall(b'HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: '+accept+b'\r\n\r\n')
def take(n):
    out=b''
    while len(out)<n:
        x=c.recv(n-len(out))
        if not x:raise EOFError()
        out+=x
    return out
methods=[];queues=0
try:
    while True:
        a,b=take(2);n=b&127
        if n==126:n=struct.unpack('!H',take(2))[0]
        mask=take(4);v=json.loads(bytes(x^mask[i%4] for i,x in enumerate(take(n))));methods.append(v['method'])
        if 'id' not in v:continue
        result={}
        if v['method']=='thread/read':result={'thread':{'id':r['threadId'],'status':{'type':'active' if r['mode']=='loaded' else 'notLoaded'}}}
        if v['method']=='thread/queue/list':
            queues+=1;result={'data':[],'nextCursor':None}
            if r['mode']=='missing':result={}
            if r['mode']=='nonempty' or r['mode']=='second-nonempty' and queues==2:result={'data':[{'id':'pending'}],'nextCursor':None}
        body=json.dumps({'id':v['id'],'result':result}).encode();head=bytes([129,len(body)]) if len(body)<126 else bytes([129,126])+struct.pack('!H',len(body));c.sendall(head+body)
except (EOFError,ConnectionError):pass
finally:
    open(r['calls'],'w').write(json.dumps(methods));c.close();s.close()
`

async function runtimeFixture(mode: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hapi-discard-test-')); fs.chmodSync(root, 0o700)
    const hapiHome = path.join(root, 'hapi'), codexHome = path.join(root, 'codex')
    for (const p of [hapiHome, path.join(hapiHome, 'codex-runtimes'), codexHome,
        path.join(codexHome, 'hapi-runtime-owners'), path.join(codexHome, 'thread-writer-locks')]) fs.mkdirSync(p, { mode: 0o700 })
    let proofExecutor: OfflineDiscardExecutor
    const f = messageFixture(async (request, commit) => proofExecutor(request, commit))
    const threadId = f.target.metadata!.codexSessionId!, socket = path.join(root, 'engine.sock'), calls = path.join(root, 'calls.json')
    const cut = ENGINE_FIXTURE.indexOf("c,_=s.accept();b=b''")
    const remoteEngine = ENGINE_FIXTURE.slice(0, cut) + '\nmethods=[]\nfor connection in range(2):\n' + ENGINE_FIXTURE.slice(cut)
        .replace('methods=[];queues=0', 'queues=0').replace('c.close();s.close()', 'c.close()')
        .split('\n').map(line => '    ' + line).join('\n') + '\ns.close()\n'
    const child = Bun.spawn(['/usr/bin/python3', '-I', '-c', remoteEngine, JSON.stringify({ mode: mode.replace('remote-', ''), socket, calls, threadId,
        writer: path.join(codexHome, 'thread-writer-locks', threadId + '.lock') })], { stdout: 'pipe', stderr: 'pipe' })
    const reader = child.stdout.getReader(); await reader.read(); reader.releaseLock()
    const marker = (pid: number) => execFileSync('/usr/bin/ps', ['-p', String(pid), '-o', 'lstart='],
        { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', TZ: 'UTC', LC_ALL: 'C' } }).trim()
    const original = { pid: 2147483000, serverPid: 2147483001, codexHome, endpoint: 'unix://' + path.join(root, 'old', 'clients.sock'),
        sessions: { [f.target.id]: { namespace: 'test', active: false, threadId } } }
    const observer = { pid: process.ppid, serverPid: process.pid, marker: marker(process.ppid), serverMarker: marker(process.pid),
        codexHome, endpoint: 'unix://' + path.join(root, 'clients.sock'),
        sessions: { [f.observer.id]: { namespace: 'test', active: true, threadId: f.observer.metadata!.codexSessionId } } }
    fs.writeFileSync(path.join(hapiHome, 'settings.json'), JSON.stringify({ machineId: f.target.metadata!.machineId }), { mode: 0o600 })
    for (const r of [original, observer]) {
        const name = randomUUID() + '.json'
        for (const parent of [path.join(hapiHome, 'codex-runtimes'), path.join(codexHome, 'hapi-runtime-owners')]) {
            fs.writeFileSync(path.join(parent, name), JSON.stringify(r), { mode: 0o600 })
        }
    }
    const helper = path.join(root, 'proof.py'); fs.writeFileSync(helper, OFFLINE_NATIVE_PROOF_SOURCE, { mode: 0o600 })
    proofExecutor = createRemoteOfflineDiscardExecutor(hapiHome, async (request, phase) => {
        const { stdout, stderr } = await promisify(exec)(offlineProofCommand(request, phase, helper),
            { timeout: 25000, maxBuffer: 16384, env: { PATH: '/usr/bin:/bin', HAPI_HOME: hapiHome } })
        return { success: true, exitCode: 0, stdout, stderr }
    })
    return { ...f, root, hapiHome, codexHome, calls, child,
        close: async () => { child.kill(); await child.exited; f.store.close(); fs.rmSync(root, { recursive: true, force: true }) } }
}

describe('local offline proof and immutable audit', () => {
    it('archives raw original bytes before exact CAS, using only read-only native RPCs', async () => {
        const f = await runtimeFixture('empty')
        try {
            expect((await f.discard()).status).toBe('cancelled')
            await f.child.exited
            expect(JSON.parse(fs.readFileSync(f.calls, 'utf8'))).toEqual(Array(2).fill(['initialize', 'initialized', 'thread/read', 'thread/queue/list', 'thread/read', 'thread/queue/list']).flat())
            const audits = path.join(f.hapiHome, 'offline-message-discard-audits')
            const files = fs.readdirSync(audits)
            const original = JSON.parse(fs.readFileSync(path.join(audits, files.find(n => n.endsWith('.original.json'))!), 'utf8'))
            expect(original.contentBase64).toBe(f.snapshot.contentBase64)
            expect(original.message.invokedAt).toBeNull()
            const attempt = JSON.parse(fs.readFileSync(path.join(audits, files.find(n => n.endsWith('.attempt.json'))!), 'utf8'))
            expect(attempt.pastConsumption).toBe('unknown'); expect(attempt.publicAction).toBe(0)
            for (const file of files) expect(fs.statSync(path.join(audits, file)).mode & 0o077).toBe(0)
            expect(fs.existsSync(path.join(f.codexHome, 'hapi-runtime-owners', 'ownership.hapi.lock'))).toBe(false)
        } finally { await f.close() }
    })

    for (const mode of ['loaded', 'missing', 'nonempty', 'second-nonempty', 'writer']) {
        it(`refuses native proof ${mode} without discarding or replaying`, async () => {
            const f = await runtimeFixture(mode)
            try {
                const result = await f.discard()
                expect(result.status).toBe('busy')
                expect(f.store.messages.lookupQueuedMessage(f.target.id, f.message.id).status).toBe('indeterminate')
                expect(fs.existsSync(path.join(f.hapiHome, 'offline-message-discard-audits'))).toBe(false)
                expect(fs.existsSync(path.join(f.codexHome, 'hapi-runtime-owners', 'ownership.hapi.lock'))).toBe(false)
            } finally { await f.close() }
        })
    }

    it('does not reclaim an existing official ownership lease', async () => {
        const f = await runtimeFixture('empty')
        const lock = path.join(f.codexHome, 'hapi-runtime-owners', 'ownership.hapi.lock')
        fs.mkdirSync(lock, { mode: 0o700 }); const inode = fs.statSync(lock).ino
        try {
            expect(await f.discard()).toEqual({ status: 'busy', localId: 'old-local', code: 'PROOF_OWNERSHIP_BUSY' })
            expect(fs.statSync(lock).ino).toBe(inode)
            expect(f.store.messages.lookupQueuedMessage(f.target.id, f.message.id).status).toBe('indeterminate')
        } finally { await f.close() }
    })

    it('rejects a still-live original wrapper even if the observer native queue would be empty', async () => {
        const f = await runtimeFixture('empty')
        const registry = path.join(f.hapiHome, 'codex-runtimes')
        const original = fs.readdirSync(registry).map(n => path.join(registry, n)).find(p => JSON.parse(fs.readFileSync(p, 'utf8')).pid === 2147483000)!
        const r = JSON.parse(fs.readFileSync(original, 'utf8')); r.pid = process.pid; fs.writeFileSync(original, JSON.stringify(r))
        try {
            expect((await f.discard()).status).toBe('busy')
            expect(f.store.messages.lookupQueuedMessage(f.target.id, f.message.id).status).toBe('indeterminate')
        } finally { await f.close() }
    })

    for (const condition of ['namespace', 'different-home', 'observer-generation', 'observer-pid', 'unsafe-record', 'audit-symlink', 'writer-parent-symlink']) {
        it(`fails closed on ${condition} evidence`, async () => {
            const f = await runtimeFixture('empty')
            const registry = path.join(f.hapiHome, 'codex-runtimes')
            const records = fs.readdirSync(registry).map(n => path.join(registry, n))
            const original = records.find(p => JSON.parse(fs.readFileSync(p, 'utf8')).pid === 2147483000)!
            const observer = records.find(p => p !== original)!
            const change = (file: string, mutate: (record: any) => void) => {
                const record = JSON.parse(fs.readFileSync(file, 'utf8')); mutate(record); fs.writeFileSync(file, JSON.stringify(record))
            }
            if (condition === 'namespace') change(original, r => { r.sessions[f.target.id].namespace = 'other' })
            if (condition === 'different-home') change(original, r => { r.codexHome = path.join(f.root, 'other-home') })
            if (condition === 'observer-generation') change(observer, r => { r.marker = 'wrong generation' })
            if (condition === 'observer-pid') f.observer.metadata!.hostPid = process.pid
            if (condition === 'unsafe-record') fs.chmodSync(original, 0o666)
            if (condition === 'audit-symlink') fs.symlinkSync(f.root, path.join(f.hapiHome, 'offline-message-discard-audits'))
            if (condition === 'writer-parent-symlink') {
                fs.rmdirSync(path.join(f.codexHome, 'thread-writer-locks'))
                fs.symlinkSync(f.root, path.join(f.codexHome, 'thread-writer-locks'))
            }
            try {
                expect((await f.discard()).status).toBe('busy')
                expect(f.store.messages.lookupQueuedMessage(f.target.id, f.message.id).status).toBe('indeterminate')
                expect(f.events).toHaveLength(0)
                expect(fs.existsSync(path.join(f.codexHome, 'hapi-runtime-owners', 'ownership.hapi.lock'))).toBe(false)
            } finally { await f.close() }
        })
    }
})

describe('authenticated owning-machine proof across a Hub migration', () => {
    const execAsync = promisify(exec)
    it('retains the remote ownership lease until exact Hub CAS and stores the raw audit on the Hub', async () => {
        const f = await runtimeFixture('remote-empty')
        const hub = path.join(f.root, 'new-hub'); fs.mkdirSync(hub, { mode: 0o700 })
        const helper = path.join(f.root, 'proof.py'); fs.writeFileSync(helper, OFFLINE_NATIVE_PROOF_SOURCE, { mode: 0o600 })
        const phases: ProofPhase[] = []
        const rpc = async (r: ProofRequest, phase: ProofPhase) => {
            phases.push(phase)
            const { stdout, stderr } = await execAsync(offlineProofCommand(r, phase, helper),
                { timeout: 25000, maxBuffer: 16384, env: { PATH: '/usr/bin:/bin', HAPI_HOME: f.hapiHome } })
            if (phase === 'prepare') {
                await expect(execAsync(offlineProofCommand({ ...r, namespace: 'wrong-namespace' }, 'finish', helper),
                    { timeout: 3000, maxBuffer: 16384, env: { PATH: '/usr/bin:/bin', HAPI_HOME: f.hapiHome } })).rejects.toThrow()
                expect(fs.existsSync(path.join(f.codexHome, 'hapi-runtime-owners', 'ownership.hapi.lock'))).toBe(true)
            }
            return { success: true, exitCode: 0, stdout, stderr }
        }
        const executor = createRemoteOfflineDiscardExecutor(hub, rpc)
        const input = { sessionId: f.target.id, threadId: f.target.metadata!.codexSessionId!, observerSessionId: f.observer.id,
            observerThreadId: f.observer.metadata!.codexSessionId!, observerPid: process.ppid, namespace: 'test',
            machineId: f.target.metadata!.machineId!, snapshot: f.snapshot }
        let committed = false
        try {
            expect((await executor(input, () => {
                expect(fs.existsSync(path.join(f.codexHome, 'hapi-runtime-owners', 'ownership.hapi.lock'))).toBe(true)
                expect(f.store.messages.discardIndeterminate(f.snapshot)).toBe(true)
                committed = true; return { status: 'cancelled', localId: 'old-local' }
            })).status).toBe('cancelled')
            expect(committed).toBe(true); expect(phases).toEqual(['prepare', 'confirm', 'finish'])
            expect(fs.readdirSync(path.join(hub, 'offline-message-discard-audits')).filter(p => p.endsWith('.original.json'))).toHaveLength(1)
            expect(fs.existsSync(path.join(f.hapiHome, 'offline-message-discard-audits'))).toBe(false)
            for (let i = 0; i < 30 && fs.existsSync(path.join(f.codexHome, 'hapi-runtime-owners', 'ownership.hapi.lock')); i++) await new Promise(r => setTimeout(r, 10))
            expect(fs.existsSync(path.join(f.codexHome, 'hapi-runtime-owners', 'ownership.hapi.lock'))).toBe(false)
        } finally { await f.close() }
    }, 30000)

    it('refuses an altered helper before starting native proof', async () => {
        const f = await runtimeFixture('empty')
        const helper = path.join(f.root, 'proof.py'); fs.writeFileSync(helper, OFFLINE_NATIVE_PROOF_SOURCE + '\n# changed', { mode: 0o600 })
        const request: ProofRequest = { attemptId: randomUUID(), machineId: f.target.metadata!.machineId!, sessionId: f.target.id,
            threadId: f.target.metadata!.codexSessionId!, observerSessionId: f.observer.id, observerThreadId: f.observer.metadata!.codexSessionId!,
            observerPid: process.ppid, namespace: 'test', snapshotSha256: snapshotDigest(f.snapshot) }
        try {
            await expect(execAsync(offlineProofCommand(request, 'prepare', helper),
                { timeout: 3000, env: { PATH: '/usr/bin:/bin', HAPI_HOME: f.hapiHome } })).rejects.toThrow()
            expect(fs.existsSync(path.join(f.codexHome, 'hapi-runtime-owners', 'ownership.hapi.lock'))).toBe(false)
        } finally { await f.close() }
    })

    for (const condition of ['new-native-alias', 'orphan-engine', 'wrong-machine', 'audit-symlink', 'missing-confirmation', 'snapshot-substitution', 'expired-lease', 'worker-substitution']) {
        it(`keeps the original row on cross-machine ${condition}`, async () => {
            const f = await runtimeFixture('remote-empty')
            const hub = path.join(f.root, 'new-hub'); fs.mkdirSync(hub, { mode: 0o700 })
            const helper = path.join(f.root, 'proof.py'); fs.writeFileSync(helper, OFFLINE_NATIVE_PROOF_SOURCE, { mode: 0o600 })
            const orphan = condition === 'orphan-engine' ? Bun.spawn(['/usr/bin/python3', '-I', '-c', 'import time;time.sleep(30)',
                '--listen', 'unix://' + path.join(f.root, 'old', 'engine.sock')], { stdout: 'ignore', stderr: 'ignore' }) : null
            if (condition === 'audit-symlink') fs.symlinkSync(f.root, path.join(hub, 'offline-message-discard-audits'))
            const input = { sessionId: f.target.id, threadId: f.target.metadata!.codexSessionId!, observerSessionId: f.observer.id,
                observerThreadId: f.observer.metadata!.codexSessionId!, observerPid: process.ppid, namespace: 'test',
                machineId: condition === 'wrong-machine' ? randomUUID() : f.target.metadata!.machineId!, snapshot: f.snapshot }
            const rpc = async (r: ProofRequest, phase: ProofPhase) => {
                const { stdout, stderr } = await execAsync(offlineProofCommand(r, phase, helper),
                    { timeout: 25000, maxBuffer: 16384, env: { PATH: '/usr/bin:/bin', HAPI_HOME: f.hapiHome } })
                const value = JSON.parse(stdout)
                if (phase === 'prepare' && condition === 'new-native-alias') {
                    const alias = { pid: process.pid, serverPid: process.ppid, codexHome: f.codexHome,
                        sessions: { [randomUUID()]: { namespace: 'other', threadId: input.threadId, active: true } } }
                    fs.writeFileSync(path.join(f.codexHome, 'hapi-runtime-owners', randomUUID() + '.json'), JSON.stringify(alias), { mode: 0o600 })
                }
                if (phase === 'confirm') {
                    if (condition === 'missing-confirmation') delete value.proof
                    if (condition === 'snapshot-substitution') value.snapshotSha256 = '0'.repeat(64)
                    if (condition === 'expired-lease') value.leaseRemainingMs = 0
                    if (condition === 'worker-substitution') value.workerPid++
                }
                return { success: true, exitCode: 0, stdout: JSON.stringify(value), stderr }
            }
            let commits = 0
            try {
                await expect(createRemoteOfflineDiscardExecutor(hub, rpc)(input,
                    () => { commits++; return { status: 'cancelled', localId: 'old-local' } })).rejects.toThrow()
                expect(commits).toBe(0)
                expect(f.store.messages.lookupQueuedMessage(f.target.id, f.message.id).status).toBe('indeterminate')
                for (let i = 0; i < 30 && fs.existsSync(path.join(f.codexHome, 'hapi-runtime-owners', 'ownership.hapi.lock')); i++) await new Promise(r => setTimeout(r, 10))
                expect(fs.existsSync(path.join(f.codexHome, 'hapi-runtime-owners', 'ownership.hapi.lock'))).toBe(false)
            } finally { if (orphan) { orphan.kill(); await orphan.exited } await f.close() }
        }, 30000)
    }
})
