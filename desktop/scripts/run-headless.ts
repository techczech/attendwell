// Headless end-to-end check of the desktop runtime, with no window and no prompt:
// a fictional workshop in a temporary private data folder, a real quick tunnel (no account), the compiled register,
// checks through the public URL, then shutdown and a check that nothing is left running or reachable.
//   node desktop/scripts/run-headless.ts          (Node, as in Electron's main process; Node 22.18+ runs .ts directly)
//   node desktop/scripts/run-headless.ts --tcp-tls   the Windows path on this computer: the gateway reaches the register
//                                                    over loopback TCP with TLS pinned to each register spawn
// Needs: bun desktop/scripts/build-sidecar.ts && bun desktop/scripts/fetch-cloudflared.ts
// Prints state transitions and check results only. Quick tunnels have no token; the register's logs are not printed
// unless --verbose is given.
import {mkdtempSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRuntime,type RuntimeSnapshot} from '../runtime/index.ts';

const here=path.dirname(new URL(import.meta.url).pathname);
const resourcesRoot=path.resolve(here,'..','resources');
const dataRoot=mkdtempSync(path.join(tmpdir(),'attendwell-headless-')); // mkdtemp creates it 0700
const verbose=process.argv.includes('--verbose');
const tcpTls=process.argv.includes('--tcp-tls');
const say=(s:string)=>console.log(`[${new Date().toISOString().slice(11,19)}] ${s}`);
let failures=0;const check=(ok:boolean,what:string)=>{say(`${ok?'PASS':'FAIL'} ${what}`);if(!ok)failures++;};

const rt=createRuntime({dataRoot,resourcesRoot,settings:{tunnel:{mode:'quick'}},participantTransport:tcpTls?'tcp-tls':'auto',log:verbose?l=>say(`  log: ${l}`):undefined});
say(`participant path: ${tcpTls?'loopback TCP with a pinned certificate (forced)':'default for this platform'}`);
let last='';
// Every PID this runtime's own children have had (from rt.childPids, never from a process listing: other AttendWell
// sessions may run the same programs from the same resources folder).
const ownPids=new Set<number>();
const notePids=()=>{const p=rt.childPids();for(const pid of [p.service,p.tunnel])if(pid)ownPids.add(pid);};
rt.status.on('change',(s:RuntimeSnapshot)=>{
 notePids();
 const t=s.tunnel.state==='online'?`online(${s.tunnel.url})`:s.tunnel.state==='failed'?`failed(${s.tunnel.message})`:s.tunnel.state==='reconnecting'?`reconnecting(${s.tunnel.attempt})`:s.tunnel.state;
 const v=s.service.state==='running'?`running(${s.service.organiserUrl})`:s.service.state==='failed'?`failed(${s.service.message})`:s.service.state;
 const line=`session=${s.session} tunnel=${t} register=${v}`;
 if(line!==last){last=line;say(line);}
});
rt.status.on('participant-origin-changed',(c:{previous:string;current:string})=>say(`participant address changed: ${c.previous} -> ${c.current} (re-pair devices)`));

async function publicGet(url:string,tries:number):Promise<Response|null>{
 for(let i=0;i<tries;i++){
  try{const r=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(10000)});if(r.status!==530&&r.status!==502&&r.status!==1033)return r;}catch{}
  await new Promise(r=>setTimeout(r,3000));
 }
 return null;
}

const isAlive=(pid:number)=>{try{process.kill(pid,0);return true}catch(e){return (e as NodeJS.ErrnoException).code==='EPERM'}};

let interrupted=false;
process.on('SIGINT',()=>{interrupted=true;void rt.shutdown().finally(()=>process.exit(130));});

try{
 const w=rt.workshops.create({title:'Fictional Headless Lab',date:new Date().toISOString().slice(0,10),organiserHelp:'This is a fictional test workshop.'});
 rt.openWorkshop(w.id);
 const snap=await rt.startSession();
 check(snap.service.state==='running','register running on loopback');
 check(snap.tunnel.state==='online','quick tunnel online');
 if(snap.tunnel.state==='online'&&snap.service.state==='running'){
  const url=snap.tunnel.url;
  const participant=snap.service.participant;
  const pinOf=()=>{const s=rt.status.get().service;return s.state==='running'&&s.participant&&'fingerprint' in s.participant?s.participant.fingerprint:null;};
  const firstPin=pinOf();
  check(tcpTls?!!participant&&'port' in participant&&/^[0-9a-f]{64}$/.test(firstPin??''):!!participant&&(process.platform==='win32'?'port' in participant:'socketPath' in participant),`register's participant listener is ${tcpTls?'loopback TCP with a pinned certificate':'the platform default'}`);
  if(tcpTls&&participant&&'port' in participant){
   const plain=await fetch(`http://127.0.0.1:${participant.port}/check-in`,{signal:AbortSignal.timeout(3000)}).then(r=>r.status,()=>0);
   check(plain!==200,`the participant port does not serve plain HTTP (${plain||'refused'})`);
  }
  const page=await publicGet(`${url}/check-in`,20);
  check(page?.status===200&&(await page.text()).includes('<html'),'participant page reachable through the public URL');
  const names=await publicGet(`${url}/api/participant-names`,3);
  const body=names?await names.json().catch(()=>null) as {participants?:unknown[];workshop?:{title?:string}}|null:null;
  check(names?.status===200&&Array.isArray(body?.participants)&&body?.workshop?.title==='Fictional Headless Lab','names-only API answers through the tunnel');
  const roster=await publicGet(`${url}/api/roster`,3);
  check(roster?.status===404,'organiser API is not reachable through the tunnel (404)');
  // The organiser listener answers only with this register's own key (never printed).
  const key=rt.organiserAuth(snap.service.organiserUrl);
  const organiser=await fetch(`${snap.service.organiserUrl}/api/check-in-window`,{headers:{Authorization:`Bearer ${key}`}}).catch(()=>null);
  check(!!key&&organiser?.status===200,'organiser API answers on 127.0.0.1 with the register\'s key');
  const keyless=await fetch(`${snap.service.organiserUrl}/api/check-in-window`).catch(()=>null);
  check(keyless?.status===401,`organiser API on 127.0.0.1 refuses a request without the key (${keyless?.status})`);
  // Secrets reach the register on its standard input only: its environment, as other programs of this account see it,
  // holds none of them (macOS: ps eww). Nothing from the listing is printed.
  if(process.platform!=='win32'){
   const pid=rt.childPids().service;
   let listing='';try{listing=pid?execFileSync('/bin/ps',['eww','-p',String(pid)],{encoding:'utf8',env:{PATH:'/bin:/usr/bin'}}):''}catch{}
   check(!!key&&listing.includes('ATTENDANCE_SECRETS=stdin')&&!listing.includes(key)&&!/ORGANISER_TOKEN|TLS_KEY|TLS_CERT/.test(listing),'the register\'s environment holds no secret (ps eww)');
  }
  // The device API: the gateway passes the route and the register answers it (here: 400, no device protocol header).
  const device=await publicGet(`${url}/device/v1/roster`,3);
  check(device?.status===400,`device route reaches the register (${device?.status})`);
  // Kill the register mid-session: the public URL must answer 503 (gateway, fail closed), then recover on its own.
  // This runtime's own register, by the PID it spawned.
  const sidecarPid=rt.childPids().service;
  check(!!sidecarPid,'register process found (this runtime\'s own child)');
  if(sidecarPid){
   const statuses:number[]=[];let stop=false;
   const poll=(async()=>{while(!stop){const r=await fetch(`${url}/check-in`,{redirect:'manual',signal:AbortSignal.timeout(5000)}).catch(()=>null);statuses.push(r?.status??0);if(!r)await new Promise(r=>setTimeout(r,100));}})();
   await new Promise(r=>setTimeout(r,500));
   say(`killing the register (process ${sidecarPid})`);
   process.kill(sidecarPid,'SIGKILL');
   const deadline=Date.now()+30000;
   while(Date.now()<deadline&&!(statuses.includes(503)&&statuses.at(-1)===200&&rt.status.get().service.state==='running')){notePids();await new Promise(r=>setTimeout(r,200));}
   notePids();
   check(rt.childPids().service!==sidecarPid,'the restarted register is a new child of this runtime');
   stop=true;await poll;
   const first503=statuses.indexOf(503);
   check(first503>=0,'public URL answers 503 while the register is down');
   check(first503>=0&&statuses.slice(first503).includes(200)&&rt.status.get().service.state==='running','register restarted and the public URL serves the page again');
   if(tcpTls)check(!!pinOf()&&pinOf()!==firstPin,'the restarted register has a new certificate, and the gateway is pinned to it');
   check(statuses.every(s=>s===200||s===503),`no other answers through the tunnel during the restart (${[...new Set(statuses)].join(', ')})`);
  }
  const report=await rt.endSession();
  check(report.clean,`session ended cleanly${report.leftovers.length?': '+report.leftovers.join(' '):''}`);
  // Give the edge a moment to drop the tunnel, then confirm the public URL no longer reaches the register.
  await new Promise(r=>setTimeout(r,3000));
  let after:Response|null=null;try{after=await fetch(`${url}/api/participant-names`,{signal:AbortSignal.timeout(10000)})}catch{}
  check(!after||after.status!==200,`public URL no longer serves the register (${after?after.status:'no answer'})`);
 }else await rt.endSession();
}catch(e){say(`error: ${(e as Error).message}`);failures++;}
finally{
 if(!interrupted){
  const report=await rt.shutdown();
  check(report.clean,'shutdown left nothing running');
  // Independent check: none of this runtime's children is still running.
  const left=[...ownPids].filter(isAlive);
  check(ownPids.size>0&&!left.length,`none of this runtime's ${ownPids.size} child processes remains${left.length?': '+left.join(', '):''}`);
  rmSync(dataRoot,{recursive:true,force:true});
  say(failures?`${failures} check(s) failed`:'all checks passed');
  process.exit(failures?1:0);
 }
}
