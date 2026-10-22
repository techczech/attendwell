// Local organiser change queue, used only on the loopback organiser origin (password-free local access on the organiser computer).
// Stores participant ID, name, intended state and expected version; never emails, recipients or sessions.
import type {Person} from '../server/store-attendance';
export type Change={opId:string;id:string;name:string;present:boolean;version:number;queuedAt:string;state:'pending'|'conflict';message?:string};
export type Shown=Person&{queued?:boolean};
type Store=Pick<Storage,'getItem'|'setItem'>;
// Resolves on success; rejects with {status,message}. Status 0 or 5xx means unreachable and stays queued.
export type Send=(change:Change)=>Promise<unknown>;
export const organiserQueueKey='attendance-organiser-queue-v1';
export function organiserQueue(storage:Store){
 const list=():Change[]=>{try{return JSON.parse(storage.getItem(organiserQueueKey)??'[]')}catch{return []}};
 const write=(q:Change[])=>storage.setItem(organiserQueueKey,JSON.stringify(q));
 let flushing:Promise<{synced:number;conflicts:number;waiting:number}>|null=null;
 return {
  list,
  add(change:Omit<Change,'queuedAt'|'state'>){write([...list(),{...change,queuedAt:new Date().toISOString(),state:'pending'}])},
  discard(opId:string){write(list().filter(c=>c.opId!==opId))},
  // Queued changes are applied over the last server read, in order, and flagged as not yet saved.
  overlay(people:Person[]):Shown[]{const q=list().filter(c=>c.state==='pending');return people.map(p=>q.filter(c=>c.id===p.id).reduce<Shown>((v,c)=>({...v,present:c.present,version:c.version+1,queued:true}),p));},
  // Sends in order, including changes queued while it runs (a quick undo). A refused change becomes a visible conflict; it is never dropped silently.
  flush(send:Send){
   // Defer the loop so an empty queue cannot clear the lock before it is assigned.
   flushing??=Promise.resolve().then(async()=>{let synced=0;const tried=new Set<string>();try{for(;;){
    const c=list().find(c=>c.state==='pending'&&!tried.has(c.opId));if(!c)break;tried.add(c.opId);
    try{await send(c);write(list().filter(x=>x.opId!==c.opId));synced++;}
    catch(e){const {status,message}=e as {status:number;message:string};if(!status||status>=500)break;write(list().map(x=>x.opId===c.opId?{...x,state:'conflict',message}:x));}
   }}finally{flushing=null}const q=list();return {synced,conflicts:q.filter(c=>c.state==='conflict').length,waiting:q.filter(c=>c.state==='pending').length};});
   return flushing;
  },
 };
}
