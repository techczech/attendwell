// The one interface the AttendWell windows use. See desktop/README-runtime.md.
import {EventEmitter} from 'node:events';
import path from 'node:path';
import {rmdirSync} from 'node:fs';
import {createWorkshopsLibrary,type WorkshopsLibrary,type WorkshopRecord,type AttendedCounter} from './workshops-library.ts';
import {ServiceSupervisor,type ServiceState,type ServiceLaunch} from './service-supervisor.ts';
import {TunnelSupervisor,type TunnelSettings,type TunnelState,TunnelError} from './tunnel-supervisor.ts';
import {probeAddress,noAddressResult,type ConnectionTestResult} from './connection-test.ts';
import {createParticipantGateway,type Upstream} from './participant-gateway.ts';
import type {ParticipantTls} from './participant-tls.ts';
import {nodeProcessHost,freeLoopbackPort,portAcceptsConnections,socketAcceptsConnections,loopbackJson,reconcileOrphans,checkRunDir,participantSocketDir,type ProcessHost} from './process-control.ts';
import {resourcePaths,platformKey} from './platform.ts';
import {batchProbeFrom,type AclProbe,type AclBatchProbe,type AclProtector,type FsHooks} from '../../server/private-path.ts';

export type RuntimeSettings={tunnel:TunnelSettings};
// orphans: plain-words notes about processes from an earlier run that AttendWell could not confirm or stop.
export type RuntimeSnapshot={workshopId:string|null;session:'idle'|'starting'|'running'|'ending';service:ServiceState;tunnel:TunnelState;orphans:string[]};
export type OriginChange={workshopId:string;previous:string;current:string};
export type StopReport={clean:boolean;leftovers:string[]};
// A register opened on this computer only (no gateway, no tunnel), for adding names and importing recovery files outside a
// session. `live`: the session's own register (its check-in is open), which the lease does not own and never stops.
export type RegisterLeaseInfo={organiserUrl:string;leaseId:number|null;live:boolean};
export type RuntimeOptions={
 dataRoot:string;resourcesRoot:string;settings:RuntimeSettings;
 // Optional seams for tests and for the packaging parcel.
 host?:ProcessHost;sidecar?:string;assets?:string;cloudflared?:string;now?:()=>Date;
 aclProbe?:AclProbe;aclBatchProbe?:AclBatchProbe;aclProtect?:AclProtector;countAttended?:AttendedCounter;fsHooks?:FsHooks;
 // How the gateway reaches the register's participant listener. 'auto': a Unix socket on macOS, loopback TCP with a
 // pinned certificate on Windows. 'tcp-tls': the Windows path on any platform (tests and the headless check on macOS).
 participantTransport?:'auto'|'tcp-tls';participantTls?:()=>ParticipantTls;
 // Test connection: how the probe reaches the public address, and how long it may take.
 connectionFetch?:typeof fetch;connectionTimeoutMs?:number;
 log?:(line:string)=>void;tunnelStartTimeoutMs?:number;serviceProbe?:(l:ServiceLaunch,participant:Upstream|null)=>Promise<boolean>;serviceBackoffMs?:number[];tunnelBackoffMs?:number[];
};

// Events on `status`:
//   'change'                    RuntimeSnapshot   every state change of the session, the register or the tunnel
//   'participant-origin-changed' OriginChange     a restarted quick tunnel has a new address: paired devices must re-pair
//   'log'                       string            one line from the register or the tunnel
export type RuntimeStatus=EventEmitter&{get:()=>RuntimeSnapshot};

const SHUTTING_DOWN='AttendWell is shutting down.';
const LEASE_NOT_STOPPED='The register opened for the name list has not stopped yet, so AttendWell will not open another register on it. Try again in a moment, or restart the computer.';
const SESSION_NOT_STOPPED='The register from the last check-in has not stopped yet, so AttendWell will not open another register on it. Try again in a moment, or restart the computer.';
const SETTINGS_REFUSED='This release supports the quick tunnel only. Own-domain tunnels return in a later release.';
const settingsOk=(s:RuntimeSettings)=>s?.tunnel?.mode==='quick'||s?.tunnel?.mode==='off';
const validSettings=(s:RuntimeSettings)=>{if(!settingsOk(s))throw new Error(SETTINGS_REFUSED);return {tunnel:{mode:s.tunnel.mode}} as RuntimeSettings;};

export function createRuntime(opts:RuntimeOptions){
 const host=opts.host??nodeProcessHost;
 // Settings the runtime cannot use do not stop it from being created (the orphan check below must always run);
 // startSession refuses them in plain words instead.
 let settings:RuntimeSettings|null=settingsOk(opts.settings)?validSettings(opts.settings):null;
 // The bundled programs for this computer, unless all three are given (tests that simulate another platform pass them).
 const res=opts.sidecar&&opts.cloudflared&&opts.assets?{sidecar:opts.sidecar,cloudflared:opts.cloudflared,assets:opts.assets}:resourcePaths(opts.resourcesRoot,platformKey(host.platform));
 const dataRoot=path.resolve(opts.dataRoot);
 const runDir=path.join(dataRoot,'run');
 // The programs this runtime starts. Orphans from an earlier run are matched against these paths only, never against
 // a path read from a pidfile.
 const sidecar=opts.sidecar??res.sidecar,cloudflared=opts.cloudflared??res.cloudflared;
 const aclBatchProbe=opts.aclBatchProbe??(opts.aclProbe?batchProbeFrom(opts.aclProbe):undefined);
 const runDirOptions={dataRoot,runDir,platform:host.platform,aclBatchProbe};
 const workshops:WorkshopsLibrary=createWorkshopsLibrary({dataRoot:opts.dataRoot,platform:host.platform,aclProbe:opts.aclProbe,aclBatchProbe:opts.aclBatchProbe,aclProtect:opts.aclProtect,now:opts.now,countAttended:opts.countAttended,fsHooks:opts.fsHooks});
 const status=new EventEmitter() as RuntimeStatus;
 const log=(line:string)=>{opts.log?.(line);status.emit('log',line);};

 // macOS: the register's participant listener is a Unix socket in a private folder (see participant-gateway.ts).
 // Windows (or participantTransport 'tcp-tls'): loopback TCP with TLS pinned per spawn. The folder is chosen at the
 // first session start.
 let socketDir:{dir:string;owned:boolean}|null=null;
 const transport=opts.participantTransport??'auto';
 if(transport!=='auto'&&transport!=='tcp-tls')throw new Error('Unknown participant transport.');
 const sockets=host.platform!=='win32'&&transport==='auto';
 // A second supervisor for register leases: loopback organiser listener only, no participant listener, never connected to
 // the gateway. A lease and a session never run on the same workshop (startSession stops a lease on its workshop first,
 // and openRegister on the live workshop returns the session's own register); both run through the one queue below.
 // Never two register processes on one register file: a lease, and the session's register, stay recorded until their
 // process has been seen to exit. A stop that fails leaves the record (lease.stuck, serviceWorkshop), and every start on
 // that workshop tries the stop again and refuses in plain words until it succeeds.
 const leaseService=new ServiceSupervisor({host,sidecar,assets:opts.assets??res.assets,runDir,log,socketDir:()=>null,...(opts.serviceProbe?{probe:opts.serviceProbe}:{}),...(opts.serviceBackoffMs?{backoffMs:opts.serviceBackoffMs}:{})});
 let lease:{id:string;n:number;launch:ServiceLaunch;stuck:boolean}|null=null;
 let leaseN=0;
 const service=new ServiceSupervisor({host,sidecar,assets:opts.assets??res.assets,runDir,log,socketDir:()=>sockets?(socketDir??=participantSocketDir(runDir)).dir:null,...(opts.participantTls?{participantTls:opts.participantTls}:{}),...(opts.serviceProbe?{probe:opts.serviceProbe}:{}),...(opts.serviceBackoffMs?{backoffMs:opts.serviceBackoffMs}:{})});
 const tunnel=new TunnelSupervisor({host,cloudflared,runDir,log,...(opts.tunnelStartTimeoutMs?{startTimeoutMs:opts.tunnelStartTimeoutMs}:{}),...(opts.tunnelBackoffMs?{backoffMs:opts.tunnelBackoffMs}:{})});
 // cloudflared points only at the gateway, which forwards to the register's participant listener while it runs.
 const gateway=createParticipantGateway();

 let active:WorkshopRecord|null=null;
 let session:RuntimeSnapshot['session']='idle';
 let launch:ServiceLaunch|null=null;
 // The workshop whose register the session supervisor started, until that process is confirmed gone.
 let serviceWorkshop:string|null=null;
 let disposed=false;
 let orphans:string[]=[];
 const snapshot=():RuntimeSnapshot=>({workshopId:active?.id??null,session,service:service.state,tunnel:tunnel.state,orphans:[...orphans]});
 status.get=snapshot;
 const changed=()=>status.emit('change',snapshot());
 // The gateway forwards only to the register child the supervisor says is live. The supervisor emits this
 // synchronously: null before it signals the register and the moment the register's exit is seen.
 let lastParticipant:Upstream|null=null;
 service.on('upstream',(u:Upstream|null)=>{gateway.setUpstream(u);if(u)lastParticipant=u;});
 service.on('state',changed);
 tunnel.on('state',changed);
 // Test connection: at most one probe at a time (repeated calls share it). It never joins the lifecycle queue and never
 // touches the register, the tunnel or the pairing; a changed address or an ended session only cancels it.
 let probing:Promise<ConnectionTestResult>|null=null;
 let cancelProbe:(()=>void)|null=null;
 tunnel.on('state',(t:TunnelState)=>{if(t.state!=='online')cancelProbe?.();});
 tunnel.on('origin-changed',()=>cancelProbe?.());

 // One queue for every lifecycle operation: start, retry, end, shutdown, and the restart after a new quick-tunnel
 // address. Each runs only after the previous one has finished, so no two of them start or stop children at once.
 let queue:Promise<unknown>=Promise.resolve();
 const serial=<T>(fn:()=>Promise<T>):Promise<T>=>{const run=queue.then(fn,fn);queue=run.catch(()=>{});return run;};
 const alive=()=>{if(disposed)throw new Error(SHUTTING_DOWN);};

 // Before any session: resolve pidfiles left by a crashed or force-quit run, whatever the tunnel setting.
 // The run folder is checked (no links, inside the data root, private) before any record in it is read.
 void serial(async()=>{
  const r=await reconcileOrphans(host,{...runDirOptions,executables:{service:sidecar,cloudflared}});
  for(const line of [...r.killed,...r.ignored])log(line);
  orphans=r.unresolved;
  if(r.killed.length||r.unresolved.length)changed();
 });

 // A restarted quick tunnel has a new address. The participant listener only answers its exact origin,
 // so the register restarts on the same ports with the new origin, and the UI is told to re-pair devices.
 tunnel.on('origin-changed',({previous,current}:{previous:string;current:string})=>{
  void serial(async()=>{
   if(disposed||!launch||session!=='running'||!active)return;
   launch={...launch,participantOrigin:current};
   await service.stop();
   try{await service.start(launch)}catch{}
   status.emit('participant-origin-changed',{workshopId:active.id,previous,current} satisfies OriginChange);
  });
 });

 async function startTunnel():Promise<string|null>{
  const t=settings?.tunnel;
  if(t?.mode!=='quick')return null;
  // The gateway is bound before cloudflared starts and stays bound until the session ends.
  const port=await gateway.start();
  alive();
  try{return await tunnel.start(t,port)}
  catch(e){if(e instanceof TunnelError)return null;throw e;}
 }

 async function verifyStopped(l:ServiceLaunch|null,gatewayPort:number|null,serviceStopped:boolean,tunnelStopped:boolean):Promise<StopReport>{
  const leftovers:string[]=[];
  if(!tunnelStopped||tunnel.pid)leftovers.push('The tunnel program did not stop.');
  if(!serviceStopped||service.pid)leftovers.push('The register program did not stop.');
  if(gatewayPort!==null&&await portAcceptsConnections(gatewayPort,500))leftovers.push(`Something still listens on the gateway port ${gatewayPort}.`);
  if(l){
   const p=lastParticipant;
   if(p&&'socketPath' in p){if(await socketAcceptsConnections(p.socketPath,500))leftovers.push('Something still listens on the register\'s participant socket.');}
   else if(await portAcceptsConnections(l.participantPort,500))leftovers.push(`Something still listens on the participant port ${l.participantPort}.`);
   if(await portAcceptsConnections(l.organiserPort,500))leftovers.push(`Something still listens on the organiser port ${l.organiserPort}.`);
  }
  return {clean:!leftovers.length,leftovers};
 }

 // Public path first: the tunnel stops before the register, the gateway after it. Then checks nothing is left.
 async function end():Promise<StopReport>{
  const l=launch;const gatewayPort=gateway.port;
  if(session==='idle'&&!l){
   const t=await tunnel.stop(),s=await service.stop();await gateway.close();
   if(!service.holdsProcess)serviceWorkshop=null;
   return verifyStopped(null,gatewayPort,s.stopped,t.stopped);
  }
  session='ending';changed();
  cancelProbe?.();
  const t=await tunnel.stop();
  if(l&&active&&service.state.state==='running'){
   const roster=await loopbackJson(l.organiserPort,'/api/roster',`127.0.0.1:${l.organiserPort}`,3000,service.organiserBearer??undefined) as {participants?:{present?:boolean}[]}|null;
   if(Array.isArray(roster?.participants))try{workshops.recordAttendedCount(active.id,roster.participants.filter(p=>p.present).length)}catch{}
  }
  const s=await service.stop();
  if(!service.holdsProcess)serviceWorkshop=null;
  await gateway.close();
  launch=null;session='idle';changed();
  return verifyStopped(l,gatewayPort,s.stopped,t.stopped);
 }

 // Stops a leased register (if any) and confirms its organiser port refuses connections. The lease is forgotten only once
 // its process has been seen to exit; otherwise it stays recorded as stuck.
 async function stopLease():Promise<StopReport>{
  const l=lease;
  const s=await leaseService.stop();
  const gone=s.stopped&&!leaseService.holdsProcess;
  if(l)lease=gone?null:{...l,stuck:true};
  const leftovers:string[]=[];
  if(!gone)leftovers.push('The register program opened for the name list did not stop.');
  if(l&&await portAcceptsConnections(l.launch.organiserPort,500))leftovers.push(`Something still listens on the organiser port ${l.launch.organiserPort}.`);
  return {clean:!leftovers.length,leftovers};
 }

 // After a session stop that failed: tries the stop again. True once no register of an earlier session is running.
 async function sessionRegisterGone():Promise<boolean>{
  if(service.holdsProcess){const s=await service.stop();if(!s.stopped||service.holdsProcess)return false;}
  serviceWorkshop=null;return true;
 }

 const api={
  workshops,
  status,
  // Chooses the workshop the next session runs. Refused while a session runs for another workshop.
  openWorkshop(id:string):WorkshopRecord{
   if(session!=='idle'&&active?.id!==id)throw new Error('End the current session before opening another workshop.');
   active=workshops.get(id);changed();return active;
  },
  // Gateway, then tunnel (to learn the public origin), then the register with that origin. If the tunnel cannot start,
  // the register still runs for the organiser on this computer, and the snapshot carries the tunnel's failure.
  startSession():Promise<RuntimeSnapshot>{
   if(disposed)return Promise.reject(new Error(SHUTTING_DOWN));
   return serial(async()=>{
    alive();
    if(!active)throw new Error('Open a workshop first.');
    if(!settings)throw new Error(SETTINGS_REFUSED);
    if(session!=='idle')return snapshot();
    if(!await sessionRegisterGone())throw new Error(SESSION_NOT_STOPPED);
    alive();
    session='starting';changed();
    try{
     const organiserPort=await freeLoopbackPort();
     let participantPort=await freeLoopbackPort();
     while(participantPort===organiserPort)participantPort=await freeLoopbackPort();
     alive();
     // Never two registers on one file: a register this workshop's name list opened is stopped first.
     if(lease?.id===active.id){const r=await stopLease();if(!r.clean)throw new Error(lease?LEASE_NOT_STOPPED:'The register opened for the name list did not stop. Try again.');}
     alive();
     const paths=workshops.prepareService(active.id,organiserPort);
     const hostSecretPath=workshops.hostSecretPath();
     checkRunDir(runDirOptions,true);
     const origin=await startTunnel();
     alive();
     launch={paths,organiserPort,participantPort,participantOrigin:origin,hostSecretPath};
     serviceWorkshop=active.id;
     await service.start(launch);
     alive();
     session='running';changed();
     return snapshot();
    }catch(e){
     await tunnel.stop().catch(()=>{});await service.stop().catch(()=>{});await gateway.close().catch(()=>{});
     if(!service.holdsProcess)serviceWorkshop=null;
     const failedService=service.state;
     session='idle';launch=null;changed();
     throw Object.assign(new Error((e as Error).message),{service:failedService});
    }
   });
  },
  // Tries the tunnel again after a failure, without stopping the register. Re-pair devices if the origin changed.
  retryTunnel():Promise<RuntimeSnapshot>{
   return serial(async()=>{
    alive();
    if(session!=='running'||!launch||!active)throw new Error('Start the session first.');
    if(tunnel.state.state==='online')return snapshot();
    await tunnel.stop();
    const origin=await startTunnel();
    alive();
    if(origin&&origin!==launch.participantOrigin){
     const previous=launch.participantOrigin;
     launch={...launch,participantOrigin:origin};
     await service.stop();await service.start(launch);
     if(previous)status.emit('participant-origin-changed',{workshopId:active.id,previous,current:origin} satisfies OriginChange);
    }
    return snapshot();
   });
  },
  endSession():Promise<StopReport>{return serial(end);},
  // Checks that the current public check-in address reaches this computer's gateway. Safe during a session.
  testConnection():Promise<ConnectionTestResult>{
   if(probing)return probing;
   const t=tunnel.state,l=launch;
   if(disposed||session!=='running'||!l||t.state!=='online'||gateway.port===null)return Promise.resolve(noAddressResult(disposed?'idle':session,t));
   const url=t.url,ac=new AbortController();
   const run=probeAddress({url,gateway,fetchImpl:opts.connectionFetch??fetch,timeoutMs:opts.connectionTimeoutMs,signal:ac.signal,
    current:()=>!disposed&&session==='running'&&launch===l&&tunnel.state.state==='online'&&tunnel.state.url===url});
   const p=run.finally(()=>{if(probing===p){probing=null;cancelProbe=null;}});
   probing=p;cancelProbe=()=>ac.abort();
   return p;
  },
  // The register of one workshop on loopback only (no gateway, no tunnel, participant window untouched), so names can be added
  // before check-in and after it. While that workshop's check-in runs, the session's own register is returned (live: true).
  // One lease at a time: opening another workshop's register stops the previous lease.
  openRegister(id:string):Promise<RegisterLeaseInfo>{
   if(disposed)return Promise.reject(new Error(SHUTTING_DOWN));
   return serial(async()=>{
    alive();
    if(session!=='idle'&&active?.id===id){
     if(session==='running'&&service.state.state==='running')return {organiserUrl:service.state.organiserUrl,leaseId:null,live:true};
     throw new Error('Check-in is starting or closing. Try again in a moment.');
    }
    // The session's register from a check-in whose stop failed still holds this workshop's register.
    if(session==='idle'&&serviceWorkshop===id&&!await sessionRegisterGone())throw new Error(SESSION_NOT_STOPPED);
    if(lease&&!lease.stuck&&lease.id===id&&leaseService.state.state==='running'){lease={...lease,n:++leaseN};return {organiserUrl:leaseService.state.organiserUrl,leaseId:lease.n,live:false};}
    if(lease){const r=await stopLease();if(!r.clean)throw new Error(lease?LEASE_NOT_STOPPED:'The register opened earlier did not stop. Try again.');}
    alive();
    const organiserPort=await freeLoopbackPort();
    const paths=workshops.prepareService(id,organiserPort);
    const launch:ServiceLaunch={paths,organiserPort,participantPort:0,participantOrigin:null,hostSecretPath:workshops.hostSecretPath()};
    checkRunDir(runDirOptions,true);
    try{await leaseService.start(launch)}
    catch(e){
     await leaseService.stop().catch(()=>{});
     // A register that would not stop stays recorded, so nothing else opens this register beside it.
     if(leaseService.holdsProcess)lease={id,n:++leaseN,launch,stuck:true};
     throw e;
    }
    alive();
    lease={id,n:++leaseN,launch,stuck:false};
    return {organiserUrl:`http://127.0.0.1:${organiserPort}`,leaseId:lease.n,live:false};
   });
  },
  // Releases a lease from openRegister. A lease that has since been replaced, or the live register, is left alone.
  releaseRegister(leaseId:number|null):Promise<StopReport>{
   return serial(async()=>{
    if(leaseId===null||!lease||lease.n!==leaseId)return {clean:true,leftovers:[]};
    return stopLease();
   });
  },
  // The organiser key of the register listening at `organiserUrl` (the session's or a lease's), while it runs; else null.
  // For the app's organiser client only: never in a snapshot, never logged, never sent to a window.
  organiserAuth(organiserUrl:string):string|null{
   if(service.state.state==='running'&&service.state.organiserUrl===organiserUrl)return service.organiserBearer;
   if(leaseService.state.state==='running'&&leaseService.state.organiserUrl===organiserUrl)return leaseService.organiserBearer;
   return null;
  },
  // The process IDs of this runtime's own register and tunnel children (null when not running). For diagnostics and
  // the headless check; never derived from anything but the children this runtime spawned.
  childPids():{service:number|null;tunnel:number|null;lease:number|null}{return {service:service.pid,tunnel:tunnel.pid,lease:leaseService.pid};},
  // Settings take effect at the next session (or retryTunnel).
  updateSettings(next:RuntimeSettings){settings=validSettings(next);},
  // Call on quit: refuses new sessions at once, cuts short a session that is still starting, ends any session, and
  // reports anything left (including processes from an earlier run that could not be confirmed or stopped).
  async shutdown():Promise<StopReport>{
   disposed=true;
   // Cut short whatever start is in flight (a session start, or a tunnel retry); queued operations then see `disposed`.
   if(session==='starting'){void tunnel.stop().catch(()=>{});void service.stop().catch(()=>{});}
   else if(tunnel.state.state==='starting')void tunnel.stop().catch(()=>{});
   if(leaseService.state.state==='starting')void leaseService.stop().catch(()=>{});
   const report=await serial(async()=>{const a=await end(),b=await stopLease();return {clean:a.clean&&b.clean,leftovers:[...a.leftovers,...b.leftovers]};});
   if(socketDir?.owned)try{rmdirSync(socketDir.dir)}catch{}
   const out={clean:report.clean&&!orphans.length,leftovers:[...report.leftovers,...orphans]};
   status.removeAllListeners();service.removeAllListeners();leaseService.removeAllListeners();tunnel.removeAllListeners();
   return out;
  },
 };
 return api;
}
export type Runtime=ReturnType<typeof createRuntime>;
