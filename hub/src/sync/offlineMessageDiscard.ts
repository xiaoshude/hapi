import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { CancelQueuedMessageResult, MessageStore } from '../store'

export type DiscardSnapshot = NonNullable<ReturnType<MessageStore['getDiscardSnapshot']>>
export type OfflineDiscardResult = Exclude<CancelQueuedMessageResult, { status: 'busy' }>
    | { status: 'busy'; localId: string | null; code?: string }
export type OfflineDiscardRequest = {
    sessionId: string; threadId: string; observerSessionId: string; observerPid: number; namespace: string
    machineId: string; observerThreadId: string
    snapshot: DiscardSnapshot
}
export type OfflineDiscardExecutor = (
    request: OfflineDiscardRequest,
    commit: () => CancelQueuedMessageResult,
) => Promise<CancelQueuedMessageResult>

export class OfflineDiscardRefused extends Error {
    constructor(readonly code: string) { super(code) }
}

function requireProof(ok: unknown, code: string): asserts ok {
    if (!ok) throw new OfflineDiscardRefused(code)
}

export function snapshotDigest(snapshot: DiscardSnapshot): string {
    const { content: _content, ...message } = snapshot.message
    return createHash('sha256').update(JSON.stringify({ message,
        contentStorage: snapshot.contentStorage, contentBase64: snapshot.contentBase64 })).digest('hex')
}

export function directory(target: string): void {
    const s = fs.lstatSync(target)
    requireProof(s.isDirectory() && !s.isSymbolicLink() && fs.realpathSync(target) === target
        && s.uid === process.getuid!() && (s.mode & 0o022) === 0, 'OFFLINE_DISCARD_DIRECTORY_UNSAFE')
}

/** Isolated stdlib client: only initialize, thread/read and thread/queue/list, no resume/send/delete. */
export const NATIVE_QUEUE_PROOF_SCRIPT = String.raw`
import sys,json,os,socket,stat,struct,hashlib,base64,secrets,time,re
from pathlib import Path
def need(ok,code):
    if not ok: raise RuntimeError(code)
def private(p):
    s=p.lstat();need(p.is_dir() and not p.is_symlink() and p.resolve()==p and s.st_uid==os.getuid() and s.st_mode&0o077==0,'NATIVE_SOCKET_PARENT_UNSAFE')
def fingerprint(p):
    s=p.lstat();return (s.st_dev,s.st_ino,s.st_uid,s.st_mode,s.st_mtime_ns,s.st_ctime_ns)
def writer_empty(home,tid):
    root=Path(home)/'thread-writer-locks';p=root/(tid+'.lock')
    need(re.fullmatch(r'[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}',tid),'NATIVE_THREAD_ID_INVALID')
    if root.exists() or root.is_symlink():
        s=root.lstat();need(root.is_dir() and not root.is_symlink() and root.resolve()==root and s.st_uid==os.getuid() and s.st_mode&0o022==0,'NATIVE_WRITER_PARENT_UNSAFE')
    if not p.exists() and not p.is_symlink():return None
    s=p.lstat();need(stat.S_ISREG(s.st_mode) and not p.is_symlink() and s.st_uid==os.getuid(),'NATIVE_WRITER_LOCK_UNSAFE')
    locks=Path('/proc/locks').read_bytes();need(len(locks)<=4194304,'NATIVE_WRITER_SCAN_LIMIT')
    for line in locks.decode().splitlines():
        for field in line.split():
            if field.count(':')!=2:continue
            try:a,b,c=field.split(':');match=int(a,16)==os.major(s.st_dev) and int(b,16)==os.minor(s.st_dev) and int(c)==s.st_ino
            except ValueError:match=False
            need(not match,'ORIGINAL_NATIVE_WRITER_PRESENT')
    return (s.st_dev,s.st_ino)
try:
    r=json.load(sys.stdin);p=Path(r['endpoint']);need(p.is_absolute() and str(p)==r['endpoint'],'NATIVE_SOCKET_PATH_INVALID');private(p.parent)
    before=fingerprint(p);target=p
    if p.is_symlink():
        target=Path(os.readlink(p));need(target.is_absolute() and target.parent==Path('/tmp/codex-daemon-'+str(os.getuid())) and len(target.name)==64 and all(c in '0123456789abcdef' for c in target.name),'NATIVE_SOCKET_LINK_INVALID');private(target.parent)
    s=target.lstat();need(stat.S_ISSOCK(s.st_mode) and s.st_uid==os.getuid() and s.st_mode&0o077==0 and target.resolve()==target,'NATIVE_SOCKET_UNSAFE');target_before=fingerprint(target)
    writer_before=writer_empty(r['codexHome'],r['threadId'])
    sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);sock.settimeout(3);sock.connect(str(p))
    pid,uid,gid=struct.unpack('3i',sock.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12));need(uid==os.getuid(),'NATIVE_PEER_UID_MISMATCH')
    raw=Path('/proc/'+str(pid)+'/stat').read_text();fields=raw[raw.rfind(')')+2:].split();need(int(fields[1])==r['serverPid'],'NATIVE_PEER_PARENT_MISMATCH');peer_start=fields[19]
    key=base64.b64encode(secrets.token_bytes(16)).decode();sock.sendall(('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: '+key+'\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
    buf=b''
    while b'\r\n\r\n' not in buf:
        more=sock.recv(4096);need(more,'NATIVE_CONNECTION_CLOSED');buf+=more;need(len(buf)<=16384,'NATIVE_HANDSHAKE_LIMIT')
    header,buf=buf.split(b'\r\n\r\n',1);lines=header.decode().split('\r\n');need(' 101 ' in lines[0],'NATIVE_HANDSHAKE_REJECTED')
    headers={line.split(':',1)[0].lower():line.split(':',1)[1].strip() for line in lines[1:] if ':' in line}
    expected=base64.b64encode(hashlib.sha1((key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode();need(headers.get('sec-websocket-accept','')==expected,'NATIVE_HANDSHAKE_IDENTITY_INVALID')
    def take(n):
        global buf
        while len(buf)<n:
            more=sock.recv(min(65536,n-len(buf)));need(more,'NATIVE_CONNECTION_CLOSED');buf+=more
        out,buf=buf[:n],buf[n:];return out
    def send(payload,opcode=1):
        mask=secrets.token_bytes(4);n=len(payload);need(n<=65535,'NATIVE_REQUEST_LIMIT')
        head=bytes([0x80|opcode,0x80|n]) if n<126 else bytes([0x80|opcode,0x80|126])+struct.pack('!H',n)
        sock.sendall(head+mask+bytes(v^mask[i%4] for i,v in enumerate(payload)))
    counter=0
    def call(method,params):
        global counter
        need(method in ['initialize','thread/read','thread/queue/list'],'NON_READONLY_RPC_REFUSED');counter+=1;send(json.dumps({'id':counter,'method':method,'params':params}).encode());deadline=time.monotonic()+4
        for _ in range(128):
            need(time.monotonic()<deadline,'NATIVE_RPC_TIMEOUT');a,b=take(2);need(a&0x80 and a&0x70==0 and b&0x80==0,'NATIVE_FRAME_UNSUPPORTED');n=b&0x7f
            if n==126:n=struct.unpack('!H',take(2))[0]
            if n==127:n=struct.unpack('!Q',take(8))[0]
            need(n<=1048576,'NATIVE_FRAME_LIMIT');payload=take(n);opcode=a&15
            if opcode==9:need(n<=125,'NATIVE_PING_INVALID');send(payload,10);continue
            if opcode==10:continue
            need(opcode==1,'NATIVE_FRAME_UNSUPPORTED');value=json.loads(payload)
            if value.get('id')!=counter:continue
            need('error' not in value and isinstance(value.get('result'),dict),'NATIVE_RPC_FAILED');return value['result']
        raise RuntimeError('NATIVE_RPC_MESSAGE_LIMIT')
    call('initialize',{'clientInfo':{'name':'hapi_explicit_offline_discard_audit','version':'1'},'capabilities':{'experimentalApi':True}});send(json.dumps({'method':'initialized'}).encode())
    def check():
        t=call('thread/read',{'threadId':r['threadId'],'includeTurns':False}).get('thread',{});need(t.get('id')==r['threadId'] and t.get('status',{}).get('type')=='notLoaded','ORIGINAL_NATIVE_THREAD_LOADED')
        q=call('thread/queue/list',{'threadId':r['threadId']});need(q.get('data')==[] and 'nextCursor' in q and q['nextCursor'] is None,'ORIGINAL_NATIVE_QUEUE_NOT_EMPTY')
    check();check();need(fingerprint(p)==before and fingerprint(target)==target_before,'NATIVE_SOCKET_CHANGED');need(writer_empty(r['codexHome'],r['threadId'])==writer_before,'NATIVE_WRITER_GENERATION_CHANGED')
    raw=Path('/proc/'+str(pid)+'/stat').read_text();fields=raw[raw.rfind(')')+2:].split();need(fields[19]==peer_start and int(fields[1])==r['serverPid'],'NATIVE_PEER_GENERATION_CHANGED')
    print(json.dumps({'threadId':r['threadId'],'nativeStatus':'notLoaded','queueEmpty':True,'enginePid':pid,'engineStart':peer_start,'readOnly':True}));sock.close()
except Exception as e:
    code=str(e) if type(e) is RuntimeError else 'NATIVE_PROOF_UNAVAILABLE'
    print(json.dumps({'code':code,'ok':False}));sys.exit(1)
`

function immutable(file: string, bytes: Buffer): void {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

export function archiveOfflineDiscard(hapiHome: string, request: OfflineDiscardRequest, proof: Record<string, unknown>): void {
    directory(hapiHome)
    const auditRoot = path.join(hapiHome, 'offline-message-discard-audits')
    if (!fs.existsSync(auditRoot)) fs.mkdirSync(auditRoot, { mode: 0o700 })
    directory(auditRoot)
    const { content: _content, ...message } = request.snapshot.message
    const original = { schema: 'hapi/offline-discard-original/v1', message,
        contentStorage: request.snapshot.contentStorage, contentBase64: request.snapshot.contentBase64 }
    const originalBytes = Buffer.from(JSON.stringify(original) + '\n')
    const originalPath = path.join(auditRoot, `${message.id}-${snapshotDigest(request.snapshot)}.original.json`)
    if (fs.existsSync(originalPath)) {
        const fd = fs.openSync(originalPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
        try {
            const s = fs.fstatSync(fd)
            requireProof(s.isFile() && s.nlink === 1 && s.uid === process.getuid!() && s.size === originalBytes.length
                && (s.mode & 0o077) === 0 && fs.readFileSync(fd).equals(originalBytes), 'OFFLINE_DISCARD_AUDIT_CONFLICT')
        } finally { fs.closeSync(fd) }
    } else { immutable(originalPath, originalBytes) }
    const audit = { schema: 'hapi/offline-discard-attempt/v1', at: new Date().toISOString(),
        sessionId: request.sessionId, localId: message.localId, observerSessionId: request.observerSessionId,
        originalPath, originalSha256: createHash('sha256').update(originalBytes).digest('hex'),
        proof, pastConsumption: 'unknown', publicAction: 0 }
    immutable(path.join(auditRoot, `${message.id}-${randomUUID()}.attempt.json`), Buffer.from(JSON.stringify(audit) + '\n'))
    const fd = fs.openSync(auditRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
