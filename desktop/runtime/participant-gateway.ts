// The participant gateway: the only thing cloudflared ever points at. It is an HTTP server owned by the runtime (Node,
// in Electron's main process), bound on 127.0.0.1 before cloudflared starts and kept bound for the whole session,
// through every restart of the register. It forwards a fixed list of participant and device paths to the register's
// participant listener, and nothing else:
//   - only while the runtime says its own register child is running (setUpstream); the runtime switches it off
//     synchronously before it signals the register and when the register's exit is seen; otherwise 503;
//   - only to the one upstream the runtime set, never to a host or port taken from the request: on macOS a Unix socket
//     in the runtime's private folder (no other account can bind that path, so a crashed register's place cannot be
//     taken before its exit is seen); on Windows (or when forced) 127.0.0.1 and a port, over TLS pinned to the
//     certificate made for that register spawn (participant-tls.ts): a program that took the port is refused during
//     the handshake, before any request byte is sent, and gets 503 (see desktop/README-runtime.md);
//   - with the Host header unchanged (the register checks it against the public origin), hop-by-hop headers removed,
//     request bodies capped at 64 KB, and no protocol upgrades.
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {pinnedRequest,isFingerprint,bodyFailed} from './participant-tls.ts';

export const GATEWAY_BODY_LIMIT=65536;
// Where the register's participant listener is: a Unix socket path (macOS), or a loopback port with the SHA-256
// fingerprint (hex) of the certificate made for that register spawn (Windows, or macOS when forced).
export type Upstream={socketPath:string}|{port:number;fingerprint:string};

// What the register's participant listener serves (server/http-attendance.ts with participantOnly, and the device
// routes of server/http-device-attendance.ts). Paths are matched after URL normalisation, and the normalised path is
// what is forwarded, so `/check-in/../api/roster` is refused rather than passed on.
const EXACT=new Set(['/','/check-in','/sw.js','/api/participant-names','/api/participant-check-in','/pair']);
export function gatewayAllows(pathname:string):boolean{
 return EXACT.has(pathname)||/^\/assets\/[a-zA-Z0-9_.-]+$/.test(pathname)&&!pathname.includes('..')||/^\/device\/v1\/[a-z]+$/.test(pathname);
}

const HOP_BY_HOP=new Set(['connection','keep-alive','proxy-connection','proxy-authenticate','proxy-authorization','te','trailer','trailers','transfer-encoding','upgrade','http2-settings','expect']);
// Removes hop-by-hop headers, including any named by any Connection header. Works on the raw header list, because
// runtimes differ in how they fold repeated headers (Bun keeps only the last Connection header in `headers`).
export function endToEndHeaders(rawHeaders:string[]):http.OutgoingHttpHeaders{
 const named=new Set<string>();
 for(let i=0;i+1<rawHeaders.length;i+=2)if(rawHeaders[i].toLowerCase()==='connection')for(const t of rawHeaders[i+1].split(','))if(t.trim())named.add(t.trim().toLowerCase());
 const out:Record<string,string|string[]>={};
 for(let i=0;i+1<rawHeaders.length;i+=2){
  const k=rawHeaders[i].toLowerCase(),v=rawHeaders[i+1];
  if(HOP_BY_HOP.has(k)||named.has(k))continue;
  const prev=out[k];
  if(prev===undefined)out[k]=k==='set-cookie'?[v]:v;
  else if(Array.isArray(prev))prev.push(v);
  else if(k!=='host'&&k!=='content-length')out[k]=`${prev}, ${v}`; // a second Host or Content-Length is ignored
 }
 return out;
}

const SECURITY={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Type':'application/json; charset=utf-8'};
export const GATEWAY_UNAVAILABLE='Check-in is not available right now. Try again in a moment.';

export type ParticipantGateway={
 // Binds 127.0.0.1 on a port the system chooses; resolves with it. Idempotent while bound.
 start:()=>Promise<number>;
 // The register's participant listener while it runs, or null (then every request gets 503).
 setUpstream:(upstream:Upstream|null)=>void;
 close:()=>Promise<void>;
 readonly port:number|null;
 readonly upstream:Upstream|null;
};

export function createParticipantGateway(opts:{bodyLimit?:number;upstreamTimeoutMs?:number}={}):ParticipantGateway{
 const limit=opts.bodyLimit??GATEWAY_BODY_LIMIT;
 let upstream:Upstream|null=null;let port:number|null=null;
 let server:http.Server|null=null;
 const sockets=new Set<net.Socket>();

 const reply=(res:http.ServerResponse,status:number,error:string,extra:Record<string,string>={})=>{
  if(res.headersSent){res.destroy();return;}
  res.writeHead(status,{...SECURITY,...extra,Connection:'close'});res.end(JSON.stringify({error}));
 };

 function handle(req:http.IncomingMessage,res:http.ServerResponse){
  const raw=req.url??'';
  // Origin-form only: an absolute-form target (`GET http://elsewhere/`) never chooses where the request goes.
  if(!raw.startsWith('/')||raw.startsWith('//'))return reply(res,400,'Bad request.');
  let url:URL;try{url=new URL(raw,'http://gateway.invalid')}catch{return reply(res,400,'Bad request.')}
  if(!gatewayAllows(url.pathname))return reply(res,404,'Not found.');
  if(upstream===null)return reply(res,503,GATEWAY_UNAVAILABLE,{'Retry-After':'2'});
  const declared=req.headers['content-length'];
  if(declared!==undefined&&!(Number(declared)<=limit))return reply(res,413,'The request is too large.');
  const chunks:Buffer[]=[];let size=0;let aborted=false;
  req.on('data',(c:Buffer)=>{if(aborted)return;size+=c.length;if(size>limit){aborted=true;reply(res,413,'The request is too large.');req.destroy();return;}chunks.push(c);});
  req.on('error',()=>{aborted=true;});
  req.on('end',()=>{
   if(aborted)return;
   const target=upstream;
   if(target===null)return reply(res,503,GATEWAY_UNAVAILABLE,{'Retry-After':'2'});
   const body=Buffer.concat(chunks);
   const headers=endToEndHeaders(req.rawHeaders);
   delete headers['content-length'];
   if(body.length||!['GET','HEAD'].includes(req.method??''))headers['content-length']=String(body.length);
   // A public client that goes away before its response has finished takes the upstream exchange with it: the
   // connection to the register (and, during the TLS handshake, the handshake) is destroyed at once rather than left
   // to the inactivity timeout, so aborted requests cannot pile up open sockets. Nothing is sent after the abort.
   const gone=new AbortController();
   const dropped=()=>gone.signal.aborted;
   const onClose=()=>{if(!res.writableFinished)gone.abort();};
   if(res.destroyed||req.socket.destroyed)return;
   res.once('close',onClose);
   const unavailable=()=>{if(!dropped())reply(res,503,GATEWAY_UNAVAILABLE,{'Retry-After':'2'});};
   const timeoutMs=opts.upstreamTimeoutMs??30000;
   if(!('socketPath' in target)){
    // Loopback TCP: TLS pinned to this register spawn's certificate; nothing is written until the pin matches, and
    // nothing at all if forwarding was switched off while the handshake ran.
    // Every failure is a controlled answer: before the head is written, 503; after it, the response is cut off (the
    // public client never sees a short body as complete). The body may already have failed (e.g. a bad chunk in the
    // packet that carried the head) by the time this runs; pinnedRequest keeps that in body.errored.
    pinnedRequest(target,{method:req.method??'GET',path:url.pathname+url.search,headers,body,timeoutMs,signal:gone.signal},()=>upstream===target&&!dropped()).then(r=>{
     if(dropped()||bodyFailed(r.body)){r.body.destroy();return unavailable();}
     r.body.on('error',()=>res.destroy());
     gone.signal.addEventListener('abort',()=>r.body.destroy(),{once:true});
     try{res.writeHead(r.statusCode,endToEndHeaders(r.rawHeaders));}catch{r.body.destroy();return unavailable();}
     r.body.pipe(res);
    }).catch(unavailable);
    return;
   }
   const up=http.request({socketPath:target.socketPath,method:req.method,path:url.pathname+url.search,headers,agent:false,timeout:timeoutMs},r=>{
    r.on('error',()=>res.destroy());
    if(dropped()){r.destroy();return;}
    res.writeHead(r.statusCode??502,endToEndHeaders(r.rawHeaders));
    r.pipe(res);
   });
   up.on('timeout',()=>up.destroy(new Error('timeout')));
   up.on('error',unavailable);
   // Destroying the request destroys its socket, and with it any response that is streaming.
   gone.signal.addEventListener('abort',()=>up.destroy(),{once:true});
   up.end(body);
  });
 }

 const api:ParticipantGateway={
  async start(){
   if(server&&port!==null)return port;
   const s=http.createServer(handle);
   s.headersTimeout=15000;s.requestTimeout=30000;s.maxHeadersCount=100;
   // No upgrade listener: Node refuses protocol upgrades; the header is also stripped above.
   s.on('upgrade',(_req,socket:net.Socket)=>socket.destroy());
   s.on('connection',sock=>{sockets.add(sock);sock.on('close',()=>sockets.delete(sock));});
   s.on('clientError',(_e,sock:net.Socket)=>{try{sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')}catch{}});
   // Port 0 on loopback cannot collide in principle; retry a few times on EADDRINUSE all the same.
   for(let attempt=0;;attempt++){
    try{
     port=await new Promise<number>((resolve,reject)=>{
      const onError=(e:Error)=>{s.off('listening',onListen);reject(e)};
      const onListen=()=>{s.off('error',onError);resolve((s.address() as net.AddressInfo).port)};
      s.once('error',onError);s.once('listening',onListen);
      s.listen({port:0,host:'127.0.0.1',exclusive:true});
     });
     break;
    }catch(e){if((e as NodeJS.ErrnoException).code!=='EADDRINUSE'||attempt>=4)throw e;}
   }
   server=s;
   return port;
  },
  setUpstream(u){
   if(u===null){upstream=null;return;}
   if('socketPath' in u){
    if(typeof u.socketPath!=='string'||!path.isAbsolute(u.socketPath))throw new Error('Invalid participant listener socket.');
    upstream={socketPath:u.socketPath};return;
   }
   const p=u.port;
   if(!Number.isInteger(p)||p<1||p>65535||p===port)throw new Error('Invalid participant listener port.');
   // A TCP upstream is never used without a pinned certificate.
   if(!isFingerprint(u.fingerprint))throw new Error('Invalid participant listener certificate fingerprint.');
   upstream={port:p,fingerprint:u.fingerprint};
  },
  async close(){
   upstream=null;
   const s=server;server=null;port=null;
   if(!s)return;
   await new Promise<void>(resolve=>{s.close(()=>resolve());for(const sock of sockets)sock.destroy();});
  },
  get port(){return port},
  get upstream(){return upstream},
 };
 return api;
}
