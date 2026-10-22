// What a paired iPad sees versus what the organiser reviews: addresses kept out of device text,
// and check-ins the register cannot apply kept for the organiser instead of vanishing.
import {test,expect} from 'bun:test';
import {AttendanceStore} from '../server/store-attendance';
import {exampleWorkshop} from '../server/workshop-config';
import {deviceRegistry,deviceText,HIDDEN_NAME} from '../server/device-attendance';
import {setup,privacyViolations} from './device-helpers';
import {fixture} from './fixtures-attendance';

test('device text: an address is removed from a name or title; text without one is untouched',()=>{
 const cases:[string,string][]=[['Alex Example <alex@example.org>','Alex Example'],['Alex<alex@example.org>','Alex'],['"Alex" (alex@example.org)','"Alex"'],
  ['Smith, Alex - alex@example.org','Smith, Alex'],['alex@example.org',HIDDEN_NAME],['Sam @ Home','Sam @ Home'],['Zoë O’Brien','Zoë O’Brien'],
  // Wider than the iPad's \s: a zero-width no-break space is not a word break here, so this is caught too.
  ['Bo x@﻿example.org','Bo']];
 for(const [input,shown] of cases){expect(deviceText(input,HIDDEN_NAME)).toBe(shown);expect(privacyViolations({x:deviceText(input,HIDDEN_NAME)})).toEqual([]);}
});

test('roster and pairing offer: names and the workshop title never carry an address; the organiser sees which were changed',async()=>{
 const s=setup();
 s.store.import({...fixture,participants:fixture.participants.map(p=>p.id==='a'?{...p,name:'Alex Example <alex@example.org>'}:p.id==='m'?{...p,name:'missing@example.org'}:p)},'test');
 const {credential}=await s.pairDevice();
 // dev() fails on any email-like value, as the iPad would.
 const r=await s.roster(credential);
 expect(r.people.map((p:any)=>p.displayName).sort()).toEqual(['Alex Duplicate','Alex Example','Bea Example',HIDDEN_NAME]);
 // Nobody is dropped, and a sanitised name checks in like any other.
 const alex=r.people.find((p:any)=>p.displayName==='Alex Example');
 expect((await s.send(credential,s.op(alex.personToken,alex.revision))).body.results[0].outcome).toBe('applied');
 expect(s.store.list().participants.find(p=>p.id==='a')!.present).toBe(true);
 const list=(await s.org('GET','/api/organiser/devices')).body;
 expect(list.adjustedText).toEqual([{participantId:'a',original:'Alex Example <alex@example.org>',shownAs:'Alex Example'},{participantId:'m',original:'missing@example.org',shownAs:HIDDEN_NAME}]);
 s.store.close();
 // A workshop title with an address: the offer and roster carry the title without it.
 const store=new AttendanceStore(':memory:',{...exampleWorkshop,title:'Spring Workshop (questions: org@example.org)'});
 const reg=deviceRegistry(store);
 expect(reg.event().eventName).toBe('Spring Workshop (questions:)');
 expect(privacyViolations(reg.snapshot())).toEqual([]);
 expect(reg.devices().adjustedText).toEqual([{participantId:null,original:'Spring Workshop (questions: org@example.org)',shownAs:'Spring Workshop (questions:)'}]);
 store.close();
});

test('re-import before upload: a check-in for a removed booking is held in the conflict queue, answered the same on replay, and only dismissable',async()=>{
 const s=setup();const {credential,deviceId}=await s.pairDevice();
 const bea=(await s.roster(credential)).people.find((p:any)=>p.displayName==='Bea Example');
 // Bea is checked in on the iPad offline; a re-import removes her booking before the upload.
 s.store.import({...fixture,participants:fixture.participants.filter(p=>p.id!=='b')},'test');
 const op=s.op(bea.personToken,bea.revision);
 expect((await s.send(credential,op)).body.results).toEqual([{opId:op.opId,outcome:'held',reason:'not_on_form'}]);
 expect((await s.send(credential,op)).body.results).toEqual([{opId:op.opId,outcome:'held',reason:'not_on_form'}]);
 expect(s.store.db.query('SELECT participantId,kind,outcome,reason,deviceId FROM operations WHERE opId=?').all(op.opId)).toEqual([{participantId:'b',kind:'device-check-in',outcome:'conflict',reason:'not-in-roster',deviceId}]);
 expect(s.store.list().conflicts).toMatchObject([{participantId:'b',name:'Bea Example',reason:'not-in-roster',count:1}]);
 expect((await s.org('GET','/api/organiser/devices')).body.devices[0]).toMatchObject({needsReview:1});
 // Not applied, and it cannot be checked in while the booking is out of the roster; dismissing clears it.
 expect(s.store.db.query("SELECT present,active FROM people WHERE id='b'").get()).toEqual({present:0,active:0});
 const org=(path:string,data:unknown)=>s.org('POST',path,data);
 expect((await org('/api/resolve-conflict',{id:'b',action:'check-in'})).status).toBe(409);
 expect((await org('/api/resolve-conflict',{id:'b',action:'dismiss'})).status).toBe(200);
 expect(s.store.list().conflicts).toEqual([]);
 s.store.close();
});

test('unknown person and reused opId: held, kept on the organiser device list once per operation, and dismissable',async()=>{
 const s=setup();const {credential,deviceId}=await s.pairDevice();
 const alex=(await s.roster(credential)).people.find((p:any)=>p.displayName==='Alex Example');
 const unknown=s.op('pt_'+'f'.repeat(24),0);
 for(let i=0;i<2;i++)expect((await s.send(credential,unknown)).body.results).toEqual([{opId:unknown.opId,outcome:'held',reason:'unknown_person'}]);
 const first=s.op(alex.personToken,alex.revision);await s.send(credential,first);
 const bea=(await s.roster(credential)).people.find((p:any)=>p.displayName==='Bea Example');
 const reused={...s.op(bea.personToken,bea.revision),opId:first.opId};
 expect((await s.send(credential,reused)).body.results).toEqual([{opId:first.opId,outcome:'held',reason:'invalid'}]);
 const list=(await s.org('GET','/api/organiser/devices')).body;
 expect(list.devices[0]).toMatchObject({id:deviceId,unmatchedCheckIns:2});
 expect(list.unmatchedCheckIns.map((h:any)=>[h.opId,h.reason,h.deviceId,h.deviceLabel,h.recordedAt])).toEqual([[first.opId,'invalid',deviceId,'iPad 1',reused.recordedAt],[unknown.opId,'unknown_person',deviceId,'iPad 1',unknown.recordedAt]]);
 const id=list.unmatchedCheckIns[1].id;
 expect((await s.org('POST',`/api/organiser/device-holds/${id}/dismiss`,{})).body.unmatchedCheckIns).toHaveLength(1);
 expect((await s.org('POST',`/api/organiser/device-holds/${id}/dismiss`,{})).status).toBe(404);
 expect((await s.org('GET',`/api/organiser/device-holds/${id}/dismiss`)).status).toBe(405);
 expect(s.store.db.query("SELECT COUNT(*) AS n FROM audit WHERE verb='device-hold-dismissed'").get()).toEqual({n:1});
 s.store.close();
});
