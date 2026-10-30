import {test,expect,afterEach} from 'bun:test';
import http from 'node:http';
import net from 'node:net';
import {probeAddress,noAddressResult} from '../runtime/connection-test.ts';
import {createParticipantGateway,PROBE_ANSWER,type ParticipantGateway} from '../runtime/participant-gateway.ts';

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const c of cleanups.splice(0))await c();});

// A gateway that records what was registered, received and withdrawn; the fetch seam plays the public address, and
// reach() plays the request arriving at this gateway.
function fakeGateway(){
 const registered:string[]=[];const withdrawn:string[]=[];let received=false;
 const g={expectProbe:(t:string)=>{registered.push(t);return {get received(){return received},withdraw(){withdrawn.push(t);}};}} as unknown as ParticipantGateway;
 return {g,registered,withdrawn,reach:()=>{received=true;}};
}
const base=(over:(fg:ReturnType<typeof fakeGateway>)=>Partial<Parameters<typeof probeAddress>[0]>=()=>({}))=>{
 const fg=fakeGateway();
 return {fg,opts:{url:'https://fictional-words.trycloudflare.com',gateway:fg.g,fetchImpl:(async()=>{fg.reach();return new Response(PROBE_ANSWER,{status:200});}) as unknown as typeof fetch,signal:new AbortController().signal,current:()=>true,timeoutMs:200,...over(fg)}};
};
const hanging=((_:unknown,init?:RequestInit)=>new Promise((_r,rej)=>init?.signal?.addEventListener('abort',()=>rej(new Error('abort'))))) as typeof fetch;

test('sends only the random token in a GET to the probe path, and withdraws it afterwards',async()=>{
 const calls:{url:string;init:RequestInit|undefined}[]=[];
 const {fg,opts}=base(fg=>({fetchImpl:(async(u:string|URL|Request,init?:RequestInit)=>{calls.push({url:String(u),init});fg.reach();return new Response(PROBE_ANSWER,{status:200});}) as typeof fetch}));
 expect(await probeAddress(opts)).toEqual({ok:true});
 expect(calls).toHaveLength(1);
 expect(calls[0].url).toBe(`https://fictional-words.trycloudflare.com/_aw/probe/${fg.registered[0]}`);
 expect(fg.registered[0]).toMatch(/^[0-9a-f]{32}$/);
 expect(calls[0].init?.method).toBe('GET');expect(calls[0].init?.body).toBeUndefined();
 expect(Object.keys(calls[0].init?.headers as Record<string,string>)).toEqual(['Accept']);
 expect(fg.withdrawn).toEqual(fg.registered);
});

test('a different token every time',async()=>{
 const {fg,opts}=base();await probeAddress(opts);await probeAddress(opts);
 expect(new Set(fg.registered).size).toBe(2);
});

test('failures are classified and never throw; the token is always withdrawn',async()=>{
 const cases:[string,typeof fetch,string][]=[
  ['dns',(async()=>{throw new TypeError('ENOTFOUND');}) as unknown as typeof fetch,'unreachable'],
  ['sync throw',(()=>{throw new TypeError('bad');}) as unknown as typeof fetch,'unreachable'],
  ['hang',hanging,'timeout'],
  ['hang ignoring the signal',(()=>new Promise(()=>{})) as unknown as typeof fetch,'timeout'],
  ['other server',(async()=>new Response('<html></html>',{status:200})) as unknown as typeof fetch,'other-server'],
  ['wrong json',(async()=>new Response('{"attendwell":"nope"}',{status:200})) as unknown as typeof fetch,'other-server'],
  ['404',(async()=>new Response('nope',{status:404})) as unknown as typeof fetch,'other-server'],
  ['redirect',(async()=>new Response(null,{status:302,headers:{Location:'https://elsewhere.example/'}})) as unknown as typeof fetch,'other-server'],
  ['edge error',(async()=>new Response('1033',{status:530})) as unknown as typeof fetch,'not-ready'],
 ];
 for(const [name,fetchImpl,reason] of cases){
  const {fg,opts}=base(()=>({fetchImpl}));
  const r=await probeAddress(opts);
  expect([name,r.ok===false&&r.reason]).toEqual([name,reason]);
  expect(fg.withdrawn).toEqual(fg.registered);
  if(!r.ok)expect(r.advice.length).toBeGreaterThan(20);
 }
});

test('an answer that arrives after the address or session changed is "changed", even if it says yes',async()=>{
 let current=true;
 const {opts}=base(fg=>({current:()=>current,fetchImpl:(async()=>{current=false;fg.reach();return new Response(PROBE_ANSWER,{status:200});}) as unknown as typeof fetch}));
 expect(await probeAddress(opts)).toMatchObject({ok:false,reason:'changed'});
});

test('cancelling the probe is "changed", not a network failure',async()=>{
 const ac=new AbortController();
 const {opts}=base(()=>({signal:ac.signal,timeoutMs:5000,fetchImpl:hanging}));
 const p=probeAddress(opts);ac.abort();
 expect(await p).toMatchObject({ok:false,reason:'changed'});
});

test('the exact answer without this gateway\'s receipt is a failure',async()=>{
 const {fg,opts}=base(()=>({fetchImpl:(async()=>new Response(PROBE_ANSWER,{status:200})) as unknown as typeof fetch}));
 expect(await probeAddress(opts)).toMatchObject({ok:false,reason:'other-server'});
 expect(fg.withdrawn).toEqual(fg.registered);
});

test('the receipt without the exact answer is a failure: something changed the response on the way back',async()=>{
 for(const [text,status] of [['{"attendwell":"nope"}',200],[PROBE_ANSWER,201],[PROBE_ANSWER+' ',200]] as const){
  const {opts}=base(fg=>({fetchImpl:(async()=>{fg.reach();return new Response(text,{status});}) as unknown as typeof fetch}));
  expect(await probeAddress(opts)).toMatchObject({ok:false,reason:'other-server'});
 }
});

test('an answer read after a cancel is not a success, even if the address has come back unchanged',async()=>{
 // A fetch that ignores the signal and says yes after the cancel.
 const ac=new AbortController();let answer=(_:Response)=>{};
 const {fg,opts}=base(()=>({signal:ac.signal,timeoutMs:5000,fetchImpl:(()=>new Promise<Response>(r=>{answer=r;})) as unknown as typeof fetch}));
 const late=probeAddress(opts);ac.abort();fg.reach();answer(new Response(PROBE_ANSWER,{status:200}));
 expect(await late).toMatchObject({ok:false,reason:'changed'});
 // A cancel while the body is being read.
 const ac2=new AbortController();let more:ReadableStreamDefaultController<Uint8Array>|null=null;
 const reading=base(fg2=>({signal:ac2.signal,timeoutMs:5000,fetchImpl:(async()=>{fg2.reach();return new Response(new ReadableStream<Uint8Array>({start(c){more=c;}}),{status:200});}) as unknown as typeof fetch}));
 const p=probeAddress(reading.opts);
 await new Promise(r=>setTimeout(r,5));
 ac2.abort();more!.enqueue(new TextEncoder().encode(PROBE_ANSWER));more!.close();
 expect(await p).toMatchObject({ok:false,reason:'changed'});
});

test('the answer is read within limits: an endless or oversized body stops early, a stalled one times out, a broken one is unreachable',async()=>{
 let pulls=0;
 const endless=new ReadableStream<Uint8Array>({pull(c){pulls++;c.enqueue(new Uint8Array(16384));}});
 const big=base(fg=>({fetchImpl:(async()=>{fg.reach();return new Response(endless,{status:200});}) as unknown as typeof fetch}));
 expect(await probeAddress(big.opts)).toMatchObject({ok:false,reason:'other-server'});
 expect(pulls).toBeLessThan(5);
 const stalled=base(fg=>({fetchImpl:(async()=>{fg.reach();return new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('{'));}}),{status:200});}) as unknown as typeof fetch}));
 expect(await probeAddress(stalled.opts)).toMatchObject({ok:false,reason:'timeout'});
 const broken=base(fg=>({fetchImpl:(async()=>{fg.reach();return new Response(new ReadableStream<Uint8Array>({pull(c){c.error(new Error('reset'));}}),{status:200});}) as unknown as typeof fetch}));
 expect(await probeAddress(broken.opts)).toMatchObject({ok:false,reason:'unreachable'});
});

// Real sockets: a real gateway, and a stand-in for whatever answers at the public address.
async function realGateway(){
 const g=createParticipantGateway();const port=await g.start();cleanups.push(()=>g.close());
 return {g,port};
}
const live=(url:string,gateway:ParticipantGateway)=>probeAddress({url,gateway,fetchImpl:fetch,signal:new AbortController().signal,current:()=>true,timeoutMs:2000});

test('a wrong server that sends the exact answer and never reaches the local gateway fails; the unused token dies with the test',async()=>{
 const {g,port}=await realGateway();
 const paths:string[]=[];
 const wrong=http.createServer((req,res)=>{paths.push(req.url??'');res.writeHead(200,{'Content-Type':'application/json','Connection':'close'});res.end(PROBE_ANSWER);});
 await new Promise<void>(r=>wrong.listen({port:0,host:'127.0.0.1'},()=>r()));
 cleanups.push(()=>new Promise(r=>{wrong.closeAllConnections();wrong.close(()=>r());}));
 const at=(wrong.address() as net.AddressInfo).port;
 expect(await live(`http://127.0.0.1:${at}`,g)).toMatchObject({ok:false,reason:'other-server'});
 expect(paths).toHaveLength(1);expect(paths[0]).toMatch(/^\/_aw\/probe\/[0-9a-f]{32}$/);
 expect((await fetch(`http://127.0.0.1:${port}${paths[0]}`)).status).toBe(404); // withdrawn when the test ended
});

test('a real round trip through the real gateway succeeds, and its token cannot be used again',async()=>{
 const {g,port}=await realGateway();
 const urls:string[]=[];
 const fetchImpl=((i:string|URL|Request,init?:RequestInit)=>{urls.push(String(i));return fetch(i,init);}) as typeof fetch;
 expect(await probeAddress({url:`http://127.0.0.1:${port}`,gateway:g,fetchImpl,signal:new AbortController().signal,current:()=>true,timeoutMs:2000})).toEqual({ok:true});
 expect((await fetch(urls[0])).status).toBe(404);
});

test('no-address answers say what to do',()=>{
 expect(noAddressResult('idle',{state:'off'})).toMatchObject({ok:false,reason:'no-session'});
 expect(noAddressResult('running',{state:'starting'})).toMatchObject({reason:'not-ready'});
 expect(noAddressResult('running',{state:'reconnecting'})).toMatchObject({reason:'reconnecting'});
 expect(noAddressResult('running',{state:'failed',message:'Blocked by the network.'})).toMatchObject({reason:'failed',advice:'Blocked by the network.'});
});
