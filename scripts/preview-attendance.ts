import {AttendanceStore} from '../server/store-attendance';
import {createHandler} from '../server/http-attendance';
import {parseWorkshopConfig} from '../server/workshop-config';
import {resolve} from 'node:path';
// Fictional preview. ATTENDANCE_WORKSHOP_PATH may point at a workshop file to preview its wording; missing fields use the example.
const workshop=parseWorkshopConfig(process.env.ATTENDANCE_WORKSHOP_PATH?await Bun.file(process.env.ATTENDANCE_WORKSHOP_PATH).json():{},{allowExampleIdentity:true});
const status=(booking:'confirmed'|'cancelled'|'waiting')=>Object.entries(workshop.sourceStatuses).find(([,b])=>b===booking)?.[0];
const store=new AttendanceStore(process.env.ATTENDANCE_PREVIEW_DATABASE_PATH??':memory:',workshop);
if(!store.list().participants.length)store.import({sessionId:workshop.sessionId,date:workshop.date,source:{filename:'fictional-preview',sha256:'0'.repeat(64),exportedAt:new Date().toISOString()},participants:([
 {id:'demo-alex',name:'Alex Example',email:'alex@example.org',booking:'confirmed'},
 {id:'demo-bea',name:'Bea Example',email:'bea@example.org',booking:'confirmed'},
 {id:'demo-cameron',name:'Cameron Example',email:'cameron@example.org',booking:'confirmed'},
 {id:'demo-missing',name:'Morgan Example',email:'',booking:'confirmed'},
 {id:'demo-wait',name:'Robin Example',email:'robin@example.org',booking:'waiting'},
 {id:'demo-cancel',name:'Taylor Example',email:'taylor@example.org',booking:'cancelled'}] as const).filter(p=>status(p.booking)).map(p=>({...p,sourceStatus:status(p.booking)!}))},'preview');
const hash=await Bun.password.hash('fictional-preview-only');
const port=Number(process.env.ATTENDANCE_PREVIEW_PORT??4318);const origin=`http://127.0.0.1:${port}`;
Bun.serve({hostname:'127.0.0.1',port,maxRequestBodySize:300000,fetch:createHandler(store,{origin,demo:true,localAdmin:true,users:{preview:{hash,role:'owner'},'second-preview':{hash,role:'facilitator'}}},resolve(import.meta.dir,'../dist'))});
console.log(`Fictional attendance preview for "${workshop.title}": ${origin}. Local organiser access needs no password. No real roster and no remote exposure.`);

// A new (in-memory) preview begins open for 30 minutes; a stored preview database keeps its window across restarts.
const checkIn=store.initParticipantWindow(30);
const participantPort=Number(process.env.ATTENDANCE_PARTICIPANT_PORT??4319);
Bun.serve({hostname:'127.0.0.1',port:participantPort,maxRequestBodySize:4096,fetch:createHandler(store,{origin:`http://127.0.0.1:${participantPort}`,users:{},demo:true,participantOnly:true},resolve(import.meta.dir,'../dist'))});
console.log(`Fictional participant preview: http://127.0.0.1:${participantPort}/check-in. Check-in ${checkIn.open?'open for 30 minutes':'closed'}; open, close or reopen it in the organiser preview.`);

// Optional fictional tunnel listener sharing the same window; it stays up after closing so check-in can be reopened at the same address.
if(process.env.ATTENDANCE_PARTICIPANT_ORIGIN){
 const remotePort=Number(process.env.ATTENDANCE_TUNNEL_PREVIEW_PORT??4320);
 if(remotePort===port||remotePort===participantPort)throw new Error('The tunnel preview needs its own listener port.');
 Bun.serve({hostname:'127.0.0.1',port:remotePort,maxRequestBodySize:4096,fetch:createHandler(store,{origin:process.env.ATTENDANCE_PARTICIPANT_ORIGIN,users:{},demo:true,participantOnly:true},resolve(import.meta.dir,'../dist'))});
 console.log(`Fictional names-only tunnel preview listener on port ${remotePort} for ${process.env.ATTENDANCE_PARTICIPANT_ORIGIN}. Uses the shared check-in window.`);
}
