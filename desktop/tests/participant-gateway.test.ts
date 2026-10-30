import {test,expect,afterEach} from 'bun:test';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createParticipantGateway,gatewayAllows,GATEWAY_BODY_LIMIT,PROBE_ANSWER,type ParticipantGateway,type Upstream} from '../runtime/participant-gateway.ts';
import {freeLoopbackPort} from '../runtime/process-control.ts';
import {spawn} from 'node:child_process';
import {createParticipantTls,participantTlsPem,type ParticipantTls} from '../runtime/participant-tls.ts';

// A stand-in for the register's participant listener: echoes what reached it. Bound on 127.0.0.1, port 0, serving
// HTTPS with a certificate made for it (as each register spawn gets on Windows), or on a Unix socket (macOS).
type Seen={method:string;url:string;headers:http.IncomingHttpHeaders;bytes:number};
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const c of cleanups.splice(0))await c();});

async function upstream(socketPath?:string,creds:ParticipantTls=createParticipantTls(),port=0){
 const seen:Seen[]=[];
 const handler:http.RequestListener=(req,res)=>{let bytes=0;req.on('data',c=>bytes+=c.length);req.on('end',()=>{seen.push({method:req.method!,url:req.url!,headers:req.headers,bytes});res.writeHead(200,{'Content-Type':'application/json','Connection':'keep-alive','Keep-Alive':'timeout=5','X-Upstream':'yes'});res.end(JSON.stringify({ok:true}));});};
 const srv=socketPath?http.createServer(handler):https.createServer(participantTlsPem(creds),handler);
 await new Promise<void>(r=>socketPath?srv.listen(socketPath,()=>r()):srv.listen({port,host:'127.0.0.1'},()=>r()));
 cleanups.push(()=>new Promise(r=>{srv.closeAllConnections();srv.close(()=>r());}));
 const at=socketPath?0:(srv.address() as net.AddressInfo).port;
 return {port:at,seen,srv,target:{port:at,fingerprint:creds.fingerprint}};
}
async function gateway(){
 const g=createParticipantGateway({upstreamTimeoutMs:2000});
 const port=await g.start();
 cleanups.push(()=>g.close());
 return {g,port};
}
// Raw HTTP/1.1 on the gateway port (fetch forbids setting Host and hop-by-hop headers). Resolves once the whole
// response has arrived (Bun's node:http does not always close the socket after `Connection: close`).
function raw(port:number,text:string):Promise<{status:number;head:string;body:string}>{
 return new Promise((resolve,reject)=>{
  const s=net.connect({port,host:'127.0.0.1'});let buf='';let done=false;
  const finish=()=>{if(done)return;const i=buf.indexOf('\r\n\r\n');const head=i<0?buf:buf.slice(0,i);done=true;s.destroy();resolve({status:Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1]??0),head,body:i<0?'':buf.slice(i+4)});};
  s.on('data',d=>{
   buf+=d;const i=buf.indexOf('\r\n\r\n');if(i<0)return;
   const head=buf.slice(0,i),body=buf.slice(i+4);
   const len=/\r\ncontent-length: *(\d+)/i.exec(head)?.[1];
   if(len!==undefined?Buffer.byteLength(body)>=Number(len):/\r\ntransfer-encoding: *chunked/i.test(head)&&/(^|\r\n)0\r\n\r\n$/.test(body))finish();
  });
  s.on('error',e=>{if(!done&&buf)finish();else if(!done)reject(e);});s.on('close',finish);
  s.write(text);
 });
}
const get=(port:number,p:string,extra='')=>raw(port,`GET ${p} HTTP/1.1\r\nHost: gentle-example-river-test.trycloudflare.com\r\n${extra}Connection: close\r\n\r\n`);

test('allow-list: participant and device paths only, after normalisation',()=>{
 for(const p of ['/','/check-in','/sw.js','/assets/index-abc123.js','/api/participant-names','/api/participant-check-in','/pair','/device/v1/hello','/device/v1/roster'])expect([p,gatewayAllows(p)]).toEqual([p,true]);
 for(const p of ['/api/roster','/api/check-in-window','/api/login','/api/organiser/devices','/api/names','/api/organiser/pairing-sessions','/api/organiser/recovery-import','/api/add-participant','/device','/device/v1/hello/x','/index.html','/assets/','/assets/a/b.js','/device/v1/','/device/v2/hello','/device/v1/Hello','/check-in/x','/server/start-attendance.ts'])expect([p,gatewayAllows(p)]).toEqual([p,false]);
});

test('bound on 127.0.0.1 before any upstream; answers 503 until the register runs; never forwards the organiser API',async()=>{
 const {g,port}=await gateway();
 expect(g.port).toBe(port);
 expect(await g.start()).toBe(port); // idempotent while bound
 expect((await get(port,'/check-in')).status).toBe(503);
 const up=await upstream();g.setUpstream(up.target);
 const page=await get(port,'/check-in');
 expect(page.status).toBe(200);
 for(const p of ['/api/roster','/api/check-in-window','/check-in/../api/roster','/check-in/%2e%2e/api/roster','/assets/..%2fapi/roster'])expect([p,(await get(port,p)).status]).toEqual([p,404]);
 expect(up.seen.map(s=>s.url)).toEqual(['/check-in']);
 g.setUpstream(null);
 expect((await get(port,'/check-in')).status).toBe(503);
 const fingerprint=up.target.fingerprint;
 expect(()=>g.setUpstream({port,fingerprint})).toThrow(/Invalid/);
 expect(()=>g.setUpstream({port:70000,fingerprint})).toThrow(/Invalid/);
 // A TCP upstream is never used without a pinned certificate.
 expect(()=>g.setUpstream({port:up.port} as never)).toThrow(/fingerprint/);
 expect(()=>g.setUpstream({port:up.port,fingerprint:'AB'})).toThrow(/fingerprint/);
});

test('the request target never chooses the destination: absolute-form and authority-form are refused',async()=>{
 const {g,port}=await gateway();const up=await upstream();g.setUpstream(up.target);
 expect((await raw(port,`GET http://127.0.0.1:${up.port}/api/roster HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`)).status).toBe(400);
 expect((await raw(port,`GET //evil.example/check-in HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)).status).toBe(400);
 expect((await raw(port,`CONNECT 127.0.0.1:22 HTTP/1.1\r\nHost: 127.0.0.1:22\r\n\r\n`)).status).not.toBe(200);
 expect(up.seen).toEqual([]);
});

test('Host is preserved; hop-by-hop headers are stripped both ways; upgrades are refused',async()=>{
 const {g,port}=await gateway();const up=await upstream();g.setUpstream(up.target);
 const r=await get(port,'/api/participant-names?x=1','Keep-Alive: timeout=99\r\nX-Hop: secret\r\nConnection: X-Hop\r\nProxy-Authorization: Basic Zm9v\r\nTE: trailers\r\nAuthorization: Bearer fictional-device-credential\r\n');
 expect(r.status).toBe(200);
 const h=up.seen[0].headers;
 expect(up.seen[0].url).toBe('/api/participant-names?x=1');
 expect(h.host).toBe('gentle-example-river-test.trycloudflare.com');
 expect(h['x-hop']).toBeUndefined();expect(h['proxy-authorization']).toBeUndefined();expect(h.te).toBeUndefined();expect(h['keep-alive']).toBeUndefined();
 expect(h.authorization).toBe('Bearer fictional-device-credential'); // end-to-end: device routes need it
 expect(r.head.toLowerCase()).toContain('x-upstream: yes');
 expect(r.head.toLowerCase()).not.toContain('keep-alive: timeout=5');
 const upg=await raw(port,`GET /check-in HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
 expect(upg.status).not.toBe(101);
 expect(up.seen).toHaveLength(1);
});

test('bodies are capped at 64 KB, declared or streamed',async()=>{
 const {g,port}=await gateway();const up=await upstream();g.setUpstream(up.target);
 const post=(len:number,chunked:boolean)=>{
  const body='x'.repeat(len);
  if(!chunked)return raw(port,`POST /api/participant-check-in HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${len}\r\nConnection: close\r\n\r\n${body}`);
  return raw(port,`POST /api/participant-check-in HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${len.toString(16)}\r\n${body}\r\n0\r\n\r\n`);
 };
 expect((await post(GATEWAY_BODY_LIMIT,false)).status).toBe(200);
 expect(up.seen.at(-1)?.bytes).toBe(GATEWAY_BODY_LIMIT);
 expect((await post(GATEWAY_BODY_LIMIT+1,false)).status).toBe(413);
 expect((await post(GATEWAY_BODY_LIMIT+1,true)).status).toBe(413);
 expect((await post(10,true)).status).toBe(200);
 expect(up.seen.at(-1)?.headers['transfer-encoding']).toBeUndefined();
 expect(up.seen.at(-1)?.headers['content-length']).toBe('10');
 expect(up.seen).toHaveLength(2);
});

test('fails closed: a register that has stopped listening gives 503, never another destination',async()=>{
 const {g,port}=await gateway();
 g.setUpstream({port:await freeLoopbackPort(),fingerprint:createParticipantTls().fingerprint}); // nothing listens there
 const r=await get(port,'/check-in');
 expect(r.status).toBe(503);
 expect(r.body).toContain('not available');
});

// Under Node, where the gateway runs (Electron's main process): on Windows, Bun 1.3's node:http server never closed the
// idle connection on close (the test timed out there), which says nothing about the app.
test('close frees the port and drops open connections; start binds again',async()=>{
 const host=await nodeGateway(null);
 const idle=net.connect({port:host.port,host:'127.0.0.1'});await new Promise(r=>idle.once('connect',r));
 const closed=new Promise(r=>idle.once('close',r));
 expect(await host.command('close',/^CLOSED (.*)$/m)).toBe('null null');
 await closed;
 // The port is free: something else can bind it now.
 const probe=net.createServer();await new Promise<void>((r,j)=>{probe.once('error',j);probe.listen({port:host.port,host:'127.0.0.1'},()=>r());});
 await new Promise<void>(r=>probe.close(()=>r()));
 expect(Number(await host.command('start',/^PORT (\d+)$/gm,2))).toBeGreaterThan(0);
 expect(host.escapes()).toEqual([]);
});

test('macOS upstream: a Unix socket in a private folder; once its listener is gone, 503 and nothing else is reached',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'aw-gw-'));cleanups.push(async()=>rmSync(dir,{recursive:true,force:true}));
 const socketPath=path.join(dir,'p-test.sock');
 const {g,port}=await gateway();const up=await upstream(socketPath);
 g.setUpstream({socketPath});
 expect(g.upstream).toEqual({socketPath});
 const ok=await get(port,'/api/participant-names','Authorization: Bearer fictional-device-credential\r\n');
 expect(ok.status).toBe(200);
 expect(up.seen[0].headers.authorization).toBe('Bearer fictional-device-credential');
 // The listener dies before anyone tells the gateway: nothing accepts on that path, so the gateway says 503.
 await new Promise<void>(r=>{up.srv.closeAllConnections();up.srv.close(()=>r());});
 expect((await get(port,'/check-in')).status).toBe(503);
 expect(up.seen).toHaveLength(1);
 expect(()=>g.setUpstream({socketPath:'relative.sock'})).toThrow(/Invalid/);
});

// Windows path: something else holds the register's port (it crashed and another account bound it before the exit was
// seen). The gateway must answer 503 without sending that program a single byte of the request.
async function impostorTls(port=0){
 const got:Buffer[]=[];let handshakes=0;
 const srv=tls.createServer(participantTlsPem(createParticipantTls()),sock=>{handshakes++;sock.on('data',d=>got.push(Buffer.from(d)));sock.on('error',()=>{});});
 srv.on('tlsClientError',()=>{});
 await new Promise<void>(r=>srv.listen({port,host:'127.0.0.1'},()=>r()));
 cleanups.push(()=>new Promise(r=>srv.close(()=>r())));
 return {port:(srv.address() as net.AddressInfo).port,got,handshakes:()=>handshakes};
}
async function impostorTcp(port=0){
 const got:Buffer[]=[];
 const socks=new Set<net.Socket>();
 const srv=net.createServer(sock=>{socks.add(sock);sock.on('data',d=>got.push(Buffer.from(d)));sock.on('error',()=>{});sock.on('close',()=>socks.delete(sock));});
 await new Promise<void>(r=>srv.listen({port,host:'127.0.0.1'},()=>r()));
 cleanups.push(()=>new Promise(r=>{for(const s of socks)s.destroy();srv.close(()=>r());}));
 return {port:(srv.address() as net.AddressInfo).port,got:()=>Buffer.concat(got),open:()=>socks.size};
}
const POST_BODY='{"token":"fictional-token-do-not-leak","opId":"x"}';
const post=(port:number)=>raw(port,`POST /api/participant-check-in HTTP/1.1\r\nHost: gentle-example-river-test.trycloudflare.com\r\nContent-Type: application/json\r\nContent-Length: ${POST_BODY.length}\r\nConnection: close\r\n\r\n${POST_BODY}`);

test('Windows path: a TLS listener with another certificate on the port gets the handshake only; the gateway answers 503',async()=>{
 const {g,port}=await gateway();
 const imp=await impostorTls();
 g.setUpstream({port:imp.port,fingerprint:createParticipantTls().fingerprint});
 const r=await post(port);
 expect(r.status).toBe(503);
 expect(r.body).toContain('not available');
 expect((await get(port,'/check-in')).status).toBe(503);
 await new Promise(r=>setTimeout(r,50));
 // The handshake ran (the impostor was really asked), but no request byte arrived over it.
 expect(Buffer.concat(imp.got).length).toBe(0);
});

test('Windows path: a plain TCP listener on the port gets a TLS ClientHello and nothing else; the gateway answers 503',async()=>{
 const {g,port}=await gateway();
 const imp=await impostorTcp();
 g.setUpstream({port:imp.port,fingerprint:createParticipantTls().fingerprint});
 // The plain listener never answers the handshake; the gateway gives up at its timeout and answers 503.
 const r=await post(port);
 expect(r.status).toBe(503);
 const bytes=imp.got();
 expect(bytes.length).toBeGreaterThan(0);
 expect(bytes[0]).toBe(0x16); // a TLS handshake record
 const text=bytes.toString('latin1');
 for(const leak of ['HTTP/1.1','POST','/api/participant','fictional-token-do-not-leak','trycloudflare'])expect([leak,text.includes(leak)]).toEqual([leak,false]);
});

test('Windows path: the organiser listener (plain HTTP, loopback) cannot be reached through the gateway',async()=>{
 const {g,port}=await gateway();
 const seen:string[]=[];
 const organiser=http.createServer((req,res)=>{seen.push(req.url!);res.end('organiser');});
 await new Promise<void>(r=>organiser.listen({port:0,host:'127.0.0.1'},()=>r()));
 cleanups.push(()=>new Promise(r=>{organiser.closeAllConnections();organiser.close(()=>r());}));
 g.setUpstream({port:(organiser.address() as net.AddressInfo).port,fingerprint:createParticipantTls().fingerprint});
 expect((await get(port,'/api/participant-names')).status).toBe(503);
 expect((await get(port,'/api/roster')).status).toBe(404);
 expect(seen).toEqual([]);
});

test('Windows path: a new register spawn has a new certificate; the old pin is refused on the same port',async()=>{
 const {g,port}=await gateway();
 const first=createParticipantTls(),second=createParticipantTls();
 expect(second.fingerprint).not.toBe(first.fingerprint);
 const a=await upstream(undefined,first);
 g.setUpstream(a.target);
 expect((await get(port,'/check-in')).status).toBe(200);
 // The first register is gone; the next one listens on the same port with its own certificate.
 await new Promise<void>(r=>{a.srv.closeAllConnections();a.srv.close(()=>r());});
 const b=await upstream(undefined,second,a.port);
 expect((await get(port,'/check-in')).status).toBe(503); // still pinned to the first spawn
 expect(b.seen).toEqual([]);
 g.setUpstream(b.target);
 expect((await get(port,'/check-in')).status).toBe(200);
 expect(b.seen.map(s=>s.url)).toEqual(['/check-in']);
});

test('Windows path: forwarding switched off during the handshake sends nothing',async()=>{
 const {g,port}=await gateway();
 const up=await upstream();
 // A relay in front of the register holds the handshake until the test has switched forwarding off.
 let connected!:()=>void;const arrived=new Promise<void>(r=>{connected=r});
 let release!:()=>void;const released=new Promise<void>(r=>{release=r});
 const relay=net.createServer(client=>{
  client.pause();connected();
  void released.then(()=>{const to=net.connect({port:up.port,host:'127.0.0.1'});client.pipe(to).pipe(client);client.resume();to.on('error',()=>client.destroy());client.on('error',()=>to.destroy());});
 });
 await new Promise<void>(r=>relay.listen({port:0,host:'127.0.0.1'},()=>r()));
 cleanups.push(()=>new Promise(r=>relay.close(()=>r())));
 g.setUpstream({port:(relay.address() as net.AddressInfo).port,fingerprint:up.target.fingerprint});
 const pending=get(port,'/check-in');
 await arrived;          // the gateway is connecting to the register
 g.setUpstream(null);    // the register's exit is seen now
 release();              // the handshake completes, and the pin matches
 expect((await pending).status).toBe(503);
 await new Promise(r=>setTimeout(r,50));
 expect(up.seen).toEqual([]);
});

// Windows path, a register answering badly: a TLS listener with the pinned certificate that writes `reply` as raw bytes
// and then ends the connection, or cuts it a moment later ('drop').
async function rawRegister(reply:string,then:'end'|'drop'='end'){
 const creds=createParticipantTls();
 const srv=tls.createServer(participantTlsPem(creds),sock=>{let got='';sock.on('error',()=>{});sock.on('data',d=>{
  got+=d;if(!got.includes('\r\n\r\n'))return;
  if(then==='end')sock.end(reply);else{sock.write(reply);setTimeout(()=>sock.destroy(),50);}
 });});
 srv.on('tlsClientError',()=>{});
 await new Promise<void>(r=>srv.listen({port:0,host:'127.0.0.1'},()=>r()));
 cleanups.push(()=>new Promise(r=>srv.close(()=>r())));
 return {port:(srv.address() as net.AddressInfo).port,fingerprint:creds.fingerprint};
}
async function noEscapes(run:()=>Promise<void>):Promise<string[]>{
 const seen:string[]=[];
 const onException=(e:Error)=>seen.push(`uncaughtException: ${e?.message}`);
 const onRejection=(e:unknown)=>seen.push(`unhandledRejection: ${(e as Error)?.message??e}`);
 process.on('uncaughtException',onException);process.on('unhandledRejection',onRejection);
 try{await run();await new Promise(r=>setTimeout(r,100));}
 finally{process.off('uncaughtException',onException);process.off('unhandledRejection',onRejection);}
 return seen;
}

test('Windows path: a bad chunk in the packet with the head gives 503; a register cut off mid-body cuts the response off',async()=>{
 const {g,port}=await gateway();
 const escaped=await noEscapes(async()=>{
  g.setUpstream(await rawRegister('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\nabc\r\n'));
  const bad=await get(port,'/check-in');
  expect(bad.status).toBe(503);
  expect(bad.body).toContain('not available');
  // Head and part of the body arrive, then the connection goes: the public client gets the head and a short body on a
  // closed connection, never a complete-looking response.
  g.setUpstream(await rawRegister('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort','drop'));
  const cut=await get(port,'/check-in');
  expect(cut.status).toBe(200);
  expect(/\r\ncontent-length: *10/i.test(cut.head)).toBe(true);
  expect(cut.body.startsWith('short')).toBe(true);
  expect(Buffer.byteLength(cut.body)).toBeLessThan(10); // under Bun's node:http a stray CRLF may follow; still short
  g.setUpstream(await rawRegister('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nab','drop'));
  const cutChunked=await get(port,'/check-in');
  expect(cutChunked.status).toBe(200);
  expect(cutChunked.body).not.toMatch(/(^|\r\n)0\r\n\r\n$/); // no last chunk: the client sees it as incomplete
 });
 expect(escaped).toEqual([]);
});

test('Windows path: framing headers reach the public client in one canonical form',async()=>{
 const {g,port}=await gateway();
 g.setUpstream(await rawRegister('HTTP/1.1 200 OK\r\nContent-Length: 2, 2\r\nX-Upstream: yes\r\n\r\nok'));
 const r=await get(port,'/check-in');
 expect([r.status,r.body]).toEqual([200,'ok']);
 expect(r.head.match(/^content-length:.*$/gim)).toEqual([expect.stringMatching(/^content-length: 2\r?$/i)]);
 expect(r.head).toMatch(/\r\nx-upstream: yes(\r|$)/i);
 // A de-chunked body is framed by the gateway itself: one Transfer-Encoding at most, never the register's raw header.
 g.setUpstream(await rawRegister('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n'));
 const c=await get(port,'/check-in');
 expect(c.status).toBe(200);
 const te=c.head.match(/^transfer-encoding:.*$/gim)??[],cl=c.head.match(/^content-length:.*$/gim)??[];
 expect(te.length+cl.length).toBe(1); // exactly one framing header, chosen by the gateway
 // A list that disagrees is refused: 503, nothing passed on.
 g.setUpstream(await rawRegister('HTTP/1.1 200 OK\r\nContent-Length: 2, 3\r\n\r\nok'));
 expect((await get(port,'/check-in')).status).toBe(503);
});

// A public client that goes away mid-response: the gateway must close its connection to the register at once, not
// leave it to the inactivity timeout. A register that streams a large body slowly (or holds the head back), on either
// upstream kind, counting the connections it has seen close.
const BIG=4*1024*1024;
async function slowRegister(kind:'unix'|'tls',mode:'stream'|'hold'|'complete'){
 // Raw net/tls servers: Bun's node:http server does not report its sockets closing.
 const creds=createParticipantTls();
 let closed=0,requests=0;
 const onSocket=(sock:net.Socket)=>{
  let got='';sock.on('error',()=>{});sock.on('close',()=>closed++);
  sock.on('data',d=>{
   if(!got.includes('\r\n\r\n')&&(got+=d).includes('\r\n\r\n')){
    requests++;
    if(mode==='hold')return; // never answers
    sock.write(`HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${BIG}\r\nConnection: close\r\n\r\n`);
    if(mode==='complete')sock.end(Buffer.alloc(BIG,97));
    else sock.write(Buffer.alloc(16384,97)); // then nothing more: the body is far from finished
   }
  });
 };
 let socketPath:string|undefined;
 if(kind==='unix'){
  const dir=mkdtempSync(path.join(tmpdir(),'aw-gw-'));cleanups.push(async()=>rmSync(dir,{recursive:true,force:true}));
  socketPath=path.join(dir,'p-slow.sock');
 }
 const socks=new Set<net.Socket>();
 const track=(sock:net.Socket)=>{socks.add(sock);sock.on('close',()=>socks.delete(sock));onSocket(sock);};
 const srv=socketPath?net.createServer(track):tls.createServer(participantTlsPem(creds),track);
 srv.on('tlsClientError',()=>{});
 await new Promise<void>(r=>socketPath?srv.listen(socketPath,()=>r()):srv.listen({port:0,host:'127.0.0.1'},()=>r()));
 cleanups.push(()=>new Promise(r=>{for(const s of socks)s.destroy();srv.close(()=>r());}));
 const target=socketPath?{socketPath}:{port:(srv.address() as net.AddressInfo).port,fingerprint:creds.fingerprint};
 return {target,closed:()=>closed,requests:()=>requests};
}
// The gateway under Node, with the production inactivity timeout (so a prompt close cannot be the timeout). Bun 1.3's
// node:http server gives no sign of a client disconnecting, so these tests run the gateway where it really runs.
async function nodeGateway(target:Upstream|null):Promise<{port:number;escapes:()=>string[];command:(cmd:string,reply:RegExp,nth?:number)=>Promise<string>}>{
 const child=spawn('node',[path.join(import.meta.dirname,'gateway-node-host.ts'),JSON.stringify(target)],{stdio:['pipe','pipe','ignore']});
 let out='';child.stdout.on('data',d=>out+=d);
 const exited=new Promise<void>(r=>child.once('exit',()=>r()));
 // Unshifted: the host is stopped before any other cleanup runs, so a stuck fixture cannot strand it.
 cleanups.unshift(async()=>{child.stdin.end();const t=setTimeout(()=>child.kill(),2000);await exited;clearTimeout(t);});
 const port=await new Promise<number>((resolve,reject)=>{
  const check=()=>{const m=/^PORT (\d+)$/m.exec(out);if(m){child.stdout.off('data',check);resolve(Number(m[1]));}};
  child.stdout.on('data',check);child.once('exit',c=>reject(new Error(`gateway host exited (${c}): ${out}`)));
 });
 // Sends one command line and resolves with the first group of the `nth` match of `reply` in the host's output.
 const command=(cmd:string,reply:RegExp,nth=1)=>new Promise<string>((resolve,reject)=>{
  const t=setTimeout(()=>reject(new Error(`no reply to ${cmd}: ${out}`)),4000);
  const check=()=>{const all=[...out.matchAll(new RegExp(reply.source,'gm'))];if(all.length>=nth){clearTimeout(t);child.stdout.off('data',check);resolve(all[nth-1][1]);}};
  child.stdout.on('data',check);child.stdin.write(cmd+'\n');check();
 });
 return {port,escapes:()=>out.split('\n').filter(l=>l.startsWith('ESCAPE')),command};
}
// Sends a GET and resolves with the socket once `bytes` bytes of the response have arrived (0: once connected and sent).
function openRequest(port:number,bytes:number):Promise<net.Socket>{
 return new Promise((resolve,reject)=>{
  const s=net.connect({port,host:'127.0.0.1'});let got=0;
  s.on('error',reject);
  s.on('connect',()=>{s.write('GET /check-in HTTP/1.1\r\nHost: gentle-example-river-test.trycloudflare.com\r\nConnection: close\r\n\r\n');if(!bytes)resolve(s);});
  s.on('data',d=>{got+=d.length;if(bytes&&got>=bytes)resolve(s);});
 });
}
async function within(ms:number,cond:()=>boolean):Promise<boolean>{
 const until=Date.now()+ms;
 while(Date.now()<until){if(cond())return true;await new Promise(r=>setTimeout(r,10));}
 return cond();
}

// The unix kind runs the gateway under Node, which takes a socket path on Windows for a named pipe; AttendWell never uses a
// Unix socket there. The tls kind is the Windows path and runs everywhere.
const posixOnly=(kind:'unix'|'tls')=>kind==='unix'&&process.platform==='win32';
for(const kind of ['unix','tls'] as const){
 test.skipIf(posixOnly(kind))(`client abort mid-body closes the ${kind} register connection promptly`,async()=>{
  const escaped=await noEscapes(async()=>{
   const reg=await slowRegister(kind,'stream');const {port,escapes}=await nodeGateway(reg.target);
   for(let i=1;i<=3;i++){
    const s=await openRequest(port,8192);
    expect(reg.closed()).toBe(i-1);
    s.destroy();
    expect(await within(500,()=>reg.closed()===i)).toBe(true);
   }
   expect(reg.requests()).toBe(3);
   await new Promise(r=>setTimeout(r,100));
   expect(escapes()).toEqual([]);
  });
  expect(escaped).toEqual([]);
 });

 test.skipIf(posixOnly(kind))(`client abort before the ${kind} register answers closes the register connection promptly`,async()=>{
  const escaped=await noEscapes(async()=>{
   const reg=await slowRegister(kind,'hold');const {port,escapes}=await nodeGateway(reg.target);
   const s=await openRequest(port,0);
   expect(await within(1000,()=>reg.requests()===1)).toBe(true);
   s.destroy();
   expect(await within(500,()=>reg.closed()===1)).toBe(true);
   await new Promise(r=>setTimeout(r,100));
   expect(escapes()).toEqual([]);
  });
  expect(escaped).toEqual([]);
 });

 test.skipIf(posixOnly(kind))(`a large complete response through the ${kind} upstream is unaffected`,async()=>{
  const escaped=await noEscapes(async()=>{
   const reg=await slowRegister(kind,'complete');const {port,escapes}=await nodeGateway(reg.target);
   const r=await get(port,'/check-in');
   expect(r.status).toBe(200);
   expect(Buffer.byteLength(r.body)).toBe(BIG);
   expect(await within(500,()=>reg.closed()===1)).toBe(true);
   await new Promise(r=>setTimeout(r,100));
   expect(escapes()).toEqual([]);
  });
  expect(escaped).toEqual([]);
 });
}

test('Windows path: client abort during the TLS handshake closes the connection; nothing is sent after it',async()=>{
 const escaped=await noEscapes(async()=>{
  // A plain TCP listener never completes the handshake: the gateway is waiting on it when the client goes.
  const imp=await impostorTcp();
  const {port,escapes}=await nodeGateway({port:imp.port,fingerprint:createParticipantTls().fingerprint});
  const s=await openRequest(port,0);
  expect(await within(1000,()=>imp.got().length>0&&imp.open()===1)).toBe(true); // the ClientHello has arrived
  s.destroy();
  // The impostor's side of the connection sees the close well before the 5 s handshake limit.
  expect(await within(500,()=>imp.open()===0)).toBe(true);
  expect(imp.got()[0]).toBe(0x16);
  expect(imp.got().toString('latin1')).not.toContain('HTTP/1.1');
  await new Promise(r=>setTimeout(r,100));
  expect(escapes()).toEqual([]);
 });
 expect(escaped).toEqual([]);
});

test('Windows path: client abort while the handshake is held back; the register later completes it and gets nothing',async()=>{
 const escaped=await noEscapes(async()=>{
  const up=await upstream();
  let connected!:()=>void;const arrived=new Promise<void>(r=>{connected=r});
  let release!:()=>void;const released=new Promise<void>(r=>{release=r});
  let relayClosed=0;
  const relaySockets=new Set<net.Socket>();
  // The relay holds the gateway's handshake back by keeping its bytes, not by pausing the socket: a paused socket on
  // Windows is not told that its peer has closed, so it could not see the gateway let go. It reads throughout.
  const relay=net.createServer(client=>{
   relaySockets.add(client);client.on('close',()=>relaySockets.delete(client));
   const held:Buffer[]=[];let to:net.Socket|null=null;
   client.on('error',()=>{});client.on('close',()=>relayClosed++);
   client.on('data',d=>{if(to)to.write(d);else{held.push(Buffer.from(d));connected();}}); // connected: the ClientHello is here
   void released.then(()=>{
    // The register gets the held handshake either way; only while the gateway is still connected can it go further.
    const t=net.connect({port:up.port,host:'127.0.0.1'});to=t;relaySockets.add(t);t.on('close',()=>relaySockets.delete(t));
    t.on('error',()=>client.destroy());
    if(client.destroyed){t.end(Buffer.concat(held));return;}
    t.write(Buffer.concat(held));
    t.on('data',d=>{if(!client.destroyed)client.write(d);});t.on('end',()=>client.end());client.on('end',()=>t.end());
   });
  });
  await new Promise<void>(r=>relay.listen({port:0,host:'127.0.0.1'},()=>r()));
  // Destroy every accepted socket first: close() only resolves once they are all gone.
  cleanups.push(()=>new Promise(r=>{for(const s of relaySockets)s.destroy();relay.close(()=>r());}));
  const {port,escapes}=await nodeGateway({port:(relay.address() as net.AddressInfo).port,fingerprint:up.target.fingerprint});
  const s=await openRequest(port,0);
  try{
   await arrived;
   s.destroy();
   expect(await within(500,()=>relayClosed===1)).toBe(true);
  }finally{
   s.destroy();
   release(); // runs even when an assertion above fails, so the paused handshake is never stranded
  }
  await new Promise(r=>setTimeout(r,100));
  expect(up.seen).toEqual([]);
  await new Promise(r=>setTimeout(r,100));
  expect(escapes()).toEqual([]);
 });
 expect(escaped).toEqual([]);
});

test('probe path: answered by the gateway itself, only for a registered single-use token, even with no upstream, and the receipt records it',async()=>{
 const {g,port}=await gateway();
 const token=randomBytes(16).toString('hex');
 expect((await raw(port,`GET /_aw/probe/${token} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)).status).toBe(404); // not registered
 const receipt=g.expectProbe(token);
 expect((await raw(port,`POST /_aw/probe/${token} HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)).status).toBe(404);
 expect((await raw(port,`GET /_aw/probe/${'0'.repeat(32)} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)).status).toBe(404);
 expect(receipt.received).toBe(false); // neither the wrong method nor another token counts as receipt
 // Decode HTTP framing with the same standard client used by the connection probe.
 const ok=await fetch(`http://127.0.0.1:${port}/_aw/probe/${token}`);
 expect(ok.status).toBe(200);expect(await ok.text()).toBe(PROBE_ANSWER);expect(receipt.received).toBe(true);
 expect((await raw(port,`GET /_aw/probe/${token} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)).status).toBe(404); // used once
 const withdrawn=g.expectProbe(token);withdrawn.withdraw();
 expect((await raw(port,`GET /_aw/probe/${token} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)).status).toBe(404);
 expect(withdrawn.received).toBe(false);
 expect(()=>g.expectProbe('short')).toThrow();
 // The probe path is not a forwarded path.
 expect(gatewayAllows(`/_aw/probe/${token}`)).toBe(false);
});

test('probe path never reaches the upstream, and a registered token does not open other paths',async()=>{
 const sock=path.join(mkdtempSync(path.join(tmpdir(),'aw-gw-')),'p.sock');cleanups.push(async()=>{rmSync(path.dirname(sock),{recursive:true,force:true});});
 const up=await upstream(sock);const {g,port}=await gateway();g.setUpstream({socketPath:sock});
 const token=randomBytes(16).toString('hex');g.expectProbe(token);
 expect((await raw(port,`GET /_aw/probe/${token} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)).status).toBe(200);
 expect((await raw(port,`GET /_aw/probe/${token}/../api/roster HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)).status).toBe(404);
 expect(up.seen).toHaveLength(0);
});
