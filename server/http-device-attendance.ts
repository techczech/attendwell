// HTTP framing for paired iPads (ADR-0002): /device/v1/* and the static /pair page on the participant listener,
// and the organiser's device routes (/api/organiser/*) on the loopback organiser listener.
// Browser routes are untouched: a browser-shaped request is refused here, and a device request never reaches browser middleware.
import {DeviceRegistry,formatCode} from './device-attendance';
import {InputError} from './store-attendance';

export const DEVICE_BODY_LIMIT=65536;
const ROUTES:Record<string,string[]>={hello:['POST'],pair:['POST'],roster:['GET'],operations:['POST'],heartbeat:['GET','POST']};
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"};
const json=(data:unknown,status=200,extra:Record<string,string>={})=>Response.json(data,{status,headers:{...headers,...extra}});
const INVALID_CODE={error:'invalid_or_expired_code'};
// Scriptless page for a camera app or browser that opens the QR link. The fragment carrying the code never reaches a server.
const PAIR_PAGE='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Pair an iPad</title><main><h1>Pair an iPad</h1><p>This code pairs an iPad with the organiser’s laptop. Open the AttendWell app on the iPad and scan the code there, or type the code shown on the laptop.</p></main></html>';

// Fixed-window budget per listener. All tunnel traffic arrives from one local address, so budgets are global, not per client.
export class Budget {
 private hits:number[]=[];
 constructor(private readonly limit:number,private readonly windowMs:number,private readonly now:()=>number){}
 take(){const t=this.now();this.hits=this.hits.filter(h=>h>t-this.windowMs);if(this.hits.length>=this.limit)return false;this.hits.push(t);return true}
}

// origin: this listener's configured participant origin, the base of every pairing QR; bound into the organiser proof.
export function createDeviceHandler(registry:DeviceRegistry,origin:string){
 const pairing=new Budget(30,60000,registry.now);   // hello + pair attempts per minute
 const refused=new Budget(60,60000,registry.now);   // failed bearer checks per minute
 return async(req:Request,url:URL):Promise<Response>=>{
  if(url.pathname==='/pair'){
   if(!['GET','HEAD'].includes(req.method))return json({error:'method_not_allowed'},405);
   return new Response(req.method==='HEAD'?null:PAIR_PAGE,{headers:{...headers,'Content-Type':'text/html; charset=utf-8'}});
  }
  const name=/^\/device\/v1\/([a-z]+)$/.exec(url.pathname)?.[1];
  if(!name||!Object.hasOwn(ROUTES,name))return json({error:'not_found'},404);
  // No CORS, no preflight: a browser can never call a device route.
  if(req.method==='OPTIONS'||!ROUTES[name].includes(req.method))return json({error:'method_not_allowed'},405);
  if(req.headers.has('Origin')||req.headers.has('Cookie')||req.headers.has('Sec-Fetch-Site'))return json({error:'browser_request_refused'},403);
  const protocol=req.headers.get('X-Attendance-Device-Protocol');
  if(protocol===null)return json({error:'bad_request'},400);
  if(protocol!=='1')return json({error:'protocol_unsupported',protocolVersions:[1]},426);
  let body:unknown=undefined;
  if(req.method==='POST'){
   if((req.headers.get('Content-Type')??'').split(';')[0].trim().toLowerCase()!=='application/json')return json({error:'bad_request'},415);
   const length=req.headers.get('Content-Length');
   if(length!==null&&!(Number(length)<=DEVICE_BODY_LIMIT))return json({error:'too_large'},413);
   const bytes=new Uint8Array(await req.arrayBuffer());
   if(bytes.byteLength>DEVICE_BODY_LIMIT)return json({error:'too_large'},413);
   try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{return json({error:'bad_request'},400)}
   if(!body||typeof body!=='object'||Array.isArray(body))return json({error:'bad_request'},400);
  }
  const bearer=/^Bearer (\S+)$/.exec(req.headers.get('Authorization')??'')?.[1]??null;
  try{
   if(name==='hello'||name==='pair'){
    if(!pairing.take())return json({error:'rate_limited'},429,{'Retry-After':'60'});
    if(name==='hello'){const offer=registry.hello(body,origin);return offer?json(offer):json(INVALID_CODE,401);}
    const success=registry.pair(body,bearer);return success?json(success,201):json(INVALID_CODE,401);
   }
   const device=registry.authenticate(bearer);
   if(!device){if(!refused.take())return json({error:'rate_limited'},429,{'Retry-After':'60'});return json({error:'device_revoked'},401);}
   if(name==='roster')return json(registry.snapshot());
   if(name==='heartbeat')return json(registry.heartbeat(device,body));
   const result=registry.submit(device,body);return json(result.body,result.status);
  }catch(err){return err instanceof InputError?json({error:'bad_request'},400):json({error:'server_error'},500)}
 };
}

// Organiser device routes. Called by the organiser handler after its own Origin, header and session checks, on loopback only.
export function organiserDeviceRoute(registry:DeviceRegistry,participantOrigin:string|undefined){
 return async(req:Request,url:URL,read:()=>Promise<any>,actor:string,owner:boolean):Promise<Response|null>=>{
  const path=url.pathname;
  const ownerOnly=()=>json({error:'Only the organiser can pair or remove iPads.'},403);
  if(path==='/api/organiser/devices'){
   if(req.method!=='GET')return json({error:'Unsupported operation.'},405);
   return json(registry.devices());
  }
  if(path==='/api/organiser/pairing-sessions'){
   if(req.method!=='POST')return json({error:'Unsupported operation.'},405);
   if(!owner)return ownerOnly();
   if(!participantOrigin)return json({error:'Turn on the participant link first: the iPad pairs through it.'},409);
   const s=registry.createPairing(await read()??{},actor);const shortCode=formatCode(s.code);
   return json({sessionId:s.sessionId,label:s.label,targetDeviceId:s.targetDeviceId,shortCode,qrPayload:`${participantOrigin}/pair#v=1&code=${shortCode}`,baseUrl:participantOrigin,expiresAt:s.expiresAt,serverTime:new Date(registry.now()).toISOString(),eventCode:registry.event().eventCode});
  }
  // An iPad's recovery file, read on the laptop: {file, dryRun}. Same idempotent path as a live upload (DeviceRegistry.importRecovery).
  if(path==='/api/organiser/recovery-import'){
   if(req.method!=='POST')return json({error:'Unsupported operation.'},405);
   if(!owner)return json({error:'Only the organiser can import an iPad recovery file.'},403);
   const p=await read();return json(registry.importRecovery(p?.file,actor,{dryRun:p?.dryRun===true}));
  }
  let m=/^\/api\/organiser\/pairing-sessions\/([a-z0-9_]{1,40})$/.exec(path);
  if(m){
   if(req.method!=='DELETE')return json({error:'Unsupported operation.'},405);
   if(!owner)return ownerOnly();
   registry.cancelPairing(m[1],actor);return json({ok:true});
  }
  m=/^\/api\/organiser\/device-holds\/([0-9]{1,12})\/dismiss$/.exec(path);
  if(m){
   if(req.method!=='POST')return json({error:'Unsupported operation.'},405);
   if(!owner)return ownerOnly();
   registry.dismissHold(Number(m[1]),actor);return json(registry.devices());
  }
  m=/^\/api\/organiser\/devices\/([a-z0-9_]{1,40})(\/revoke)?$/.exec(path);
  if(m){
   if(!owner)return ownerOnly();
   if(m[2]&&req.method==='POST'){registry.revokeDevice(m[1],actor);return json(registry.devices());}
   if(!m[2]&&req.method==='PATCH'){registry.renameDevice(m[1],(await read())?.label,actor);return json(registry.devices());}
   return json({error:'Unsupported operation.'},405);
  }
  return null;
 };
}
