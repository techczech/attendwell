import {test,expect} from 'bun:test';
import {AttendanceStore} from '../server/store-attendance';
import {createHandler} from '../server/http-attendance';
import {participantSync,participantKeys,participantBase} from '../src/offline-participant';
import {organiserQueue} from '../src/offline-organiser';
import {fixture} from './fixtures-attendance';
import {removeTempDir} from './service-spawn';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const origin='https://names.example.org';
const memory=()=>{const m=new Map<string,string>();return {getItem:(k:string)=>m.get(k)??null,setItem:(k:string,v:string)=>void m.set(k,v),removeItem:(k:string)=>void m.delete(k),dump:()=>JSON.stringify([...m])}};
const participantHandler=(store:AttendanceStore,assets='/tmp/missing-assets')=>createHandler(store,{origin,users:{},participantOnly:true},assets);
// Transport routes the device module to the real participant handler; `mode` simulates outages and lost responses.
function device(store:AttendanceStore,storage=memory()){
 const link={mode:'online' as 'online'|'down'|'lose-response'|'tunnel-error',handler:participantHandler(store)};
 const transport=async(path:string,init:RequestInit)=>{
  if(link.mode==='down')throw new TypeError('Failed to fetch');
  if(link.mode==='tunnel-error')return new Response('<html>Bad gateway</html>',{status:502});
  const response=await link.handler(new Request(origin+path,{...init,headers:{...(init.headers as Record<string,string>),Origin:origin}}));
  if(link.mode==='lose-response')throw new TypeError('Network connection was lost');
  return response;
 };
 return {link,storage,sync:participantSync(storage,transport)};
}
const setup=()=>{const store=new AttendanceStore(':memory:');store.import(fixture,'test');store.initParticipantWindow();return store};
const alex=(d:ReturnType<typeof device>)=>d.sync.snapshot()!.names.find(n=>n.name==='Alex Example')!;
const person=(s:AttendanceStore,id:string)=>s.list().participants.find(p=>p.id===id)!;

test('offline check-in is queued durably, survives reload, is not reported as saved, and syncs once on reconnect',async()=>{
 const store=setup();const d=device(store);expect(await d.sync.refresh()).toBe('online');d.link.mode='down';
 expect(await d.sync.refresh()).toBe('offline');
 expect((await d.sync.checkIn(alex(d))).kind).toBe('queued');expect(person(store,'a').present).toBe(false);
 expect((await d.sync.checkIn(alex(d))).kind).toBe('queued');expect(d.sync.queue()).toHaveLength(1);
 d.link.mode='tunnel-error';expect((await d.sync.flush()).remaining).toBe(1);
 const reloaded=participantSync(d.storage,async()=>{throw new TypeError('offline')});
 expect(reloaded.queue()).toHaveLength(1);expect(reloaded.entries().find(e=>e.name==='Alex Example')!.status).toBe('queued');
 d.link.mode='online';expect(await d.sync.flush()).toEqual({synced:1,remaining:0});
 expect(person(store,'a').present).toBe(true);expect(person(store,'a').version).toBe(1);
 await d.sync.refresh();expect(d.sync.entries().find(e=>e.name==='Alex Example')!.status).toBe('checked-in');store.close();
});

test('a lost response is replayed with the same operation ID and writes once',async()=>{
 const store=setup();const d=device(store);await d.sync.refresh();d.link.mode='lose-response';
 expect((await d.sync.checkIn(alex(d))).kind).toBe('queued');expect(person(store,'a').present).toBe(true);
 d.link.mode='online';await d.sync.flush();expect(d.sync.queue()).toHaveLength(0);
 expect(person(store,'a').version).toBe(1);
 expect((store.db.query("SELECT COUNT(*) AS n FROM operations").get() as {n:number}).n).toBe(1);
 expect((store.db.query("SELECT COUNT(*) AS n FROM audit WHERE verb='check-in'").get() as {n:number}).n).toBe(1);store.close();
});

test('a stale offline check-in never overwrites an organiser undo; it is held for organiser resolution',async()=>{
 const store=setup();const d=device(store);await d.sync.refresh();d.link.mode='down';
 expect((await d.sync.checkIn(alex(d))).kind).toBe('queued');
 store.setAttendance('a',true,0,'local-organiser');store.setAttendance('a',false,1,'local-organiser');
 d.link.mode='online';await d.sync.flush();
 expect(person(store,'a').present).toBe(false);expect(d.sync.queue()).toHaveLength(0);
 expect(store.conflicts()).toMatchObject([{participantId:'a',name:'Alex Example',reason:'changed'}]);
 await d.sync.refresh();expect(d.sync.entries().find(e=>e.name==='Alex Example')!.status).toBe('held');
 expect(()=>store.resolveConflict('b','check-in','local-organiser')).toThrow('already resolved');
 store.resolveConflict('a','dismiss','local-organiser');expect(store.conflicts()).toHaveLength(0);
 await d.sync.refresh();expect(d.sync.entries().find(e=>e.name==='Alex Example')!.status).toBe('pending');
 const again=await d.sync.checkIn(alex(d));expect(again.kind).toBe('saved');expect(person(store,'a').present).toBe(true);store.close();
});

test('organiser can accept a held check-in; conflicts are listed in the private roster only',async()=>{
 const store=setup();store.participantCheckIn('b',{opId:'op-held-0001',basis:7});
 expect(store.list().conflicts.map(c=>c.participantId)).toEqual(['b']);store.resolveConflict('b','check-in','local-organiser');
 expect(person(store,'b').present).toBe(true);expect(store.list().conflicts).toHaveLength(0);store.close();
});

test('closure: no new check-ins after the window; queued records stay recoverable until explicit handover',async()=>{
 const store=setup();const d=device(store);await d.sync.refresh();d.link.mode='down';await d.sync.checkIn(alex(d));
 store.closeParticipantWindow('local-organiser');d.link.mode='online';
 expect(await d.sync.refresh()).toBe('closed');expect((await d.sync.flush()).remaining).toBe(1);expect(d.sync.closed()).toBe(true);
 const bea=d.sync.snapshot()!.names.find(n=>n.name==='Bea Example')!;expect((await d.sync.checkIn(bea)).kind).toBe('closed');
 expect(d.sync.queue().map(o=>o.name)).toEqual(['Alex Example']);expect(person(store,'a').present).toBe(false);
 d.sync.handedOver();expect(d.sync.queue()).toHaveLength(0);
 const later=device(setup());await later.sync.refresh();const clock=participantSync(later.storage,async()=>{throw new TypeError('offline')},()=>Date.now()+31*60000);
 expect(clock.closed()).toBe(true);expect((await clock.checkIn(alex(later))).kind).toBe('closed');expect(clock.queue()).toHaveLength(0);store.close();
});

test('selection tokens are stable across a service restart and queued check-ins replay after it',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'attendance-offline-'));const path=join(dir,'check.sqlite');
 let store=new AttendanceStore(path);store.import(fixture,'test');store.initParticipantWindow();const d=device(store);await d.sync.refresh();const token=alex(d).token;
 d.link.mode='down';await d.sync.checkIn(alex(d));store.close();
 store=new AttendanceStore(path);d.link.handler=participantHandler(store);d.link.mode='online';
 expect(store.participantToken('a')).toBe(token);expect(token).toMatch(/^[a-f0-9]{48}$/);expect(token).not.toContain('a'.repeat(3));
 await d.sync.flush();expect(person(store,'a').present).toBe(true);store.close();
 const other=new AttendanceStore(':memory:');expect(other.participantToken('a')).not.toBe(token);other.close();removeTempDir(dir);
});

test('participant device storage holds no emails, source IDs or organiser data',async()=>{
 const store=setup();const d=device(store);await d.sync.refresh();d.link.mode='down';await d.sync.checkIn(alex(d));d.link.mode='online';await d.sync.flush();await d.sync.refresh();
 const stored=d.storage.dump();expect(stored).not.toContain('@');for(const id of ['"a"','"b"','"m"','manual-'])expect(stored).not.toContain(id);
 expect(stored).not.toContain('Cancelled Example');expect(stored).not.toContain('Waiting Example');expect(stored).not.toContain('sourceStatus');
 expect(Object.values(participantKeys()).every(k=>stored.includes(k))).toBe(true);store.close();
});

test('waiting-list admission: provenance kept, pending until check-in, same policy everywhere, revoked on status change',async()=>{
 const store=setup();expect(store.participantNames().map(p=>p.id)).not.toContain('w');
 expect(()=>store.setAttendance('w',true,0,'o')).toThrow();expect(()=>store.admit('c',true,0,'o')).toThrow('waiting-list');
 store.admit('w',true,0,'local-organiser');let w=person(store,'w');expect(w).toMatchObject({booking:'waiting',sourceStatus:'Waiting list',admitted:true,present:false});
 expect(store.participantNames().map(p=>p.id)).toContain('w');expect(store.recipients(['w']).recipients).toHaveLength(0);
 store.participantCheckIn('w');expect(store.recipients(['w']).bcc).toBe('wait@example.org');
 expect(()=>store.admit('w',false,person(store,'w').version,'o')).toThrow('Undo');
 store.import(fixture,'test');expect(person(store,'w').admitted).toBe(true);
 store.import({...fixture,participants:fixture.participants.map(p=>p.id==='w'?{...p,booking:'cancelled' as const,sourceStatus:'Cancelled'}:p)},'test');
 w=person(store,'w');expect(w.admitted).toBe(false);expect(w.present).toBe(true);expect(store.recipients(['w']).recipients).toHaveLength(0);expect(store.participantNames().map(p=>p.id)).not.toContain('w');
 store.import(fixture,'test');expect(person(store,'w').admitted).toBe(false);store.close();
});

test('admission API is owner-only on the organiser listener and absent from the participant listener',async()=>{
 const store=setup();const hash=await Bun.password.hash('test-only-not-a-production-secret');const local='http://127.0.0.1:4318';
 const h=createHandler(store,{origin:local,users:{owner:{hash,role:'owner'},facilitator:{hash,role:'facilitator'}}},'/tmp/missing');
 const post=(handler:typeof h,base:string,path:string,data:unknown,cookie='')=>handler(new Request(base+'/api/'+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Attendance-Request':'1',Cookie:cookie},body:JSON.stringify(data)}));
 const login=async(identity:string)=>(await post(h,local,'login',{identity,passphrase:'test-only-not-a-production-secret'})).headers.get('set-cookie')!.split(';')[0];
 expect((await post(h,local,'admit',{id:'w',admitted:true,version:0})).status).toBe(401);
 expect((await post(h,local,'admit',{id:'w',admitted:true,version:0},await login('facilitator'))).status).toBe(403);
 expect((await post(h,local,'admit',{id:'w',admitted:true,version:0},await login('owner'))).status).toBe(200);
 const p=participantHandler(store);for(const path of ['admit','resolve-conflict'])expect((await post(p,origin,path,{id:'w',admitted:true,version:1})).status).toBe(404);
 const names=await (await p(new Request(origin+'/api/participant-names'))).json();expect(names.participants.map((n:any)=>n.name)).toContain('Waiting Example');store.close();
});

test('organiser changes replay idempotently by operation ID; the local queue keeps refusals visible',async()=>{
 const store=setup();store.setAttendance('a',true,0,'o','op-organiser-1');store.setAttendance('a',true,0,'o','op-organiser-1');
 expect(person(store,'a').version).toBe(1);expect(()=>store.setAttendance('a',false,1,'o','op-organiser-1')).toThrow('already used');
 const storage=memory();const q=organiserQueue(storage);q.add({opId:'op-q-0001',id:'a',name:'Alex Example',present:false,version:1});q.add({opId:'op-q-0002',id:'b',name:'Bea Example',present:true,version:5});
 expect(q.overlay(store.list().participants).find(p=>p.id==='a')).toMatchObject({present:false,version:2,queued:true});
 const send=(c:{id:string;present:boolean;version:number;opId:string})=>{try{return Promise.resolve(store.setAttendance(c.id,c.present,c.version,'o',c.opId))}catch(e){return Promise.reject(e)}};
 expect(await q.flush(()=>Promise.reject({status:0,message:'down'}))).toEqual({synced:0,conflicts:0,waiting:2});
 expect(await q.flush(send)).toEqual({synced:1,conflicts:1,waiting:0});expect(person(store,'a').present).toBe(false);
 expect(q.list()).toMatchObject([{id:'b',state:'conflict'}]);expect(storage.dump()).not.toContain('@');store.close();
});

test('password-free local organiser: loopback alias redirects, API alias refused, service worker only on participant origin',async()=>{
 const store=setup();const assets=mkdtempSync(join(tmpdir(),'attendance-assets-'));writeFileSync(join(assets,'sw.js'),'// worker');writeFileSync(join(assets,'index.html'),'<html></html>');
 const local=createHandler(store,{origin:'http://127.0.0.1:4318',users:{},localAdmin:true},assets);
 const page=await local(new Request('http://localhost:4318/'));expect(page.status).toBe(302);expect(page.headers.get('location')).toBe('http://127.0.0.1:4318/');
 const api=await local(new Request('http://localhost:4318/api/roster'));expect(api.status).toBe(403);expect((await api.json()).error).toContain('http://127.0.0.1:4318');
 expect((await local(new Request('http://localhost:9999/api/roster'))).status).toBe(403);
 expect((await local(new Request('http://127.0.0.1:4318/sw.js'))).status).toBe(404);
 const roster=await (await local(new Request('http://127.0.0.1:4318/api/roster'))).json();expect(roster.localAdmin).toBe(true);expect(roster.conflicts).toEqual([]);
 const worker=await participantHandler(store,assets)(new Request(origin+'/sw.js'));expect(worker.status).toBe(200);expect(worker.headers.get('cache-control')).toBe('no-store');
 store.close();rmSync(assets,{recursive:true});
});


test('an initial empty participant flush does not block later offline replay',async()=>{
 const store=setup();const d=device(store);await d.sync.refresh();
 expect(await d.sync.flush()).toEqual({synced:0,remaining:0});
 d.link.mode='down';expect((await d.sync.checkIn(alex(d))).kind).toBe('queued');
 d.link.mode='online';expect(await d.sync.flush()).toEqual({synced:1,remaining:0});
 expect(person(store,'a').present).toBe(true);expect(person(store,'a').version).toBe(1);store.close();
});


test('reopening at the same address clears the closed snapshot, replays queued check-ins and keeps revision holds',async()=>{
 const store=setup();const d=device(store);await d.sync.refresh();d.link.mode='down';
 const bea=d.sync.snapshot()!.names.find(n=>n.name==='Bea Example')!;
 expect((await d.sync.checkIn(alex(d))).kind).toBe('queued');expect((await d.sync.checkIn(bea)).kind).toBe('queued');
 store.setAttendance('b',true,0,'local-organiser');store.setAttendance('b',false,1,'local-organiser');
 store.closeParticipantWindow('local-organiser');d.link.mode='online';
 expect(await d.sync.refresh()).toBe('closed');expect(d.sync.closed()).toBe(true);expect((await d.sync.flush()).remaining).toBe(2);
 const missing=d.sync.snapshot()!.names.find(n=>n.name==='Missing Address')!;expect((await d.sync.checkIn(missing)).kind).toBe('closed');
 expect(d.sync.queue().map(o=>o.name)).toEqual(['Alex Example','Bea Example']);expect(person(store,'a').present).toBe(false);
 store.openParticipantWindow(15,'local-organiser');
 expect(await d.sync.refresh()).toBe('online');expect(d.sync.closed()).toBe(false);expect(d.sync.snapshot()!.closed).toBeUndefined();
 expect(await d.sync.flush()).toEqual({synced:2,remaining:0});
 expect(person(store,'a').present).toBe(true);expect(person(store,'b').present).toBe(false);
 expect(store.conflicts()).toMatchObject([{participantId:'b',reason:'changed'}]);
 await d.sync.refresh();expect(d.sync.entries().find(e=>e.name==='Bea Example')!.status).toBe('held');store.close();
});

test('participant routes and a configured public prefix: API calls carry the prefix the host proxy strips',async()=>{
 expect(['/check-in','/example-check-in','/example-check-in/','/','/example-check-in/x','/check-in/','/Example','/api','/assets/','/index.html'].map(participantBase)).toEqual(['','/example-check-in','/example-check-in',null,null,null,null,null,null,null]);
 const store=setup();const handler=participantHandler(store);const seen:string[]=[];const p='/example-check-in';
 const proxy=async(path:string,init:RequestInit)=>{seen.push(path);if(!path.startsWith(p+'/'))return new Response('not found',{status:404});return handler(new Request(origin+path.slice(p.length),{...init,headers:{...(init.headers as Record<string,string>),Origin:origin}}));};
 const sync=participantSync(memory(),proxy,undefined,undefined,p);
 expect(await sync.refresh()).toBe('online');expect((await sync.checkIn(sync.snapshot()!.names.find(n=>n.name==='Alex Example')!)).kind).toBe('saved');
 expect(seen).toEqual([p+'/api/participant-names',p+'/api/participant-check-in']);expect(person(store,'a').present).toBe(true);store.close();
});

test('two participant paths on one origin never share names or queue; the local page keeps its original keys',async()=>{
 const storage=memory();const a=setup(),b=setup();const handlers={'/session-a':participantHandler(a),'/session-b':participantHandler(b)};let down=false;
 const proxy=(p:'/session-a'|'/session-b')=>async(path:string,init:RequestInit)=>{if(down)throw new TypeError('offline');return handlers[p](new Request(origin+path.slice(p.length),{...init,headers:{...(init.headers as Record<string,string>),Origin:origin}}))};
 const syncA=participantSync(storage,proxy('/session-a'),undefined,undefined,'/session-a'),syncB=participantSync(storage,proxy('/session-b'),undefined,undefined,'/session-b');
 await syncA.refresh();await syncB.refresh();down=true;
 expect(syncA.enqueue(syncA.snapshot()!.names.find(n=>n.name==='Alex Example')!).kind).toBe('queued');await syncA.flush();
 expect(syncA.queue()).toHaveLength(1);expect(syncB.queue()).toHaveLength(0);expect(syncB.entries().find(e=>e.name==='Alex Example')!.status).toBe('pending');
 const tokensA=syncA.snapshot()!.names.map(n=>n.token);expect(syncB.snapshot()!.names.some(n=>tokensA.includes(n.token))).toBe(false);
 expect(participantKeys('/session-a')).not.toEqual(participantKeys('/session-b'));expect(participantKeys()).toEqual({names:'attendance-participant-names-v1',queue:'attendance-participant-queue-v1'});
 expect(participantSync(storage,proxy('/session-a')).queue()).toHaveLength(0);
 down=false;await syncB.flush();expect(person(b,'a').present).toBe(false);await syncA.flush();expect(person(a,'a').present).toBe(true);a.close();b.close();
});

// Cache storage shared by every worker on one origin, as in a browser.
function cacheStorage(){
 const named=new Map<string,Map<string,Response>>();const key=(k:any)=>typeof k==='string'?k:new URL(k.url).pathname;
 const handle=(entries:Map<string,Response>)=>({match:async(k:any)=>entries.get(key(k))?.clone(),put:async(k:any,r:Response)=>void entries.set(key(k),r),keys:async()=>[...entries.keys()].map(k=>({url:'https://cache.example.org'+k})),delete:async(k:any)=>entries.delete(key(k))});
 const open=async(name:string)=>{if(!named.has(name))named.set(name,new Map());return handle(named.get(name)!)};
 return {named,key,api:{open,keys:async()=>[...named.keys()],delete:async(name:string)=>named.delete(name),match:async(k:any)=>{for(const entries of named.values()){const hit=entries.get(key(k));if(hit)return hit.clone()}}}};
}
// Runs public/sw.js (install, then activate) against minimal worker, cache and fetch stubs for a given registration scope.
async function worker(scope:string,html:string,shared=cacheStorage()){
 const src=await Bun.file(join(import.meta.dir,'../public/sw.js')).text();const listeners:Record<string,(e:any)=>void>={};
 const state={offline:false,fetched:[] as string[]};
 const fetchStub=async(input:any)=>{const p=shared.key(input);state.fetched.push(p);if(state.offline)throw new TypeError('offline');const r=new Response(p.endsWith('/')||p==='/check-in'?html:'asset',{status:200});Object.defineProperty(r,'type',{value:'basic'});return r;};
 new Function('self','caches','fetch',src)({registration:{scope},location:new URL('sw.js',scope),addEventListener:(t:string,f:(e:any)=>void)=>listeners[t]=f,skipWaiting:()=>undefined,clients:{claim:async()=>undefined}},shared.api,fetchStub);
 for(const phase of ['install','activate']){const waits:Promise<unknown>[]=[];listeners[phase]({waitUntil:(p:Promise<unknown>)=>waits.push(p)});await Promise.all(waits);}
 const request=async(path:string,mode='cors')=>{let answer:Promise<Response>|undefined;listeners.fetch({request:{url:new URL(scope).origin+path,method:'GET',mode},respondWith:(p:Promise<Response>)=>answer=p,waitUntil:()=>undefined});return answer?await answer:undefined;};
 const name='attendance-participant-shell-v3:'+(new URL(scope).pathname.replace(/\/$/,'')||'/');
 return {entries:shared.named.get(name)!,state,request};
}

test('service worker caches the shell and assets under its own prefix and never answers API requests',async()=>{
 const html='<script type="module" crossorigin src="./assets/index-abc.js"></script><link rel="stylesheet" href="./assets/index-def.css">';
 const pub=await worker('https://check-in.example.org/example-check-in/',html);
 expect([...pub.entries.keys()].sort()).toEqual(['/example-check-in/','/example-check-in/assets/index-abc.js','/example-check-in/assets/index-def.css']);
 expect(pub.state.fetched.some(p=>p.startsWith('/assets/')||p==='/check-in')).toBe(false);
 for(const path of ['/example-check-in/api/participant-names','/example-check-in/api/participant-check-in','/api/participant-names','/api/roster'])expect(await pub.request(path)).toBeUndefined();
 pub.state.offline=true;expect(await (await pub.request('/example-check-in/','navigate'))!.text()).toBe(html);
 expect(await (await pub.request('/example-check-in/assets/index-abc.js'))!.text()).toBe('asset');
 const local=await worker('http://127.0.0.1:4319/',html);
 expect([...local.entries.keys()].sort()).toEqual(['/assets/index-abc.js','/assets/index-def.css','/check-in']);
 expect(await local.request('/api/participant-names')).toBeUndefined();
 local.state.offline=true;expect(await (await local.request('/check-in','navigate'))!.text()).toBe(html);expect((await local.request('/','navigate'))!.headers.get('location')).toBe('http://127.0.0.1:4319/check-in');
});

test('service workers for two paths on one origin keep separate shells and delete only their own superseded cache',async()=>{
 const shared=cacheStorage();for(const name of ['other-app-cache','attendance-participant-shell-v2:/session-a','attendance-participant-shell-v2'])await shared.api.open(name);
 const a=await worker('https://check-in.example.org/session-a/','<p>A</p><script src="./assets/a.js"></script>',shared);
 const b=await worker('https://check-in.example.org/session-b/','<p>B</p><script src="./assets/b.js"></script>',shared);
 const root=await worker('https://check-in.example.org/','<p>local</p>',shared);
 expect([...shared.named.keys()].sort()).toEqual(['attendance-participant-shell-v2','attendance-participant-shell-v3:/','attendance-participant-shell-v3:/session-a','attendance-participant-shell-v3:/session-b','other-app-cache']);
 expect([...a.entries.keys()].sort()).toEqual(['/session-a/','/session-a/assets/a.js']);expect([...b.entries.keys()].sort()).toEqual(['/session-b/','/session-b/assets/b.js']);
 a.state.offline=b.state.offline=root.state.offline=true;
 expect(await (await a.request('/session-a/','navigate'))!.text()).toBe('<p>A</p><script src="./assets/a.js"></script>');
 expect(await (await b.request('/session-b/','navigate'))!.text()).toBe('<p>B</p><script src="./assets/b.js"></script>');
 // A worker answers only its own path, from its own cache.
 expect(await b.request('/session-a/assets/a.js')).toBeUndefined();expect(await (await b.request('/session-b/assets/b.js'))!.text()).toBe('asset');
});

test('an initial empty organiser flush does not block a later queued change',async()=>{
 const q=organiserQueue(memory());const sent:string[]=[];const send=async(c:{opId:string})=>{sent.push(c.opId)};
 expect(await q.flush(send)).toEqual({synced:0,conflicts:0,waiting:0});
 q.add({opId:'later-organiser-op',id:'a',name:'Alex Example',present:true,version:0});
 expect(await q.flush(send)).toEqual({synced:1,conflicts:0,waiting:0});
 expect(sent).toEqual(['later-organiser-op']);
});
