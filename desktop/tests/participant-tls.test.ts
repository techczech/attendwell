import {test,expect,afterEach} from 'bun:test';
import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import {createParticipantTls,participantTlsPem,participantTlsSecrets,pinnedRequest,pinnedStatus,connectPinned,bodyFailed,PinMismatch,type ParticipantTls} from '../runtime/participant-tls.ts';

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const c of cleanups.splice(0))await c();});

// A TLS listener that answers every request with `reply` (raw bytes, so framing can be chosen) and records what arrived.
// With `then: 'drop'`, the reply is written and the connection is cut a moment later (a register failing mid-response);
// with 'hold', it is written and the connection left open.
async function listener(creds:ParticipantTls,reply:string,then:'end'|'drop'|'hold'='end'){
 const got:Buffer[]=[];let closed=0;
 const srv=tls.createServer(participantTlsPem(creds),sock=>{sock.on('error',()=>{});sock.on('close',()=>closed++);sock.on('data',d=>{
  got.push(Buffer.from(d));if(!Buffer.concat(got).includes('\r\n\r\n'))return;
  if(then==='end')sock.end(reply);else{sock.write(reply);if(then==='drop')setTimeout(()=>sock.destroy(),30);}
 });});
 srv.on('tlsClientError',()=>{});
 await new Promise<void>(r=>srv.listen({port:0,host:'127.0.0.1'},()=>r()));
 cleanups.push(()=>new Promise(r=>srv.close(()=>r())));
 return {target:{port:(srv.address() as net.AddressInfo).port,fingerprint:creds.fingerprint},got:()=>Buffer.concat(got).toString('latin1'),closed:()=>closed};
}
// Settles a promise into its error (or null). Used instead of expect(...).rejects, which crashed Bun 1.3.10's test runner
// intermittently (segfault) after a TLS socket had been destroyed earlier in the same test.
const failure=(p:Promise<unknown>)=>p.then(()=>null,(e:Error)=>e);
const read=async(r:{body:NodeJS.ReadableStream})=>{let s='';for await(const c of r.body)s+=c;return s;};

test('each certificate is fresh, a valid X.509 certificate, and its pin is its SHA-256 fingerprint',()=>{
 const a=createParticipantTls(),b=createParticipantTls();
 expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
 expect(b.fingerprint).not.toBe(a.fingerprint);
 const x=new crypto.X509Certificate(a.cert);
 expect(x.fingerprint256.replace(/:/g,'').toLowerCase()).toBe(a.fingerprint);
 expect(x.subject).toContain('AttendWell register');
 expect(x.checkPrivateKey(crypto.createPrivateKey({key:a.key,format:'der',type:'pkcs8'}))).toBe(true);
 expect(x.verify(x.publicKey)).toBe(true); // self-signed
 const secrets=participantTlsSecrets(a);
 expect(Object.keys(secrets).sort()).toEqual(['tlsCert','tlsKey']);
 for(const v of Object.values(secrets))expect(v).toMatch(/^[A-Za-z0-9+/]+=*$/);
});

test('the pinned certificate is accepted; any other is refused before anything is written',async()=>{
 const creds=createParticipantTls();
 const ok=await listener(creds,'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
 const sock=await connectPinned(ok.target);sock.destroy();
 expect(await failure(connectPinned({...ok.target,fingerprint:createParticipantTls().fingerprint}))).toBeInstanceOf(PinMismatch);
 expect(await pinnedStatus({...ok.target,fingerprint:createParticipantTls().fingerprint},'/check-in','x')).toBe(0);
 await new Promise(r=>setTimeout(r,50));
 expect(ok.got()).toBe('');
 expect(await pinnedStatus(ok.target,'/check-in','example.test')).toBe(200);
 expect(ok.got()).toMatch(/^GET \/check-in HTTP\/1\.1\r\nHost: example\.test\r\nConnection: close\r\n\r\n$/);
});

test('responses: Content-Length, chunked (with trailers), read to close, HEAD and 204 without a body',async()=>{
 const creds=createParticipantTls();
 const cases:[string,string,string][]=[
  ['GET','HTTP/1.1 200 OK\r\nContent-Length: 5\r\nX-A: 1\r\n\r\nhelloEXTRA','hello'],
  ['GET','HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2;ext=1\r\nde\r\n0\r\nX-T: 1\r\n\r\n','abcde'],
  ['GET','HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n\r\nuntil close','until close'],
  ['HEAD','HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\n',''],
  ['GET','HTTP/1.1 204 No Content\r\n\r\n',''],
 ];
 for(const [method,reply,want] of cases){
  const l=await listener(creds,reply);
  const r=await pinnedRequest(l.target,{method,path:'/x?y=1',headers:{host:'h.example','content-type':'text/plain'},timeoutMs:2000});
  expect([reply.slice(0,40),await read(r)]).toEqual([reply.slice(0,40),want]);
 }
});

test('malformed responses are refused, not passed on',async()=>{
 const creds=createParticipantTls();
 for(const reply of [
  'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\nok',
  'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\nok',
  'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\n\r\n',
  'HTTP/1.1 200 OK\r\nBad Header\r\n\r\n',
  'NOT-HTTP\r\n\r\n',
 ]){
  const l=await listener(creds,reply);
  expect((await failure(pinnedRequest(l.target,{method:'GET',path:'/',headers:{},timeoutMs:2000})))?.message).toMatch(/./);
 }
 // A body cut short ends with an error, never as a complete response.
 const l=await listener(creds,'HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort');
 const r=await pinnedRequest(l.target,{method:'GET',path:'/',headers:{},timeoutMs:2000});
 expect((await failure(read(r)))?.message).toMatch(/./);
});

test('the request is withdrawn after the handshake when the caller says so; nothing is sent',async()=>{
 const creds=createParticipantTls();
 const l=await listener(creds,'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
 expect((await failure(pinnedRequest(l.target,{method:'POST',path:'/api/participant-check-in',headers:{'content-length':'4'},body:Buffer.from('body')},()=>false)))?.message).toMatch(/no longer running/);
 await new Promise(r=>setTimeout(r,50));
 expect(l.got()).toBe('');
 // Header injection is refused before connecting.
 expect((await failure(pinnedRequest(l.target,{method:'GET',path:'/',headers:{'x-a':'1\r\nX-B: 2'}})))?.message).toMatch(/Invalid/);
 expect((await failure(pinnedRequest(l.target,{method:'GET',path:'/ HTTP/1.1\r\n',headers:{}})))?.message).toMatch(/Invalid/);
});

// Records every uncaught exception and unhandled rejection while `run` runs (and a little after, for late emits).
async function noEscapes(run:()=>Promise<void>):Promise<string[]>{
 const seen:string[]=[];
 const onException=(e:Error)=>seen.push(`uncaughtException: ${e?.message}`);
 const onRejection=(e:unknown)=>seen.push(`unhandledRejection: ${(e as Error)?.message??e}`);
 process.on('uncaughtException',onException);process.on('unhandledRejection',onRejection);
 try{await run();await new Promise(r=>setTimeout(r,100));}
 finally{process.off('uncaughtException',onException);process.off('unhandledRejection',onRejection);}
 return seen;
}

test('a body that fails before the caller listens (bad chunk in the head packet) is kept, never thrown',async()=>{
 const creds=createParticipantTls();
 const escaped=await noEscapes(async()=>{
  const l=await listener(creds,'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\nabc\r\n');
  const r=await pinnedRequest(l.target,{method:'GET',path:'/',headers:{},timeoutMs:2000});
  await new Promise(res=>setTimeout(res,30)); // the caller attaches nothing for a while
  expect(bodyFailed(r.body)).toBe(true);
  expect(r.body.errored?.message).toMatch(/Invalid chunk size/);
  // The same reply never counts as healthy.
  expect(await pinnedStatus(l.target,'/check-in','h')).toBe(0);
 });
 expect(escaped).toEqual([]);
});

test('a register that breaks off mid-body: the health probe says unhealthy, and nothing escapes',async()=>{
 const creds=createParticipantTls();
 const escaped=await noEscapes(async()=>{
  for(const reply of ['HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort','HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nab']){
   const ended=await listener(creds,reply,'end'),dropped=await listener(creds,reply,'drop');
   expect([reply,await pinnedStatus(ended.target,'/check-in','h'),await pinnedStatus(dropped.target,'/check-in','h')]).toEqual([reply,0,0]);
   const r=await pinnedRequest(dropped.target,{method:'GET',path:'/',headers:{},timeoutMs:2000});
   expect((await failure(read(r)))?.message).toMatch(/closed the connection early/);
  }
  // A whole response is still healthy.
  expect(await pinnedStatus((await listener(creds,'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok','drop')).target,'/check-in','h')).toBe(200);
 });
 expect(escaped).toEqual([]);
});

test('framing headers are canonical: one Content-Length (identical lists collapsed), no Transfer-Encoding after decoding',async()=>{
 const creds=createParticipantTls();
 const framing=(h:string[])=>h.flatMap((v,i)=>i%2===0&&/^(content-length|transfer-encoding)$/i.test(v)?[`${v}: ${h[i+1]}`]:[]);
 for(const [reply,want,body] of [
  ['HTTP/1.1 200 OK\r\nContent-Length: 2, 2\r\n\r\nok',['Content-Length: 2'],'ok'],
  ['HTTP/1.1 200 OK\r\nContent-Length: 2\r\ncontent-length: 2 \r\n\r\nok',['Content-Length: 2'],'ok'],
  ['HTTP/1.1 200 OK\r\nContent-Length: 002\r\n\r\nok',['Content-Length: 2'],'ok'],
  ['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n',[],'ok'],
 ] as [string,string[],string][]){
  const l=await listener(creds,reply);
  const r=await pinnedRequest(l.target,{method:'GET',path:'/',headers:{},timeoutMs:2000});
  expect([reply,framing(r.rawHeaders),await read(r)]).toEqual([reply,want,body]);
 }
 for(const reply of ['HTTP/1.1 200 OK\r\nContent-Length: 2, 3\r\n\r\nok','HTTP/1.1 200 OK\r\nContent-Length: 2,\r\n\r\nok']){
  const l=await listener(creds,reply);
  expect((await failure(pinnedRequest(l.target,{method:'GET',path:'/',headers:{},timeoutMs:2000})))?.message).toMatch(/Content-Length/);
 }
});

test('a caller that drops the body closes the connection to the register',async()=>{
 const creds=createParticipantTls();
 const l=await listener(creds,'HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npart','hold');
 const r=await pinnedRequest(l.target,{method:'GET',path:'/',headers:{},timeoutMs:5000});
 await new Promise(res=>setTimeout(res,30));
 expect(l.closed()).toBe(0);
 r.body.destroy();
 await new Promise(res=>setTimeout(res,100));
 expect(l.closed()).toBe(1);
});
