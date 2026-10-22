// An iPad's recovery file imported on the laptop: validated against the device-v1 contract shape, previewed without writing, applied
// through the same operations path as a live upload (idempotent by opId, ADR-0004), so replays and late live sends record nothing twice.
import {describe,expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {setup} from './device-helpers';

async function rig(opts:{open?:boolean}={}){
 const s=setup(opts);
 const {credential,deviceId}=await s.pairDevice({label:'Door iPad'});
 const snap=await s.roster(credential);
 const token=(name:string)=>snap.people.find((p:{displayName:string})=>p.displayName===name)!;
 const op=(name:string,opId:string=crypto.randomUUID())=>{const p=token(name);return {opId,personToken:p.personToken,displayName:p.displayName,baseRevision:p.revision,windowRevisionSeen:1,recordedAt:new Date(s.clock.t).toISOString()};};
 const file=(operations:unknown[],over:Record<string,unknown>={})=>({format:'attendance-recovery',version:1,eventId:snap.eventId,eventCode:snap.eventCode,deviceId,exportedAt:new Date(s.clock.t).toISOString(),operations,...over});
 const importFile=(f:unknown,dryRun=false)=>s.org('POST','/api/organiser/recovery-import',{file:f,dryRun});
 return {s,credential,deviceId,snap,op,file,importFile};
}

describe('recovery import', () => {
 test('a preview writes nothing; the import records each check-in once; importing again records nothing new', async () => {
  const r=await rig();
  const f=r.file([r.op('Alex Example'),r.op('Bea Example')]);
  const preview=await r.importFile(f,true);
  expect(preview.status).toBe(200);
  expect(preview.body).toMatchObject({written:false,deviceLabel:'Door iPad',counts:{recorded:2,already:0,review:0,refused:0}});
  expect(preview.body.rows.map((x:{name:string})=>x.name)).toEqual(['Alex Example','Bea Example']);
  expect(r.s.store.list().participants.filter(p=>p.present)).toHaveLength(0);
  const done=await r.importFile(f);
  expect(done.body).toMatchObject({written:true,counts:{recorded:2,already:0}});
  expect(r.s.store.list().participants.filter(p=>p.present).map(p=>p.name).sort()).toEqual(['Alex Example','Bea Example']);
  const again=await r.importFile(f);
  expect(again.body.counts).toEqual({recorded:0,already:2,review:0,refused:0});
  const audit=r.s.store.db.query("SELECT COUNT(*) AS n FROM audit WHERE verb='check-in'").get() as {n:number};
  expect(audit.n).toBe(2);
 });
 test('check-ins in the file that the iPad later sends live are answered already_applied', async () => {
  const r=await rig();
  const o=r.op('Alex Example');
  await r.importFile(r.file([o]));
  const {displayName:_,...wire}=o;
  const live=await r.s.send(r.credential,wire);
  expect(live.body.results).toEqual([{opId:o.opId,outcome:'already_applied'}]);
 });
 test('a check-in sent live first is already recorded when the file comes later', async () => {
  const r=await rig();
  const o=r.op('Bea Example');
  const {displayName:_,...wire}=o;
  await r.s.send(r.credential,wire);
  expect((await r.importFile(r.file([o]))).body.counts).toMatchObject({recorded:0,already:1});
 });
 test('the window being closed does not stop a recovery import (the iPad recorded them while it was open)', async () => {
  const r=await rig();
  r.s.store.closeParticipantWindow('test');
  expect((await r.importFile(r.file([r.op('Alex Example')]))).body.counts.recorded).toBe(1);
 });
 test('held, unknown and malformed operations are reported, never applied', async () => {
  const r=await rig();
  const stale=r.op('Alex Example');
  r.s.store.setAttendance('a',true,0,'organiser');r.s.store.setAttendance('a',false,1,'organiser');
  const unknown={...r.op('Bea Example'),personToken:'pt_'+'f'.repeat(24),displayName:'Someone Else'};
  const res=await r.importFile(r.file([stale,unknown,{opId:'x',personToken:1}]));
  expect(res.body.counts).toEqual({recorded:0,already:0,review:2,refused:1});
  expect(res.body.rows.map((x:{outcome:string;reason?:string})=>[x.outcome,x.reason])).toEqual([['review','stale'],['review','unknown_person'],['refused','invalid']]);
  expect(res.body.rows[1].name).toBe('Someone Else');
  expect(r.s.store.list().conflicts).toHaveLength(1);
 });
 test('a file from another workshop, another format or a newer version is refused whole', async () => {
  const r=await rig();
  expect((await r.importFile(r.file([r.op('Alex Example')],{eventId:'evt_other',eventCode:'ZZ9Q'}))).body.error).toContain('another workshop (event code ZZ9Q)');
  expect((await r.importFile(r.file([],{format:'roster'}))).status).toBe(400);
  expect((await r.importFile(r.file([],{version:2}))).body.error).toContain('newer version');
  expect((await r.importFile(r.file([],{deviceId:'../etc'}))).status).toBe(400);
  expect((await r.importFile(r.file(Array.from({length:1001},()=>r.op('Alex Example'))))).status).toBe(400);
  expect(r.s.store.list().participants.filter(p=>p.present)).toHaveLength(0);
 });
 test('a file with no device id or an unknown one still imports; unmatched check-ins are kept for the organiser', async () => {
  const r=await rig();
  const res=await r.importFile(r.file([r.op('Alex Example'),{...r.op('Bea Example'),personToken:'pt_'+'e'.repeat(24)}],{deviceId:null}));
  expect(res.body).toMatchObject({deviceId:'recovery-file',deviceLabel:null,counts:{recorded:1,review:1}});
  const devices=await r.s.org('GET','/api/organiser/devices');
  expect(devices.body.unmatchedCheckIns).toHaveLength(1);
 });
 test('the iPad contract fixture (copied in tests/fixtures/device-v1) has the shape the import reads, and imports', async () => {
  const path=resolve(import.meta.dir,'fixtures/device-v1/recovery.example.attendance-recovery.json');
  const f=JSON.parse(readFileSync(path,'utf8')) as Record<string,unknown>;
  expect(f).toMatchObject({format:'attendance-recovery',version:1});
  expect(Object.keys((f.operations as object[])[0]!).sort()).toEqual(['baseRevision','displayName','opId','personToken','recordedAt','windowRevisionSeen']);
  // Its event is another register's: refused. Pointed at this register, its person is unknown here and is kept for review.
  const r=await rig();
  expect((await r.importFile(f)).status).toBe(409);
  const res=await r.importFile({...f,eventId:r.snap.eventId,deviceId:null});
  expect(res.body.counts).toEqual({recorded:0,already:0,review:1,refused:0});
 });
});
