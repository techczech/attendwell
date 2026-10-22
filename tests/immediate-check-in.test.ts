import {test,expect} from 'bun:test';
import {AttendanceStore} from '../server/store-attendance';
import {createHandler} from '../server/http-attendance';
import {participantSync,participantKeys,storageFailure} from '../src/offline-participant';
import {organiserQueue} from '../src/offline-organiser';
import {fixture} from './fixtures-attendance';
const origin='https://names.example.org';
const memory=()=>{const m=new Map<string,string>();return {getItem:(k:string)=>m.get(k)??null,setItem:(k:string,v:string)=>void m.set(k,v),removeItem:(k:string)=>void m.delete(k),dump:()=>JSON.stringify([...m])}};
const setup=()=>{const store=new AttendanceStore(':memory:');store.import(fixture,'test');store.initParticipantWindow();return store};
const person=(s:AttendanceStore,id:string)=>s.list().participants.find(p=>p.id===id)!;
const settle=()=>new Promise(r=>setTimeout(r,0));
// Deferred transport: every request waits (standing in for a 5-second network delay) until the test releases it.
// release('deliver') runs the real participant handler; 'fail' is an unreachable network; 'lose' applies on the server but loses the reply.
// answer() lets the server answer now while the reply stays in transit, standing in for a slow response.
type Mode='deliver'|'fail'|'lose';
function deferredDevice(store:AttendanceStore,storage:DeviceStorage=memory()){
 const handler=createHandler(store,{origin,users:{},participantOnly:true},'/tmp/missing-assets');
 const waiting:{path:string;answer:()=>Promise<void>;release:(mode:Mode)=>Promise<void>}[]=[];
 const transport=(path:string,init:RequestInit)=>new Promise<Response>((resolve,reject)=>{
  let answered:Response|undefined;const serve=()=>handler(new Request(origin+path,{...init,headers:{...(init.headers as Record<string,string>),Origin:origin}}));
  waiting.push({path,answer:async()=>{answered=await serve()},release:async mode=>{
   if(mode==='fail'){reject(new TypeError('Failed to fetch'));return;}
   const response=answered??await serve();
   if(mode==='lose')reject(new TypeError('Network connection was lost'));else resolve(response);
  }});
 });
 const sync=participantSync(storage,transport);let notified=0;sync.subscribe(()=>notified++);
 // Releases the oldest waiting request (or the oldest one for a path) and lets the background flush continue.
 const next=async(mode:Mode='deliver',path?:string)=>{await settle();const i=path?waiting.findIndex(r=>r.path===path):0;const r=i<0?undefined:waiting.splice(i,1)[0];if(!r)throw new Error('No request waiting');await r.release(mode);await settle();return r.path;};
 const status=(name:string)=>sync.entries().find(e=>e.name===name)!.status;
 return {sync,storage,waiting,next,status,notified:()=>notified};
}
type DeviceStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
async function ready(store:AttendanceStore,storage?:DeviceStorage){const d=deferredDevice(store,storage);const loading=d.sync.refresh();await d.next();expect(await loading).toBe('online');return d;}
const NAMES='/api/participant-names',CHECK_IN='/api/participant-check-in';
const choice=(d:ReturnType<typeof deferredDevice>,name:string)=>d.sync.snapshot()!.names.find(n=>n.name===name)!;

test('acknowledges in well under 250 ms while the transport takes 5 seconds; durable before any request is sent',async()=>{
 const store=setup();const d=await ready(store);const before=d.notified();
 const started=performance.now();const ack=d.sync.enqueue(choice(d,'Alex Example'));const elapsed=performance.now()-started;
 expect(elapsed).toBeLessThan(250);expect(ack).toMatchObject({kind:'queued',name:'Alex Example'});
 // Durable and visible before the network is touched; nothing claims the register has it yet.
 expect(d.waiting).toHaveLength(0);expect(JSON.parse(d.storage.getItem(participantKeys().queue)!)).toMatchObject([{opId:ack.opId,name:'Alex Example',state:'pending'}]);
 expect(d.status('Alex Example')).toBe('queued');expect(d.notified()).toBeGreaterThan(before);expect(person(store,'a').present).toBe(false);
 // A reload during the delay still has it.
 expect(participantSync(d.storage,async()=>{throw new TypeError('offline')}).entries().find(e=>e.name==='Alex Example')!.status).toBe('queued');
 expect(await d.next()).toBe('/api/participant-check-in');
 expect(d.status('Alex Example')).toBe('checked-in');expect(d.sync.queue()).toHaveLength(0);expect(person(store,'a').present).toBe(true);store.close();
});

test('rapid check-ins are all acknowledged at once and delivered in order by one background flush',async()=>{
 const store=setup();const d=await ready(store);
 for(const name of ['Alex Example','Bea Example','Missing Address'])expect(d.sync.enqueue(choice(d,name)).kind).toBe('queued');
 // Tapping the same name again does not queue a second record.
 expect(d.sync.enqueue(choice(d,'Alex Example')).kind).toBe('queued');expect(d.sync.queue()).toHaveLength(3);
 await d.next();expect(d.status('Alex Example')).toBe('checked-in');expect(d.status('Bea Example')).toBe('queued');
 await d.next();await d.next();expect(d.waiting).toHaveLength(0);
 expect(['a','b','m'].map(id=>person(store,id).present)).toEqual([true,true,true]);
 expect(store.db.query("SELECT participantId FROM operations ORDER BY receivedAt,rowid").all()).toEqual([{participantId:'a'},{participantId:'b'},{participantId:'m'}]);store.close();
});

test('a failed or lost delivery stays queued and is replayed once with the same operation ID',async()=>{
 const store=setup();const d=await ready(store);const ack=d.sync.enqueue(choice(d,'Alex Example'));
 await d.next('fail');expect(d.status('Alex Example')).toBe('queued');expect(person(store,'a').present).toBe(false);
 void d.sync.flush();await d.next('lose');expect(d.status('Alex Example')).toBe('queued');expect(person(store,'a').present).toBe(true);
 void d.sync.flush();await d.next();expect(d.sync.queue()).toHaveLength(0);
 expect(store.db.query('SELECT opId,outcome FROM operations').all()).toEqual([{opId:ack.opId!,outcome:'applied'}]);
 expect(person(store,'a').version).toBe(1);store.close();
});

test('an organiser undo while the check-in is in flight is never overwritten: the record is held',async()=>{
 const store=setup();const d=await ready(store);d.sync.enqueue(choice(d,'Alex Example'));
 store.setAttendance('a',true,0,'local-organiser');store.setAttendance('a',false,1,'local-organiser');
 await d.next();expect(d.status('Alex Example')).toBe('held');expect(person(store,'a').present).toBe(false);
 expect(store.conflicts()).toMatchObject([{participantId:'a',reason:'changed'}]);store.close();
});

test('closing during delivery keeps the record on the device; reopening sends it',async()=>{
 const store=setup();const d=await ready(store);d.sync.enqueue(choice(d,'Alex Example'));
 store.closeParticipantWindow('local-organiser');await d.next();
 expect(d.sync.closed()).toBe(true);expect(d.status('Alex Example')).toBe('queued');
 expect(d.sync.enqueue(choice(d,'Bea Example')).kind).toBe('closed');expect(d.sync.queue()).toHaveLength(1);
 store.openParticipantWindow(15,'local-organiser');const reading=d.sync.refresh();await d.next();expect(await reading).toBe('online');
 void d.sync.flush();await d.next();expect(d.status('Alex Example')).toBe('checked-in');expect(person(store,'a').present).toBe(true);store.close();
});

test('a refusal is kept on the device as not sent, with its reason, never silently dropped',async()=>{
 const store=setup();const d=await ready(store);const alex=choice(d,'Alex Example');
 d.sync.enqueue({...alex,token:'f'.repeat(48)});await d.next();
 expect(d.sync.queue()).toMatchObject([{state:'unsent',message:'Please find your name again.'}]);
 expect(d.sync.entries().find(e=>e.token==='f'.repeat(48))).toMatchObject({status:'unsent',message:'Please find your name again.'});store.close();
});

test('checkIn still reports the delivery outcome for callers that wait for it',async()=>{
 const store=setup();const d=await ready(store);const result=d.sync.checkIn(choice(d,'Alex Example'));
 await d.next();expect(await result).toEqual({kind:'saved',name:'Alex Example'});store.close();
});

test('full or blocked device storage fails the acknowledgement: nothing is queued, sent or claimed',async()=>{
 const store=setup();const base=memory();let mode:'ok'|'throws'|'ignores'='ok';
 // 'throws' is a full or blocked localStorage; 'ignores' silently drops the write.
 const storage={...base,setItem:(k:string,v:string)=>{if(k===participantKeys().queue&&mode==='throws')throw new Error('QuotaExceededError');if(k===participantKeys().queue&&mode==='ignores')return;base.setItem(k,v)}};
 const d=await ready(store,storage);
 for(const failing of ['throws','ignores'] as const){
  mode=failing;const ack=d.sync.enqueue(choice(d,'Alex Example'));
  expect(ack).toMatchObject({kind:'failed',name:'Alex Example',message:storageFailure});expect(ack.opId).toBeUndefined();
  expect(await d.sync.checkIn(choice(d,'Alex Example'))).toEqual({kind:'failed',name:'Alex Example',message:storageFailure});
  await settle();expect(d.waiting).toHaveLength(0);expect(d.sync.queue()).toHaveLength(0);expect(d.status('Alex Example')).toBe('pending');expect(person(store,'a').present).toBe(false);
 }
 mode='ok';expect(d.sync.enqueue(choice(d,'Alex Example')).kind).toBe('queued');await d.next();expect(d.status('Alex Example')).toBe('checked-in');store.close();
});

test('a names poll that started before a server acknowledgement cannot undo it; a later poll shows an organiser undo',async()=>{
 const store=setup();const d=await ready(store);d.sync.enqueue(choice(d,'Alex Example'));await settle();
 const polling=d.sync.refresh();await settle();
 // The server answers the poll before the check-in reaches it; that reply is still in transit when the check-in is acknowledged.
 await d.waiting.find(r=>r.path===NAMES)!.answer();
 await d.next('deliver',CHECK_IN);expect(d.status('Alex Example')).toBe('checked-in');expect(d.sync.queue()).toHaveLength(0);
 await d.next('deliver',NAMES);expect(await polling).toBe('online');
 expect(d.status('Alex Example')).toBe('checked-in');expect(choice(d,'Alex Example').checkedIn).toBe(true);
 store.setAttendance('a',false,1,'local-organiser');
 const later=d.sync.refresh();await d.next('deliver',NAMES);expect(await later).toBe('online');expect(d.status('Alex Example')).toBe('pending');store.close();
});

test('names polling does not wait for a slow send: closure shows while the check-in is still in flight',async()=>{
 const store=setup();const d=await ready(store);expect(d.sync.link()).toEqual({names:'online',delivery:'unknown'});
 d.sync.enqueue(choice(d,'Alex Example'));await settle();expect(d.waiting.map(r=>r.path)).toEqual([CHECK_IN]);
 store.closeParticipantWindow('local-organiser');
 const polling=d.sync.refresh();await d.next('deliver',NAMES);expect(await polling).toBe('closed');
 // The send is still in flight: the list is closed, and connectivity is not guessed from the pending request.
 expect(d.waiting.map(r=>r.path)).toEqual([CHECK_IN]);expect(d.sync.closed()).toBe(true);expect(d.sync.link()).toEqual({names:'closed',delivery:'unknown'});
 expect(d.sync.enqueue(choice(d,'Bea Example')).kind).toBe('closed');
 await d.next('deliver',CHECK_IN);expect(d.status('Alex Example')).toBe('queued');expect(d.sync.link().delivery).toBe('ok');store.close();
});

test('a dropped send shows as failing even while names polls succeed; pending requests never change connectivity',async()=>{
 const store=setup();const d=await ready(store);d.sync.enqueue(choice(d,'Alex Example'));await settle();
 const polling=d.sync.refresh();await settle();expect(d.sync.link()).toEqual({names:'online',delivery:'unknown'});
 await d.next('fail',CHECK_IN);expect(d.sync.link()).toEqual({names:'online',delivery:'failing'});
 await d.next('deliver',NAMES);expect(await polling).toBe('online');expect(d.sync.link()).toEqual({names:'online',delivery:'failing'});expect(d.status('Alex Example')).toBe('queued');
 const offline=d.sync.refresh();await settle();expect(d.sync.link().names).toBe('online');
 await d.next('fail',NAMES);expect(await offline).toBe('offline');expect(d.sync.link().names).toBe('offline');
 void d.sync.flush();await d.next('deliver',CHECK_IN);expect(d.sync.link().delivery).toBe('ok');expect(d.status('Alex Example')).toBe('checked-in');store.close();
});

test('organiser queue: a quick undo queued during delivery is sent in the same flush, in order',async()=>{
 const store=setup();const q=organiserQueue(memory());const gates:(()=>void)[]=[];
 const send=(c:{id:string;present:boolean;version:number;opId:string})=>new Promise<void>((resolve,reject)=>gates.push(()=>{try{store.setAttendance(c.id,c.present,c.version,'local-organiser',c.opId);resolve()}catch(e){reject(e)}}));
 q.add({opId:'organiser-op-0001',id:'a',name:'Alex Example',present:true,version:0});const flushing=q.flush(send);await settle();
 q.add({opId:'organiser-op-0002',id:'a',name:'Alex Example',present:false,version:1});
 expect(q.overlay(store.list().participants).find(p=>p.id==='a')).toMatchObject({present:false,queued:true});
 gates.shift()!();await settle();gates.shift()!();
 expect(await flushing).toEqual({synced:2,conflicts:0,waiting:0});expect(person(store,'a')).toMatchObject({present:false,version:2});store.close();
});
