// Participant device storage and sync. Holds names-only data: public name, stable token, status and revision.
// Never stores emails, organiser data or recipient data. The queue lives on this device only; there is no remote queue.
// Every check-in is written to device storage and acknowledged before any network call; delivery runs in the background.
import {validBasePath,type PublicWorkshop} from '../server/workshop-config';
export type Choice={token:string;name:string;checkedIn:boolean;rev:number;review:boolean};
export type Snapshot={names:Choice[];closesAt:number;savedAt:number;demo:boolean;session:string;closed?:boolean;workshop?:PublicWorkshop};
export type Queued={opId:string;token:string;name:string;basis:number;queuedAt:string;state:'pending'|'unsent';message?:string};
export type Entry={token:string;name:string;status:'pending'|'checked-in'|'queued'|'held'|'unsent';message?:string};
// Delivery outcome of one queued check-in. Only 'saved' means the register has it.
// 'failed' means this device could not store it, so nothing was sent.
export type Sent={kind:'saved'|'queued'|'held'|'rejected'|'closed'|'failed';name:string;message?:string};
// Immediate acknowledgement: 'queued' means durably saved on this device, never that the register has it.
// 'failed' means device storage refused or silently dropped the write: nothing is queued or sent.
export type Ack={kind:'queued'|'closed'|'failed';name:string;token:string;opId?:string;message?:string};
// Connectivity from finished requests only; a request still in flight never changes it.
// names: the last list poll. delivery: the last check-in send ('failing' when it did not reach the register).
export type Link={names:'unknown'|'online'|'offline'|'closed';delivery:'unknown'|'ok'|'failing'};
type Transport=(path:string,init:RequestInit)=>Promise<Response>;
type Store=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
// Storage keys are namespaced by participant base path, so two sessions on one origin never share names or queue.
// The local /check-in page (base '') keeps the original keys.
export const participantKeys=(base='')=>({names:'attendance-participant-names-v1'+(base?':'+base:''),queue:'attendance-participant-queue-v1'+(base?':'+base:'')});
export const defaultOrganiserHelp='Please speak to the workshop organisers.';
export const storageFailure='This check-in could not be saved on this device, so it has not been sent. Please tell an organiser now.';
const defaultTransport:Transport=(path,init)=>fetch(path,{...init,signal:AbortSignal.timeout(8000)});
// Participant page paths: local /check-in (no prefix) or a public /<prefix>/ whose edge proxy strips the prefix.
// Returns the prefix for API and worker URLs, or null when the path is the organiser register.
export const participantBase=(pathname:string):string|null=>{
 if(pathname==='/check-in')return '';
 const prefix=pathname.endsWith('/')?pathname.slice(0,-1):pathname;
 return validBasePath(prefix)?prefix:null;
};
export function participantSync(storage:Store,transport:Transport=defaultTransport,now=()=>Date.now(),newId=()=>crypto.randomUUID(),base=''){
 const listeners=new Set<()=>void>();
 const emit=()=>{for(const l of listeners)try{l()}catch{}};
 const read=<T>(key:string,fallback:T):T=>{try{const v=storage.getItem(key);return v?JSON.parse(v) as T:fallback}catch{return fallback}};
 const keys=participantKeys(base);
 const snapshot=()=>read<Snapshot|null>(keys.names,null);
 const queue=()=>read<Queued[]>(keys.queue,[]);
 // Writes never throw: full or blocked storage returns false, and a write that was silently ignored fails the read-back.
 const write=(key:string,value:unknown)=>{const text=JSON.stringify(value);let ok=false;try{storage.setItem(key,text);ok=storage.getItem(key)===text}catch{}emit();return ok};
 const writeQueue=(q:Queued[])=>write(keys.queue,q);
 const writeSnapshot=(s:Snapshot)=>write(keys.names,s);
 // Connectivity from finished requests, for this page only.
 let link:Link={names:'unknown',delivery:'unknown'};
 const setLink=(change:Partial<Link>)=>{const next={...link,...change};if(next.names!==link.names||next.delivery!==link.delivery){link=next;emit()}};
 // Each server acknowledgement gets a sequence number, so a names poll that started before it cannot undo it.
 let seq=0,closedSeq=-1;const acked=new Map<string,{seq:number;change:Partial<Choice>}>();
 const acknowledge=(token:string,change:Partial<Choice>)=>{acked.set(token,{seq:++seq,change});patchName(token,change)};
 const patchName=(token:string,change:Partial<Choice>)=>{const s=snapshot();if(s)writeSnapshot({...s,names:s.names.map(n=>n.token===token?{...n,...change}:n)})};
 const closed=()=>{const s=snapshot();return !!s&&(!!s.closed||now()>=s.closesAt)};
 const help=()=>snapshot()?.workshop?.organiserHelp??defaultOrganiserHelp;
 // Last delivery outcome per operation, so a caller can await one check-in without owning the flush loop.
 const outcomes=new Map<string,Sent>();
 // Status 0 means unreachable or a non-JSON reply (for example a tunnel error page): always retryable.
 async function call(path:string,data?:unknown):Promise<{status:number;body:any}>{
  let response:Response;
  try{response=await transport(base+'/api/participant-'+path,{method:data?'POST':'GET',cache:'no-store',headers:data?{'Content-Type':'application/json','X-Attendance-Request':'1'}:{},body:data?JSON.stringify(data):undefined})}catch{return {status:0,body:null}}
  try{return {status:response.status,body:await response.json()}}catch{return {status:0,body:null}}
 }
 async function send(op:Queued):Promise<Sent>{
  const r=await call('check-in',{token:op.token,opId:op.opId,basis:op.basis,queuedAt:op.queuedAt});
  const drop=()=>writeQueue(queue().filter(o=>o.opId!==op.opId));
  if(r.status===0||r.status===429||r.status>=500){setLink({delivery:'failing'});return {kind:'queued',name:op.name};}
  setLink({delivery:'ok'});
  if(r.status===200){drop();acknowledge(op.token,{checkedIn:true});return {kind:'saved',name:op.name};}
  // The server has durably recorded a held check-in for organiser review.
  if(r.status===409&&r.body?.conflict){drop();acknowledge(op.token,{review:true});return {kind:'held',name:op.name,message:r.body.error};}
  if(r.status===410){closedSeq=++seq;const s=snapshot();if(s)writeSnapshot({...s,closed:true});return {kind:'closed',name:op.name};}
  return {kind:'rejected',name:op.name,message:r.body?.error??help()};
 }
 let flushing:Promise<{synced:number;remaining:number}>|null=null;
 // Replays pending check-ins oldest first, including any enqueued while it runs; stops at the first transient failure or closure.
 // A refusal stays on the device as 'unsent' with the reason, for an organiser to see; it is never dropped silently.
 function flush(){
  // Defer the loop so an empty queue cannot clear the lock before it is assigned.
  flushing??=Promise.resolve().then(async()=>{let synced=0;const tried=new Set<string>();try{for(;;){
   const op=queue().find(o=>o.state==='pending'&&!tried.has(o.opId));if(!op)break;tried.add(op.opId);
   const r=await send(op);outcomes.set(op.opId,r);
   if(r.kind==='queued'||r.kind==='closed')break;
   if(r.kind==='rejected')writeQueue(queue().map(o=>o.opId===op.opId?{...o,state:'unsent',message:r.message}:o));else synced++;
  }}finally{flushing=null}return {synced,remaining:queue().length};});
  return flushing;
 }
 // Durable write first, then acknowledge. No network call happens before this returns.
 function enqueue(choice:Choice):Ack{
  if(closed())return {kind:'closed',name:choice.name,token:choice.token,message:`Check-in has closed. ${help()}`};
  const existing=queue().find(o=>o.token===choice.token);
  if(existing){void flush();return {kind:'queued',name:choice.name,token:choice.token,opId:existing.opId};}
  const op:Queued={opId:newId(),token:choice.token,name:choice.name,basis:choice.rev,queuedAt:new Date(now()).toISOString(),state:'pending'};
  // Acknowledge only what reads back from storage; otherwise nothing is sent and the caller must say so.
  if(!writeQueue([...queue(),op])||!queue().some(o=>o.opId===op.opId))return {kind:'failed',name:choice.name,token:choice.token,message:storageFailure};
  void flush();
  return {kind:'queued',name:choice.name,token:choice.token,opId:op.opId};
 }
 return {
  snapshot,queue,closed,flush,enqueue,
  organiserHelp:help,
  link:()=>link,
  // Called after every change to device storage, including background delivery results.
  subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener)}},
  // Polls the names list only and never waits for delivery, so closure and undo show while a send is slow.
  async refresh():Promise<'online'|'offline'|'closed'>{
   const since=seq;
   const r=await call('names');
   // A fresh open response replaces the snapshot entirely, so a reopened window clears any earlier closure here.
   // Acknowledgements and closures that arrived after this poll started are newer than its answer and are kept.
   if(r.status===200&&Array.isArray(r.body?.participants)){
    const fresh=(p:Choice)=>{const n={token:p.token,name:p.name,checkedIn:!!p.checkedIn,rev:p.rev,review:!!p.review};const a=acked.get(p.token);return a&&a.seq>since?{...n,...a.change}:n};
    const stillClosed=closedSeq>since;
    writeSnapshot({names:r.body.participants.map(fresh),closesAt:now()+r.body.closesInMs,savedAt:now(),demo:!!r.body.demo,session:r.body.session,workshop:r.body.workshop,...(stillClosed?{closed:true}:{})});
    setLink({names:stillClosed?'closed':'online'});return stillClosed?'closed':'online';
   }
   if(r.status===410){const s=snapshot();if(s)writeSnapshot({...s,closed:true});else writeSnapshot({names:[],closesAt:now(),savedAt:now(),demo:false,session:'',closed:true});setLink({names:'closed'});return 'closed';}
   setLink({names:'offline'});return 'offline';
  },
  // Enqueue, then wait for this check-in's delivery attempt. For callers that need the outcome; the UI uses enqueue.
  async checkIn(choice:Choice):Promise<Sent>{
   const ack=enqueue(choice);if(ack.kind!=='queued')return {kind:ack.kind,name:ack.name,message:ack.message};
   await flush();
   const left=queue().find(o=>o.opId===ack.opId);
   if(left?.state==='unsent')return {kind:'rejected',name:choice.name,message:left.message};
   if(left)return {kind:'queued',name:choice.name};
   // No recorded outcome means the record left by organiser handover, not by delivery: never report it as saved.
   return outcomes.get(ack.opId!)??{kind:'closed',name:choice.name};
  },
  // Merges the saved names with this device's queue; queued names count as checked in here, never as server-saved.
  entries():Entry[]{
   const q=queue();const s=snapshot();const byToken=new Map(q.map(o=>[o.token,o]));
   const listed=(s?.names??[]).map(n=>{const op=byToken.get(n.token);return {token:n.token,name:n.name,status:op?(op.state==='pending'?'queued':'unsent'):n.review?'held':n.checkedIn?'checked-in':'pending',message:op?.message} as Entry;});
   const known=new Set(listed.map(e=>e.token));
   return [...listed,...q.filter(o=>!known.has(o.token)).map(o=>({token:o.token,name:o.name,status:o.state==='pending'?'queued':'unsent',message:o.message} as Entry))];
  },
  // Explicit organiser handover after the public service has closed; the only way queued records leave the device.
  handedOver(){writeQueue([])},
 };
}
export type ParticipantSync=ReturnType<typeof participantSync>;
