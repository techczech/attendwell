// The register's participant listener over loopback TCP (Windows, or macOS when forced): authenticated before any
// request byte is sent. Each register spawn gets a fresh key pair and self-signed certificate made here (in memory;
// the key goes to the register in its environment and is never written or logged). The register serves HTTPS on
// 127.0.0.1 with it, and the gateway connects with TLS and uses the connection only if the peer's certificate has the
// SHA-256 fingerprint pinned for that spawn. No certificate authority and no trust store are involved.
//
// Node's TLS client completes the handshake with `rejectUnauthorized: false`; the handshake itself proves that the peer
// holds the private key of the certificate it presented (TLS 1.3 CertificateVerify), and the pin then says which
// certificate that must be. Only after the pin matches is anything written to the socket, so a program that took the
// port gets a TLS ClientHello and nothing else. The HTTP exchange on the verified socket is a small HTTP/1.1 client
// below (one request per connection, `Connection: close`), because Node's http client cannot be handed an
// already-verified socket in every runtime this code runs in (Bun's ignores `createConnection`).
//
// Node APIs only: runs in Electron's main process (gateway, supervisor) and under Bun in the tests.
import crypto from 'node:crypto';
import tls from 'node:tls';
import {PassThrough,type Readable} from 'node:stream';
import type {OutgoingHttpHeaders} from 'node:http';

// ---------------------------------------------------------------------------------------------------------------------
// A self-signed P-256 certificate, built as DER with node:crypto only (no native or third-party dependency)

export type ParticipantTls={key:Buffer;cert:Buffer;fingerprint:string}; // key: PKCS#8 DER; cert: X.509 DER

const derLength=(n:number)=>n<0x80?Buffer.from([n]):n<0x100?Buffer.from([0x81,n]):Buffer.from([0x82,n>>8,n&255]);
const tlv=(tag:number,body:Buffer)=>Buffer.concat([Buffer.from([tag]),derLength(body.length),body]);
const seq=(...parts:Buffer[])=>tlv(0x30,Buffer.concat(parts));
const derInt=(b:Buffer)=>tlv(0x02,b[0]&0x80?Buffer.concat([Buffer.from([0]),b]):b);
const oid=(dotted:string)=>{
 const a=dotted.split('.').map(Number);const out=[40*a[0]+a[1]];
 for(const v of a.slice(2)){const b=[v&127];for(let x=Math.floor(v/128);x;x=Math.floor(x/128))b.unshift((x&127)|128);out.push(...b);}
 return tlv(0x06,Buffer.from(out));
};
const utcTime=(ms:number)=>tlv(0x17,Buffer.from(new Date(ms).toISOString().replace(/[-:T]/g,'').slice(2,14)+'Z','ascii'));

export const certificateFingerprint=(der:Buffer)=>crypto.createHash('sha256').update(der).digest('hex');

// A fresh key pair and certificate (CN "AttendWell register", valid from an hour ago for 30 days; validity is never
// checked, the pin is). ECDSA with SHA-256 on P-256.
export function createParticipantTls(now:number=Date.now()):ParticipantTls{
 const {privateKey,publicKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const ecdsaSha256=seq(oid('1.2.840.10045.4.3.2'));
 const name=seq(tlv(0x31,seq(oid('2.5.4.3'),tlv(0x0c,Buffer.from('AttendWell register','utf8')))));
 const serial=crypto.randomBytes(16);serial[0]=(serial[0]&0x7f)|0x01;
 const tbs=seq(
  tlv(0xa0,derInt(Buffer.from([2]))), // v3
  derInt(serial),ecdsaSha256,name,
  seq(utcTime(now-3600_000),utcTime(now+30*86400_000)),
  name,
  publicKey.export({type:'spki',format:'der'}) as Buffer,
 );
 const signature=crypto.sign('sha256',tbs,privateKey); // DER ECDSA-Sig-Value
 const cert=seq(tbs,ecdsaSha256,tlv(0x03,Buffer.concat([Buffer.from([0]),signature])));
 return {key:privateKey.export({type:'pkcs8',format:'der'}) as Buffer,cert,fingerprint:certificateFingerprint(cert)};
}

// What the register gets on its standard input (with its organiser key; see serviceSecrets): base64 DER.
export const participantTlsSecrets=(t:ParticipantTls)=>({tlsKey:t.key.toString('base64'),tlsCert:t.cert.toString('base64')});

const pem=(label:string,der:Buffer)=>`-----BEGIN ${label}-----\n${der.toString('base64').replace(/(.{64})/g,'$1\n').replace(/\n$/,'')}\n-----END ${label}-----\n`;
// PEM text for a TLS server (tests; the register converts what it is given the same way).
export const participantTlsPem=(t:ParticipantTls)=>({key:pem('PRIVATE KEY',t.key),cert:pem('CERTIFICATE',t.cert)});

export const isFingerprint=(f:unknown):f is string=>typeof f==='string'&&/^[0-9a-f]{64}$/.test(f);

// ---------------------------------------------------------------------------------------------------------------------
// Pinned connection

export class PinMismatch extends Error {}
export type PinnedTarget={port:number;fingerprint:string};

// Connects to 127.0.0.1:port with TLS and resolves with the socket only if the peer's certificate has `fingerprint`.
// Nothing is written before that; on a mismatch, an error, or the timeout, the socket is destroyed and the promise rejects.
// A loopback handshake takes milliseconds, so it is never given more than HANDSHAKE_LIMIT_MS. An aborted `signal`
// (the caller no longer wants the answer) destroys the socket at once, mid-handshake included.
export const HANDSHAKE_LIMIT_MS=5000;
export function connectPinned(target:PinnedTarget,timeoutMs=HANDSHAKE_LIMIT_MS,signal?:AbortSignal):Promise<tls.TLSSocket>{
 timeoutMs=Math.min(timeoutMs,HANDSHAKE_LIMIT_MS);
 return new Promise((resolve,reject)=>{
  if(!isFingerprint(target.fingerprint)){reject(new PinMismatch('No pinned certificate.'));return;}
  if(signal?.aborted){reject(new Error('The request was withdrawn.'));return;}
  const want=Buffer.from(target.fingerprint,'hex');
  const sock=tls.connect({host:'127.0.0.1',port:target.port,rejectUnauthorized:false,minVersion:'TLSv1.3',ALPNProtocols:['http/1.1']});
  let settled=false;
  const onAbort=()=>fail(new Error('The request was withdrawn.'));
  const fail=(e:Error)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',onAbort);sock.destroy();reject(e);};
  signal?.addEventListener('abort',onAbort,{once:true});
  sock.setTimeout(timeoutMs,()=>fail(new Error('The participant listener did not answer in time.')));
  sock.on('error',fail);
  sock.once('close',()=>fail(new Error('The participant listener closed the connection.')));
  sock.once('secureConnect',()=>{
   if(settled)return;
   const raw=sock.getPeerCertificate(true)?.raw;
   const got=Buffer.isBuffer(raw)?crypto.createHash('sha256').update(raw).digest():null;
   if(!got||got.length!==want.length||!crypto.timingSafeEqual(got,want))return fail(new PinMismatch('The participant listener did not present the certificate pinned for this register.'));
   settled=true;signal?.removeEventListener('abort',onAbort);sock.setTimeout(0);sock.off('error',fail);
   sock.on('error',()=>{}); // later errors surface through pinnedRequest's own listeners
   resolve(sock);
  });
 });
}

// ---------------------------------------------------------------------------------------------------------------------
// One HTTP/1.1 request on a pinned connection

// signal: aborting it at any point (handshake, waiting for the head, streaming the body) destroys the connection to the
// register; before the request is sent, nothing is sent.
export type PinnedRequest={method:string;path:string;headers:OutgoingHttpHeaders;body?:Buffer;timeoutMs?:number;signal?:AbortSignal};
// rawHeaders describe the decoded message: exactly one canonical Content-Length when the response carried one (an
// identical-value list such as `2, 2` is collapsed, RFC 9110 section 8.6), and no Transfer-Encoding (a chunked body
// arrives decoded). body never raises an uncaught error: it has its own error listener from the moment it exists, so
// a failure that happens before the caller attaches one is kept in `body.errored`. Check that first (bodyFailed).
export type PinnedResponse={statusCode:number;rawHeaders:string[];body:Readable};
export const bodyFailed=(body:Readable):boolean=>Boolean(body.errored)||body.destroyed&&!body.readableEnded;
const TOKEN=/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEAD_LIMIT=65536;

function requestHead(target:PinnedTarget,r:PinnedRequest):string{
 if(!TOKEN.test(r.method)||!/^\/[\x21-\x7e]*$/.test(r.path))throw new Error('Invalid request line.');
 const lines=[`${r.method} ${r.path} HTTP/1.1`];let host=false;
 for(const [k,v] of Object.entries(r.headers)){
  if(v===undefined||k.toLowerCase()==='connection')continue;
  if(!TOKEN.test(k))throw new Error('Invalid header name.');
  for(const one of Array.isArray(v)?v:[String(v)]){
   if(/[\r\n\0]/.test(one))throw new Error('Invalid header value.');
   lines.push(`${k}: ${one}`);
  }
  if(k.toLowerCase()==='host')host=true;
 }
 if(!host)lines.push(`Host: 127.0.0.1:${target.port}`);
 lines.push('Connection: close');
 return lines.join('\r\n')+'\r\n\r\n';
}

type Framing={kind:'none'}|{kind:'length';left:number}|{kind:'chunked'}|{kind:'close'};
function parseHead(head:string,method:string):{statusCode:number;rawHeaders:string[];framing:Framing}{
 const lines=head.split('\r\n');
 const status=/^HTTP\/1\.[01] ([1-9]\d\d)(?: [^\r\n]*)?$/.exec(lines[0]);
 if(!status)throw new Error('Invalid status line.');
 const statusCode=Number(status[1]);
 if(statusCode<200)throw new Error('Unexpected interim response.');
 // Framing headers are taken out of the list as they are read; what goes back in is only what describes the decoded
 // body, so no list, duplicate or Transfer-Encoding is ever passed on.
 const rawHeaders:string[]=[];const lengths=new Set<string>();let te:string|null=null;
 for(const line of lines.slice(1)){
  const m=/^([^:\s]+):[ \t]*(.*?)[ \t]*$/.exec(line);
  if(!m||!TOKEN.test(m[1])||/[\r\n\0]/.test(m[2]))throw new Error('Invalid response header.');
  const k=m[1].toLowerCase();
  if(k==='content-length'){for(const v of m[2].split(','))lengths.add(v.trim());continue;}
  if(k==='transfer-encoding'){te=te===null?m[2]:`${te}, ${m[2]}`;continue;}
  rawHeaders.push(m[1],m[2]);
 }
 let length:number|null=null;
 if(lengths.size){
  const [v]=[...lengths];
  if(lengths.size!==1||!/^\d{1,15}$/.test(v))throw new Error('Invalid Content-Length.');
  length=Number(v);
 }
 if(te!==null&&(length!==null||te.trim().toLowerCase()!=='chunked'))throw new Error('Unsupported response framing.');
 if(length!==null)rawHeaders.push('Content-Length',String(length));
 if(method==='HEAD'||statusCode===204||statusCode===304)return {statusCode,rawHeaders,framing:{kind:'none'}};
 if(te!==null)return {statusCode,rawHeaders,framing:{kind:'chunked'}};
 if(length!==null)return {statusCode,rawHeaders,framing:length?{kind:'length',left:length}:{kind:'none'}};
 return {statusCode,rawHeaders,framing:{kind:'close'}};
}

// Decodes a chunked body: feed() bytes in, returns the data bytes and whether the last chunk and trailers have arrived.
function chunkedDecoder(){
 let buf=Buffer.alloc(0);let state:'size'|'data'|'crlf'|'trailer'|'done'='size';let left=0;
 return (more:Buffer):{data:Buffer[];done:boolean}=>{
  buf=Buffer.concat([buf,more]);const data:Buffer[]=[];
  for(;;){
   if(state==='done')return {data,done:true};
   if(state==='data'){
    if(!buf.length)break;
    const take=Math.min(left,buf.length);data.push(buf.subarray(0,take));buf=buf.subarray(take);left-=take;
    if(!left)state='crlf';continue;
   }
   if(state==='crlf'){
    if(buf.length<2)break;
    if(buf[0]!==13||buf[1]!==10)throw new Error('Invalid chunk.');
    buf=buf.subarray(2);state='size';continue;
   }
   const eol=buf.indexOf('\r\n');
   if(eol<0){if(buf.length>4096)throw new Error('Invalid chunk.');break;}
   const line=buf.subarray(0,eol).toString('latin1');buf=buf.subarray(eol+2);
   if(state==='size'){
    const m=/^([0-9a-fA-F]{1,8})(?:[ \t]*;.*)?$/.exec(line);if(!m)throw new Error('Invalid chunk size.');
    left=parseInt(m[1],16);state=left?'data':'trailer';continue;
   }
   if(line==='')state='done'; // trailer lines are read and dropped
  }
  return {data,done:false};
 };
}

// Sends one request over a pinned connection and resolves once the response head has arrived; the body streams after.
// Rejects (nothing sent) when the pin does not match; rejects or ends the body with an error on anything malformed.
export async function pinnedRequest(target:PinnedTarget,r:PinnedRequest,beforeSend:()=>boolean=()=>true):Promise<PinnedResponse>{
 const head=requestHead(target,r);
 const sock=await connectPinned(target,r.timeoutMs,r.signal);
 // The caller may withdraw the request once the connection is verified (the register it was meant for has gone).
 if(!beforeSend()){sock.destroy();throw new Error('The register is no longer running.');}
 if(r.signal?.aborted){sock.destroy();throw new Error('The request was withdrawn.');}
 return new Promise<PinnedResponse>((resolve,reject)=>{
  let pending=Buffer.alloc(0);let body:PassThrough|null=null;let framing:Framing|null=null;let decode:ReturnType<typeof chunkedDecoder>|null=null;let finished=false;
  const fail=(e:Error)=>{sock.destroy();if(body){if(!finished){finished=true;body.destroy(e);}}else reject(e);};
  const finish=()=>{if(finished)return;finished=true;body!.end();sock.destroy();};
  const push=(chunk:Buffer)=>{if(chunk.length&&!body!.write(chunk))sock.pause();};
  const feed=(chunk:Buffer)=>{
   if(!framing||!body||finished)return;
   if(framing.kind==='close')return push(chunk);
   if(framing.kind==='length'){const take=chunk.subarray(0,framing.left);framing.left-=take.length;push(take);if(!framing.left)finish();return;}
   if(framing.kind==='chunked'){const out=decode!(chunk);for(const d of out.data)push(d);if(out.done)finish();}
  };
  const onAbort=()=>fail(new Error('The request was withdrawn.'));
  r.signal?.addEventListener('abort',onAbort,{once:true});
  sock.once('close',()=>r.signal?.removeEventListener('abort',onAbort));
  sock.setTimeout(r.timeoutMs??30000,()=>fail(new Error('The register did not answer in time.')));
  sock.on('error',fail);
  sock.on('data',(chunk:Buffer)=>{
   try{
    if(body)return feed(chunk);
    pending=Buffer.concat([pending,chunk]);
    const end=pending.indexOf('\r\n\r\n');
    if(end<0){if(pending.length>HEAD_LIMIT)throw new Error('Response head too large.');return;}
    if(end>HEAD_LIMIT)throw new Error('Response head too large.');
    const parsed=parseHead(pending.subarray(0,end).toString('latin1'),r.method);
    framing=parsed.framing;if(framing.kind==='chunked')decode=chunkedDecoder();
    // The error listener goes on before resolve and before any body byte is parsed: a failure in the rest of this
    // packet (or a close) can happen before the caller's .then runs, and is kept in body.errored for it to find.
    body=new PassThrough();body.on('error',()=>{});body.on('drain',()=>sock.resume());
    body.on('close',()=>{if(!finished){finished=true;sock.destroy();}}); // the caller dropped the body
    resolve({statusCode:parsed.statusCode,rawHeaders:parsed.rawHeaders,body});
    if(framing.kind==='none')return finish();
    feed(pending.subarray(end+4));pending=Buffer.alloc(0);
   }catch(e){fail(e as Error);}
  });
  sock.on('end',()=>{if(!body)return fail(new Error('The register closed the connection.'));if(framing?.kind==='close')finish();else if(!finished)fail(new Error('The register closed the connection early.'));});
  sock.on('close',()=>{if(!body)reject(new Error('The register closed the connection.'));else if(!finished){if(framing?.kind==='close')finish();else fail(new Error('The register closed the connection early.'));}});
  sock.write(head);
  if(r.body?.length)sock.write(r.body);
 });
}

// GET on a pinned listener with an explicit Host header. Resolves to the status once the body has been read in full, or
// 0 on any failure (also when the pin does not match, or the body breaks off).
export async function pinnedStatus(target:PinnedTarget,pathname:string,host:string,timeoutMs=2000):Promise<number>{
 try{
  const res=await pinnedRequest(target,{method:'GET',path:pathname,headers:{Host:host},timeoutMs});
  // The answer counts only once the whole response has arrived; a register that fails mid-body is not healthy.
  await new Promise<void>((resolve,reject)=>{
   if(bodyFailed(res.body))return reject(res.body.errored??new Error('Response body failed.'));
   res.body.on('error',reject);res.body.on('end',resolve);res.body.resume();
  });
  return res.statusCode;
 }catch{return 0;}
}
