import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {createRuntime,type RuntimeSnapshot,type OriginChange,type RuntimeSettings} from '../runtime/index.ts';
import {resourcePaths} from '../runtime/platform.ts';
import {PidFile} from '../runtime/process-control.ts';
import {fakeHost,until,secretsOf,simulatedAcl,SIM_KEY,SIM_WINDOWS,type FakeChild,type FakeHost} from './fakes.ts';
import {createParticipantTls,participantTlsPem} from '../runtime/participant-tls.ts';
import {PROBE_ANSWER} from '../runtime/participant-gateway.ts';

const dirs:string[]=[];
const servers=new Set<http.Server>();
afterEach(()=>{for(const s of servers){s.closeAllConnections();s.close();}servers.clear();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const URL_A='https://gentle-example-river-test.trycloudflare.com',URL_B='https://other-fictional-words-here.trycloudflare.com';
const ONLINE=(url:string)=>(c:FakeChild)=>setImmediate(()=>{c.err(`INF |  ${url}   |`);c.err('INF Registered tunnel connection connIndex=0 event=0 ip=198.41.200.33 location=lhr01 protocol=quic');});

// A fake register: while its child lives, a real server answers on the participant socket (macOS) or port it was
// given, so requests through the runtime's real gateway can be checked. `reached` counts requests per child.
const reached=new Map<number,number>();
const listeners=new Map<number,http.Server>();
// On the TCP path the fake register serves HTTPS with the key and certificate it was given, like the real one.
const pemOf=(label:string,b64:string)=>`-----BEGIN ${label}-----\n${b64.replace(/(.{64})/g,'$1\n')}\n-----END ${label}-----\n`;
function participantListener(c:FakeChild){
 const socket=c.req.env.ATTENDANCE_PARTICIPANT_SOCKET,port=Number(c.req.env.ATTENDANCE_PARTICIPANT_PORT);if(!socket&&!port)return;
 const {tlsKey:key,tlsCert:cert}=secretsOf(c);
 if(!socket&&(!key||!cert))throw new Error('A TCP participant listener was started without its certificate.');
 const handler:http.RequestListener=(req,res)=>{reached.set(c.pid,(reached.get(c.pid)??0)+1);res.writeHead(200,{'Content-Type':'text/plain'});res.end(`register ${c.pid} host=${req.headers.host}`);};
 const srv=socket?http.createServer(handler):https.createServer({key:pemOf('PRIVATE KEY',key!),cert:pemOf('CERTIFICATE',cert!)},handler);
 servers.add(srv);listeners.set(c.pid,srv);
 if(socket)srv.listen(socket);else srv.listen({port,host:'127.0.0.1'});
 c.once('exit',()=>{srv.closeAllConnections();srv.close();servers.delete(srv);});
}
function viaGateway(port:number,p:string):Promise<{status:number;body:string}>{
 return new Promise(resolve=>{
  const req=http.request({host:'127.0.0.1',port,path:p,headers:{Host:new URL(URL_A).host,Connection:'close'},agent:false},res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>resolve({status:res.statusCode??0,body}));});
  req.on('error',()=>resolve({status:0,body:''}));req.end();
 });
}

type Res=ReturnType<typeof resourcePaths>;
type SetupOpts={fetch?:typeof fetch;settings?:RuntimeSettings;transport?:'auto'|'tcp-tls';tunnel?:(c:FakeChild,n:number)=>void;healthy?:()=>boolean;before?:(o:{dataRoot:string;runDir:string;host:FakeHost;res:Res})=>void};
function setup(o:SetupOpts={}){
 const root=mkdtempSync(path.join(tmpdir(),'attendwell-rt-'));dirs.push(root);
 const resourcesRoot=path.join(root,'resources');const res=resourcePaths(resourcesRoot,SIM_KEY);
 for(const f of [res.sidecar,res.cloudflared]){mkdirSync(path.dirname(f),{recursive:true});writeFileSync(f,'');}
 const dataRoot=path.join(root,'data');
 let tunnels=0;
 const host=fakeHost(c=>{
  if(c.req.command===res.cloudflared)return (o.tunnel??((c,n)=>ONLINE(n===0?URL_A:URL_B)(c)))(c,tunnels++);
  participantListener(c);
 });
 o.before?.({dataRoot,runDir:path.join(dataRoot,'run'),host,res});
 const sidecars=()=>host.children.filter(c=>c.req.command===res.sidecar);
 const tunnelsList=()=>host.children.filter(c=>c.req.command===res.cloudflared);
 const rt=createRuntime({dataRoot,resourcesRoot,sidecar:res.sidecar,cloudflared:res.cloudflared,assets:res.assets,...simulatedAcl(),settings:o.settings??{tunnel:{mode:'quick'}},host,...(o.transport?{participantTransport:o.transport}:{}),countAttended:()=>0,...(o.fetch?{connectionFetch:o.fetch,connectionTimeoutMs:300}:{}),
  serviceProbe:async()=>{const c=sidecars().at(-1);return !!c&&!c.done&&(o.healthy?.()??true);},serviceBackoffMs:[5,5,5],tunnelBackoffMs:[5]});
 const snaps:RuntimeSnapshot[]=[];rt.status.on('change',(s:RuntimeSnapshot)=>snaps.push(s));
 const gatewayPort=()=>Number(/:(\d+)$/.exec(tunnelsList()[0].req.args.at(-1)!)![1]);
 return {rt,host,res,sidecars,tunnelsList,snaps,dataRoot,gatewayPort};
}
const workshop=(rt:ReturnType<typeof setup>['rt'])=>{const w=rt.workshops.create({title:'Fictional Lab',date:'2031-03-04'});rt.openWorkshop(w.id);return w;};

test('start order: gateway, tunnel to the gateway only, then the register with the tunnel origin; end stops all and reports clean',async()=>{
 const {rt,host,res,sidecars,gatewayPort}=setup();
 const w=rt.workshops.create({title:'Fictional Lab',date:'2031-03-04'});
 await expect(rt.startSession()).rejects.toThrow(/Open a workshop/);
 rt.openWorkshop(w.id);
 const snap=await rt.startSession();
 expect(snap).toMatchObject({workshopId:w.id,session:'running',tunnel:{state:'online',url:URL_A},service:{state:'running',participantOrigin:URL_A},orphans:[]});
 expect(host.children.map(c=>c.req.command)).toEqual([res.cloudflared,res.sidecar]);
 const env=sidecars()[0].req.env;
 expect(env.ATTENDANCE_PARTICIPANT_ORIGIN).toBe(URL_A);
 expect(env.ATTENDANCE_HOST_SECRET_PATH).toBe(path.join(rt.workshops.dataRoot,'host-secret'));
 expect(existsSync(env.ATTENDANCE_HOST_SECRET_PATH)).toBe(true);
 // cloudflared never learns the register's ports: it points at the gateway, which forwards to the participant port.
 const gw=gatewayPort();
 expect(String(gw)).not.toBe(env.ATTENDANCE_LISTEN_PORT);
 if(!SIM_WINDOWS){
  // macOS: the participant listener is a Unix socket in the private run folder; there is no participant TCP port.
  expect(env.ATTENDANCE_PARTICIPANT_PORT).toBeUndefined();
  expect(path.dirname(env.ATTENDANCE_PARTICIPANT_SOCKET)).toBe(path.join(rt.workshops.dataRoot,'run'));
  expect(statSync(path.join(rt.workshops.dataRoot,'run')).mode&0o777).toBe(0o700);
 }else{
  // Windows: loopback TCP with this spawn's certificate, pinned by the gateway; no socket.
  expect(env.ATTENDANCE_PARTICIPANT_SOCKET).toBeUndefined();
  expect(Number(env.ATTENDANCE_PARTICIPANT_PORT)).toBeGreaterThan(0);
  expect(rt.status.get().service).toMatchObject({participant:{port:Number(env.ATTENDANCE_PARTICIPANT_PORT),fingerprint:expect.stringMatching(/^[0-9a-f]{64}$/)}});
 }
 expect(await viaGateway(gw,'/check-in')).toEqual({status:200,body:`register ${sidecars()[0].pid} host=${new URL(URL_A).host}`});
 expect((await viaGateway(gw,'/api/roster')).status).toBe(404);
 expect(()=>rt.openWorkshop(rt.workshops.create({title:'Other Lab',date:'2031-03-05'}).id)).toThrow(/End the current session/);
 const report=await rt.endSession();
 expect(report).toEqual({clean:true,leftovers:[]});
 expect(host.children.every(c=>c.done)).toBe(true);
 expect(host.children[0].signals).toEqual(['SIGTERM']); // the public path is told to stop first
 expect(rt.status.get()).toMatchObject({session:'idle',tunnel:{state:'off'},service:{state:'off'}});
 expect((await viaGateway(gw,'/check-in')).status).toBe(0); // the gateway closes with the session
});

test('the gateway stays bound through a register crash: 503 while it is down, forwarding again after the restart',async()=>{
 let healthy=true;
 const {rt,sidecars,gatewayPort,tunnelsList}=setup({healthy:()=>healthy});
 workshop(rt);await rt.startSession();
 const gw=gatewayPort();
 expect((await viaGateway(gw,'/check-in')).status).toBe(200);
 healthy=false; // the restarted register is slow to become healthy
 sidecars()[0].exit(1);
 await until(()=>sidecars().length===2);
 const down=await viaGateway(gw,'/check-in');
 expect(down.status).toBe(503);
 expect(down.body).toContain('not available');
 healthy=true;
 await until(()=>rt.status.get().service.state==='running');
 expect(tunnelsList()).toHaveLength(1); // the tunnel was never restarted
 expect(await viaGateway(gw,'/check-in')).toMatchObject({status:200,body:expect.stringContaining(`register ${sidecars()[1].pid}`)});
 expect((await rt.shutdown()).clean).toBe(true);
});

test('a restarted quick tunnel restarts the register with the new origin and asks for re-pairing',async()=>{
 const {rt,tunnelsList,sidecars,gatewayPort}=setup();
 const w=workshop(rt);
 await rt.startSession();
 const gw=gatewayPort();
 const changes:OriginChange[]=[];rt.status.on('participant-origin-changed',(c:OriginChange)=>changes.push(c));
 tunnelsList()[0].exit(1);
 await until(()=>changes.length===1&&rt.status.get().service.state==='running');
 expect(changes[0]).toEqual({workshopId:w.id,previous:URL_A,current:URL_B});
 expect(sidecars()).toHaveLength(2);
 expect(sidecars()[1].req.env.ATTENDANCE_PARTICIPANT_ORIGIN).toBe(URL_B);
 expect(sidecars()[1].req.env.ATTENDANCE_LISTEN_PORT).toBe(sidecars()[0].req.env.ATTENDANCE_LISTEN_PORT);
 expect(tunnelsList()[1].req.args.at(-1)).toBe(`http://127.0.0.1:${gw}`); // the same gateway
 expect((await rt.shutdown()).clean).toBe(true);
 await expect(rt.startSession()).rejects.toThrow(/shutting down/);
});

test('if the tunnel cannot start, the register still runs locally and the failure is reported in plain words',async()=>{
 const {rt,host,res,sidecars}=setup();
 rmSync(res.cloudflared);
 workshop(rt);
 const snap=await rt.startSession();
 expect(snap.tunnel).toMatchObject({state:'failed',reason:'cloudflared-missing'});
 expect(snap.service).toMatchObject({state:'running',participantOrigin:null});
 expect(sidecars()[0].req.env.ATTENDANCE_PARTICIPANT_ORIGIN).toBeUndefined();
 expect(host.children).toHaveLength(1);
 expect((await rt.endSession()).clean).toBe(true);
});

test('race: shutdown while startSession waits for the tunnel leaves nothing running and starts no register',async()=>{
 const {rt,host,sidecars,tunnelsList}=setup({tunnel:()=>{}}); // cloudflared never comes online
 workshop(rt);
 const starting=rt.startSession();
 await until(()=>tunnelsList().length===1);
 const report=await rt.shutdown();
 await expect(starting).rejects.toThrow();
 expect(sidecars()).toHaveLength(0);
 expect(host.children.every(c=>c.done)).toBe(true);
 expect(report).toEqual({clean:true,leftovers:[]});
 expect(rt.status.get().session).toBe('idle');
});

test('race: shutdown while the register is starting stops it; nothing is left',async()=>{
 const {rt,host,sidecars}=setup({healthy:()=>false});
 workshop(rt);
 const starting=rt.startSession();
 await until(()=>sidecars().length===1);
 const report=await rt.shutdown();
 await expect(starting).rejects.toThrow();
 expect(host.children.every(c=>c.done)).toBe(true);
 expect(report.clean).toBe(true);
});

test('race: concurrent starts, a start queued behind an end, and a tunnel retry during shutdown are serialised',async()=>{
 let hang=false;
 const {rt,host,sidecars,tunnelsList}=setup({tunnel:(c,n)=>{if(!hang)ONLINE(n===0?URL_A:URL_B)(c);}});
 workshop(rt);
 const [a,b]=await Promise.all([rt.startSession(),rt.startSession()]);
 expect(a.session).toBe('running');expect(b.session).toBe('running');
 expect(tunnelsList()).toHaveLength(1);expect(sidecars()).toHaveLength(1);
 const [ended,again]=await Promise.all([rt.endSession(),rt.startSession()]);
 expect(ended.clean).toBe(true);expect(again.session).toBe('running');
 expect(host.children.filter(c=>!c.done)).toHaveLength(2); // exactly one tunnel and one register
 // A tunnel retry that is still waiting for Cloudflare is cut short by shutdown.
 hang=true;
 expect((await rt.retryTunnel()).tunnel.state).toBe('online'); // online: nothing to do
 tunnelsList().at(-1)!.exit(1); // cloudflared stops; its restart hangs
 await until(()=>rt.status.get().tunnel.state==='reconnecting');
 const retry=rt.retryTunnel();
 await until(()=>rt.status.get().tunnel.state==='starting');
 const report=await rt.shutdown();
 await retry.catch(()=>{});
 expect(report.clean).toBe(true);
 expect(host.children.every(c=>c.done)).toBe(true);
});

test('settings: only quick or off; anything else is refused at start, not at creation',async()=>{
 const legacy={tunnel:{mode:'named',hostname:'check-in.example.org'}} as unknown as RuntimeSettings;
 const {rt,host}=setup({settings:legacy});
 workshop(rt);
 await expect(rt.startSession()).rejects.toThrow(/quick tunnel only/);
 expect(()=>rt.updateSettings(legacy)).toThrow(/quick tunnel only/);
 rt.updateSettings({tunnel:{mode:'off'}});
 const snap=await rt.startSession();
 expect(snap.tunnel).toEqual({state:'off'});expect(snap.service).toMatchObject({state:'running',participantOrigin:null});
 expect(host.children).toHaveLength(1);
 expect((await rt.shutdown()).clean).toBe(true);
});

for(const settings of [{tunnel:{mode:'off'}},{tunnel:{mode:'unknown'}}] as RuntimeSettings[])
test(`orphans from an earlier run are resolved at creation (tunnel mode ${settings.tunnel.mode}); unproven ones are kept and reported`,async()=>{
 const started=Date.parse('2031-03-04T09:00:00Z');
 const files:Record<string,string>={};
 const {rt,host}=setup({settings,before:({runDir,host,res})=>{
  const rec=(name:string,pid:number,executable:string,exe:string,startMs:number)=>{
   files[name]=path.join(runDir,name);
   new PidFile(files[name]).write({pid,executable,startedAt:new Date(started).toISOString()});
   host.alive.add(pid);host.exes.set(pid,exe);host.starts.set(pid,startMs);
  };
  rec('service-4242.pid',4242,res.sidecar,res.sidecar,started+1000);            // proven: killed
  rec('cloudflared-4343.pid',4343,res.cloudflared,res.cloudflared,started+3600_000); // same program, other start time: unproven
  rec('service-4444.pid',4444,res.sidecar,'/Applications/Other.app/Contents/MacOS/Other',started); // PID reused: left alone
  files['cloudflared-4545.pid']=path.join(runDir,'cloudflared-4545.pid');
  new PidFile(files['cloudflared-4545.pid']).write({pid:4545,executable:res.cloudflared,startedAt:new Date(started).toISOString()});
  host.alive.add(4545); // alive, but the system will not say what it is: unproven
 }});
 await until(()=>rt.status.get().orphans.length===2);
 expect(host.signalled.map(([pid])=>pid)).toEqual([4242]);
 expect(existsSync(files['service-4242.pid'])).toBe(false);
 expect(existsSync(files['service-4444.pid'])).toBe(false);
 expect(existsSync(files['cloudflared-4343.pid'])).toBe(true);
 expect(existsSync(files['cloudflared-4545.pid'])).toBe(true);
 expect(rt.status.get().orphans.join(' ')).toMatch(/\(4343\).*could not confirm/);
 const report=await rt.shutdown();
 expect(report.clean).toBe(false);
 expect(report.leftovers).toHaveLength(2);
 expect(host.alive.has(4343)&&host.alive.has(4444)&&host.alive.has(4545)).toBe(true);
});

test('ending a session: the gateway answers 503 before the register is sent SIGTERM; nothing reaches the register after',async()=>{
 const {rt,sidecars,gatewayPort}=setup();
 workshop(rt);await rt.startSession();
 const gw=gatewayPort();const reg=sidecars()[0];
 expect((await viaGateway(gw,'/check-in')).status).toBe(200);
 const before=reached.get(reg.pid);
 // At the moment SIGTERM is sent the register is still alive and listening; it exits only after this request.
 let atTerm:{status:number}|null=null;
 reg.ignoreTerm=true;const kill=reg.kill.bind(reg);
 reg.kill=sig=>{const r=kill(sig);if(sig==='SIGTERM'||sig===undefined)void viaGateway(gw,'/check-in').then(x=>{atTerm=x;reg.exit(0);});return r;};
 // Keep the tunnel's own stop out of the way: end stops the tunnel first, then the register.
 const report=await rt.endSession();
 expect(atTerm).toMatchObject({status:503});
 expect(reached.get(reg.pid)).toBe(before);
 expect(report.clean).toBe(true);
});

// macOS socket path. The Windows counterpart is 'TCP+TLS path: a crashed register's port taken by another program…' below.
test.skipIf(SIM_WINDOWS)('a crashed register whose exit is not yet seen is never forwarded to: 503, and nothing is reached',async()=>{
 const {rt,sidecars,gatewayPort,tunnelsList}=setup();
 workshop(rt);await rt.startSession();
 const gw=gatewayPort();const reg=sidecars()[0];
 const socket=reg.req.env.ATTENDANCE_PARTICIPANT_SOCKET;
 expect(socket).toBeTruthy();
 // The crash: its listener is gone, but the exit event has not arrived yet.
 const srv=listeners.get(reg.pid)!;await new Promise<void>(r=>{srv.closeAllConnections();srv.close(()=>r());});
 const during=await viaGateway(gw,'/check-in');
 expect(during.status).toBe(503);
 expect(rt.status.get().service.state).toBe('running'); // the runtime has not noticed yet
 // Nothing else could have taken its place: no TCP participant port exists, and the socket's folder is private.
 expect(reg.req.env.ATTENDANCE_PARTICIPANT_PORT).toBeUndefined();
 expect(statSync(path.dirname(socket)).mode&0o077).toBe(0);
 reg.exit(1);
 await until(()=>rt.status.get().service.state==='running'&&sidecars().length===2);
 expect(await viaGateway(gw,'/check-in')).toMatchObject({status:200,body:expect.stringContaining(`register ${sidecars()[1].pid}`)});
 expect(tunnelsList()).toHaveLength(1);
 expect((await rt.shutdown()).clean).toBe(true);
});

test('childPids reports only this runtime\'s own children',async()=>{
 const {rt,sidecars,tunnelsList}=setup();
 workshop(rt);
 expect(rt.childPids()).toEqual({service:null,tunnel:null,lease:null});
 await rt.startSession();
 expect(rt.childPids()).toEqual({service:sidecars()[0].pid,tunnel:tunnelsList()[0].pid,lease:null});
 await rt.shutdown();
 expect(rt.childPids()).toEqual({service:null,tunnel:null,lease:null});
});

// The Windows path, forced on this computer: loopback TCP with TLS pinned to each register spawn.
test('TCP+TLS path: a crashed register\'s port taken by another program before its exit is seen: 503, and no request byte reaches it',async()=>{
 const {rt,sidecars,gatewayPort}=setup({transport:'tcp-tls'});
 workshop(rt);await rt.startSession();
 const gw=gatewayPort();const reg=sidecars()[0];
 expect(reg.req.env.ATTENDANCE_PARTICIPANT_SOCKET).toBeUndefined();
 const port=Number(reg.req.env.ATTENDANCE_PARTICIPANT_PORT);
 expect(port).toBeGreaterThan(0);
 const pin=(rt.status.get().service as {participant:{fingerprint:string}}).participant.fingerprint;
 expect(pin).toMatch(/^[0-9a-f]{64}$/);
 expect(await viaGateway(gw,'/check-in')).toMatchObject({status:200,body:expect.stringContaining(`register ${reg.pid}`)});
 // The crash: the listener is gone and another program binds the port, before the exit event arrives.
 const srv=listeners.get(reg.pid)!;await new Promise<void>(r=>{srv.closeAllConnections();srv.close(()=>r());});
 for(const kind of ['tls','tcp'] as const){
  const got:Buffer[]=[];const socks=new Set<net.Socket>();
  // The plain listener drops the connection once it has seen the ClientHello (the gateway's test covers one that waits).
  const onConn=(sock:net.Socket)=>{socks.add(sock);sock.on('data',d=>{got.push(Buffer.from(d));if(kind==='tcp')sock.destroy();});sock.on('error',()=>{});};
  const imp=kind==='tls'?tls.createServer(participantTlsPem(createParticipantTls()),onConn):net.createServer(onConn);
  imp.on('tlsClientError',()=>{});
  await new Promise<void>(r=>imp.listen({port,host:'127.0.0.1'},()=>r()));
  const during=await viaGateway(gw,'/api/participant-names');
  expect([kind,during.status]).toEqual([kind,503]);
  const bytes=Buffer.concat(got).toString('latin1');
  expect([kind,/HTTP\/1\.1|participant-names|trycloudflare/.test(bytes)]).toEqual([kind,false]);
  for(const s of socks)s.destroy();
  await new Promise<void>(r=>imp.close(()=>r()));
 }
 expect(rt.status.get().service.state).toBe('running'); // the runtime has not noticed yet
 reg.exit(1);
 await until(()=>rt.status.get().service.state==='running'&&sidecars().length===2);
 const next=sidecars()[1];
 expect(Number(next.req.env.ATTENDANCE_PARTICIPANT_PORT)).toBe(port);
 const nextPin=(rt.status.get().service as {participant:{fingerprint:string}}).participant.fingerprint;
 expect(nextPin).not.toBe(pin);
 expect(await viaGateway(gw,'/check-in')).toMatchObject({status:200,body:expect.stringContaining(`register ${next.pid}`)});
 expect((await rt.shutdown()).clean).toBe(true);
});

test('participantTransport accepts only auto or tcp-tls',()=>{
 expect(()=>setup({transport:'plain' as never})).toThrow(/Unknown participant transport/);
});

// The organiser listener's key: fresh for every register spawn, given to the register in its environment, and to the app
// only through organiserAuth while that register runs; never in a snapshot or a log line.
test('organiser key: 32 random bytes per register spawn, on the register\'s standard input, never in its environment, a snapshot or log',async()=>{
 const logs:string[]=[];
 const {rt,sidecars}=setup();
 rt.status.on('log',(l:string)=>logs.push(l));
 workshop(rt);
 const snap=await rt.startSession();
 const first=secretsOf(sidecars()[0]).organiserToken;
 expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
 expect(Buffer.from(first,'base64url')).toHaveLength(32);
 expect(JSON.stringify([sidecars()[0].req.env,sidecars()[0].req.args])).not.toContain(first);
 expect(sidecars()[0].req.env.ATTENDANCE_SECRETS).toBe('stdin');
 const url=(snap.service as {organiserUrl:string}).organiserUrl;
 expect(rt.organiserAuth(url)).toBe(first);
 expect(rt.organiserAuth('http://127.0.0.1:1')).toBeNull();
 expect(JSON.stringify(rt.status.get())).not.toContain(first);
 // A register that crashed and was restarted has a new key; the old one is gone.
 sidecars()[0].exit(1);
 await until(()=>rt.status.get().service.state==='running'&&sidecars().length===2);
 const second=secretsOf(sidecars()[1]).organiserToken;
 expect(second).not.toBe(first);
 expect(rt.organiserAuth(url)).toBe(second);
 await rt.endSession();
 expect(rt.organiserAuth(url)).toBeNull();
 expect(logs.join('\n')).not.toContain(first);
 await rt.shutdown();
});

test('register lease: loopback only (no participant listener, no gateway, no tunnel); never alongside a session on the same workshop',async()=>{
 const {rt,sidecars,tunnelsList}=setup();
 const w=workshop(rt);
 const other=rt.workshops.create({title:'Another Fictional Lab',date:'2031-03-05'});
 const a=await rt.openRegister(w.id);
 expect(a.live).toBe(false);
 expect(a.organiserUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
 expect(tunnelsList()).toHaveLength(0);
 const leased=sidecars()[0];
 for(const k of ['ATTENDANCE_PARTICIPANT_ORIGIN','ATTENDANCE_PARTICIPANT_SOCKET','ATTENDANCE_PARTICIPANT_PORT','ATTENDANCE_PARTICIPANT_TLS_KEY'])expect(leased.req.env[k]).toBeUndefined();
 expect(secretsOf(leased)).toEqual({organiserToken:expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)});
 expect(rt.organiserAuth(a.organiserUrl)).toBe(secretsOf(leased).organiserToken);
 expect(rt.status.get().session).toBe('idle');
 expect(rt.childPids().lease).toBe(leased.pid);
 // Opening the same register again reuses it; the earlier lease id no longer stops it.
 const again=await rt.openRegister(w.id);
 expect(sidecars()).toHaveLength(1);
 await rt.releaseRegister(a.leaseId);
 expect(leased.done).toBe(false);
 // Start check-in on the leased workshop: the lease's register stops before the session's register is spawned.
 await rt.startSession();
 expect(leased.done).toBe(true);
 expect(sidecars()).toHaveLength(2);
 expect(rt.organiserAuth(again.organiserUrl)).toBeNull();
 await rt.releaseRegister(again.leaseId); // a no-op now
 // While check-in runs, its register is the lease.
 const live=await rt.openRegister(w.id);
 expect([live.live,live.leaseId,live.organiserUrl]).toEqual([true,null,(rt.status.get().service as {organiserUrl:string}).organiserUrl]);
 expect(sidecars()).toHaveLength(2);
 // Another workshop's register can be leased beside a running session; shutdown stops it too.
 const b=await rt.openRegister(other.id);
 expect(b.live).toBe(false);
 expect(sidecars()).toHaveLength(3);
 const report=await rt.shutdown();
 expect(report.clean).toBe(true);
 expect(sidecars().every(c=>c.done)).toBe(true);
 expect(rt.childPids()).toEqual({service:null,tunnel:null,lease:null});
});

// Never two register processes on one register file. A register that will not stop stays recorded (lease or session) until
// its exit is seen; every start on that register tries the stop again and refuses in plain words until it has stopped.
const liveByRegister=(sidecars:()=>FakeChild[])=>{const m=new Map<string,number>();for(const c of sidecars())if(!c.done)m.set(c.req.env.ATTENDANCE_DATABASE_PATH,(m.get(c.req.env.ATTENDANCE_DATABASE_PATH)??0)+1);return Math.max(0,...m.values());};

// Each has its own time limit, so a hang names the test (Bun 1.3.10 on Windows crashed around these tests in CI).
test('a lease that will not stop: check-in and another lease on that register are refused, on every retry, until it has exited',async()=>{
 const {rt,sidecars}=setup();
 const w=workshop(rt);
 const other=rt.workshops.create({title:'Another Fictional Lab',date:'2031-03-05'});
 await rt.openRegister(w.id);
 const leased=sidecars()[0];leased.stuck=true;
 for(let i=0;i<3;i++){
  await expect(rt.startSession()).rejects.toThrow(/has not stopped yet/);
  expect(rt.status.get().session).toBe('idle');
  await expect(rt.openRegister(w.id)).rejects.toThrow(/has not stopped yet/);
  // The one lease slot is held too: no other workshop's register opens beside it.
  await expect(rt.openRegister(other.id)).rejects.toThrow(/has not stopped yet/);
  expect(sidecars()).toHaveLength(1);
 }
 expect(leased.signals.length).toBeGreaterThan(3); // each refusal tried the stop again
 expect(rt.childPids().lease).toBe(leased.pid);
 // It exits at last: the next start goes ahead, with one register process on the file.
 leased.exit(0);
 await rt.startSession();
 expect(sidecars()).toHaveLength(2);
 expect(liveByRegister(sidecars)).toBe(1);
 expect(rt.childPids().lease).toBeNull();
 expect((await rt.shutdown()).clean).toBe(true);
},15000);

test('a lease that stops on a later try: the retry stops it first, then check-in starts',async()=>{
 const {rt,sidecars}=setup();
 const w=workshop(rt);
 const a=await rt.openRegister(w.id);
 const leased=sidecars()[0];leased.stuck=true;
 await expect(rt.startSession()).rejects.toThrow(/has not stopped yet/);
 // releaseRegister with the stuck lease's id tries again and reports it, and the lease stays recorded.
 const r=await rt.releaseRegister(a.leaseId);
 expect(r.clean).toBe(false);
 expect(liveByRegister(sidecars)).toBe(1);
 leased.stuck=false;
 await rt.startSession();
 expect(leased.done).toBe(true);
 expect(sidecars()).toHaveLength(2);
 expect(liveByRegister(sidecars)).toBe(1);
 await rt.shutdown();
},15000);

test('a check-in register that will not stop: no lease and no new check-in on that register until it has exited; another workshop\'s lease is unaffected',async()=>{
 const {rt,sidecars}=setup();
 const w=workshop(rt);
 const other=rt.workshops.create({title:'Another Fictional Lab',date:'2031-03-05'});
 await rt.startSession();
 const live=sidecars()[0];live.stuck=true;
 const report=await rt.endSession();
 expect(report.clean).toBe(false);
 expect(report.leftovers.join(' ')).toMatch(/register program did not stop/);
 const snap=rt.status.get();
 expect(snap.session).toBe('idle');
 expect(snap.service).toMatchObject({state:'failed',reason:'will-not-stop'});
 for(let i=0;i<3;i++){
  await expect(rt.openRegister(w.id)).rejects.toThrow(/last check-in has not stopped yet/);
  await expect(rt.startSession()).rejects.toThrow(/last check-in has not stopped yet/);
  expect(sidecars()).toHaveLength(1);
 }
 // Another workshop's register is another file: its lease opens.
 const b=await rt.openRegister(other.id);
 expect(sidecars()).toHaveLength(2);
 await rt.releaseRegister(b.leaseId);
 // The stuck register exits: the snapshot says so, and its workshop's register opens again.
 live.exit(0);
 await until(()=>rt.status.get().service.state==='off');
 const lease=await rt.openRegister(w.id);
 expect(lease.live).toBe(false);
 expect(liveByRegister(sidecars)).toBe(1);
 await rt.releaseRegister(lease.leaseId);
 await rt.startSession();
 expect(liveByRegister(sidecars)).toBe(1);
 expect((await rt.shutdown()).clean).toBe(true);
},15000);

test('a check-in register that stops on a later try: the next start stops it first',async()=>{
 const {rt,sidecars}=setup();
 const w=workshop(rt);
 await rt.startSession();
 const live=sidecars()[0];live.stuck=true;
 expect((await rt.endSession()).clean).toBe(false);
 await expect(rt.openRegister(w.id)).rejects.toThrow(/has not stopped yet/);
 live.stuck=false;
 const lease=await rt.openRegister(w.id);
 expect(live.done).toBe(true);
 expect(lease.live).toBe(false);
 expect(liveByRegister(sidecars)).toBe(1);
 await rt.shutdown();
},15000);

test('shutdown while a register that never becomes healthy will not stop: shutdown completes and reports it left running',async()=>{
 const {rt,sidecars}=setup({healthy:()=>false});
 workshop(rt);
 const starting=rt.startSession();
 await until(()=>sidecars().length===1);
 sidecars()[0].stuck=true;
 const began=Date.now();
 const report=await rt.shutdown();
 await expect(starting).rejects.toThrow();
 expect(Date.now()-began).toBeLessThan(10000);
 expect(report.clean).toBe(false);
 expect(report.leftovers).toContain('The register program did not stop.');
 expect(rt.childPids().service).toBe(sidecars()[0].pid); // still recorded, never forgotten
 sidecars()[0].exit(0);
},15000);

// Test connection: the fake "Cloudflare" forwards a request for the public address to the real gateway the tunnel points at.
const viaTunnel=(gw:()=>number,seen:string[]=[]):typeof fetch=>((input:string|URL|Request,init?:RequestInit)=>{
 const u=new URL(String(input));seen.push(u.origin);
 return fetch(`http://127.0.0.1:${gw()}${u.pathname}${u.search}`,{...init,redirect:'manual'});
}) as typeof fetch;

test('Test connection succeeds through the gateway, sends only a random token, and leaves the running session untouched',async()=>{
 const seen:string[]=[];const urls:string[]=[];
 let gw=0;
 const fetcher:typeof fetch=((input:string|URL|Request,init?:RequestInit)=>{urls.push(String(input));return viaTunnel(()=>gw,seen)(input,init);}) as typeof fetch;
 const {rt,sidecars,tunnelsList,gatewayPort,host}=setup({fetch:fetcher});
 workshop(rt);await rt.startSession();gw=gatewayPort();
 const pids=host.children.map(c=>c.pid);const before=JSON.stringify(rt.status.get());
 expect(await rt.testConnection()).toEqual({ok:true});
 expect(seen).toEqual([URL_A]);
 expect(urls[0]).toMatch(/^https:\/\/gentle-example-river-test\.trycloudflare\.com\/_aw\/probe\/[0-9a-f]{32}$/);
 expect(JSON.stringify(rt.status.get())).toBe(before);
 expect(host.children.map(c=>c.pid)).toEqual(pids);
 expect(sidecars().every(c=>!c.done)).toBe(true);expect(tunnelsList().every(c=>!c.done)).toBe(true);
 expect(reached.get(sidecars()[0].pid)??0).toBe(0); // the register never saw the probe
 expect(await viaGateway(gw,'/check-in')).toMatchObject({status:200}); // check-in still served
 await rt.shutdown();
});

test('Test connection: no session, address not online, and repeated clicks share one probe',async()=>{
 let gw=0,calls=0;
 const fetcher:typeof fetch=((i:string|URL|Request,init?:RequestInit)=>{calls++;return viaTunnel(()=>gw)(i,init);}) as typeof fetch;
 const {rt,gatewayPort}=setup({fetch:fetcher});
 expect(await rt.testConnection()).toMatchObject({ok:false,reason:'no-session'});
 workshop(rt);await rt.startSession();gw=gatewayPort();
 const [a,b]=await Promise.all([rt.testConnection(),rt.testConnection()]);
 expect(a).toEqual({ok:true});expect(b).toBe(a);expect(calls).toBe(1);
 expect(await rt.testConnection()).toEqual({ok:true});expect(calls).toBe(2);
 await rt.shutdown();
 expect(calls).toBe(2);
 expect(await rt.testConnection()).toMatchObject({ok:false,reason:'no-session'});
});

test('Test connection: a tunnel that failed to start has no address to test',async()=>{
 const {rt,res,sidecars}=setup({fetch:(()=>{throw new Error('must not fetch');}) as unknown as typeof fetch});
 rmSync(res.cloudflared);
 workshop(rt);await rt.startSession();
 expect(await rt.testConnection()).toMatchObject({ok:false,reason:'failed'});
 expect(sidecars()[0].done).toBe(false); // the local register is left running
 await rt.shutdown();
});

test('Test connection: unreachable, timeout and another server answering are told apart; each leaves no token behind',async()=>{
 const mode={v:'down'};let gw=0;
 const fetcher:typeof fetch=((i:string|URL|Request,init?:RequestInit)=>{
  if(mode.v==='down')return Promise.reject(new TypeError('getaddrinfo ENOTFOUND'));
  if(mode.v==='hang')return new Promise((_,rej)=>init?.signal?.addEventListener('abort',()=>rej(new Error('aborted'))));
  if(mode.v==='other')return Promise.resolve(new Response('<html>hello</html>',{status:200}));
  if(mode.v==='impostor')return Promise.resolve(new Response(PROBE_ANSWER,{status:200}));
  if(mode.v==='edge')return Promise.resolve(new Response('error 1033',{status:530}));
  return viaTunnel(()=>gw)(i,init);
 }) as typeof fetch;
 const {rt,gatewayPort}=setup({fetch:fetcher});
 workshop(rt);await rt.startSession();gw=gatewayPort();
 expect(await rt.testConnection()).toMatchObject({ok:false,reason:'unreachable'});
 mode.v='hang';expect(await rt.testConnection()).toMatchObject({ok:false,reason:'timeout'});
 mode.v='other';expect(await rt.testConnection()).toMatchObject({ok:false,reason:'other-server'});
 mode.v='impostor';expect(await rt.testConnection()).toMatchObject({ok:false,reason:'other-server'}); // the exact answer, but the gateway saw nothing
 mode.v='edge';expect(await rt.testConnection()).toMatchObject({ok:false,reason:'not-ready'});
 mode.v='ok';expect(await rt.testConnection()).toEqual({ok:true});
 await rt.shutdown();
});

test('Test connection is cancelled, not answered, when the session ends or the address changes during the probe',async()=>{
 let gw=0;const release:(()=>void)[]=[];
 const slow:typeof fetch=((i:string|URL|Request,init?:RequestInit)=>new Promise((res,rej)=>{
  init?.signal?.addEventListener('abort',()=>rej(new Error('aborted')));
  release.push(()=>viaTunnel(()=>gw)(i,init).then(res,rej));
 })) as typeof fetch;
 const {rt,gatewayPort,tunnelsList}=setup({fetch:slow});
 workshop(rt);await rt.startSession();gw=gatewayPort();
 const ended=rt.testConnection();await until(()=>release.length===1);
 await rt.endSession();
 expect(await ended).toMatchObject({ok:false,reason:'changed'});
 // A new session gets a fresh probe, not the old one.
 await rt.startSession();gw=Number(/:(\d+)$/.exec(tunnelsList().at(-1)!.req.args.at(-1)!)![1]);
 const again=rt.testConnection();await until(()=>release.length===2);release[1]();
 expect(await again).toEqual({ok:true});
 await rt.shutdown();
});

test('A probe cancelled by a reconnect stays cancelled when the same address comes back',async()=>{
 let gw=0;let finish:(()=>void)|null=null;
 // Ignores the abort, as a late answer would.
 const slow:typeof fetch=((i:string|URL|Request,init?:RequestInit)=>new Promise((res,rej)=>{finish=()=>viaTunnel(()=>gw)(i,{...init,signal:undefined}).then(res,rej);})) as typeof fetch;
 const {rt,gatewayPort,tunnelsList}=setup({fetch:slow,tunnel:ONLINE(URL_A)});
 workshop(rt);await rt.startSession();gw=gatewayPort();
 const p=rt.testConnection();await until(()=>finish!==null);
 tunnelsList()[0].exit(1);
 await until(()=>tunnelsList().length===2&&rt.status.get().tunnel.state==='online');
 expect(rt.status.get().tunnel).toMatchObject({state:'online',url:URL_A});
 finish!();
 expect(await p).toMatchObject({ok:false,reason:'changed'});
 await rt.shutdown();
});

test('A stale answer is not a success: the address read at the start must still be current when the answer arrives',async()=>{
 let gw=0;let finish:(()=>void)|null=null;
 const slow:typeof fetch=((i:string|URL|Request,init?:RequestInit)=>new Promise((res,rej)=>{finish=()=>viaTunnel(()=>gw)(i,init).then(res,rej);})) as typeof fetch;
 const {rt,gatewayPort,tunnelsList}=setup({fetch:slow});
 workshop(rt);await rt.startSession();gw=gatewayPort();
 const p=rt.testConnection();await until(()=>finish!==null);
 // The tunnel drops and comes back on a new address while the probe waits.
 tunnelsList()[0].exit(1);
 await until(()=>tunnelsList().length===2&&rt.status.get().tunnel.state==='online');
 finish!();
 expect(await p).toMatchObject({ok:false,reason:'changed'});
 await rt.shutdown();
});
