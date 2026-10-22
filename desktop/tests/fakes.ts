// Fake child processes and a fake process host for the supervisor tests. No real process is started.
import {test} from 'bun:test';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import type {ProcessHost,SpawnRequest} from '../runtime/process-control.ts';

// The platform the fake host reports: this computer's (Windows on Windows, macOS elsewhere). ATTENDWELL_SIMULATE_WINDOWS=1
// runs the Windows branches on a Mac: the access lists then come from windowsAcl() below, never from PowerShell.
export const SIM_PLATFORM:NodeJS.Platform=process.platform==='win32'||process.env.ATTENDWELL_SIMULATE_WINDOWS==='1'?'win32':'darwin';
export const SIM_WINDOWS=SIM_PLATFORM==='win32';
// The bundled programs' folder for the simulated platform (resourcePaths key).
export const SIM_KEY=SIM_WINDOWS?'windows-x64':'darwin-arm64';

// Simulated Windows access lists: every folder and file private to this user (SYSTEM and Administrators too, as in AppData);
// a folder given its own list by aclProtect reads back protected. Pass windowsAcl().options to the runtime or library.
export const TEST_USER_SID='S-1-5-21-1111-2222-3333-1001';
export function windowsAcl(){
 const protectedDirs=new Set<string>();
 const inherited=`O:${TEST_USER_SID}D:(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${TEST_USER_SID})`;
 const own=`O:${TEST_USER_SID}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${TEST_USER_SID})`;
 return {protectedDirs,options:{
  aclBatchProbe:(targets:string[])=>({userSid:TEST_USER_SID,sddl:new Map(targets.map(t=>[t,protectedDirs.has(t)?own:inherited] as [string,string]))}),
  aclProtect:(dir:string,sid:string)=>{if(sid!==TEST_USER_SID)throw new Error('wrong user');protectedDirs.add(dir);},
 }};
}
// On the simulated Windows path, the access-list seams; on macOS nothing (the real permission bits are checked).
export const simulatedAcl=()=>SIM_WINDOWS?windowsAcl().options:{};

let nextPid=70000;
export class FakeChild extends EventEmitter{
 pid=nextPid++;stdout=new PassThrough();stderr=new PassThrough();
 // ignoreTerm: survives SIGTERM. stuck: survives every signal (a process that will not stop) until exit() is called.
 signals:string[]=[];done=false;ignoreTerm=false;stuck=false;
 constructor(readonly req:SpawnRequest){super();}
 kill(sig:NodeJS.Signals='SIGTERM'){
  this.signals.push(sig);
  if(!this.stuck&&!(this.ignoreTerm&&sig==='SIGTERM'))setImmediate(()=>this.exit(sig==='SIGKILL'?137:0));
  return true;
 }
 exit(code:number|null){if(this.done)return;this.done=true;this.stdout.end();this.stderr.end();setImmediate(()=>this.emit('exit',code));}
 err(line:string){this.stderr.write(line+'\n');}
 out(line:string){this.stdout.write(line+'\n');}
}

// exes/starts: what the fake system reports for a PID (executable path, start time in ms).
export type FakeHost=ProcessHost&{children:FakeChild[];alive:Set<number>;exes:Map<number,string>;starts:Map<number,number>;signalled:[number,string][]};
export function fakeHost(onSpawn:(c:FakeChild)=>void=()=>{},platform:NodeJS.Platform=SIM_PLATFORM):FakeHost{
 const h:FakeHost={
  platform,children:[],alive:new Set(),exes:new Map(),starts:new Map(),signalled:[],
  spawn:req=>{const c=new FakeChild(req);h.children.push(c);onSpawn(c);return c;}, // write output from onSpawn inside setImmediate
  isAlive:pid=>h.alive.has(pid),
  identityOf:pid=>h.exes.has(pid)||h.starts.has(pid)?{executable:h.exes.get(pid)??null,startedAtMs:h.starts.get(pid)??null}:null,
  signal:(pid,sig)=>{h.signalled.push([pid,sig]);h.alive.delete(pid);},
  sleep:ms=>new Promise(r=>setTimeout(r,Math.min(ms,20))),
  now:()=>Date.now(),
 };
 return h;
}

export const fixture=(name:string)=>readFileSync(path.join(import.meta.dirname,'fixtures',name),'utf8').split('\n').filter(Boolean);
// Bun 1.3.10 on Windows did not wake for a timer the code under test had unref'd when nothing else held its event loop:
// the tunnel start-timeout test sat silent until the 240 s file limit (Windows CI run 39718566836), while the same test
// passes in 0.3 s on macOS. A test that waits only on such a timer holds a referenced one for the wait.
export async function keepAwake<T>(p:Promise<T>):Promise<T>{const t=setInterval(()=>{},20);try{return await p}finally{clearInterval(t)}}
export const until=async(cond:()=>boolean,ms=3000)=>{const end=Date.now()+ms;while(!cond()){if(Date.now()>end)throw new Error('timed out waiting');await new Promise(r=>setTimeout(r,5));}};
// What a register child was given on its standard input (its organiser key and, on the TCP path, its key and certificate).
export type ServiceSecrets={organiserToken:string;tlsKey?:string;tlsCert?:string};
export const secretsOf=(c:FakeChild):ServiceSecrets=>JSON.parse(c.req.input??'null');

// Bun on Windows reads numeric open flags (fs.constants.O_CREAT|O_EXCL…) with its own values, so the settings store
// (@app-patterns/settings, vendored, which opens its files that way) cannot save under the test runner there. The app runs
// the store under Electron's Node, where those flags are right: 'the settings store under Node' in
// settings-changelog.test.ts saves and reads back on every platform, Windows included.
export const settingsWriteTest:typeof test=process.platform==='win32'?test.skip:test;
