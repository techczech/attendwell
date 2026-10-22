import {test,expect} from 'bun:test';
import {AttendanceStore} from '../server/store-attendance';
import {createHandler} from '../server/http-attendance';
import {parseWorkshopConfig,exampleWorkshop,validBasePath,WorkshopConfigError} from '../server/workshop-config';
import {fixture} from './fixtures-attendance';
const valid={sessionId:'spring-lab-02',title:'Spring Lab: Data Basics',date:'2031-03-04'};
const origin='https://origin.example.net';

test('explicit configuration needs session, title and date; optional fields fall back to the fictional example',()=>{
 const c=parseWorkshopConfig(valid);expect(c).toMatchObject({...valid,startTime:'13:00',endTime:'16:00',organiserHelp:exampleWorkshop.organiserHelp,participantBasePath:'/example-check-in',publicOrigin:null});
 expect(Object.isFrozen(c)).toBe(true);
 for(const k of ['sessionId','title','date'] as const){const {[k]:_,...rest}=valid;expect(()=>parseWorkshopConfig(rest)).toThrow(k);}
 expect(parseWorkshopConfig({},{allowExampleIdentity:true})).toEqual(exampleWorkshop);
});

test('every field is validated and unknown fields are refused',()=>{
 const bad:Record<string,unknown>[]=[{sessionId:'has space'},{sessionId:''},{title:''},{title:'x'.repeat(201)},{title:'<b>bold</b>'},{title:'line\nbreak'},{date:'2031-02-30'},{date:'04/03/2031'},
  {startTime:'9:00'},{startTime:'16:00',endTime:'13:00'},{endTime:'24:00'},{organiserHelp:''},{participantBasePath:'example'},{participantBasePath:'/check-in'},{participantBasePath:'/api'},{participantBasePath:'/Upper'},{participantBasePath:'/a/b'},
  {publicOrigin:'http://check-in.example.org'},{publicOrigin:'https://check-in.example.org/path'},{publicOrigin:'not a url'},
  {sourceStatuses:{}},{sourceStatuses:{Booked:'present'}},{sourceStatuses:{'Manual addition':'confirmed'}},{sourceStatuses:[]},{secret:'x'}];
 for(const extra of bad)expect(()=>parseWorkshopConfig({...valid,...extra})).toThrow(WorkshopConfigError);
 expect(()=>parseWorkshopConfig(null)).toThrow(WorkshopConfigError);expect(()=>parseWorkshopConfig([])).toThrow(WorkshopConfigError);
 expect(parseWorkshopConfig({...valid,publicOrigin:'https://check-in.example.org',participantBasePath:'/spring-lab'})).toMatchObject({publicOrigin:'https://check-in.example.org',participantBasePath:'/spring-lab'});
 expect(['/a','/spring-lab-02'].every(validBasePath)).toBe(true);
});

test('malformed and impossible dates raise the configuration error, never a RangeError',()=>{
 for(const date of ['2030-13-15','2030-00-10','2030-01-32','2030-01-00','2030-02-29','2030-04-31','2030-99-99','2030-1-15','2030-01-15T00:00','20300115','',' 2030-01-15',20300115]){
  let thrown:unknown;try{parseWorkshopConfig({...valid,date})}catch(e){thrown=e}
  expect(thrown).toBeInstanceOf(WorkshopConfigError);expect((thrown as Error).message).toContain('"date"');
 }
 expect(parseWorkshopConfig({...valid,date:'2032-02-29'}).date).toBe('2032-02-29');
});

test('import provenance checks follow the configured session, date and source labels',()=>{
 const workshop=parseWorkshopConfig({...valid,sourceStatuses:{Booked:'confirmed',Cancelled:'cancelled','Waiting List':'waiting'}});
 const store=new AttendanceStore(':memory:',workshop);
 // The fictional example roster belongs to another session and is refused.
 expect(()=>store.import(fixture,'test')).toThrow('spring-lab-02');
 const relabel:Record<string,string>={Confirmed:'Booked',Cancelled:'Cancelled','Waiting list':'Waiting List'};
 const roster={...fixture,sessionId:valid.sessionId,date:valid.date,participants:fixture.participants.map(p=>({...p,sourceStatus:relabel[p.sourceStatus]}))};
 expect(()=>store.import({...roster,participants:[{...roster.participants[0],sourceStatus:'Confirmed'}]},'test')).toThrow('source status');
 expect(()=>store.import({...roster,participants:[{...roster.participants[0],booking:'waiting'}]},'test')).toThrow();
 expect(()=>store.import({...roster,source:{...roster.source,sha256:'short'}},'test')).toThrow('checksum');
 const list=store.import(roster,'test');
 expect(list).toMatchObject({sessionId:valid.sessionId,title:valid.title,date:valid.date,time:'13:00–16:00'});expect(list.participants).toHaveLength(6);store.close();
});

test('shipped examples stay valid: both workshop files parse and the example roster imports',async()=>{
 const read=(f:string)=>Bun.file(new URL('../examples/'+f,import.meta.url)).json();
 const workshop=parseWorkshopConfig(await read('workshop.example.json'));expect(workshop).toEqual(exampleWorkshop);
 expect(parseWorkshopConfig(await read('workshop.cosy-adapter.example.json')).sourceStatuses).toEqual({Booked:'confirmed',Cancelled:'cancelled','Waiting List':'waiting'});
 const store=new AttendanceStore(':memory:',workshop);expect(store.import(await read('roster.example.json'),'test').participants).toHaveLength(4);store.close();
});

test('participant listener shows only the public workshop fields and uses the configured organiser help',async()=>{
 const workshop=parseWorkshopConfig({...valid,organiserHelp:'Ask at the front desk.',publicOrigin:'https://check-in.example.org'});
 const store=new AttendanceStore(':memory:',workshop);store.import({...fixture,sessionId:valid.sessionId,date:valid.date},'test');store.initParticipantWindow();
 const handler=createHandler(store,{origin,users:{},participantOnly:true},'/tmp/missing-assets');
 const body=await (await handler(new Request(origin+'/api/participant-names'))).json();
 expect(body.workshop).toEqual({title:valid.title,date:valid.date,startTime:'13:00',endTime:'16:00',organiserHelp:'Ask at the front desk.'});
 expect(JSON.stringify(body)).not.toContain('@');expect(JSON.stringify(body)).not.toContain(valid.sessionId);expect(JSON.stringify(body)).not.toContain('sourceStatus');
 store.db.query('UPDATE people SET name=? WHERE id=?').run('Alex Example','b');
 const token=body.participants.find((p:any)=>p.name==='Alex Example').token;
 const held=await handler(new Request(origin+'/api/participant-check-in',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Attendance-Request':'1'},body:JSON.stringify({token})}));
 expect(held.status).toBe(409);expect((await held.json()).error).toContain('Ask at the front desk.');
 store.closeParticipantWindow('test');const closed=await handler(new Request(origin+'/api/participant-names'));expect(closed.status).toBe(410);expect((await closed.json()).error).toContain('Ask at the front desk.');
 store.close();
});
