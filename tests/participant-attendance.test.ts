import {test,expect} from 'bun:test';
import {AttendanceStore} from '../server/store-attendance';
import {createHandler} from '../server/http-attendance';
import {fixture} from './fixtures-attendance';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const origin='https://names.example.org';
function setup(open=true){const store=new AttendanceStore(':memory:');store.import(fixture,'test');store.initParticipantWindow();if(!open)store.closeParticipantWindow('test');const handler=createHandler(store,{origin,users:{},participantOnly:true},'/tmp/missing-assets');const call=(path:string,data?:unknown)=>handler(new Request(origin+'/api/'+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{Origin:origin,'Content-Type':'application/json','X-Attendance-Request':'1'},body:data===undefined?undefined:JSON.stringify(data)}));return{store,handler,call}}
test('participant output is names and opaque tokens only; private APIs are inaccessible',async()=>{const s=setup();const body=await (await s.call('participant-names')).json();expect(body.participants).toHaveLength(4);for(const p of body.participants){expect(Object.keys(p).sort()).toEqual(['checkedIn','name','rev','review','token']);expect(p.token).toMatch(/^[a-f0-9]{48}$/)}expect(JSON.stringify(body)).not.toContain('@');expect(JSON.stringify(body)).not.toContain('Cancelled Example');expect(JSON.stringify(body)).not.toContain('Waiting Example');for(const path of ['roster','recipients','login','import','attendance','logout','add-participant']){expect((await s.call(path)).status).toBe(404);expect((await s.call(path,{})).status).toBe(404)}s.store.close()});
test('check-in saves locally, returns no emails, is idempotent and cannot undo',async()=>{const s=setup();const names=await (await s.call('participant-names')).json();const token=names.participants.find((p:any)=>p.name==='Alex Example').token;for(let i=0;i<2;i++)expect(await (await s.call('participant-check-in',{token})).json()).toEqual({ok:true,token,name:'Alex Example',checkedIn:true,already:i===1,outcome:i===1?'already':'applied'});expect(s.store.list().participants.find(p=>p.id==='a')!.version).toBe(1);expect(s.store.recipients(['a']).bcc).toBe('alex@example.org');expect((await s.call('participant-check-in',{token:'a'})).status).toBe(400);expect((await s.call('participant-check-in',{token,present:false})).status).toBe(200);expect(s.store.list().participants.find(p=>p.id==='a')!.present).toBe(true);s.store.close()});
test('closed windows, cross-origin writes and ambiguous names fail closed',async()=>{const s=setup(false);expect((await s.call('participant-names')).status).toBe(410);expect((await s.call('participant-check-in',{token:'x'})).status).toBe(410);s.store.close();const a=setup();a.store.db.query('UPDATE people SET name=? WHERE id=?').run('Alex Example','b');const names=await (await a.call('participant-names')).json();expect((await a.call('participant-check-in',{token:names.participants.find((p:any)=>p.name==='Alex Example').token})).status).toBe(409);expect((await a.handler(new Request(origin+'/api/participant-check-in',{method:'POST',headers:{Origin:'https://other.example.org','Content-Type':'application/json','X-Attendance-Request':'1'},body:'{}'}))).status).toBe(403);a.store.close()});
test('check-in window: default 30 minutes, 1–1440 whole minutes, close early, reopen, kept across restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'attendance-window-'));const path=join(dir,'window.sqlite');const t0=Date.parse('2030-01-15T12:50:00Z');
 let store=new AttendanceStore(path);expect(store.participantWindow(t0).open).toBe(false);
 expect(store.initParticipantWindow(30,t0)).toMatchObject({open:true,minutes:30,closesAt:t0+30*60000,remainingMs:30*60000});
 for(const bad of [0,1441,1.5,'30',null,-5])expect(()=>store.openParticipantWindow(bad,'o',t0)).toThrow('1440');
 expect(store.openParticipantWindow(1440,'o',t0).closesAt).toBe(t0+1440*60000);expect(store.openParticipantWindow(1,'o',t0).closesAt).toBe(t0+60000);
 expect(store.closeParticipantWindow('o',t0+1000)).toMatchObject({open:false,closedEarly:true,closesAt:t0+1000});store.close();
 // Restart keeps the explicit closure: initialisation never reopens a stored window.
 store=new AttendanceStore(path);expect(store.initParticipantWindow(30,t0+2000).open).toBe(false);
 expect(store.openParticipantWindow(90,'o',t0+3000)).toMatchObject({open:true,closedEarly:false,minutes:90});store.close();
 store=new AttendanceStore(path);expect(store.initParticipantWindow(30,t0+4000)).toMatchObject({open:true,minutes:90});
 expect(store.participantWindow(t0+3000+90*60000).open).toBe(false);store.close();rmSync(dir,{recursive:true});
});
test('owner-only local endpoint opens and closes every participant listener sharing the database',async()=>{
 const s=setup();const other=createHandler(s.store,{origin:'https://origin.example.net',users:{},participantOnly:true},'/tmp/missing-assets');
 const hash=await Bun.password.hash('test-only-not-a-production-secret');const local='http://127.0.0.1:4318';
 const admin=createHandler(s.store,{origin:local,users:{owner:{hash,role:'owner'},facilitator:{hash,role:'facilitator'}}},'/tmp/missing');
 const post=(data:unknown,cookie='')=>admin(new Request(local+'/api/check-in-window',{method:'POST',headers:{Origin:local,'Content-Type':'application/json','X-Attendance-Request':'1',Cookie:cookie},body:JSON.stringify(data)}));
 const login=async(identity:string)=>(await admin(new Request(local+'/api/login',{method:'POST',headers:{Origin:local,'Content-Type':'application/json','X-Attendance-Request':'1'},body:JSON.stringify({identity,passphrase:'test-only-not-a-production-secret'})}))).headers.get('set-cookie')!.split(';')[0];
 const owner=await login('owner');
 expect((await post({action:'close'})).status).toBe(401);expect((await post({action:'close'},await login('facilitator'))).status).toBe(403);
 expect((await post({action:'open',minutes:0},owner)).status).toBe(400);expect((await post({action:'open',minutes:'45'},owner)).status).toBe(400);expect((await post({action:'pause'},owner)).status).toBe(400);
 expect(await (await post({action:'close'},owner)).json()).toMatchObject({open:false,closedEarly:true});
 expect((await s.call('participant-names')).status).toBe(410);expect((await other(new Request('https://origin.example.net/api/participant-names'))).status).toBe(410);
 const roster=await (await admin(new Request(local+'/api/roster',{headers:{Cookie:owner}}))).json();expect(roster.participantWindow).toMatchObject({open:false});
 expect(await (await post({action:'open',minutes:120},owner)).json()).toMatchObject({open:true,minutes:120});
 const names=await (await other(new Request('https://origin.example.net/api/participant-names'))).json();expect(names.closesInMs).toBeGreaterThan(119*60000);
 expect((await s.call('check-in-window')).status).toBe(404);expect((await s.call('check-in-window',{action:'open',minutes:5})).status).toBe(404);s.store.close();
});

test('local admin undo is reflected in names-only participant data',async()=>{const s=setup();let data=await (await s.call('participant-names')).json();const choice=data.participants.find((p:any)=>p.name==='Alex Example');expect(choice.checkedIn).toBe(false);await s.call('participant-check-in',{token:choice.token});data=await (await s.call('participant-names')).json();expect(data.participants.find((p:any)=>p.token===choice.token).checkedIn).toBe(true);const local=s.store.list().participants.find(p=>p.id==='a')!;s.store.setAttendance(local.id,false,local.version,'local-owner');data=await (await s.call('participant-names')).json();expect(data.participants.find((p:any)=>p.token===choice.token).checkedIn).toBe(false);expect(s.store.recipients(['a']).recipients).toHaveLength(0);s.store.close()});

test('participant host checks and static paths retain the exposure boundary',async()=>{const s=setup();expect((await s.handler(new Request('https://wrong.example.org/api/participant-names'))).status).toBe(403);for(const path of ['/server/start-attendance.ts','/attendance.sqlite','/roster.json'])expect((await s.handler(new Request(origin+path))).status).toBe(404);const response=await s.handler(new Request(origin+'/index.html'));expect(response.status).toBe(302);expect(response.headers.get('location')).toBe('/check-in');s.store.close()});
