import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {TunnelSupervisor,type TunnelSettings,type TunnelState} from '../runtime/tunnel-supervisor.ts';
import {parseCloudflaredLine} from '../runtime/cloudflared-output.ts';
import {fakeHost,fixture,until,keepAwake,type FakeChild} from './fakes.ts';

const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const replay=(lines:string[])=>(c:FakeChild)=>setImmediate(()=>{for(const l of lines)c.err(l);});

function setup(onSpawn:(c:FakeChild,n:number)=>void,opts:{startTimeoutMs?:number}={}){
 const dir=mkdtempSync(path.join(tmpdir(),'attendwell-tun-'));dirs.push(dir);
 const cloudflared=path.join(dir,'cloudflared');writeFileSync(cloudflared,'');
 let n=0;const host=fakeHost(c=>onSpawn(c,n++));
 const logs:string[]=[];const states:TunnelState[]=[];
 const sup=new TunnelSupervisor({host,cloudflared,runDir:path.join(dir,'run'),log:l=>logs.push(l),startTimeoutMs:opts.startTimeoutMs??2000,backoffMs:[5,10]});
 sup.on('state',(s:TunnelState)=>states.push(s));
 return {dir,cloudflared,host,sup,logs,states};
}

test('recorded quick-tunnel output: the URL from the banner, online after a registered connection',()=>{
 const events=fixture('cloudflared-quick-online.log').map(parseCloudflaredLine).filter(Boolean);
 expect(events).toContainEqual({kind:'quick-url',url:'https://gentle-example-river-test.trycloudflare.com'});
 expect(events).toContainEqual({kind:'connected',connIndex:0});
 // The API host in the disclaimer or errors is never taken for the tunnel URL.
 expect(parseCloudflaredLine('failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF')).toEqual({kind:'problem',failure:'blocked-by-network',fatal:true});
 expect(parseCloudflaredLine('see https://evil.trycloudflare.com.example.org/x')).toBeNull();
 // Failed pre-checks are hints only (the recorded run failed them and still connected).
 const pre=fixture('cloudflared-quick-precheck-fail-then-stop.log').map(parseCloudflaredLine).filter(e=>e?.kind==='problem');
 expect(pre.every(e=>e?.kind==='problem'&&!e.fatal)).toBe(true);
 expect(fixture('cloudflared-quick-no-internet.log').map(parseCloudflaredLine)).toContainEqual({kind:'problem',failure:'no-internet',fatal:true});
});

test('quick mode: exact command (the gateway port only), URL resolved, stop ends the process',async()=>{
 const {sup,host,states}=setup(replay(fixture('cloudflared-quick-online.log')));
 const url=await sup.start({mode:'quick'},45002);
 expect(url).toBe('https://gentle-example-river-test.trycloudflare.com');
 const {args,env}=host.children[0].req;
 expect(args.slice(0,2)).toEqual(['tunnel','--no-autoupdate']);
 expect(args.slice(-2)).toEqual(['--url','http://127.0.0.1:45002']);
 expect(args).toContain('--config');expect(readFileSync(args[args.indexOf('--config')+1],'utf8')).toContain('{}');
 expect(env.TUNNEL_TOKEN).toBeUndefined();
 expect(states.map(s=>s.state)).toEqual(['starting','online']);
 await sup.stop();
 expect(host.children[0].signals).toEqual(['SIGTERM']);
 expect(sup.state).toEqual({state:'off'});
});

test('two starts in the same tick: the second is refused before anything is spawned; the settings must be quick',async()=>{
 const {sup,host}=setup(replay(fixture('cloudflared-quick-online.log')));
 const first=sup.start({mode:'quick'},45002);
 await expect(sup.start({mode:'quick'},45003)).rejects.toThrow(/already running/);
 expect(await first).toBe('https://gentle-example-river-test.trycloudflare.com');
 expect(host.children).toHaveLength(1);
 await expect(sup.start({mode:'quick'},45002)).rejects.toThrow(/already running/);
 await sup.stop();
 const off=setup(()=>{});
 await expect(off.sup.start({mode:'off'} as TunnelSettings,45002)).rejects.toThrow(/turned off/);
 await expect(off.sup.start({mode:'named'} as unknown as TunnelSettings,45002)).rejects.toThrow(/turned off/);
 await expect(off.sup.start({mode:'quick'},0)).rejects.toThrow(/port/);
 expect(off.host.children).toHaveLength(0);
});

test('a stop while the tunnel is starting ends the process and rejects the start',async()=>{
 const {sup,host}=setup(()=>{});
 const starting=sup.start({mode:'quick'},45002);
 await until(()=>host.children.length===1);
 await sup.stop();
 await expect(starting).rejects.toThrow();
 expect(host.children[0].done).toBe(true);
 expect(sup.state).toEqual({state:'off'});
},10000);

test('failures in plain words: no internet, refused quick tunnel, missing cloudflared, timeout with a blocked network',async()=>{
 const a=setup(c=>setImmediate(()=>{for(const l of fixture('cloudflared-quick-no-internet.log'))c.err(l);}));
 await expect(a.sup.start({mode:'quick'},45002)).rejects.toThrow(/No internet connection/);
 const b=setup(c=>setImmediate(()=>{c.err('2026-10-21T22:20:00Z ERR failed to unmarshal quick Tunnel: status code 429 Too Many Requests');}));
 await expect(b.sup.start({mode:'quick'},45002)).rejects.toThrow(/refused the tunnel/);
 expect(b.host.children[0].done).toBe(true);
 const c=setup(()=>{});rmSync(c.cloudflared);
 await expect(c.sup.start({mode:'quick'},45002)).rejects.toThrow(/tunnel program is missing/);
 // Recorded run on a network that blocks port 7844: no connection before the start timeout.
 const d=setup(c=>setImmediate(()=>{for(const l of fixture('cloudflared-quick-precheck-fail-then-stop.log').filter(l=>!/graceful shutdown/.test(l)))c.err(l);}),{startTimeoutMs:300});
 await expect(keepAwake(d.sup.start({mode:'quick'},45002))).rejects.toThrow(/blocking the connection/);
 expect(d.host.children[0].done).toBe(true);
},10000);

test('reconnecting within one process keeps the URL; a restarted quick tunnel announces its new origin',async()=>{
 const urls=['https://gentle-example-river-test.trycloudflare.com','https://other-fictional-words-here.trycloudflare.com'];
 const {sup,host,states}=setup((c,n)=>{
  if(n===0)setImmediate(()=>{for(const l of fixture('cloudflared-quick-reconnect.log').slice(0,2))c.err(l);});
  else setImmediate(()=>{c.err(`INF |  ${urls[1]}   |`);c.err('INF Registered tunnel connection connIndex=0 event=0 ip=198.41.200.33 location=lhr01 protocol=quic');});
 });
 const changes:unknown[]=[];sup.on('origin-changed',e=>changes.push(e));
 expect(await sup.start({mode:'quick'},45002)).toBe(urls[0]);
 for(const l of fixture('cloudflared-quick-reconnect.log').slice(2))host.children[0].err(l);
 await until(()=>states.filter(s=>s.state==='online').length===2);
 expect(states.map(s=>s.state)).toEqual(['starting','online','reconnecting','online']);
 expect(changes).toEqual([]);
 host.children[0].exit(1); // cloudflared itself stopped
 await until(()=>changes.length===1);
 expect(changes[0]).toEqual({previous:urls[0],current:urls[1]});
 expect(sup.state).toEqual({state:'online',url:urls[1]});
 await sup.stop();
},10000);
