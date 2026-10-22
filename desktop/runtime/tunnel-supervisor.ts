// Runs the bundled cloudflared as a quick tunnel (no account; random trycloudflare URL) pointed at the runtime's
// participant gateway, and nothing else:
//   cloudflared tunnel --no-autoupdate --config <empty file> --grace-period 1s --url http://127.0.0.1:<gatewayPort>
// The empty config stops a personal ~/.cloudflared/config.yml from adding ingress rules; the grace period keeps stop
// prompt. Release 1 has no named (remotely managed) tunnel: Cloudflare can push ingress to those that cloudflared
// applies before any log the runtime could watch. See desktop/README-runtime.md.
import {EventEmitter} from 'node:events';
import {existsSync,mkdirSync,renameSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {writeNewPrivateFile} from '../../server/private-path.ts';
import path from 'node:path';
import {type ProcessHost,type ChildLike,type PidFile,pidFileFor,terminateChild,onLines,baseChildEnv} from './process-control.ts';
import {parseCloudflaredLine,FAILURE_TEXT,type TunnelFailure} from './cloudflared-output.ts';

export type TunnelSettings={mode:'off'}|{mode:'quick'};
export type TunnelState=
 |{state:'off'}
 |{state:'starting'}
 |{state:'online';url:string}
 |{state:'reconnecting';attempt:number;url:string|null}
 |{state:'failed';reason:TunnelFailure;message:string};

export class TunnelError extends Error{
 readonly reason:TunnelFailure;
 constructor(reason:TunnelFailure){super(FAILURE_TEXT[reason]);this.reason=reason;}
}

export type TunnelSupervisorOptions={
 host:ProcessHost;cloudflared:string;runDir:string;log?:(line:string)=>void;
 startTimeoutMs?:number;backoffMs?:number[];stableMs?:number;
};

type Run={child:ChildLike;exited:Promise<number|null>;pidfile:PidFile|null;url:string|null;connections:Set<number>;everOnline:boolean;hints:TunnelFailure[];fatal:TunnelFailure|null};

export class TunnelSupervisor extends EventEmitter{
 private o:Required<Omit<TunnelSupervisorOptions,'log'>>&{log:(l:string)=>void};
 private run:Run|null=null;
 private starting=false;
 private targetPort=0;
 private lastUrl:string|null=null;
 private attempt=0;private blips=0;private onlineSince=0;private stopping=false;
 private restartTimer:ReturnType<typeof setTimeout>|null=null;
 private waiter:{resolve:(u:string)=>void;reject:(e:TunnelError)=>void;timer:ReturnType<typeof setTimeout>|null}|null=null;
 state:TunnelState={state:'off'};

 constructor(opts:TunnelSupervisorOptions){
  super();
  this.o={startTimeoutMs:90000,backoffMs:[1000,2000,4000,8000,16000,30000],stableMs:120000,log:()=>{},...opts} as typeof this.o;
 }

 private set(s:TunnelState){this.state=s;this.emit('state',s);}
 private say(line:string){this.o.log(line);}

 // Starts a quick tunnel to 127.0.0.1:<targetPort>. Resolves with the public origin once Cloudflare reports a
 // connection; rejects with a TunnelError. The starting slot is reserved before anything else, so a second start in
 // the same tick is refused.
 async start(settings:TunnelSettings,targetPort:number):Promise<string>{
  if(this.starting||this.run||this.waiter||this.restartTimer)throw new Error('The tunnel is already running. Stop it first.');
  if(settings.mode!=='quick')throw new Error('The tunnel is turned off in Settings.');
  if(!Number.isInteger(targetPort)||targetPort<1||targetPort>65535)throw new Error('Invalid tunnel target port.');
  this.starting=true;
  try{
   this.targetPort=targetPort;this.stopping=false;this.attempt=0;this.lastUrl=null;
   return await new Promise<string>((resolve,reject)=>{
    const timer=setTimeout(()=>this.giveUp(),this.o.startTimeoutMs);(timer as {unref?:()=>void}).unref?.();
    this.waiter={resolve,reject,timer};
    this.set({state:'starting'});
    if(this.waiter)this.spawn();
   });
  }finally{this.starting=false;}
 }

 private emptyConfig(){
  mkdirSync(this.o.runDir,{recursive:true,mode:0o700});
  const file=path.join(this.o.runDir,'cloudflared-empty-config.yml');
  // A fresh file (exclusive, never through a link, 0600 on the descriptor) renamed over the old one.
  const tmp=`${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeNewPrivateFile(tmp,'# Written by AttendWell: no local ingress rules. See desktop/README-runtime.md.\n{}\n',{platform:this.o.host.platform});
  renameSync(tmp,file);
  return file;
 }

 // The exact command line: a quick tunnel to the gateway on loopback, nothing else.
 argsFor(targetPort:number,configFile:string):string[]{
  return ['tunnel','--no-autoupdate','--config',configFile,'--grace-period','1s','--url',`http://127.0.0.1:${targetPort}`];
 }

 private spawn(){
  if(!existsSync(this.o.cloudflared))return this.finish('cloudflared-missing');
  const env=baseChildEnv(this.o.host.platform);
  let child:ChildLike;
  try{child=this.o.host.spawn({command:this.o.cloudflared,args:this.argsFor(this.targetPort,this.emptyConfig()),env})}
  catch{return this.finish('cloudflared-missing')}
  let resolveExit!:(c:number|null)=>void;
  const pidfile=child.pid?pidFileFor(this.o.runDir,'cloudflared',child.pid):null;
  const run:Run={child,exited:new Promise(r=>{resolveExit=r}),pidfile,url:null,connections:new Set(),everOnline:false,hints:[],fatal:null};
  child.once('exit',(code:number|null)=>resolveExit(code));
  child.once('error',(err:NodeJS.ErrnoException)=>{if(err?.code==='ENOENT'||err?.code==='EACCES')run.fatal='cloudflared-missing';resolveExit(null);});
  this.run=run;
  pidfile?.write({pid:child.pid!,executable:this.o.cloudflared,startedAt:new Date(this.o.host.now()).toISOString()});
  const handle=(line:string)=>{this.say(line);if(this.run===run)this.onLine(run,line);};
  onLines(child.stdout,handle);onLines(child.stderr,handle);
  run.exited.then(code=>this.onExit(run,code));
 }

 private onLine(run:Run,line:string){
  if(this.stopping)return; // shutdown chatter (unregistering connections) is not a reconnect
  const ev=parseCloudflaredLine(line);if(!ev)return;
  switch(ev.kind){
   case 'quick-url':if(!run.url)run.url=ev.url;break;
   case 'connected':run.connections.add(ev.connIndex);break;
   case 'disconnected':
    if(ev.connIndex===null)run.connections.clear();else run.connections.delete(ev.connIndex);
    if(run.everOnline&&!run.connections.size&&this.state.state==='online')this.set({state:'reconnecting',attempt:++this.blips,url:run.url});
    break;
   case 'problem':
    if(ev.fatal&&!run.everOnline){run.fatal=ev.failure;void this.killRun(run);return;}
    if(ev.fatal&&ev.failure==='tunnel-refused'){run.fatal=ev.failure;void this.killRun(run);return;}
    run.hints.push(ev.failure);
    break;
  }
  this.maybeOnline(run);
 }

 private maybeOnline(run:Run){
  if(this.run!==run||run.fatal||!run.url||!run.connections.size)return;
  if(this.state.state==='online'&&this.state.url===run.url)return;
  run.everOnline=true;this.onlineSince=this.o.host.now();this.blips=0;
  const previous=this.lastUrl;this.lastUrl=run.url;
  this.set({state:'online',url:run.url});
  if(this.waiter){const w=this.waiter;this.waiter=null;if(w.timer)clearTimeout(w.timer);w.resolve(run.url);}
  else if(previous&&previous!==run.url)this.emit('origin-changed',{previous,current:run.url});
 }

 private async killRun(run:Run){await terminateChild(run.child,run.exited,this.o.host);}

 private onExit(run:Run,code:number|null){
  if(this.run!==run)return;
  this.run=null;run.pidfile?.clear();
  if(this.stopping)return;
  if(run.fatal&&run.fatal!=='no-internet'&&run.fatal!=='blocked-by-network')return this.finish(run.fatal);
  if(this.waiter&&!run.everOnline)return this.finish(run.fatal??run.hints.at(-1)??'stopped-unexpectedly');
  // It was online and stopped: reconnect by restarting it, with backoff. A quick tunnel comes back with a new URL.
  this.say(`The tunnel stopped (exit ${code}); restarting.`);
  if(this.o.host.now()-this.onlineSince>=this.o.stableMs)this.attempt=0;
  if(this.attempt>=this.o.backoffMs.length)return this.finish(run.hints.at(-1)??'stopped-unexpectedly');
  const delay=this.o.backoffMs[this.attempt++];
  this.set({state:'reconnecting',attempt:this.attempt,url:null});
  this.restartTimer=setTimeout(()=>{this.restartTimer=null;if(!this.stopping)this.spawn();},delay);
  (this.restartTimer as {unref?:()=>void}).unref?.();
 }

 private giveUp(){
  if(!this.waiter)return;
  const run=this.run;
  const reason=run?.fatal??run?.hints.at(-1)??'blocked-by-network';
  if(run){run.fatal=reason;void this.killRun(run);}
  else this.finish(reason);
 }

 private finish(reason:TunnelFailure){
  if(this.restartTimer){clearTimeout(this.restartTimer);this.restartTimer=null;}
  this.set({state:'failed',reason,message:FAILURE_TEXT[reason]});
  if(this.waiter){const w=this.waiter;this.waiter=null;if(w.timer)clearTimeout(w.timer);w.reject(new TunnelError(reason));}
 }

 // Stops cloudflared and waits for its exit. Afterwards nothing of ours forwards public traffic.
 async stop():Promise<{stopped:boolean}>{
  this.stopping=true;
  if(this.restartTimer){clearTimeout(this.restartTimer);this.restartTimer=null;}
  const run=this.run;let stopped=true;
  if(run){stopped=await terminateChild(run.child,run.exited,this.o.host);if(stopped&&this.run===run){this.run=null;run.pidfile?.clear();}}
  if(this.waiter){const w=this.waiter;this.waiter=null;if(w.timer)clearTimeout(w.timer);w.reject(new TunnelError('stopped-unexpectedly'));}
  this.set({state:'off'});
  return {stopped};
 }

 get url(){return this.state.state==='online'?this.state.url:null}
 get pid(){return this.run?.child.pid??null}
}
