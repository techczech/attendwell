import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,existsSync,readFileSync,mkdirSync} from 'node:fs';
import net from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ServiceSupervisor,serviceEnv,serviceSecrets,type ServiceLaunch,type ServiceState} from '../runtime/service-supervisor.ts';
import {createParticipantTls} from '../runtime/participant-tls.ts';
import {X509Certificate,createPrivateKey} from 'node:crypto';
import {fakeHost,until,secretsOf,type FakeChild} from './fakes.ts';
import type {Upstream} from '../runtime/participant-gateway.ts';

const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function setup(onSpawn:(c:FakeChild)=>void=()=>{},probe?:(l:ServiceLaunch)=>Promise<boolean>,socketDir?:string){
 const dir=mkdtempSync(path.join(tmpdir(),'attendwell-svc-'));dirs.push(dir);
 const sidecar=path.join(dir,'attendwell-service');writeFileSync(sidecar,'');
 const host=fakeHost(onSpawn);
 // Healthy while the newest child is alive.
 const healthy=probe??(async()=>{const c=host.children.at(-1);return !!c&&!c.done;});
 const states:ServiceState['state'][]=[];
 const sup=new ServiceSupervisor({host,sidecar,assets:path.join(dir,'dist'),runDir:path.join(dir,'run'),probe:healthy,healthTimeoutMs:300,backoffMs:[5,10,20],stableMs:60000,...(socketDir?{socketDir:()=>socketDir}:{})});
 sup.on('state',(s:ServiceState)=>states.push(s.state));
 // Every 'upstream' event and every signal, in the order they happened.
 const events:string[]=[];
 sup.on('upstream',(u:Upstream|null)=>events.push(u===null?'upstream:off':'upstream:on'));
 const spawn=host.spawn;host.spawn=req=>{const c=spawn(req) as FakeChild;const kill=c.kill.bind(c);c.kill=sig=>{events.push(`signal:${sig??'SIGTERM'}`);return kill(sig);};c.once('exit',()=>events.push('exit'));return c;};
 const launch:ServiceLaunch={paths:{root:dir,dir,workshopFile:path.join(dir,'workshop.json'),metaFile:'',provenanceFile:'',serviceFile:path.join(dir,'service.json'),dbDir:path.join(dir,'db'),database:path.join(dir,'db','attendance.sqlite')},organiserPort:45001,participantPort:45002,participantOrigin:'https://gentle-example-river-test.trycloudflare.com',hostSecretPath:path.join(dir,'host-secret')};
 return {dir,sidecar,host,sup,states,launch,events,pidfile:(pid:number)=>path.join(dir,'run',`service-${pid}.pid`)};
}

test('starts on loopback with the service environment only, records a pidfile, and stops cleanly',async()=>{
 process.env.ATTENDWELL_TEST_SECRET='do-not-pass-me';
 const {host,sup,launch,pidfile,states}=setup();
 await sup.start(launch);
 const env=host.children[0].req.env;
 expect(env).toMatchObject({ATTENDANCE_BIND:'127.0.0.1',ATTENDANCE_LISTEN_PORT:'45001',ATTENDANCE_PARTICIPANT_PORT:'45002',ATTENDANCE_PARTICIPANT_ORIGIN:launch.participantOrigin!,ATTENDANCE_DATABASE_PATH:launch.paths.database,ATTENDANCE_DATA_ROOT:launch.paths.root,ATTENDANCE_HOST_SECRET_PATH:launch.hostSecretPath!});
 expect(env.ATTENDWELL_TEST_SECRET).toBeUndefined();
 expect(sup.state).toMatchObject({state:'running',organiserUrl:'http://127.0.0.1:45001'});
 expect(JSON.parse(readFileSync(pidfile(host.children[0].pid),'utf8')).pid).toBe(host.children[0].pid);
 expect((await sup.stop()).stopped).toBe(true);
 expect(host.children[0].signals).toEqual(['SIGTERM']);
 expect(existsSync(pidfile(host.children[0].pid))).toBe(false);
 expect(states).toEqual(['starting','running','off']);
 delete process.env.ATTENDWELL_TEST_SECRET;
});

test('never two at once: a second start while running is refused',async()=>{
 const {sup,launch,host}=setup();
 await sup.start(launch);
 await expect(sup.start(launch)).rejects.toThrow(/already running/);
 expect(host.children).toHaveLength(1);
 await sup.stop();
});

test('restarts after a crash with backoff, and gives up after the last step',async()=>{
 const {sup,launch,host,states}=setup();
 await sup.start(launch);
 host.children[0].exit(1);
 await until(()=>host.children.length===2&&sup.state.state==='running');
 expect(states).toContain('restarting');
 // Every later child dies at once: three backoff steps, then failed.
 const crash=(c:FakeChild)=>c.exit(1);
 host.spawn=((orig)=>(req)=>{const c=orig(req) as FakeChild;setImmediate(()=>crash(c));return c;})(host.spawn);
 host.children[1].exit(1);
 await until(()=>sup.state.state==='failed',5000);
 expect(sup.state).toMatchObject({state:'failed',reason:'kept-crashing'});
 expect(host.children.length).toBe(4); // first, one good restart (attempt 1), then attempts 2 and 3: the budget only resets after a stable minute
 await sup.stop();
});

test('a child that ignores SIGTERM is killed',async()=>{
 const {sup,launch,host}=setup(c=>{c.ignoreTerm=true;});
 await sup.start(launch);
 await sup.stop();
 expect(host.children[0].signals).toEqual(['SIGTERM','SIGKILL']);
});

test('two starts in the same tick: the second is refused before anything is spawned',async()=>{
 const {sup,launch,host}=setup();
 const first=sup.start(launch);
 await expect(sup.start(launch)).rejects.toThrow(/already running/);
 await first;
 expect(host.children).toHaveLength(1);
 await sup.stop();
});

test('start failures are reported in plain words: port in use, missing sidecar',async()=>{
 const a=setup(c=>setImmediate(()=>{c.err('error: Failed to start server. Is port 45001 in use?');c.exit(1);}),async()=>false);
 await expect(a.sup.start(a.launch)).rejects.toThrow(/Another program is using the port/);
 expect(a.sup.state).toMatchObject({state:'failed',reason:'port-in-use'});
 const b=setup();rmSync(b.sidecar);
 await expect(b.sup.start(b.launch)).rejects.toThrow(/missing/);
 expect(b.host.children).toHaveLength(0);
});

test('the gateway is switched off before any signal is sent, and synchronously when the register exits',async()=>{
 const {sup,launch,host,events}=setup();
 await sup.start(launch);
 expect(events).toEqual(['upstream:on']);
 // A crash: the supervisor's own exit listener (registered at spawn, so it runs first) switches forwarding off.
 let seenAtExit:string|undefined;
 host.children[0].once('exit',()=>{seenAtExit=events.at(-1);});
 host.children[0].exit(1);
 await until(()=>sup.state.state==='running'&&host.children.length===2);
 expect(seenAtExit).toBe('upstream:off');
 events.length=0;
 await sup.stop();
 expect(events.slice(0,2)).toEqual(['upstream:off','signal:SIGTERM']);
});

// A Unix socket path cannot be served on Windows; its counterpart there is the 'Windows path' test below.
test.skipIf(process.platform==='win32')('macOS: each register gets a fresh Unix socket in the private folder, no TCP participant port, removed after exit',async()=>{
 const base=mkdtempSync(path.join(tmpdir(),'attendwell-sock-'));dirs.push(base);
 const sockDir=path.join(base,'run');mkdirSync(sockDir,{mode:0o700});
 const servers:net.Server[]=[];
 // The fake register listens on the socket it was given, like the real one, and leaves the file behind (as a crash would).
 const {sup,launch,host}=setup(c=>{const p=c.req.env.ATTENDANCE_PARTICIPANT_SOCKET;if(!p)return;const srv=net.createServer(s=>s.destroy());servers.push(srv);srv.listen(p);},undefined,sockDir);
 const ups:(Upstream|null)[]=[];sup.on('upstream',(u:Upstream|null)=>ups.push(u));
 await sup.start(launch);
 const env=host.children[0].req.env;
 expect(env.ATTENDANCE_PARTICIPANT_PORT).toBeUndefined();
 expect(path.dirname(env.ATTENDANCE_PARTICIPANT_SOCKET)).toBe(sockDir);
 expect(ups.at(-1)).toEqual({socketPath:env.ATTENDANCE_PARTICIPANT_SOCKET});
 expect(sup.state).toMatchObject({state:'running',participant:{socketPath:env.ATTENDANCE_PARTICIPANT_SOCKET}});
 host.children[0].exit(1);
 await until(()=>sup.state.state==='running'&&host.children.length===2);
 expect(host.children[1].req.env.ATTENDANCE_PARTICIPANT_SOCKET).not.toBe(env.ATTENDANCE_PARTICIPANT_SOCKET);
 await sup.stop();
 for(const c of host.children)expect(existsSync(c.req.env.ATTENDANCE_PARTICIPANT_SOCKET)).toBe(false);
 for(const srv of servers)srv.close();
});

test('Windows path: each register gets a fresh key and certificate; the gateway is pinned to that spawn only',async()=>{
 const {sup,launch,host}=setup();
 const ups:(Upstream|null)[]=[];sup.on('upstream',(u:Upstream|null)=>ups.push(u));
 await sup.start(launch);
 const env=host.children[0].req.env;
 expect(env.ATTENDANCE_PARTICIPANT_SOCKET).toBeUndefined();
 expect(env.ATTENDANCE_PARTICIPANT_PORT).toBe('45002');
 // Key and certificate go on standard input, never in the environment.
 const secrets=secretsOf(host.children[0]);
 expect(Object.keys(secrets).sort()).toEqual(['organiserToken','tlsCert','tlsKey']);
 for(const v of Object.values(secrets))expect(JSON.stringify(env)).not.toContain(v!.slice(0,40));
 const cert=new X509Certificate(Buffer.from(secrets.tlsCert!,'base64'));
 const pin=cert.fingerprint256.replace(/:/g,'').toLowerCase();
 expect(cert.checkPrivateKey(createPrivateKey({key:Buffer.from(secrets.tlsKey!,'base64'),format:'der',type:'pkcs8'}))).toBe(true);
 expect(ups.at(-1)).toEqual({port:45002,fingerprint:pin});
 expect(sup.state).toMatchObject({state:'running',participant:{port:45002,fingerprint:pin}});
 host.children[0].exit(1);
 await until(()=>sup.state.state==='running'&&host.children.length===2);
 expect(host.children[1].req.env.ATTENDANCE_PARTICIPANT_PORT).toBe('45002');
 const next=secretsOf(host.children[1]);
 expect(next.tlsCert).not.toBe(secrets.tlsCert);
 expect(next.tlsKey).not.toBe(secrets.tlsKey);
 expect(next.organiserToken).not.toBe(secrets.organiserToken);
 const nextPin=new X509Certificate(Buffer.from(next.tlsCert!,'base64')).fingerprint256.replace(/:/g,'').toLowerCase();
 expect(ups.at(-1)).toEqual({port:45002,fingerprint:nextPin});
 expect(nextPin).not.toBe(pin);
 await sup.stop();
});

test('serviceEnv and serviceSecrets never start a TCP participant listener without its certificate; secrets only on standard input',()=>{
 const {launch}=setup();
 const tls=createParticipantTls();const bearer='A'.repeat(43);
 const target={port:45002,fingerprint:tls.fingerprint},otherPin={port:45002,fingerprint:createParticipantTls().fingerprint};
 expect(()=>serviceEnv({assets:'/x',platform:'win32'},launch,target)).toThrow(/certificate/);
 expect(()=>serviceEnv({assets:'/x',platform:'win32'},launch,otherPin,tls)).toThrow(/certificate/);
 expect(()=>serviceSecrets(launch,target,null,bearer)).toThrow(/certificate/);
 expect(()=>serviceSecrets(launch,otherPin,tls,bearer)).toThrow(/certificate/);
 expect(()=>serviceSecrets(launch,target,tls,'short')).toThrow(/32 bytes/);
 const env=serviceEnv({assets:'/x',platform:'win32'},launch,target,tls);
 expect(env.ATTENDANCE_SECRETS).toBe('stdin');
 for(const k of Object.keys(env))expect(k).not.toMatch(/TOKEN|TLS_KEY|TLS_CERT/);
 const line=serviceSecrets(launch,target,tls,bearer);
 expect(line.endsWith('\n')&&line.indexOf('\n')===line.length-1).toBe(true);
 expect(JSON.parse(line)).toEqual({organiserToken:bearer,tlsKey:tls.key.toString('base64'),tlsCert:tls.cert.toString('base64')});
 // A socket or no participant listener: the organiser key only.
 expect(JSON.parse(serviceSecrets(launch,{socketPath:'/x/p.sock'},null,bearer))).toEqual({organiserToken:bearer});
 expect(JSON.parse(serviceSecrets({...launch,participantOrigin:null},null,null,bearer))).toEqual({organiserToken:bearer});
});

test('a register that will not stop stays recorded: failed (will-not-stop), no new start, pidfile kept, until its exit is seen',async()=>{
 const {host,sup,launch,pidfile}=setup();
 await sup.start(launch);
 const c=host.children[0];c.stuck=true;
 expect((await sup.stop()).stopped).toBe(false);
 expect(c.signals).toEqual(['SIGTERM','SIGKILL']);
 expect(sup.holdsProcess).toBe(true);
 expect(sup.pid).toBe(c.pid);
 expect(sup.state).toMatchObject({state:'failed',reason:'will-not-stop'});
 expect(existsSync(pidfile(c.pid))).toBe(true);
 await expect(sup.start(launch)).rejects.toThrow(/already running/);
 expect(host.children).toHaveLength(1);
 // A second stop tries again; it still will not go.
 expect((await sup.stop()).stopped).toBe(false);
 expect(sup.holdsProcess).toBe(true);
 // It exits on its own: off, nothing recorded, and a new start goes ahead.
 c.exit(0);
 await until(()=>!sup.holdsProcess);
 expect(sup.state.state).toBe('off');
 expect(existsSync(pidfile(c.pid))).toBe(false);
 await sup.start(launch);
 expect(host.children).toHaveLength(2);
 expect((await sup.stop()).stopped).toBe(true);
});

test('a register that never becomes healthy and will not stop: start fails as will-not-stop within its bounded wait; it stays recorded until it exits',async()=>{
 const {host,sup,launch,pidfile}=setup(c=>{c.stuck=true;},async()=>false);
 const began=Date.now();
 await expect(sup.start(launch)).rejects.toThrow(/did not stop/);
 expect(Date.now()-began).toBeLessThan(5000);
 const c=host.children[0];
 expect(c.signals).toEqual(['SIGTERM','SIGKILL']);
 expect(sup.state).toMatchObject({state:'failed',reason:'will-not-stop'});
 expect(sup.holdsProcess).toBe(true);
 expect(existsSync(pidfile(c.pid))).toBe(true);
 await expect(sup.start(launch)).rejects.toThrow(/already running/);
 expect(host.children).toHaveLength(1);
 // stop() returns too, and reports that it did not stop.
 expect((await sup.stop()).stopped).toBe(false);
 c.exit(0);
 await until(()=>!sup.holdsProcess);
 expect(sup.state.state).toBe('off');
 expect(existsSync(pidfile(c.pid))).toBe(false);
});
