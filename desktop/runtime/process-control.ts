// Child processes, pidfiles, loopback ports and health probes. Node APIs only (runs in Electron's main process).
// The supervisors depend on the small ProcessHost interface below, so tests drive them with fake children.
import {spawn,execFileSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {mkdirSync,rmSync,renameSync,readdirSync,realpathSync,lstatSync,openSync,fstatSync,readSync,closeSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import type {Readable} from 'node:stream';
import {assertContained,assertPrivatePaths,chmodNoFollow,writeNewPrivateFile,powershellAclBatchProbe,windowsAclProblem,runWindowsPowerShell,READ_NOFOLLOW_FLAGS,type AclBatchProbe} from '../../server/private-path.ts';

export type ChildLike=EventEmitter&{pid?:number;stdout:Readable|null;stderr:Readable|null;kill:(signal?:NodeJS.Signals)=>boolean};
// input: written to the child's standard input, which is then closed (secrets go this way, never in env or args, which
// other programs of this account can read while the child runs). Without it the child's standard input is empty.
export type SpawnRequest={command:string;args:string[];env:Record<string,string>;cwd?:string;input?:string};
export type PidRecord={pid:number;executable:string;startedAt:string};

// What the system reports about a running process. Either part is null when it cannot be read.
export type ProcessIdentity={executable:string|null;startedAtMs:number|null};

// Everything a supervisor needs from the operating system.
export type ProcessHost={
 platform:NodeJS.Platform;
 spawn:(req:SpawnRequest)=>ChildLike;
 isAlive:(pid:number)=>boolean;
 // The executable the kernel runs for a process (never argv[0], which a process sets itself) and its start time, or
 // null when nothing can be read. Guards against signalling anything but our own children: see killOrphan.
 identityOf:(pid:number)=>ProcessIdentity|null;
 signal:(pid:number,signal:NodeJS.Signals)=>void;
 sleep:(ms:number)=>Promise<void>;
 now:()=>number;
};

// `ps -o lstart=` with LC_ALL=C and TZ=UTC0: "Thu Oct 22 00:47:42 2026" in UTC, whole seconds. Returns ms since the epoch.
// ps runs with an explicit UTC zone so the reading never depends on this process's or the system's time zone.
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export function parseLstart(lstart:string):number|null{
 const m=/^[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(lstart.trim());
 if(!m)return null;
 const month=MONTHS.indexOf(m[1]);if(month<0)return null;
 const t=Date.UTC(Number(m[6]),month,Number(m[2]),Number(m[3]),Number(m[4]),Number(m[5]));
 return Number.isFinite(t)?t:null;
}

export const nodeProcessHost:ProcessHost={
 platform:process.platform,
 spawn:({command,args,env,cwd,input})=>{
  const child=spawn(command,args,{env,cwd,stdio:[input===undefined?'ignore':'pipe','pipe','pipe'],windowsHide:true,detached:false});
  // A child that exits before reading gives EPIPE here; its exit is reported through 'exit' as usual.
  if(input!==undefined&&child.stdin){child.stdin.on('error',()=>{});child.stdin.end(input);}
  return child as unknown as ChildLike;
 },
 isAlive:pid=>{try{process.kill(pid,0);return true}catch(e){return (e as NodeJS.ErrnoException).code==='EPERM'}},
 identityOf:pid=>{
  try{
   if(process.platform==='win32'){
    const script=`$p=Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}";if($p){"EXE "+$p.ExecutablePath;"START "+$p.CreationDate.ToUniversalTime().ToString('o')}`;
    const out=runWindowsPowerShell(script,{},15000);
    const exe=/^EXE (.+?)\r?$/m.exec(out)?.[1]?.trim()||null;
    const start=Date.parse(/^START (\S+)/m.exec(out)?.[1]??'');
    return exe||Number.isFinite(start)?{executable:exe,startedAtMs:Number.isFinite(start)?start:null}:null;
   }
   // Start time from ps (the kernel's start time, in UTC). The executable from lsof: the first `txt` entry is the file
   // the kernel mapped as the program, links resolved. ps's comm column is not used: it follows argv[0], which any
   // process can set to our sidecar's path.
   const env={PATH:'/bin:/usr/bin:/usr/sbin',LC_ALL:'C',TZ:'UTC0'};
   const startedAtMs=parseLstart(execFileSync('/bin/ps',['-p',String(Number(pid)),'-o','lstart='],{encoding:'utf8',timeout:5000,env}));
   let executable:string|null=null;
   try{executable=/^n(.+)$/m.exec(execFileSync('/usr/sbin/lsof',['-a','-p',String(Number(pid)),'-d','txt','-Fn','-w'],{encoding:'utf8',timeout:5000,env}))?.[1]??null}catch{}
   return startedAtMs===null&&executable===null?null:{executable,startedAtMs};
  }catch{return null}
 },
 signal:(pid,signal)=>{try{process.kill(pid,signal)}catch{}},
 sleep:ms=>new Promise(r=>setTimeout(r,ms)),
 now:()=>Date.now(),
};

const normal=(a:string,platform:NodeJS.Platform)=>platform==='win32'?path.win32.normalize(a).toLowerCase():path.posix.normalize(a);
const canonical=(a:string)=>{try{return realpathSync.native(a)}catch{return a}};
// True when `reported` (what the system says a process runs) is exactly `expected` (this app's bundled program), as
// given or with links in `expected` resolved (/var and /private/var on macOS). `reported` is never resolved itself.
export const isExpectedExecutable=(reported:string,expected:string,platform:NodeJS.Platform)=>{
 const r=normal(reported,platform);
 return r===normal(expected,platform)||r===normal(canonical(expected),platform);
};

// Pidfiles live in a private run folder under the data root, one per child.
export class PidFile{
 readonly file:string;
 constructor(file:string){this.file=file;}
 // Read without following a link; anything but a small plain file is no record.
 read():PidRecord|null{
  let fd:number;try{fd=openSync(this.file,READ_NOFOLLOW_FLAGS)}catch{return null}
  try{
   const st=fstatSync(fd);if(!st.isFile()||st.size>4096)return null;
   const buf=Buffer.alloc(st.size);readSync(fd,buf,0,st.size,0);
   const r=JSON.parse(buf.toString('utf8'));
   return Number.isInteger(r?.pid)&&r.pid>0&&typeof r.executable==='string'&&typeof r.startedAt==='string'?{pid:r.pid,executable:r.executable,startedAt:r.startedAt}:null;
  }catch{return null}
  finally{closeSync(fd)}
 }
 // A fresh temporary file (exclusive, no link, 0600 on the descriptor), renamed into place.
 write(rec:PidRecord){
  mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});
  const tmp=`${this.file}.${randomBytes(4).toString('hex')}.tmp`;
  writeNewPrivateFile(tmp,JSON.stringify(rec));renameSync(tmp,this.file);
 }
 clear(){rmSync(this.file,{force:true})} // removes a link itself, never its target
}

// ps and CreationDate are read to the second and the pidfile is written just after spawn: allow a few seconds either way.
export const START_TOLERANCE_MS=5000;
// same: the process runs the expected program and started when recorded. other: it runs another program.
// restarted: the expected program with another start time. unknown: the system will not say.
export type IdentityVerdict='same'|'other'|'restarted'|'unknown';
export function identityVerdict(host:ProcessHost,pid:number,expected:{executable:string;startedAtMs:number}):IdentityVerdict{
 const id=host.identityOf(pid);
 if(id?.executable&&!isExpectedExecutable(id.executable,expected.executable,host.platform))return 'other';
 if(!id?.executable||id.startedAtMs===null)return 'unknown';
 return Math.abs(id.startedAtMs-expected.startedAtMs)<=START_TOLERANCE_MS?'same':'restarted';
}

// Stops a process this run did not spawn: polite signal, then a hard kill after `graceMs`. `verify` is asked
// immediately before EVERY signal; anything but 'same' sends nothing (the PID may have been reused in the meantime).
// Resolves true once the process we meant is gone (exited, or its PID now names something else).
// Windows has no SIGTERM; it terminates at once.
export async function stopPid(host:ProcessHost,pid:number,verify:()=>IdentityVerdict,graceMs=3000):Promise<boolean>{
 // null: still the process we meant (signal it); true: it is gone; false: cannot tell (send nothing).
 const gone=():boolean|null=>{if(!host.isAlive(pid))return true;const v=verify();return v==='same'?null:v!=='unknown';};
 let g=gone();if(g!==null)return g;
 host.signal(pid,'SIGTERM');
 for(const deadline=host.now()+graceMs;host.now()<deadline;){if(!host.isAlive(pid))return true;await host.sleep(50);}
 g=gone();if(g!==null)return g;
 host.signal(pid,'SIGKILL');
 for(const deadline=host.now()+2000;host.now()<deadline;){if(!host.isAlive(pid))return true;await host.sleep(50);}
 return gone()??false;
}

export type OrphanOutcome='none'|'stale'|'foreign'|'killed'|'survived'|'unproven';

// A previous run that crashed or was force-quit can leave its child running. It is signalled only when the system
// says the recorded PID runs `expectedExecutable` (this app's bundled program, never a path taken from the pidfile)
// and started when the pidfile says, re-checked before every signal. A record naming any other program is not ours:
// dropped, nothing signalled. A PID the system has given to another program is left alone and its record dropped.
// When identity cannot be proven, nothing is signalled and the record is kept for the next try.
export async function killOrphan(host:ProcessHost,pidfile:PidFile,expectedExecutable:string):Promise<OrphanOutcome>{
 const rec=pidfile.read();
 if(!rec){pidfile.clear();return 'none';}
 const recorded=Date.parse(rec.startedAt);
 if(!isExpectedExecutable(rec.executable,expectedExecutable,host.platform)||!Number.isFinite(recorded)){pidfile.clear();return 'foreign';}
 if(!host.isAlive(rec.pid)){pidfile.clear();return 'stale';}
 const verify=()=>identityVerdict(host,rec.pid,{executable:expectedExecutable,startedAtMs:recorded});
 const v=verify();
 if(v==='other'){pidfile.clear();return 'stale';}
 if(v!=='same')return 'unproven';
 const stopped=await stopPid(host,rec.pid,verify);
 if(stopped)pidfile.clear();
 return stopped?'killed':'survived';
}

// One pidfile per child we start: <runDir>/<kind>-<pid>.pid (so a record we cannot resolve is never overwritten).
export type ChildKind='service'|'cloudflared';
export const pidFileFor=(runDir:string,kind:ChildKind,pid:number)=>new PidFile(path.join(runDir,`${kind}-${pid}.pid`));
const PIDFILE_RE=/^(service|cloudflared)(?:-\d+)?\.pid$/;
const KIND_TEXT:Record<ChildKind,string>={service:'register',cloudflared:'tunnel program'};
// ignored: records that were not AttendWell's (removed, nothing signalled); for the log.
export type OrphanReport={killed:string[];unresolved:string[];ignored:string[]};

export type RunDirOptions={dataRoot:string;runDir:string;platform?:NodeJS.Platform;aclBatchProbe?:AclBatchProbe};
// The run folder must be a real folder inside the data root (no link anywhere from the data root down, canonical path
// where it should be) and private, like the data root (POSIX 0700; Windows: private access list). With `create`, it is
// made first (0700 set on the opened folder). Returns false when it does not exist and `create` is off; throws
// PrivatePathError when it is not safe.
export function checkRunDir(o:RunDirOptions,create=false):boolean{
 const platform=o.platform??process.platform;
 const message='AttendWell keeps its process records in a private folder inside its data folder.';
 if(create){try{mkdirSync(o.runDir,{mode:0o700})}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}}
 else{try{lstatSync(o.runDir)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;}}
 const contained=()=>assertContained(o.dataRoot,o.runDir,{platform,message});
 contained();
 if(create&&platform!=='win32')chmodNoFollow(o.runDir,0o700,'dir',{platform,recheck:contained});
 assertPrivatePaths([{path:o.dataRoot,kind:'dir'},{path:o.runDir,kind:'dir'}],{platform,aclBatchProbe:o.aclBatchProbe??powershellAclBatchProbe,message});
 return true;
}

function removeUnread(file:string,name:string,report:OrphanReport){
 try{rmSync(file,{force:true})}catch{}
 report.ignored.push(`Removed ${name} from the process records: it was not a private plain file. Nothing was stopped.`);
}

// Resolves every pidfile left in the run folder: kills proven orphans, drops stale and foreign records, reports the
// rest. The run folder is checked before any record in it is read; a linked or shared folder is refused unread.
export async function reconcileOrphans(host:ProcessHost,o:RunDirOptions&{executables:Record<ChildKind,string>}):Promise<OrphanReport>{
 const report:OrphanReport={killed:[],unresolved:[],ignored:[]};
 const platform=o.platform??host.platform;
 try{if(!checkRunDir({...o,platform}))return report;}
 catch{
  report.unresolved.push(`AttendWell did not look for programs left running by an earlier session, because the folder that records them (${o.runDir}) is not a private folder inside its data folder. Nothing was stopped.`);
  return report;
 }
 let names:string[]=[];try{names=readdirSync(o.runDir)}catch{return report}
 // A record is a private plain file with one link; anything else (a link, a folder, a shared file) is removed unread.
 // POSIX: no group or other permission bits. Windows: mode bits mean nothing, so each record's access list is read
 // first (one PowerShell call for all of them) and must allow only this user, SYSTEM and Administrators.
 const records:{name:string;kind:ChildKind;file:string}[]=[];
 for(const name of names){
  const kind=PIDFILE_RE.exec(name)?.[1] as ChildKind|undefined;if(!kind)continue;
  const file=path.join(o.runDir,name);
  let plain=false;try{const st=lstatSync(file);plain=st.isFile()&&st.nlink===1&&(platform==='win32'||(st.mode&0o077)===0);}catch{}
  if(!plain){removeUnread(file,name,report);continue;}
  records.push({name,kind,file});
 }
 let shared=new Set<string>();
 if(platform==='win32'&&records.length){
  let acl:ReturnType<AclBatchProbe>;
  try{acl=(o.aclBatchProbe??powershellAclBatchProbe)(records.map(r=>r.file))}
  catch{
   // The lists could not be read at all: no record is read and nothing is signalled; the records stay for the next run.
   report.unresolved.push('AttendWell could not check its process records from an earlier session, so it did not read them. Nothing was stopped.');
   return report;
  }
  shared=new Set(records.filter(r=>{const sddl=acl.sddl.get(r.file);return !sddl||windowsAclProblem(sddl,acl.userSid,{userAlias:acl.userAlias})!==null;}).map(r=>r.file));
 }
 for(const {name,kind,file} of records){
  if(shared.has(file)){removeUnread(file,name,report);continue;}
  const pidfile=new PidFile(file);const pid=pidfile.read()?.pid;
  const outcome=await killOrphan(host,pidfile,o.executables[kind]);
  if(outcome==='killed')report.killed.push(`Stopped a ${KIND_TEXT[kind]} left running by an earlier session (process ${pid}).`);
  if(outcome==='foreign')report.ignored.push(`Removed ${name} from the process records: it does not name this copy of AttendWell's ${KIND_TEXT[kind]}. Nothing was stopped.`);
  if(outcome==='survived')report.unresolved.push(`A ${KIND_TEXT[kind]} from an earlier session (process ${pid}) could not be stopped. Restart the computer.`);
  if(outcome==='unproven')report.unresolved.push(`A process (${pid}) may be a ${KIND_TEXT[kind]} from an earlier session, but AttendWell could not confirm it, so it was left running. Restart the computer if check-in misbehaves.`);
 }
 return report;
}

// macOS: the register's participant listener is a Unix socket in a private folder, so only this account can bind its
// path. The run folder is used when the path fits the 104-byte socket limit; otherwise a new private folder in this
// account's temporary directory, which the caller owns and removes.
const SOCKET_NAME='p-000000000000.sock';
export function participantSocketDir(runDir:string):{dir:string;owned:boolean}{
 if(Buffer.byteLength(path.join(runDir,SOCKET_NAME))<100)return {dir:runDir,owned:false};
 const made=path.join(realpathSync.native(os.tmpdir()),`attendwell-${randomBytes(4).toString('hex')}`);
 mkdirSync(made,{mode:0o700});
 const st=lstatSync(made);
 if(!st.isDirectory()||(st.mode&0o077)!==0||(process.getuid&&st.uid!==process.getuid()))throw new Error('Could not make a private folder for the register.');
 if(Buffer.byteLength(path.join(made,SOCKET_NAME))>=104)throw new Error('The temporary folder path is too long for a private socket.');
 return {dir:made,owned:true};
}
export const newParticipantSocket=(dir:string)=>path.join(dir,`p-${randomBytes(6).toString('hex')}.sock`);
// Removes a socket file we created (only a socket; a link or anything else is left alone).
export function removeSocketFile(file:string){try{if(lstatSync(file).isSocket())rmSync(file,{force:true})}catch{}}

// True when something accepts connections on the Unix socket at `socketPath`.
export function socketAcceptsConnections(socketPath:string,timeoutMs=1000):Promise<boolean>{
 return new Promise(resolve=>{
  const sock=net.connect({path:socketPath});let done=false;
  const finish=(v:boolean)=>{if(done)return;done=true;sock.destroy();resolve(v)};
  sock.setTimeout(timeoutMs,()=>finish(false));sock.once('connect',()=>finish(true));sock.once('error',()=>finish(false));
 });
}

// Asks the system for a free TCP port on 127.0.0.1 only.
export function freeLoopbackPort():Promise<number>{
 return new Promise((resolve,reject)=>{
  const srv=net.createServer();srv.unref();srv.on('error',reject);
  srv.listen({port:0,host:'127.0.0.1',exclusive:true},()=>{const port=(srv.address() as net.AddressInfo).port;srv.close(()=>resolve(port));});
 });
}

// True when something accepts TCP connections on 127.0.0.1:port.
export function portAcceptsConnections(port:number,timeoutMs=1000):Promise<boolean>{
 return new Promise(resolve=>{
  const sock=net.connect({port,host:'127.0.0.1'});let done=false;
  const finish=(v:boolean)=>{if(done)return;done=true;sock.destroy();resolve(v)};
  sock.setTimeout(timeoutMs,()=>finish(false));sock.once('connect',()=>finish(true));sock.once('error',()=>finish(false));
 });
}

// GET on a loopback listener with an explicit Host header (fetch forbids setting Host). Resolves to the status, or 0.
// `to` is a loopback port, or {socketPath} for a Unix socket.
// `bearer`: the organiser listener's per-start key, sent as Authorization (never logged).
export function loopbackStatus(to:number|{socketPath:string},pathname:string,host:string,timeoutMs=2000,bearer?:string):Promise<number>{
 return new Promise(resolve=>{
  const where=typeof to==='number'?{host:'127.0.0.1',port:to}:{socketPath:to.socketPath};
  const req=http.request({...where,path:pathname,method:'GET',headers:{Host:host,...(bearer?{Authorization:`Bearer ${bearer}`}:{})},timeout:timeoutMs,agent:false},res=>{res.resume();resolve(res.statusCode??0)});
  req.on('timeout',()=>{req.destroy();resolve(0)});req.on('error',()=>resolve(0));req.end();
 });
}

// Emits whole lines from a child's output stream.
export function onLines(stream:Readable|null,fn:(line:string)=>void){
 if(!stream)return;let buf='';
 stream.setEncoding?.('utf8');
 stream.on('data',(chunk:string|Buffer)=>{buf+=String(chunk);let i;while((i=buf.indexOf('\n'))>=0){fn(buf.slice(0,i).replace(/\r$/,''));buf=buf.slice(i+1);}if(buf.length>65536)buf=buf.slice(-65536);});
 stream.on('end',()=>{if(buf)fn(buf);buf='';});
}

// The environment a child gets: only what it needs, never the parent's whole environment (which may hold secrets).
export function baseChildEnv(platform:NodeJS.Platform=process.platform,from:NodeJS.ProcessEnv=process.env):Record<string,string>{
 const keep=platform==='win32'?['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','HOMEDRIVE','HOMEPATH','ComSpec','PATHEXT']:['PATH','HOME','TMPDIR','LANG'];
 const env:Record<string,string>={};
 for(const k of keep)if(typeof from[k]==='string')env[k]=from[k] as string;
 return env;
}

// GET JSON from a loopback listener; null on any failure.
export function loopbackJson(port:number,pathname:string,host:string,timeoutMs=3000,bearer?:string):Promise<unknown>{
 return new Promise(resolve=>{
  const req=http.request({host:'127.0.0.1',port,path:pathname,method:'GET',headers:{Host:host,...(bearer?{Authorization:`Bearer ${bearer}`}:{})},timeout:timeoutMs},res=>{
   let body='';res.setEncoding('utf8');res.on('data',c=>{body+=c;if(body.length>5_000_000)req.destroy();});
   res.on('end',()=>{if(res.statusCode!==200)return resolve(null);try{resolve(JSON.parse(body))}catch{resolve(null)}});
  });
  req.on('timeout',()=>{req.destroy();resolve(null)});req.on('error',()=>resolve(null));req.end();
 });
}

// Ends a child we spawned: SIGTERM, then SIGKILL after `graceMs`. Resolves true once its exit has been observed.
export async function terminateChild(child:ChildLike,exited:Promise<unknown>,host:ProcessHost,graceMs=3000):Promise<boolean>{
 let done=false;const watch=exited.then(()=>{done=true});
 const wait=(ms:number)=>Promise.race([watch,host.sleep(ms)]);
 if(!done){try{child.kill('SIGTERM')}catch{}await wait(graceMs);}
 if(!done){try{child.kill('SIGKILL')}catch{}await wait(2000);}
 return done;
}
