import { createHash, randomUUID } from 'node:crypto'
import { archiveOfflineDiscard, OfflineDiscardRefused, snapshotDigest,
    type OfflineDiscardExecutor, type OfflineDiscardRequest } from './offlineMessageDiscard'
import { OFFLINE_NATIVE_PROOF_SOURCE } from './offlineNativeProofSource'

export type ProofRequest = Pick<OfflineDiscardRequest, 'sessionId' | 'threadId' | 'observerSessionId'
    | 'observerThreadId' | 'observerPid' | 'namespace' | 'machineId'> & { attemptId: string; snapshotSha256: string }
export type ProofPhase = 'prepare' | 'confirm' | 'finish'
export type ProofRpc = (request: ProofRequest, phase: ProofPhase) => Promise<unknown>

export const OFFLINE_PROOF_HELPER_PATH = '/usr/local/lib/teamai-hapi/hapi-offline-message-proof.py'
export const OFFLINE_PROOF_HELPER_SHA256 = createHash('sha256').update(OFFLINE_NATIVE_PROOF_SOURCE).digest('hex')

function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'" }

/** Fixed, hash-checked helper; no caller command, home, endpoint or native mutation. */
export function offlineProofCommand(request: ProofRequest, phase: ProofPhase,
    helperPath = OFFLINE_PROOF_HELPER_PATH): string {
    const wrapper = `import os,stat,hashlib,sys\np=${JSON.stringify(helperPath)}\nfd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)\ns=os.fstat(fd)\nassert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid in (0,os.getuid()) and s.st_mode&0o022==0 and s.st_size<65536\nb=os.read(fd,65537);os.close(fd)\nassert hashlib.sha256(b).hexdigest()==${JSON.stringify(OFFLINE_PROOF_HELPER_SHA256)}\nexec(compile(b,p,'exec'),{'__name__':'__main__','__file__':p})`
    return ['/usr/bin/python3', '-I', '-c', wrapper, phase, Buffer.from(JSON.stringify(request)).toString('base64')]
        .map(shellQuote).join(' ')
}

function parseResponse(value: unknown, request: ProofRequest, phase: ProofPhase) {
    const v = value as Record<string, unknown> | null
    if (!v || v.success !== true || v.exitCode !== 0 || typeof v.stdout !== 'string' || v.stdout.length > 16384) {
        throw new OfflineDiscardRefused('OFFLINE_PROOF_RPC_UNAVAILABLE')
    }
    const r = JSON.parse(v.stdout) as Record<string, any>
    const requestSha256 = createHash('sha256').update(JSON.stringify(Object.fromEntries(
        Object.keys(request).sort().map(key => [key, request[key as keyof ProofRequest]])))).digest('hex')
    if (r.ok === false) throw new OfflineDiscardRefused(typeof r.code === 'string'
        && /^[A-Z_]{1,64}$/.test(r.code) ? r.code : 'OFFLINE_PROOF_UNAVAILABLE')
    const expected = phase === 'prepare' ? 'prepared' : phase === 'confirm' ? 'confirmed' : 'finished'
    if (r.schema !== 'hapi/offline-native-proof/v1' || r.phase !== expected || r.attemptId !== request.attemptId
        || r.machineId !== request.machineId || r.snapshotSha256 !== request.snapshotSha256
        || !Number.isSafeInteger(r.workerPid) || r.workerPid <= 1 || !/^[0-9]+$/.test(r.workerStart)
        || r.requestSha256 !== requestSha256) throw new OfflineDiscardRefused('OFFLINE_PROOF_IDENTITY_INVALID')
    if (phase !== 'finish' && (r.proof?.native?.threadId !== request.threadId || r.proof?.native?.nativeStatus !== 'notLoaded'
        || r.proof?.native?.queueEmpty !== true || r.proof?.native?.readOnly !== true
        || !Number.isSafeInteger(r.proof?.originalRecords) || r.proof.originalRecords < 1
        || !Number.isSafeInteger(r.proof?.nativeAliases) || r.proof.nativeAliases < 1)) {
        throw new OfflineDiscardRefused('OFFLINE_PROOF_INVALID')
    }
    return r
}

/** The authenticated original machine retains the ownership lease through the Hub CAS. */
export function createRemoteOfflineDiscardExecutor(hapiHome: string, rpc: ProofRpc): OfflineDiscardExecutor {
    return async (input, commit) => {
        if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.snapshot.message.id)
            || input.snapshot.message.sessionId !== input.sessionId
            || input.snapshot.message.deliveryState !== 'indeterminate' || input.snapshot.message.invokedAt !== null) {
            throw new OfflineDiscardRefused('OFFLINE_DISCARD_SNAPSHOT_INVALID')
        }
        const { sessionId, threadId, observerSessionId, observerThreadId, observerPid, namespace, machineId } = input
        const request: ProofRequest = { sessionId, threadId, observerSessionId, observerThreadId, observerPid, namespace,
            machineId, attemptId: randomUUID(), snapshotSha256: snapshotDigest(input.snapshot) }
        try {
            const prepared = parseResponse(await rpc(request, 'prepare'), request, 'prepare')
            // Audit failure prevents a disposition; raw original bytes live on the actual Hub.
            archiveOfflineDiscard(hapiHome, input, { machineId, ...prepared })
            const started = performance.now()
            const confirmed = parseResponse(await rpc(request, 'confirm'), request, 'confirm')
            if (confirmed.workerPid !== prepared.workerPid || confirmed.workerStart !== prepared.workerStart
                || confirmed.requestSha256 !== prepared.requestSha256
                || confirmed.proof.native.enginePid !== prepared.proof.native.enginePid
                || confirmed.proof.native.engineStart !== prepared.proof.native.engineStart
                || confirmed.proof.observerRegistrySha256 !== prepared.proof.observerRegistrySha256
                || !Number.isSafeInteger(confirmed.leaseRemainingMs) || confirmed.leaseRemainingMs < 20000
                || confirmed.leaseRemainingMs > 30000 || performance.now() - started > 5000) {
                throw new OfflineDiscardRefused('OFFLINE_PROOF_LEASE_UNPROVEN')
            }
            archiveOfflineDiscard(hapiHome, input, { machineId, ...confirmed })
            if (performance.now() - started > 5000) throw new OfflineDiscardRefused('OFFLINE_PROOF_LEASE_UNPROVEN')
            return commit()
        } finally {
            // One bounded cleanup request; a lost RPC cannot extend the remote lease's 60s lifetime.
            try { await rpc(request, 'finish') } catch { /* Native helper self-closes; never retry the message. */ }
        }
    }
}
