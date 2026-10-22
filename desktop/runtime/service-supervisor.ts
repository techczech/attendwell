// Runs the compiled attendance service (the sidecar) for one workshop: loopback ports only, health-checked,
// restarted with backoff after a crash, stopped cleanly, and never two at once. Each child gets a pidfile in the run
// folder; the runtime resolves pidfiles left by an earlier run (reconcileOrphans) before any session starts.
import {EventEmitter} from 'node:events';
import {existsSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import type {WorkshopPaths} from './workshops-library.ts';
import {type ProcessHost,type ChildLike,type PidFile,pidFileFor,terminateChild,onLines,baseChildEnv,loopbackStatus,newParticipantSocket,removeSocketFile} from './process-control.ts';
import type {Upstream} from './participant-gateway.ts';
import {createParticipantTls,participantTlsSecrets,pinnedStatus,type ParticipantTls} from './participant-tls.ts';

// participantPort: the register's participant listener on Windows (loopback TCP, HTTPS with a certificate made for each
// spawn and pinned by the gateway). On macOS the supervisor gives each register a fresh Unix socket in a private folder
// instead (socketDir). Only the gateway knows either; cloudflared never.
// hostSecretPath: the laptop's long-lived host secret (see workshops-library.ts); its contents are never read here.
export type ServiceLaunch={paths:WorkshopPaths;organiserPort:number;participantPort:number;participantOrigin:string|null;hostSecretPath?:string};
export type ServiceFailure='sidecar-missing'|'port-in-use'|'will-not-start'|'kept-crashing'|'will-not-stop';
export const SERVICE_FAILURE_TEXT:Record<ServiceFailure,string>={
 'sidecar-missing':'The register program is missing from this copy of AttendWell. Reinstall AttendWell.',
 'port-in-use':'Another program is using the port AttendWell needs. Quit it, or restart the computer, and try again.',
 'will-not-start':'The register would not start for this workshop.',
 'kept-crashing':'The register kept stopping, so AttendWell stopped restarting it.',
 'will-not-stop':'The register program did not stop. AttendWell will not start this register again until it has. Try again in a moment, or restart the computer.',
};
export type ServiceState=
 |{state:'off'}
 |{state:'starting'}
 |{state:'running';organiserUrl:string;participant:Upstream|null;participantOrigin:string|null}
 |{state:'restarting';attempt:number}
 |{state:'failed';reason:ServiceFailure;message:string;detail?:string};

type Outcome={ok:true}|{ok:false;reason:ServiceFailure;detail?:string};

export type ServiceSupervisorOptions={
 host:ProcessHost;sidecar:string;assets:string;runDir:string;log?:(line:string)=>void;
 // macOS: the private folder for the participant listener's Unix socket, asked for at each spawn. Absent or
 // returning null: loopback TCP with a pinned certificate (Windows, or macOS when forced).
 socketDir?:()=>string|null;
 // Makes the key pair and certificate for one spawn on the TCP path. Test seam; default participant-tls.ts.
 participantTls?:()=>ParticipantTls;
 healthTimeoutMs?:number;backoffMs?:number[];stableMs?:number;
 // Default: organiser API answers 200 on loopback (with this spawn's organiser key); participant listener (when on) answers at all.
 probe?:(launch:ServiceLaunch,participant:Upstream|null,bearer:string)=>Promise<boolean>;
};

// The organiser listener's key for one register spawn: 32 random bytes, base64url. Given to the register on its standard
// input (serviceSecrets) and to the app's organiser client; never in its environment, logged or in a snapshot.
export const newOrganiserBearer=()=>randomBytes(32).toString('base64url');

export const defaultServiceProbe=async(l:ServiceLaunch,participant:Upstream|null,bearer:string)=>{
 if(await loopbackStatus(l.organiserPort,'/api/check-in-window',`127.0.0.1:${l.organiserPort}`,2000,bearer)!==200)return false;
 if(!l.participantOrigin||!participant)return true;
 const host=new URL(l.participantOrigin).host;
 const s='socketPath' in participant?await loopbackStatus(participant,'/check-in',host):await pinnedStatus(participant,'/check-in',host);
 return s>0&&s<500;
};

// `participant`: where this register's participant listener must listen (a Unix socket path, or a loopback port with
// `tls`, the key and certificate for this spawn; a TCP participant listener is never started without them).
// The environment holds paths and ports only. ATTENDANCE_SECRETS=stdin tells the register to read its secrets from its
// standard input (serviceSecrets) before it binds anything, and to refuse to start without them.
export function serviceEnv(o:{assets:string;platform:NodeJS.Platform},l:ServiceLaunch,participant:Upstream|null,tls:ParticipantTls|null=null):Record<string,string>{
 const env:Record<string,string>={...baseChildEnv(o.platform),
  ATTENDANCE_CONFIG_PATH:l.paths.serviceFile,ATTENDANCE_DATABASE_PATH:l.paths.database,ATTENDANCE_WORKSHOP_PATH:l.paths.workshopFile,
  ATTENDANCE_ASSETS_PATH:o.assets,ATTENDANCE_BIND:'127.0.0.1',ATTENDANCE_LISTEN_PORT:String(l.organiserPort),ATTENDANCE_DATA_ROOT:l.paths.root,
  ATTENDANCE_SECRETS:'stdin'};
 if(l.hostSecretPath)env.ATTENDANCE_HOST_SECRET_PATH=l.hostSecretPath;
 if(l.participantOrigin&&participant){
  env.ATTENDANCE_PARTICIPANT_ORIGIN=l.participantOrigin;
  if('socketPath' in participant)env.ATTENDANCE_PARTICIPANT_SOCKET=participant.socketPath;
  else{
   if(!tls||tls.fingerprint!==participant.fingerprint)throw new Error('A TCP participant listener needs its own certificate.');
   env.ATTENDANCE_PARTICIPANT_PORT=String(participant.port);
  }
 }
 return env;
}

// The one line the register reads on its standard input: its organiser key and, for a TCP participant listener, its key
// and certificate (see server/start-attendance.ts). Never logged.
export function serviceSecrets(l:ServiceLaunch,participant:Upstream|null,tls:ParticipantTls|null,bearer:string):string{
 if(!/^[A-Za-z0-9_-]{43}$/.test(bearer))throw new Error('The organiser key must be 32 bytes.');
 const tcp=!!l.participantOrigin&&!!participant&&!('socketPath' in participant);
 if(tcp&&(!tls||tls.fingerprint!==(participant as {fingerprint:string}).fingerprint))throw new Error('A TCP participant listener needs its own certificate.');
 return JSON.stringify({organiserToken:bearer,...(tcp?participantTlsSecrets(tls!):{})})+'\n';
}

// Events: 'state' (ServiceState) on every change; 'upstream' (Upstream|null), emitted synchronously, is where the gateway
// may forward: set when the register is healthy, null before any signal is sent to it and the moment its exit is seen.
export class ServiceSupervisor extends EventEmitter{
 private o:Required<Omit<ServiceSupervisorOptions,'log'>>&{log:(l:string)=>void};
 private pidfile:PidFile|null=null;
 private child:ChildLike|null=null;private exited:Promise<number|null>|null=null;
 private launch:ServiceLaunch|null=null;
 private restartTimer:ReturnType<typeof setTimeout>|null=null;
 private attempt=0;private healthySince=0;private stopping=false;private busy:Promise<void>|null=null;
 private tail:string[]=[];
 // The organiser key of the register now running (or starting); null when none. Never part of `state`.
 private bearer:string|null=null;
 state:ServiceState={state:'off'};

 constructor(opts:ServiceSupervisorOptions){
  super();
  this.o={healthTimeoutMs:20000,backoffMs:[500,1000,2000,4000,8000,16000,30000],stableMs:60000,probe:defaultServiceProbe,log:()=>{},socketDir:()=>null,participantTls:createParticipantTls,...opts} as typeof this.o;
 }

 private set(s:ServiceState){this.state=s;this.emit('state',s);}
 private forwardTo(u:Upstream|null){this.emit('upstream',u);}
 private say(l:string){this.tail.push(l);if(this.tail.length>40)this.tail.shift();this.o.log(l);}

 // Starts the service for `launch`. Resolves once it answers health checks; rejects (state failed) otherwise.
 async start(launch:ServiceLaunch):Promise<void>{
  // The busy slot is taken before anything else, so a second start in the same tick is refused.
  if(this.busy||this.child||this.restartTimer)throw new Error('The register is already running. Stop it first.');
  this.stopping=false;this.attempt=0;this.launch=launch;
  let release!:()=>void;this.busy=new Promise<void>(r=>{release=r});
  let outcome:Outcome;
  try{this.set({state:'starting'});outcome=await this.spawnAndWait()}
  catch(e){outcome={ok:false,reason:'will-not-start',detail:(e as Error).message}}
  finally{this.busy=null;release();}
  if(this.stopping)return;
  if(!outcome.ok){this.fail(outcome.reason,outcome.detail);throw Object.assign(new Error(SERVICE_FAILURE_TEXT[outcome.reason]),{reason:outcome.reason});}
 }

 private fail(reason:ServiceFailure,detail?:string){this.set({state:'failed',reason,message:SERVICE_FAILURE_TEXT[reason],...(detail?{detail}:{})});}

 private async spawnAndWait():Promise<Outcome>{
  const l=this.launch!;
  if(!existsSync(this.o.sidecar))return {ok:false,reason:'sidecar-missing'};
  this.tail=[];
  // A fresh socket per register (macOS), so a restarted register never shares a path with an earlier one. On the TCP
  // path a fresh key pair and certificate per register, so the gateway's pin names this spawn and no earlier one.
  const dir=l.participantOrigin?this.o.socketDir?.()??null:null;
  const tls=l.participantOrigin&&!dir?this.o.participantTls():null;
  const participant:Upstream|null=!l.participantOrigin?null:dir?{socketPath:newParticipantSocket(dir)}:{port:l.participantPort,fingerprint:tls!.fingerprint};
  const bearer=newOrganiserBearer();
  let env:Record<string,string>,input:string;
  try{env=serviceEnv({assets:this.o.assets,platform:this.o.host.platform},l,participant,tls);input=serviceSecrets(l,participant,tls,bearer)}
  catch(e){return {ok:false,reason:'will-not-start',detail:(e as Error).message}}
  let child:ChildLike;
  try{child=this.o.host.spawn({command:this.o.sidecar,args:[],env,input})}
  catch{return {ok:false,reason:'sidecar-missing'}}
  this.child=child;this.bearer=bearer;
  let exitedNow=false;
  // First thing on exit, before anything awaits: the gateway stops forwarding to this register.
  const gone=()=>{if(exitedNow)return;exitedNow=true;if(this.child===child)this.forwardTo(null);if(participant&&'socketPath' in participant)removeSocketFile(participant.socketPath);};
  const exited=this.exited=new Promise<number|null>(res=>{
   child.once('exit',(code:number|null)=>{gone();res(code)});
   child.once('error',()=>{gone();res(null)});
  });
  onLines(child.stdout,s=>this.say(s));onLines(child.stderr,s=>this.say(s));
  const pidfile=this.pidfile=child.pid?pidFileFor(this.o.runDir,'service',child.pid):null;
  pidfile?.write({pid:child.pid!,executable:this.o.sidecar,startedAt:new Date(this.o.host.now()).toISOString()});
  const deadline=this.o.host.now()+this.o.healthTimeoutMs;
  while(!exitedNow&&!this.stopping&&this.o.host.now()<deadline){
   if(await this.o.probe(l,participant,bearer)&&!exitedNow&&!this.stopping){
    this.healthySince=this.o.host.now();
    this.forwardTo(participant);
    this.set({state:'running',organiserUrl:`http://127.0.0.1:${l.organiserPort}`,participant,participantOrigin:l.participantOrigin});
    exited.then(code=>this.onExit(child,code));
    return {ok:true};
   }
   await this.o.host.sleep(150);
  }
  // Did not become healthy (or a stop arrived): end it, then report why. The wait is bounded (terminateChild: SIGTERM,
  // then SIGKILL and a last wait). A child that survives it stays recorded (child, pidfile; holdsProcess) and is
  // reported as will-not-stop, so start, stop, the runtime's lifecycle queue and shutdown never wait on it forever.
  if(!exitedNow){if(this.child===child)this.forwardTo(null);
   if(!await terminateChild(child,exited,this.o.host)){
    exited.then(()=>this.onHeldExit(child));
    return {ok:false,reason:'will-not-stop',detail:this.tail.slice(-3).join(' ').slice(0,500)||undefined};
   }
  }
  await exited;
  if(this.child===child){this.child=null;this.bearer=null;pidfile?.clear();}
  const out=this.tail.join('\n');
  return {ok:false,reason:/EADDRINUSE|address already in use|port \d+ in use|Is port \d+ in use/i.test(out)?'port-in-use':'will-not-start',detail:this.tail.slice(-3).join(' ').slice(0,500)||undefined};
 }

 // A crash after the service was healthy: restart with backoff; a failed restart counts as another crash.
 private onExit(child:ChildLike,code:number|null){
  if(child!==this.child)return;
  this.child=null;this.bearer=null;this.pidfile?.clear();
  // A register that would not stop has now exited: nothing is left running.
  if(this.stopping){if(this.state.state==='failed'&&this.state.reason==='will-not-stop')this.set({state:'off'});return;}
  this.say(`The register stopped unexpectedly (exit ${code}).`);
  if(this.o.host.now()-this.healthySince>=this.o.stableMs)this.attempt=0;
  this.scheduleRestart();
 }

 // A child that would not stop during a start has now exited: nothing is left running.
 private onHeldExit(child:ChildLike){
  if(child!==this.child)return;
  this.child=null;this.bearer=null;this.pidfile?.clear();
  if(this.state.state==='failed'&&this.state.reason==='will-not-stop')this.set({state:'off'});
 }
 private scheduleRestart(detail?:string){
  if(this.attempt>=this.o.backoffMs.length)return this.fail('kept-crashing',detail??(this.tail.slice(-3).join(' ').slice(0,500)||undefined));
  const delay=this.o.backoffMs[this.attempt++];
  this.set({state:'restarting',attempt:this.attempt});
  this.restartTimer=setTimeout(async()=>{
   this.restartTimer=null;if(this.stopping)return;
   const run=this.spawnAndWait();this.busy=run.then(()=>{});
   let outcome:Outcome;try{outcome=await run}finally{this.busy=null}
   if(this.stopping||outcome.ok)return;
   if(outcome.reason==='sidecar-missing'||outcome.reason==='will-not-stop')return this.fail(outcome.reason,outcome.detail);
   this.scheduleRestart(outcome.detail);
  },delay);
  (this.restartTimer as {unref?:()=>void}).unref?.();
 }

 // Stops the service and waits until its process has exited. Safe to call in any state.
 async stop():Promise<{stopped:boolean}>{
  this.stopping=true;
  // Before any signal: the gateway answers 503 from here on.
  this.forwardTo(null);
  if(this.restartTimer){clearTimeout(this.restartTimer);this.restartTimer=null;}
  const child=this.child,exited=this.exited;
  let stopped=true;
  if(child&&exited)stopped=await terminateChild(child,exited,this.o.host);
  if(this.busy)await this.busy.catch(()=>{});
  // A spawn that was in flight when the stop arrived has ended itself (spawnAndWait checks `stopping`).
  if(stopped){this.child=null;this.pidfile?.clear();}
  this.bearer=null;
  this.launch=null;
  // A child that did not exit stays recorded (child, pidfile): `holdsProcess` stays true and start() refuses until its
  // exit is seen, or a later stop() confirms it.
  stopped=stopped&&!this.child;
  this.set(stopped?{state:'off'}:{state:'failed',reason:'will-not-stop',message:SERVICE_FAILURE_TEXT['will-not-stop']});
  return {stopped};
 }

 // True while a register process this supervisor spawned has not been seen to exit (also after a stop that failed).
 get holdsProcess(){return this.child!==null}

 get current(){return this.launch}
 get pid(){return this.child?.pid??null}
 // The running register's organiser key, only while it is running (for the app's organiser client and the runtime's own reads).
 get organiserBearer():string|null{return this.state.state==='running'?this.bearer:null}
}
