import { NATIVE_QUEUE_PROOF_SCRIPT } from './offlineMessageDiscard'

// Installed on the owning Runner, never executed against a caller-supplied home.
export const OFFLINE_NATIVE_PROOF_SOURCE = `NATIVE_SCRIPT = ${JSON.stringify(NATIVE_QUEUE_PROOF_SCRIPT)}\n` + String.raw`
import os,sys,json,time,stat,hashlib,base64,re,socket,struct,subprocess,threading,select,grp,pwd,errno
from pathlib import Path
UUID=re.compile(r'[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}')
def need(ok,code):
    if not ok:raise RuntimeError(code)
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
def directory(p):
    s=p.lstat();need(stat.S_ISDIR(s.st_mode) and p.resolve()==p and not p.is_symlink() and s.st_uid==os.getuid() and s.st_mode&0o022==0,'PROOF_DIRECTORY_UNSAFE')
def native_home(p):
    s=p.lstat();need(stat.S_ISDIR(s.st_mode) and p.resolve()==p and not p.is_symlink() and s.st_uid==os.getuid() and s.st_mode&0o002==0,'PROOF_NATIVE_HOME_UNSAFE')
    if not s.st_mode&0o020:return
    # A user-private primary group grants the same principal, not another writer.
    user=pwd.getpwuid(os.getuid());group=grp.getgrgid(s.st_gid)
    need(s.st_gid==user.pw_gid and group.gr_name==user.pw_name and all(n==user.pw_name for n in group.gr_mem),'PROOF_NATIVE_HOME_GROUP_UNPROVEN')
    nss=Path('/etc/nsswitch.conf').read_text();need(len(nss)<=65536,'PROOF_NSS_LIMIT')
    for key in ['passwd','group']:
        lines=re.findall(r'^'+key+r':\s*(.*)$',nss,re.M);need(len(lines)==1,'PROOF_NSS_UNPROVEN')
        providers=re.sub(r'\[[^\]]*\]','',lines[0].split('#',1)[0]).split()
        need(providers and providers[0]=='files' and set(providers)<=set(['files','systemd']),'PROOF_NSS_UNPROVEN')
    accounts=pwd.getpwall();need(len(accounts)<=4096 and all(a.pw_uid==os.getuid() for a in accounts if a.pw_gid==s.st_gid),'PROOF_NATIVE_HOME_GROUP_UNPROVEN')
    try:os.getxattr(p,'system.posix_acl_access');raise RuntimeError('PROOF_NATIVE_HOME_ACL_UNPROVEN')
    except OSError as e:need(e.errno==errno.ENODATA,'PROOF_NATIVE_HOME_ACL_UNPROVEN')
def identity(p):
    s=p.lstat();return (s.st_dev,s.st_ino)
def record(p):
    fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        s=os.fstat(fd);need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==os.getuid() and s.st_mode&0o022==0 and 0<s.st_size<=131072,'PROOF_RECORD_UNSAFE')
        b=os.read(fd,131073);after=p.lstat();need(len(b)==s.st_size and (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns),'PROOF_RECORD_CHANGED')
        v=json.loads(b);need(isinstance(v,dict),'PROOF_RECORD_INVALID');return v,hashlib.sha256(b).hexdigest(),len(b)
    finally:os.close(fd)
def proc(pid):
    need(type(pid) is int and pid>1,'PROOF_PID_INVALID')
    try:
        p=Path('/proc')/str(pid);need(p.stat().st_uid==os.getuid(),'PROOF_PROCESS_OWNER_MISMATCH')
        s=(p/'stat').read_text();f=s[s.rfind(')')+2:].split();return {'start':f[19],'parent':int(f[1])}
    except FileNotFoundError:return None
def marker(pid):
    return subprocess.check_output(['/usr/bin/ps','-p',str(pid),'-o','lstart='],env={'PATH':'/usr/bin:/bin','LC_ALL':'C','TZ':'UTC'},timeout=1).decode().strip()
def inspect(home,r):
    roots=[home/'codex-runtimes'];records=[];total=0
    directory(roots[0])
    for p in sorted(roots[0].glob('*.json')):
        need(UUID.fullmatch(p.stem),'PROOF_REGISTRY_NAME_INVALID');v,h,n=record(p);total+=n;records.append((v,h))
    need(0<len(records)<=8192 and total<=16777216,'PROOF_REGISTRY_LIMIT')
    witnesses=[]
    for v,h in records:
        b=v.get('sessions',{}).get(r['observerSessionId'],{})
        if b.get('namespace')==r['namespace'] and b.get('active') is True and proc(v.get('pid')):
            need(v['pid']==r['observerPid'] and b.get('threadId')==r['observerThreadId'],'PROOF_OBSERVER_BINDING_MISMATCH')
            server=proc(v.get('serverPid'));need(server and server['parent']==v['pid'],'PROOF_OBSERVER_PROCESS_MISMATCH')
            need(marker(v['pid'])==v.get('marker') and marker(v['serverPid'])==v.get('serverMarker'),'PROOF_OBSERVER_GENERATION_MISMATCH')
            witnesses.append((v,h,proc(v['pid']),server))
    need(len(witnesses)==1,'PROOF_OBSERVER_UNPROVEN');w,h,wp,sp=witnesses[0]
    codex=Path(w.get('codexHome',''));native_home(codex);owners=codex/'hapi-runtime-owners';directory(owners)
    for p in sorted(owners.glob('*.json')):
        need(UUID.fullmatch(p.stem),'PROOF_REGISTRY_NAME_INVALID');v,k,n=record(p);total+=n;records.append((v,k))
    need(len(records)<=8192 and total<=16777216,'PROOF_REGISTRY_LIMIT')
    old=0;native_aliases=0;engine_endpoints=set()
    for v,k in records:
        sessions=v.get('sessions',{});need(isinstance(sessions,dict),'PROOF_RECORD_INVALID')
        bound=sessions.get(r['sessionId'])
        same_thread=any(isinstance(b,dict) and b.get('threadId')==r['threadId'] for b in sessions.values())
        if bound is not None or same_thread or r['sessionId'] in json.dumps(v):
            need(v.get('codexHome')==str(codex),'PROOF_NATIVE_HOME_MISMATCH')
            if bound is not None:
                need(bound.get('namespace')==r['namespace'] and bound.get('threadId')==r['threadId'],'PROOF_ORIGINAL_BINDING_MISMATCH');old+=1
            if same_thread:native_aliases+=1
            need(not proc(v.get('pid')) and not proc(v.get('serverPid')),'PROOF_ORIGINAL_PROCESS_PRESENT')
            endpoint=v.get('endpoint','');need(isinstance(endpoint,str) and endpoint.startswith('unix:///'),'PROOF_ORIGINAL_ENDPOINT_UNPROVEN')
            engine_endpoints.add('unix://'+str(Path(endpoint[7:]).parent/'engine.sock'))
    need(old>0 and native_aliases>0,'PROOF_ORIGINAL_UNPROVEN')
    processes=list(Path('/proc').glob('[0-9]*'));need(len(processes)<=8192,'PROOF_PROCESS_SCAN_LIMIT')
    for p in processes:
        try:
            if p.stat().st_uid!=os.getuid():continue
            with (p/'cmdline').open('rb') as f:command=f.read(65537)
            need(len(command)<=65536,'PROOF_PROCESS_COMMAND_LIMIT')
            args=command.decode().split('\0')
            need(not any(a in engine_endpoints for a in args),'PROOF_ORIGINAL_ENGINE_PRESENT')
        except FileNotFoundError:continue
    return {'runtime':w,'registrySha256':h,'wrapper':wp,'server':sp,'originalRecords':old,'nativeAliases':native_aliases,'codexHome':str(codex)}
def native(e,r):
    endpoint=e['runtime'].get('endpoint','');need(endpoint.startswith('unix://'),'PROOF_ENDPOINT_UNSUPPORTED')
    p=str(Path(endpoint[7:]).parent/'engine.sock')
    result=subprocess.run(['/usr/bin/python3','-I','-c',NATIVE_SCRIPT],input=json.dumps({'endpoint':p,'serverPid':e['runtime']['serverPid'],'codexHome':e['codexHome'],'threadId':r['threadId']}),text=True,capture_output=True,timeout=18,env={'PATH':'/usr/bin:/bin'})
    need(len(result.stdout)<=16384 and len(result.stderr)<=16384,'PROOF_OUTPUT_LIMIT')
    v=json.loads(result.stdout)
    if result.returncode:
        code=v.get('code','NATIVE_PROOF_UNAVAILABLE');need(isinstance(code,str) and re.fullmatch(r'[A-Z_]{1,64}',code),'NATIVE_PROOF_UNAVAILABLE');raise RuntimeError(code)
    need(v.get('threadId')==r['threadId'] and v.get('nativeStatus')=='notLoaded' and v.get('queueEmpty') is True and v.get('readOnly') is True,'NATIVE_PROOF_INVALID');return v
def clean_error(e):return str(e) if type(e) is RuntimeError and re.fullmatch(r'[A-Z_]{1,64}',str(e)) else 'PROOF_UNAVAILABLE_'+type(e).__name__.upper()[:32]
def reply(fd,v):os.write(fd,json.dumps(v,separators=(',',':')).encode()+b'\n')
def receive(c):
    c.settimeout(1);b=b''
    while b'\n' not in b:
        x=c.recv(4096);need(x,'PROOF_CONTROL_CLOSED');b+=x;need(len(b)<=4096,'PROOF_CONTROL_LIMIT')
    v=json.loads(b);need(isinstance(v,dict),'PROOF_CONTROL_INVALID');return v
def worker(home,r,root,pipe):
    os.setsid();null=os.open('/dev/null',os.O_RDWR)
    for n in [0,1,2]:os.dup2(null,n)
    os.close(null);lease=None;lease_fd=None;lease_identity=None;listener=None;stop=threading.Event();broken=threading.Event();started=time.monotonic();lease_deadline=started+60
    try:
        first=inspect(home,r);lease=Path(first['codexHome'])/'hapi-runtime-owners'/'ownership.hapi.lock'
        try:lease.mkdir(mode=0o700)
        except FileExistsError:raise RuntimeError('PROOF_OWNERSHIP_BUSY')
        lease_fd=os.open(lease,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);s=os.fstat(lease_fd);lease_identity=(s.st_dev,s.st_ino)
        def held():need(not broken.is_set() and identity(lease)==lease_identity,'PROOF_OWNERSHIP_LEASE_LOST')
        def heartbeat():
            while not stop.wait(5):
                try:held();os.utime(lease_fd,None)
                except Exception:broken.set();return
        threading.Thread(target=heartbeat,daemon=True).start()
        def prove():
            held();before=inspect(home,r);need(before['registrySha256']==first['registrySha256'] and before['wrapper']==first['wrapper'] and before['server']==first['server'],'PROOF_OBSERVER_CHANGED')
            v=native(before,r);held();after=inspect(home,r);need(after['registrySha256']==before['registrySha256'] and after['wrapper']==before['wrapper'] and after['server']==before['server'],'PROOF_OBSERVER_CHANGED')
            return {'native':v,'observerRegistrySha256':after['registrySha256'],'originalRecords':after['originalRecords'],'nativeAliases':after['nativeAliases']}
        proof=prove();lease_deadline=min(started+60,time.monotonic()+30)
        listener=socket.socket(socket.AF_UNIX);listener.bind('\0hapi-offline-proof-'+str(os.getuid())+'-'+r['attemptId']);listener.listen(2);listener.settimeout(1)
        own=proc(os.getpid());base={'schema':'hapi/offline-native-proof/v1','attemptId':r['attemptId'],'machineId':r['machineId'],'requestSha256':digest(r),'snapshotSha256':r['snapshotSha256'],'workerPid':os.getpid(),'workerStart':own['start']}
        reply(pipe,{**base,'phase':'prepared','proof':proof});os.close(pipe);pipe=None;confirmed=False
        while time.monotonic()<lease_deadline:
            held();need(time.monotonic()<lease_deadline,'PROOF_LEASE_EXPIRED')
            try:c,_=listener.accept()
            except socket.timeout:continue
            with c:
                try:
                    pid,uid,gid=struct.unpack('3i',c.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12));need(uid==os.getuid(),'PROOF_CONTROL_UID_MISMATCH')
                    v=receive(c);need(v.get('requestSha256')==base['requestSha256'],'PROOF_REQUEST_CHANGED')
                    need(v.get('mode')=='finish' or v.get('mode')=='confirm' and not confirmed,'PROOF_CONTROL_PHASE_INVALID')
                except Exception as e:
                    try:c.sendall(json.dumps({'ok':False,'code':clean_error(e)}).encode()+b'\n')
                    except OSError:pass
                    continue
                if v.get('mode')=='finish':c.sendall(json.dumps({**base,'phase':'finished'}).encode()+b'\n');return
                proof=prove();confirmed=True
                lease_deadline=min(started+60,time.monotonic()+30);held();remaining=int((lease_deadline-time.monotonic())*1000);need(remaining>=20000,'PROOF_LEASE_TOO_SHORT')
                c.sendall(json.dumps({**base,'phase':'confirmed','proof':proof,'leaseRemainingMs':remaining}).encode()+b'\n')
        raise RuntimeError('PROOF_LEASE_EXPIRED')
    except Exception as e:
        if pipe is not None:
            try:reply(pipe,{'ok':False,'code':clean_error(e)})
            except OSError:pass
    finally:
        stop.set()
        if listener is not None:listener.close()
        if lease_fd is not None:
            try:
                if identity(lease)==lease_identity:lease.rmdir()
            except OSError:pass
            os.close(lease_fd)
        if pipe is not None:os.close(pipe)
        try:
            root.rmdir()
        except OSError:pass
        os._exit(0)
def main():
    mode=sys.argv[1];r=json.loads(base64.b64decode(sys.argv[2],validate=True));need(isinstance(r,dict) and set(r)=={'attemptId','machineId','sessionId','threadId','observerSessionId','observerThreadId','observerPid','namespace','snapshotSha256'},'PROOF_REQUEST_INVALID')
    for key in ['attemptId','machineId','sessionId','threadId','observerSessionId','observerThreadId']:need(isinstance(r[key],str) and UUID.fullmatch(r[key]),'PROOF_ID_INVALID')
    need(type(r['observerPid']) is int and r['observerPid']>1 and isinstance(r['namespace'],str) and 0<len(r['namespace'])<=128 and re.fullmatch(r'[a-f0-9]{64}',r['snapshotSha256']),'PROOF_REQUEST_INVALID')
    home=Path(os.environ.get('HAPI_HOME',str(Path.home()/'.hapi')));directory(home)
    settings,_,_=record(home/'settings.json');need(settings.get('machineId')==r['machineId'],'PROOF_MACHINE_MISMATCH')
    parent=home/'offline-message-proof-leases'
    if not parent.exists():parent.mkdir(mode=0o700)
    directory(parent);root=parent/r['attemptId']
    if mode=='prepare':
        root.mkdir(mode=0o700);read,write=os.pipe()
        try:pid=os.fork()
        except Exception:
            os.close(read);os.close(write);root.rmdir();raise
        if pid==0:os.close(read);worker(home,r,root,write)
        os.close(write)
        try:
            ready,_,_=select.select([read],[],[],23);need(ready,'PROOF_PREPARE_TIMEOUT');b=os.read(read,16385);need(0<len(b)<=16384,'PROOF_RESPONSE_LIMIT');sys.stdout.write(b.decode())
        finally:os.close(read)
    else:
        need(mode in ['confirm','finish'],'PROOF_CONTROL_PHASE_INVALID');directory(root)
        c=socket.socket(socket.AF_UNIX);c.settimeout(22);c.connect('\0hapi-offline-proof-'+str(os.getuid())+'-'+r['attemptId']);pid,uid,gid=struct.unpack('3i',c.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12));need(uid==os.getuid(),'PROOF_CONTROL_UID_MISMATCH');before=proc(pid)
        c.sendall(json.dumps({'mode':mode,'requestSha256':digest(r)}).encode()+b'\n');b=b''
        while b'\n' not in b:
            x=c.recv(16384);need(x,'PROOF_CONTROL_CLOSED');b+=x;need(len(b)<=16384,'PROOF_RESPONSE_LIMIT')
        v=json.loads(b);need(v.get('workerPid')==pid and v.get('workerStart')==before['start'],'PROOF_WORKER_IDENTITY_MISMATCH');print(json.dumps(v));c.close()
try:main()
except Exception as e:print(json.dumps({'ok':False,'code':clean_error(e)}));sys.exit(1)
`
