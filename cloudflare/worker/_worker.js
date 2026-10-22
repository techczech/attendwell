// Cloudflare Pages advanced-mode proxy for the public participant check-in.
// Only an allowlisted set of session paths reaches the organiser computer through a named tunnel;
// everything else is answered here. No storage, no queue, no caching of names or check-ins, no body logging.
// Deployment settings come from Pages environment variables and are validated per request; missing or invalid means 503.
export const LIMITS=Object.freeze({maxBody:4096,timeoutMs:10000});
const HOST=/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
// Same rule as participantBasePath in server/workshop-config.ts (a test keeps them in step).
const RESERVED=new Set(['/check-in','/api','/assets','/sw.js','/index.html']);
export const validPrefix=p=>typeof p==='string'&&/^\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(p)&&!RESERVED.has(p);
// CHECKIN_PUBLIC_ORIGIN: exact HTTPS origin participants open (for example https://check-in.example.org).
// CHECKIN_PREFIX: session path such as /example-check-in. CHECKIN_ORIGIN_HOST: tunnel hostname of the organiser computer.
export function configure(env){
 const publicOrigin=env?.CHECKIN_PUBLIC_ORIGIN,prefix=env?.CHECKIN_PREFIX,originHost=env?.CHECKIN_ORIGIN_HOST;
 let url=null;try{url=new URL(publicOrigin)}catch{}
 if(!url||url.protocol!=='https:'||url.origin!==publicOrigin||!validPrefix(prefix)||typeof originHost!=='string'||!HOST.test(originHost)||originHost===url.hostname)return null;
 return Object.freeze({publicOrigin,prefix,originHost,...LIMITS});
}
const CSP="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'";
const SAFE={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':CSP,'X-Frame-Options':'DENY'};
const ASSET=/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;
// Tunnel and edge statuses that mean "backend unreachable" rather than an application answer.
const UNREACHABLE=new Set([502,503,504,520,521,522,523,524,525,526,527,530]);
const TYPES={
 api:['application/json'],
 shell:['text/html'],
 sw:['text/javascript','application/javascript'],
 asset:['text/javascript','application/javascript','text/css','font/woff2','font/woff','image/svg+xml','image/png','image/webp','image/x-icon','application/json'],
};
const OFFLINE='Check-in cannot reach the organiser’s register right now (the connection is offline). If this page was already open, keep it open: a saved check-in is retried when the connection returns. Otherwise please speak to the workshop organisers.';

const headers=(extra={})=>({...SAFE,...extra});
const json=(data,status,extra={})=>new Response(JSON.stringify(data),{status,headers:headers({'Content-Type':'application/json; charset=utf-8',...extra})});
const html=(body,status,extra={})=>new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${body}</html>`,{status,headers:headers({'Content-Type':'text/html; charset=utf-8',...extra})});
const notFound=()=>json({error:'Not found.'},404);
const landing=()=>html('<title>Workshop check-in</title><main><h1>Workshop check-in</h1><p>Open the check-in link given to you by the workshop organisers.</p></main>',200);
const failure=(kind,status,message,extra={})=>kind==='api'?json({error:message,unavailable:true},status,extra):html(`<title>Check-in unavailable</title><main><h1>Check-in unavailable</h1><p>${message}</p></main>`,status,extra);
const unavailable=kind=>failure(kind,503,OFFLINE,{'Retry-After':'30'});
const baseType=value=>(value??'').split(';')[0].trim().toLowerCase();

// Maps a public method and path to an upstream route; null means 404 at the edge.
export function route(method,pathname,p){
 const read=method==='GET'||method==='HEAD';
 if(pathname==='/')return read?{kind:'landing'}:null;
 if(pathname===p)return read?{kind:'slash'}:null;
 if(!pathname.startsWith(p+'/'))return null;
 const rest=pathname.slice(p.length);
 if(rest==='/')return read?{kind:'shell',upstream:'/check-in'}:null;
 if(rest==='/sw.js')return read?{kind:'sw',upstream:'/sw.js'}:null;
 if(rest.startsWith('/assets/')&&ASSET.test(rest.slice(8)))return read?{kind:'asset',upstream:rest}:null;
 if(rest==='/api/participant-names')return method==='GET'?{kind:'api',upstream:rest}:null;
 if(rest==='/api/participant-check-in')return method==='POST'?{kind:'api',upstream:rest,write:true}:null;
 return null;
}

async function readLimited(request,max){
 const length=request.headers.get('Content-Length');
 if(length!==null&&!(Number(length)<=max))return null;
 if(!request.body)return new Uint8Array(0);
 const reader=request.body.getReader();const chunks=[];let size=0;
 for(;;){
  const {done,value}=await reader.read();if(done)break;
  size+=value.byteLength;if(size>max){await reader.cancel().catch(()=>undefined);return null;}
  chunks.push(value);
 }
 const out=new Uint8Array(size);let at=0;for(const c of chunks){out.set(c,at);at+=c.byteLength;}
 return out;
}

// Validates a public write before anything is forwarded; returns an error response or the JSON text.
async function checkWrite(request,url,config){
 // Preview and local hostnames never accept writes, whatever Origin they present.
 if(url.origin!==config.publicOrigin||request.headers.get('Origin')!==config.publicOrigin||request.headers.get('X-Attendance-Request')!=='1')return {error:json({error:'Open the check-in page to perform this action.'},403)};
 if(baseType(request.headers.get('Content-Type'))!=='application/json')return {error:json({error:'Use a JSON request.'},415)};
 const bytes=await readLimited(request,config.maxBody);
 if(!bytes)return {error:json({error:'The request is too large.'},413)};
 let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);JSON.parse(text);}catch{return {error:json({error:'Invalid JSON.'},400)};}
 return {body:text};
}

export async function handle(request,env={},upstreamFetch=fetch){
 const url=new URL(request.url);const config=configure(env);
 // An unconfigured deployment forwards nothing: there is no built-in default backend.
 if(!config)return failure(url.pathname.includes('/api/')?'api':'shell',503,'Check-in is not configured on this address. Please speak to the workshop organisers.');
 const r=route(request.method,url.pathname,config.prefix);
 if(!r)return notFound();
 if(r.kind==='landing'){const page=landing();return request.method==='HEAD'?new Response(null,{status:200,headers:page.headers}):page;}
 if(r.kind==='slash')return new Response(null,{status:301,headers:headers({Location:config.prefix+'/'})});
 let body;
 if(r.write){const checked=await checkWrite(request,url,config);if(checked.error)return checked.error;body=checked.body;}
 const host=config.originHost;
 // Fresh headers: no cookies, authorisation or client forwarding headers reach the backend.
 const forward={Accept:r.kind==='api'?'application/json':'*/*'};
 if(r.write)Object.assign(forward,{Origin:`https://${host}`,'Content-Type':'application/json','X-Attendance-Request':'1'});
 let upstream;
 try{upstream=await upstreamFetch(new Request(`https://${host}${r.upstream}`,{method:request.method,headers:forward,body,redirect:'manual',signal:AbortSignal.timeout(config.timeoutMs)}));}
 catch{return unavailable(r.kind);}
 if(UNREACHABLE.has(upstream.status)){upstream.body?.cancel().catch(()=>undefined);return unavailable(r.kind);}
 const type=baseType(upstream.headers.get('Content-Type'));
 const ok=upstream.status>=200&&upstream.status<300;
 // Redirects and unexpected content never pass through: they could point at backend pages.
 if(upstream.status>=300&&upstream.status<400||!(TYPES[r.kind].includes(type)||!ok&&type==='application/json')){
  upstream.body?.cancel().catch(()=>undefined);
  return failure(r.kind,502,'Check-in received an unexpected answer from the organiser’s register. Please speak to the workshop organisers.');
 }
 const extra={'Content-Type':upstream.headers.get('Content-Type')};
 if(r.kind==='sw')extra['Service-Worker-Allowed']=config.prefix+'/';
 return new Response(request.method==='HEAD'?null:upstream.body,{status:upstream.status,headers:headers(extra)});
}

export default {fetch:(request,env)=>handle(request,env)};
