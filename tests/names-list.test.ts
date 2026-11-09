// Adding a pasted or imported name list: merge by email (never by name alone), duplicates within the list, refusals with reasons,
// a preview that writes nothing, the same list twice, provenance, and the organiser route. Fictional names only.
import {describe,expect,test} from 'bun:test';
import {AttendanceStore} from '../server/store-attendance';
import {classifyStatus,listKeyOf,planNames,PLAN_CHANGED,type NameRow} from '../server/names-list';
import {exampleWorkshop} from '../server/workshop-config';
import {fixture} from './fixtures-attendance';
import {setup} from './device-helpers';

const rows=(...xs:Array<[string,string?,string?,string?]>):NameRow[]=>xs.map(([name,email='',status,date],i)=>({row:i+1,name,email,...(status!==undefined?{status}:{}),...(date!==undefined?{date}:{})}));
const fresh=()=>new AttendanceStore(':memory:');
const paste=(r:NameRow[],dryRun=false)=>({source:{kind:'paste' as const},rows:r,dryRun});
/** A write as the desktop app makes it: preview first, then apply with that preview's planKey. */
const write=(s:AttendanceStore,body:any)=>s.addNames({...body,planKey:s.addNames(body,'owner',{dryRun:true}).plan.planKey},'owner');

describe('the plan', () => {
 const plan=(r:NameRow[],existing:{name:string;email:string}[]=[])=>planNames({existing,addedLists:{},rows:r,workshopDate:'2030-01-15',statuses:exampleWorkshop.sourceStatuses});
 test('emails merge case-insensitively and trimmed; a name alone never merges', () => {
  const p=plan(rows(['Aisha Rahman','aisha.rahman@example.ac.uk'],['Sofia Marchetti',' Sofia.Marchetti@Example.ac.uk '],['Sofia M.','sofia.marchetti@example.ac.uk'],['Sam Patel'],['Sam Patel']));
  expect(p.rows.map(r=>r.result)).toEqual(['added','added','merged','added','added']);
  expect(p.rows[2]).toMatchObject({mergedWith:2,email:'sofia.marchetti@example.ac.uk'});
  expect(p.counts).toMatchObject({added:4,merged:1,skipped:0});
  expect(p.sameName).toEqual(['Sam Patel']);
 });
 test('someone already in the register with the same email is not added again', () => {
  const p=plan(rows(['Henrik Olsen','HENRIK.OLSEN@example.ac.uk'],['Henrik Olsen']),[{name:'Henrik Olsen',email:'henrik.olsen@example.ac.uk'}]);
  expect(p.rows.map(r=>r.result)).toEqual(['known','added']);
  expect(p.sameName).toEqual(['Henrik Olsen']);
  expect(p.total).toBe(2);
 });
 test('plus addresses stay distinct; refusals carry their reason', () => {
  const p=plan(rows(['Yuki Tanaka','yuki+ws@example.ac.uk'],['Yuki Tanaka','yuki@example.ac.uk'],['','rowan.blake@example.ac.uk'],['Priya V','priya@example.ac.uk','Cancelled'],
   ['Felix Grant','felix@example.ac.uk','Booked','2030-01-16'],['Lars Eriksson','lars@'],['X'.repeat(201)],['Mateusz Nowak','','Waiting List'],['','','']));
  expect(p.rows.map(r=>[r.result,r.reason])).toEqual([['added',undefined],['added',undefined],['skipped','no-name'],['skipped','cancelled'],['skipped','other-date'],['skipped','bad-email'],['skipped','name-too-long'],['added',undefined]]);
  expect(p.rows[4]!.date).toBe('2030-01-16');
  expect(p.rows[7]).toMatchObject({booking:'waiting',sourceStatus:'Waiting list'});
  expect(p.counts.blank).toBe(1);
 });
 test('status words: a workshop label wins, then cancelled, waiting, else confirmed', () => {
  expect(classifyStatus('Waiting list',exampleWorkshop.sourceStatuses)).toEqual({booking:'waiting',sourceStatus:'Waiting list'});
  expect(classifyStatus('Withdrawn',exampleWorkshop.sourceStatuses).booking).toBe('cancelled');
  expect(classifyStatus('',exampleWorkshop.sourceStatuses)).toEqual({booking:'confirmed',sourceStatus:'Confirmed'});
  expect(classifyStatus('Booked',{Booked:'confirmed'})).toEqual({booking:'confirmed',sourceStatus:'Booked'});
  expect(classifyStatus('On the waiting list',{Booked:'confirmed'})).toEqual({booking:'waiting',sourceStatus:null});
 });
 test('the list key ignores blank rows, spacing and email case, so the same list is recognised', () => {
  expect(listKeyOf(rows(['Aisha  Rahman','A@example.ac.uk'],['']))).toBe(listKeyOf(rows(['Aisha Rahman','a@example.ac.uk'])));
  expect(listKeyOf(rows(['Aisha Rahman']))).not.toBe(listKeyOf(rows(['Aisha Rahmen'])));
 });
});

describe('the register', () => {
 test('a preview writes nothing; adding writes the people, provenance and an audit row, and never touches attendance', () => {
  const s=fresh();s.import(fixture,'test');
  s.setAttendance('a',true,0,'test');
  const before=JSON.stringify(s.list().participants);
  const list=rows(['Aisha Rahman','aisha.rahman@example.ac.uk'],['Alex Again','Alex@Example.org'],['Callum MacLeod']);
  const preview=s.addNames(paste(list,true),'owner',{dryRun:true});
  expect(preview).toMatchObject({written:false,plan:{counts:{added:2,known:1}}});
  expect(JSON.stringify(s.list().participants)).toBe(before);
  expect(s.nameLists()).toEqual([]);
  const done=write(s,paste(list));
  expect(done.written).toBe(true);
  const people=s.list().participants;
  expect(people.find(p=>p.id==='a')).toMatchObject({present:true,version:1,name:'Alex Example'});
  expect(people.filter(p=>p.id.startsWith('list-')).map(p=>[p.name,p.email,p.booking,p.present])).toEqual([['Aisha Rahman','aisha.rahman@example.ac.uk','confirmed',false],['Callum MacLeod','','confirmed',false]]);
  expect(s.nameLists()).toEqual([expect.objectContaining({kind:'paste',filename:null,added:2,known:1,rows:3})]);
  expect(s.list().nameLists).toHaveLength(1);
  expect((s.db.query("SELECT COUNT(*) AS n FROM audit WHERE verb='add-names'").get() as {n:number}).n).toBe(1);
 });
 test('the same list twice changes nothing; a new list with the same emails merges', () => {
  const s=fresh();
  const list=rows(['Imogen Pryce','imogen@example.ac.uk'],['Sam Patel']);
  write(s,{source:{kind:'file',filename:'list.csv',sha256:'b'.repeat(64)},rows:list});
  expect(s.addNames(paste(list,true),'owner',{dryRun:true}).plan.alreadyAdded).toMatchObject({filename:'list.csv'});
  expect(()=>write(s,paste(list))).toThrow('already added');
  expect(s.list().participants).toHaveLength(2);
  const again=write(s,paste(rows(['Imogen Pryce','IMOGEN@example.ac.uk'],['Lars Eriksson'])));
  expect(again.plan.rows.map(r=>r.result)).toEqual(['known','added']);
  expect(s.list().participants.map(p=>p.name).sort()).toEqual(['Imogen Pryce','Lars Eriksson','Sam Patel']);
 });
 test('the first list is still recognised after more than 100 later lists (the display list keeps 100, the keys are all kept)', () => {
  const s=fresh();
  const first=rows(['Imogen Pryce','imogen@example.ac.uk']);
  write(s,paste(first));
  for(let i=0;i<101;i+=1)write(s,paste(rows([`Fictional Person ${i}`,`person${i}@example.ac.uk`])));
  expect(s.nameLists()).toHaveLength(100);
  expect(s.nameLists().some(l=>l.added===1&&l.rows===1)).toBe(true);
  expect(s.addNames(paste(first,true),'owner',{dryRun:true}).plan.alreadyAdded).not.toBeNull();
  // Imogen left in a full import; the first list again is still the same list, so it changes nothing.
  s.db.query("UPDATE people SET active=0 WHERE email='imogen@example.ac.uk'").run();
  expect(()=>write(s,paste(first))).toThrow('already added');
  expect(s.list().participants.filter(p=>p.active)).toHaveLength(101);
 });
 test('a person with an email keeps one stable record: removed by a full import, added again from a list, it comes back', () => {
  const s=fresh();
  write(s,paste(rows(['Ngozi Adeyemi','ngozi@example.ac.uk'])));
  const id=s.list().participants[0]!.id;
  s.import(fixture,'test');
  expect(s.list().participants.some(p=>p.id===id)).toBe(false);
  write(s,paste(rows(['Ngozi Adeyemi','ngozi@example.ac.uk'],['Tom Whitfield'])));
  expect(s.list().participants.find(p=>p.email==='ngozi@example.ac.uk')!.id).toBe(id);
 });
 test('two people with the same name and no email are both kept, and a self check-in under that name is held', () => {
  const s=fresh();s.initParticipantWindow(30);
  write(s,paste(rows(['Sam Patel'],['Sam Patel'])));
  const sams=s.list().participants;
  expect(sams).toHaveLength(2);
  expect(s.participantCheckIn(sams[0]!.id).outcome).toBe('conflict');
 });
 test('the register limit and bad input are refused in plain words', () => {
  const s=fresh();
  const many=Array.from({length:501},(_,i)=>({row:i+1,name:`Person ${i+1}`,email:''}));
  expect(s.addNames(paste(many,true),'owner',{dryRun:true}).plan.full).toBe(true);
  expect(()=>write(s,paste(many))).toThrow('up to 500 people');
  for(const bad of [{rows:[]},{source:{kind:'email'},rows:rows(['A'])},{source:{kind:'paste'},rows:[{row:0,name:'A',email:''}]},{source:{kind:'file',sha256:'nope'},rows:rows(['A'])},{source:{kind:'paste'},rows:[{row:1,name:'A',email:'',date:'15/01/2030'}]}])
   expect(()=>write(s,bad),JSON.stringify(bad)).toThrow();
  expect(s.list().participants).toHaveLength(0);
 });
 test('control characters and formula-looking names are stored as plain text', () => {
  const s=fresh();
  write(s,paste(rows(['=HYPERLINK("x")\tRahman',''])));
  expect(s.list().participants[0]!.name).toBe('=HYPERLINK("x") Rahman');
 });
});

describe('updating bookings from a newer export', () => {
 // A register built from an earlier CoSy export: two booked, one waiting (admitted by the organiser), one walk-in added by hand.
 const earlier=()=>{
  const s=fresh();
  write(s,{source:{kind:'file',filename:'cosy-1.csv',sha256:'a'.repeat(64)},rows:rows(['Aisha Rahman','aisha@example.ac.uk','Confirmed'],['Ben Okoye','ben@example.ac.uk','Confirmed'],['Marta Silva','marta@example.ac.uk','Waiting list'])});
  s.addParticipant({name:'Dev Patel',email:'dev@example.ac.uk'},'owner');
  const id=(n:string)=>s.list().participants.find(p=>p.name===n)!;
  s.admit(id('Marta Silva').id,true,id('Marta Silva').version,'owner');
  s.setAttendance(id('Ben Okoye').id,true,id('Ben Okoye').version,'owner');
  return {s,id};
 };
 const newer=rows(['Aisha Rahman','aisha@example.ac.uk','Cancelled'],['Ben Okoye','BEN@example.ac.uk','Cancelled'],['Marta Silva','marta@example.ac.uk','Confirmed'],
  ['Dev Patel','dev@example.ac.uk','Cancelled'],['Priya Varma','priya@example.ac.uk','Waiting list'],['Ola Nowak','ola@example.ac.uk','Cancelled']);
 const update=(r:NameRow[],dryRun=false)=>({source:{kind:'file' as const,filename:'cosy-2.csv'},rows:r,updateBookings:true,dryRun});
 test('without updateBookings a list only adds: people already here keep their booking', () => {
  const {s,id}=earlier();
  const r=write(s,{source:{kind:'file',filename:'cosy-2.csv'},rows:newer});
  expect(r.plan.counts).toMatchObject({added:1,updated:0});
  expect(id('Aisha Rahman').booking).toBe('confirmed');
 });
 test('the preview shows each booking change and writes nothing; the write changes bookings, never attendance or organiser additions', () => {
  const {s,id}=earlier();
  const before=JSON.stringify(s.list().participants);
  const p=s.addNames(update(newer,true),'owner',{dryRun:true});
  expect(p.written).toBe(false);
  expect(JSON.stringify(s.list().participants)).toBe(before);
  expect(p.plan.rows.map(r=>[r.name,r.result,r.from??null,r.booking??null])).toEqual([
   ['Aisha Rahman','updated','confirmed','cancelled'],['Ben Okoye','updated','confirmed','cancelled'],['Marta Silva','updated','waiting','confirmed'],
   ['Dev Patel','skipped',null,null],['Priya Varma','added',null,'waiting'],['Ola Nowak','skipped',null,null]]);
  expect(p.plan.rows[1]!.present).toBe(true);
  expect(p.plan.counts).toMatchObject({added:1,updated:3,skipped:2});
  const done=write(s,update(newer));
  expect(done.written).toBe(true);
  expect(id('Aisha Rahman')).toMatchObject({booking:'cancelled',sourceStatus:'Cancelled',present:false});
  // Cancelled, but the check-in stands: a list never changes attendance.
  expect(id('Ben Okoye')).toMatchObject({booking:'cancelled',present:true});
  // A booking change revokes waiting-list admission, as a full import does.
  expect(id('Marta Silva')).toMatchObject({booking:'confirmed',sourceStatus:'Confirmed',admitted:false});
  expect(id('Dev Patel')).toMatchObject({booking:'confirmed',sourceStatus:'Manual addition'});
  expect(id('Priya Varma')).toMatchObject({booking:'waiting'});
  // Cancelled people drop off the iPad's names list.
  expect(s.participantNames().map(n=>n.name)).toEqual(['Dev Patel','Marta Silva']);
  expect(s.nameLists().at(-1)).toMatchObject({updated:3,added:1});
  expect((s.db.query("SELECT COUNT(*) AS n FROM audit WHERE verb='update-bookings'").get() as {n:number}).n).toBe(1);
 });
 test('rows without a status never change a booking; an unchanged booking keeps admission', () => {
  const {s,id}=earlier();
  const r=write(s,update(rows(['Aisha Rahman','aisha@example.ac.uk'],['Marta Silva','marta@example.ac.uk','Waiting list'])));
  expect(r.plan.rows.map(x=>x.result)).toEqual(['known','known']);
  expect(r.written).toBe(false);
  expect(id('Marta Silva')).toMatchObject({booking:'waiting',admitted:true});
 });
 test('one email on several rows: a live booking beats a cancelled one, the other rows merge into it', () => {
  const {s,id}=earlier();
  const r=write(s,update(rows(['Aisha Rahman','aisha@example.ac.uk','Cancelled'],['Ben Okoye','ben@example.ac.uk','Cancelled'],['Ben Okoye','ben@example.ac.uk','Confirmed'])));
  expect(r.plan.rows.map(x=>[x.result,x.mergedWith??null])).toEqual([['updated',null],['merged',3],['known',null]]);
  expect(id('Ben Okoye').booking).toBe('confirmed');
 });
 test('the same list again is refused once its booking changes are in', () => {
  const {s}=earlier();
  const list=rows(['Aisha Rahman','aisha@example.ac.uk','Cancelled']);
  write(s,{source:{kind:'paste'},rows:list});
  expect(write(s,update(list)).plan.counts.updated).toBe(1);
  expect(()=>write(s,update(list))).toThrow('already added');
 });
});

describe('review findings on booking updates (regressions)', () => {
 const update=(r:NameRow[],dryRun=false)=>({source:{kind:'file' as const,filename:'cosy-2.csv'},rows:r,updateBookings:true,dryRun});
 test('re-importing a list already added never re-adds its rows without an email, even when it still changes a booking', () => {
  const s=fresh();s.import(fixture,'test');
  const list=rows(['Alex Example','bea@example.org','Cancelled'],['Callum MacLeod','','Confirmed']);
  // First time without updates: Callum is added (Bea's cancellation is skipped) and then checked in.
  write(s,{source:{kind:'file',filename:'cosy.csv'},rows:list});
  const callum=()=>s.list().participants.filter(p=>p.name==='Callum MacLeod');
  expect(callum()).toHaveLength(1);
  s.setAttendance(callum()[0]!.id,true,callum()[0]!.version,'owner');
  // Same list again, now updating bookings: the cancellation applies, Callum is not added a second time.
  const p=s.addNames(update(list,true),'owner',{dryRun:true}).plan;
  expect(p.rows.map(r=>[r.name,r.result,r.reason??null])).toEqual([['Alex Example','updated',null],['Callum MacLeod','skipped','already-added']]);
  expect(p.counts.added).toBe(0);
  expect(write(s,update(list)).written).toBe(true);
  expect(s.list().participants.find(p=>p.id==='b')!.booking).toBe('cancelled');
  expect(callum()).toHaveLength(1);
  expect(callum()[0]!.present).toBe(true);
 });
 test('an email shared by two people in the register changes neither, and a change is applied only to the previewed id', () => {
  const s=fresh();s.import(fixture,'test');
  // Alex Example and Alex Duplicate share alex@example.org; the list names only one of them.
  const p=s.addNames(update(rows(['Alex Example','alex@example.org','Cancelled'],['Bea Example','bea@example.org','Waiting list']),true),'owner',{dryRun:true}).plan;
  expect(p.rows.map(r=>[r.name,r.result,r.reason??null,r.id??null])).toEqual([['Alex Example','skipped','ambiguous-email',null],['Bea Example','updated',null,'b']]);
  write(s,update(rows(['Alex Example','alex@example.org','Cancelled'],['Bea Example','bea@example.org','Waiting list'])));
  const by=(id:string)=>s.list().participants.find(p=>p.id===id)!;
  expect([by('a').booking,by('d').booking,by('b').booking]).toEqual(['confirmed','confirmed','waiting']);
 });
 test('a write whose plan differs from the approved preview is refused and changes nothing', () => {
  const s=fresh();s.import(fixture,'test');
  const list=rows(['Bea Example','bea@example.org','Confirmed'],['Callum MacLeod','','Confirmed']);
  // The preview: Bea unchanged (known), Callum added.
  const preview=s.addNames(update(list,true),'owner',{dryRun:true}).plan;
  expect(preview.rows.map(r=>r.result)).toEqual(['known','added']);
  // Meanwhile another list cancels Bea.
  write(s,update(rows(['Bea Example','bea@example.org','Cancelled'])));
  expect(()=>s.addNames({...update(list),planKey:preview.planKey},'owner')).toThrow(PLAN_CHANGED);
  expect(s.list().participants.find(p=>p.id==='b')!.booking).toBe('cancelled');
  expect(s.list().participants.some(p=>p.name==='Callum MacLeod')).toBe(false);
 });
});

describe('the organiser route', () => {
 test('dryRun previews, the add returns the roster, and the same list twice is a 409', async () => {
  const s=setup();
  const body={source:{kind:'paste'},rows:rows(['Rebecca Hartley','rebecca@example.ac.uk'])};
  const preview=await s.org('POST','/api/names',{...body,dryRun:true});
  expect(preview.status).toBe(200);
  expect(preview.body).toMatchObject({written:false,plan:{counts:{added:1}}});
  expect(preview.body.roster.participants.some((p:{name:string})=>p.name==='Rebecca Hartley')).toBe(false);
  const done=await s.org('POST','/api/names',{...body,planKey:preview.body.plan.planKey});
  expect(done.body.written).toBe(true);
  expect(done.body.roster.participants.some((p:{name:string})=>p.name==='Rebecca Hartley')).toBe(true);
  expect((await s.org('POST','/api/names',{...body,planKey:preview.body.plan.planKey})).status).toBe(409);
  // A write without an approved preview is refused.
  expect((await s.org('POST','/api/names',{source:{kind:'paste'},rows:rows(['Tom Whitfield'])})).status).toBe(409);
 });
});
