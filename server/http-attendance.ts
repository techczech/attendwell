import {AttendanceStore,InputError} from './store-attendance';
import {publicWorkshop} from './workshop-config';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {resolve} from 'node:path';
import {deviceRegistry} from './device-attendance';
import {createDeviceHandler,organiserDeviceRoute} from './http-device-attendance';
// organiserBearer: on a loopback organiser handler only (the desktop app), a per-start secret every request must carry as
// `Authorization: Bearer <it>`, so another local process or account cannot use the organiser listener. Never logged.
// participantOrigin: on the organiser handler, the participant listener's origin that pairing QR codes point at. now: test clock for device pairing.
export type Config={origin:string;users:Record<string,{hash:string;role:'owner'|'facilitator'}>;demo?:boolean;localAdmin?:boolean;participantOnly?:boolean;participantOrigin?:string;now?:()=>number;hostSecret?:Buffer;organiserBearer?:string};
export const BROWSER_PARTICIPANT_LIMIT=4096;
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
export function createHandler(store:AttendanceStore,config:Config,assets:string){
 const origin=new URL(config.origin);const local=['localhost','127.0.0.1','[::1]'].includes(origin.hostname);
 if(origin.origin!==config.origin||(!local&&origin.protocol!=='https:')||(config.demo&&!local&&!config.participantOnly))throw new Error('Use an exact HTTPS origin, or loopback for local review.');
 if(config.localAdmin&&(!local||config.participantOnly))throw new Error('Password-free organiser access is allowed only on loopback.');
 if(config.organiserBearer!==undefined&&(!local||config.participantOnly||!/^[A-Za-z0-9_-]{43}$/.test(config.organiserBearer)))throw new Error('The organiser key is only for a loopback organiser listener, and must be 32 bytes in base64url.');
 // Compared as SHA-256 digests in constant time, so neither the content nor the length of a wrong key changes the timing.
 const bearerDigest=config.organiserBearer!==undefined?createHash('sha256').update(config.organiserBearer).digest():null;
 const bearerOk=(req:Request)=>{
  if(!bearerDigest)return true;
  const m=/^Bearer ([A-Za-z0-9_-]{1,200})$/.exec(req.headers.get('Authorization')??'');
  return timingSafeEqual(createHash('sha256').update(m?.[1]??'').digest(),bearerDigest)&&!!m;
 };
 const loopbackHosts=['localhost','127.0.0.1','[::1]'];
 const help=store.workshop.organiserHelp;
 const heldMessage:Record<string,string>={changed:`An organiser changed this record after this device saved it. ${help}`,'duplicate-name':`There is more than one booking with this name. ${help}`,'not-eligible':`This booking needs an organiser check. ${help}`};
 const failures=new Map<string,{count:number;until:number}>();
 // Paired iPads: device routes on the participant listener; organiser device routes only on a loopback organiser listener.
 const devices=deviceRegistry(store,config.now,config.hostSecret);
 const deviceRoutes=config.participantOnly?createDeviceHandler(devices,config.origin):null;
 const organiserDevices=!config.participantOnly&&local?organiserDeviceRoute(devices,config.participantOrigin):null;
 const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'"};
 const json=(data:unknown,status=200,extra:Record<string,string>={})=>Response.json(data,{status,headers:{...headers,...extra}});
 const cookie=(value:string,age=43200)=>`attendance=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${local?'':'; Secure'}`;
 return async(req:Request):Promise<Response>=>{
  try{
   // The desktop app's organiser listener: nothing at all without the per-start key, before any route or redirect.
   if(!bearerOk(req))return json({error:'This register is open only to the AttendWell app.'},401);
   const url=new URL(req.url);
   // A loopback alias (localhost versus 127.0.0.1) is a different browser origin: send page loads to the configured one.
   if(local&&!config.participantOnly&&url.host!==origin.host&&loopbackHosts.includes(url.hostname)&&url.port===origin.port){
    if(['GET','HEAD'].includes(req.method)&&!url.pathname.startsWith('/api/'))return new Response(null,{status:302,headers:{...headers,Location:config.origin+url.pathname}});
    return json({error:`Open the register at ${config.origin}.`},403);
   }
   if(url.host!==origin.host||url.protocol!==origin.protocol&&!(origin.protocol==='https:'&&url.protocol==='http:'))return json({error:'Invalid application origin.'},403);
   // Device routes have their own middleware (ADR-0002) and never pass through the browser Origin and header rules below.
   if(deviceRoutes&&(url.pathname==='/pair'||url.pathname==='/device'||url.pathname.startsWith('/device/')))return deviceRoutes(req,url);
   if(req.method!=='GET'&&req.method!=='HEAD'){
    if(req.headers.get('Origin')!==config.origin||req.headers.get('X-Attendance-Request')!=='1')return json({error:'Open the attendance register to perform this action.'},403);
    if(!req.headers.get('Content-Type')?.startsWith('application/json'))return json({error:'Use a JSON request.'},415);
   }
   // Limits count UTF-8 bytes, checked before parsing: 4 KB for browser participant writes, 300 KB for the organiser.
   // The participant listener accepts 64 KB bodies for paired iPads; those never reach this reader.
   const read=async()=>{
    const limit=config.participantOnly?BROWSER_PARTICIPANT_LIMIT:300000;const length=req.headers.get('Content-Length');
    if(length!==null&&!(Number(length)<=limit))throw new InputError('The request is too large.',413);
    const bytes=new Uint8Array(await req.arrayBuffer());if(bytes.byteLength>limit)throw new InputError('The request is too large.',413);
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw new InputError('Invalid JSON.')}
   };
   if(config.participantOnly&&url.pathname.startsWith('/api/')){
    if(!['/api/participant-names','/api/participant-check-in'].includes(url.pathname))return json({error:'Not found.'},404);
    // The window lives in the shared database, so an organiser can close early or reopen without restarting listeners.
    const checkIn=store.participantWindow();
    if(!checkIn.open)return json({error:`Check-in has closed. ${help}`},410);
    if(url.pathname==='/api/participant-names'&&req.method==='GET'){
     const names=store.participantNames();
     return json({participants:names.map(p=>({token:store.participantToken(p.id),name:p.name,checkedIn:p.checkedIn,rev:p.version,review:p.review})),session:store.participantSession(),closesAt:new Date(checkIn.closesAt!).toISOString(),closesInMs:checkIn.remainingMs,demo:!!config.demo,workshop:publicWorkshop(store.workshop)});
    }
    if(url.pathname==='/api/participant-check-in'&&req.method==='POST'){
     const input=await read();const id=store.participantIdForToken(input?.token);
     if(!id)return json({error:'Please find your name again.'},400);
     const result=store.participantCheckIn(id,{opId:input.opId,basis:input.basis,queuedAt:input.queuedAt});
     // Held records are durably stored for organiser review; the device may stop retrying them.
     if(result.outcome==='conflict')return json({error:heldMessage[result.reason!]??heldMessage['not-eligible'],conflict:true,token:input.token,name:result.name,reason:result.reason},409);
     return json({ok:true,token:input.token,name:result.name,checkedIn:true,already:result.already,outcome:result.outcome});
    }
    return json({error:'Unsupported operation.'},405);
   }
   if(url.pathname==='/api/login'&&req.method==='POST'){
    const input=await read();if(typeof input.identity!=='string'||input.identity.length>100||typeof input.passphrase!=='string'||input.passphrase.length>512)return json({error:'Check your facilitator sign-in.'},401);
    // Bounded global and identity budgets resist distributed guessing and unknown-name floods.
    const now=Date.now();for(const [key,entry] of failures)if(entry.until<now)failures.delete(key);
    const keys=['*',Object.hasOwn(config.users,input.identity)?input.identity:'unknown'];
    if(keys.some(k=>(failures.get(k)?.count??0)>=(k==='*'?50:8)))return json({error:'Too many attempts. Try again in 15 minutes.'},429);
    const user=Object.hasOwn(config.users,input.identity)?config.users[input.identity]:undefined;const valid=user&&await Bun.password.verify(input.passphrase,user.hash);
    if(!valid){for(const k of keys){const e=failures.get(k)??{count:0,until:now+900000};e.count++;failures.set(k,e);}return json({error:'Check your facilitator sign-in.'},401);}
    failures.delete(input.identity);const token=randomBytes(32).toString('hex');store.db.query('DELETE FROM sessions WHERE expires<?').run(now);
    store.db.query('INSERT INTO sessions(hash,actor,expires) VALUES(?,?,?)').run(digest(token),input.identity,now+43200000);
    return json({identity:input.identity,role:user.role,demo:!!config.demo},200,{'Set-Cookie':cookie(token)});
   }
   const token=req.headers.get('Cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith('attendance='))?.slice(11)??'';
   const session=/^[a-f0-9]{64}$/.test(token)?store.db.query('SELECT actor,expires FROM sessions WHERE hash=?').get(digest(token)) as {actor:string;expires:number}|null:null;
   const user=config.localAdmin?{role:'owner' as const}:session&&config.users[session.actor];
   const authorised=!!config.localAdmin||!!session&&session.expires>Date.now()&&!!user;
   if(url.pathname.startsWith('/api/')){
    if(!authorised)return json({error:'Please sign in to the attendance register.'},401);
    const actor=config.localAdmin?'local-organiser':session!.actor;
    if(url.pathname==='/api/logout'&&req.method==='POST'){store.db.query('DELETE FROM sessions WHERE hash=?').run(digest(token));return json({ok:true},200,{'Set-Cookie':cookie('',0)});}
    if(url.pathname==='/api/roster'&&req.method==='GET')return json({...store.list(),identity:actor,role:user!.role,demo:!!config.demo,localAdmin:!!config.localAdmin,participantWindow:store.participantWindow()});
    // Owner-only control of the shared participant window. Never routed on a participant listener (its API allowlist is fixed above).
    if(url.pathname==='/api/check-in-window'){
     if(req.method==='GET')return json(store.participantWindow());
     if(req.method!=='POST')return json({error:'Unsupported operation.'},405);
     if(user!.role!=='owner')return json({error:'Only the organiser can open or close participant check-in.'},403);
     const p=await read();
     if(p?.action==='open')return json(store.openParticipantWindow(p.minutes,actor));
     if(p?.action==='close')return json(store.closeParticipantWindow(actor));
     return json({error:'Choose whether to open or close check-in.'},400);
    }
    if(url.pathname==='/api/attendance'&&req.method==='POST'){const p=await read();return json(store.setAttendance(p.id,p.present,p.version,actor,p.opId));}
    if(url.pathname==='/api/resolve-conflict'&&req.method==='POST'){const p=await read();return json(store.resolveConflict(p.id,p.action,actor));}
    if(url.pathname==='/api/admit'&&req.method==='POST'){
     if(user!.role!=='owner')return json({error:'Only the organiser can admit from the waiting list.'},403);
     const p=await read();return json(store.admit(p.id,p.admitted,p.version,actor));
    }
    if(url.pathname==='/api/add-participant'&&req.method==='POST'){
     if(user!.role!=='owner')return json({error:'Only the organiser can add a participant.'},403);
     return json(store.addParticipant(await read(),actor));
    }
    if(url.pathname==='/api/import'&&req.method==='POST'){
     if(config.demo)return json({error:'Roster import is disabled in the fictional preview.'},403);
     if(user!.role!=='owner')return json({error:'Only the roster owner can import booking records.'},403);
     return json(store.import(await read(),actor));
    }
    // A pasted or imported name list (server/names-list.ts): dryRun previews, otherwise adds. Owner only, like import.
    if(url.pathname==='/api/names'&&req.method==='POST'){
     if(config.demo)return json({error:'Adding names is disabled in the fictional preview.'},403);
     if(user!.role!=='owner')return json({error:'Only the organiser can add a name list.'},403);
     const p=await read();const r=store.addNames(p,actor,{dryRun:p?.dryRun===true});
     return json({plan:r.plan,written:r.written,roster:store.list()});
    }
    if(organiserDevices&&url.pathname.startsWith('/api/organiser/')){const r=await organiserDevices(req,url,read,actor,user!.role==='owner');if(r)return r;}
    if(url.pathname==='/api/recipients'&&req.method==='POST')return json(store.recipients((await read()).ids));
    return json({error:'Unknown operation.'},404);
   }
   if(!['GET','HEAD'].includes(req.method))return json({error:'Unsupported operation.'},405);
   // Serve only the generated entry and generated assets; source, DB and roster are never static routes.
   if(config.participantOnly&&['/','/index.html'].includes(url.pathname))return new Response(null,{status:302,headers:{...headers,Location:'/check-in'}});
   let relative=url.pathname==='/'||config.participantOnly&&url.pathname==='/check-in'?'index.html':url.pathname.slice(1);
   // The offline shell worker exists only on the names-only participant origin; organiser pages are never worker-cached.
   if(relative==='sw.js'&&!config.participantOnly)return json({error:'Not found.'},404);
   if(relative!=='index.html'&&relative!=='sw.js'&&!/^assets\/[a-zA-Z0-9_.-]+$/.test(relative))return json({error:'Not found.'},404);
   const file=Bun.file(resolve(assets,relative));if(!await file.exists())return json({error:'Build the attendance interface first.'},404);
   return new Response(req.method==='HEAD'?null:file,{headers:{...headers,'Content-Type':file.type}});
  }catch(err){return err instanceof InputError?json({error:err.message},err.status):json({error:'The change could not be saved. Refresh and try again.'},500);}
 };
}
