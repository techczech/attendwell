// Adding a pasted or imported name list: merge by email (never by name alone), duplicates within the list, refusals with reasons,
// a preview that writes nothing, the same list twice, provenance, and the organiser route. Fictional names only.
import {describe,expect,test} from 'bun:test';
import {AttendanceStore} from '../server/store-attendance';
import {classifyStatus,listKeyOf,planNames,type NameRow} from '../server/names-list';
import {exampleWorkshop} from '../server/workshop-config';
import {fixture} from './fixtures-attendance';
import {setup} from './device-helpers';

const rows=(...xs:Array<[string,string?,string?,string?]>):NameRow[]=>xs.map(([name,email='',status,date],i)=>({row:i+1,name,email,...(status!==undefined?{status}:{}),...(date!==undefined?{date}:{})}));
const fresh=()=>new AttendanceStore(':memory:');
const paste=(r:NameRow[],dryRun=false)=>({source:{kind:'paste' as const},rows:r,dryRun});

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
  const done=s.addNames(paste(list),'owner');
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
  s.addNames({source:{kind:'file',filename:'list.csv',sha256:'b'.repeat(64)},rows:list},'owner');
  expect(s.addNames(paste(list,true),'owner',{dryRun:true}).plan.alreadyAdded).toMatchObject({filename:'list.csv'});
  expect(()=>s.addNames(paste(list),'owner')).toThrow('already added');
  expect(s.list().participants).toHaveLength(2);
  const again=s.addNames(paste(rows(['Imogen Pryce','IMOGEN@example.ac.uk'],['Lars Eriksson'])),'owner');
  expect(again.plan.rows.map(r=>r.result)).toEqual(['known','added']);
  expect(s.list().participants.map(p=>p.name).sort()).toEqual(['Imogen Pryce','Lars Eriksson','Sam Patel']);
 });
 test('the first list is still recognised after more than 100 later lists (the display list keeps 100, the keys are all kept)', () => {
  const s=fresh();
  const first=rows(['Imogen Pryce','imogen@example.ac.uk']);
  s.addNames(paste(first),'owner');
  for(let i=0;i<101;i+=1)s.addNames(paste(rows([`Fictional Person ${i}`,`person${i}@example.ac.uk`])),'owner');
  expect(s.nameLists()).toHaveLength(100);
  expect(s.nameLists().some(l=>l.added===1&&l.rows===1)).toBe(true);
  expect(s.addNames(paste(first,true),'owner',{dryRun:true}).plan.alreadyAdded).not.toBeNull();
  // Imogen left in a full import; the first list again is still the same list, so it changes nothing.
  s.db.query("UPDATE people SET active=0 WHERE email='imogen@example.ac.uk'").run();
  expect(()=>s.addNames(paste(first),'owner')).toThrow('already added');
  expect(s.list().participants.filter(p=>p.active)).toHaveLength(101);
 });
 test('a person with an email keeps one stable record: removed by a full import, added again from a list, it comes back', () => {
  const s=fresh();
  s.addNames(paste(rows(['Ngozi Adeyemi','ngozi@example.ac.uk'])),'owner');
  const id=s.list().participants[0]!.id;
  s.import(fixture,'test');
  expect(s.list().participants.some(p=>p.id===id)).toBe(false);
  s.addNames(paste(rows(['Ngozi Adeyemi','ngozi@example.ac.uk'],['Tom Whitfield'])),'owner');
  expect(s.list().participants.find(p=>p.email==='ngozi@example.ac.uk')!.id).toBe(id);
 });
 test('two people with the same name and no email are both kept, and a self check-in under that name is held', () => {
  const s=fresh();s.initParticipantWindow(30);
  s.addNames(paste(rows(['Sam Patel'],['Sam Patel'])),'owner');
  const sams=s.list().participants;
  expect(sams).toHaveLength(2);
  expect(s.participantCheckIn(sams[0]!.id).outcome).toBe('conflict');
 });
 test('the register limit and bad input are refused in plain words', () => {
  const s=fresh();
  const many=Array.from({length:501},(_,i)=>({row:i+1,name:`Person ${i+1}`,email:''}));
  expect(s.addNames(paste(many,true),'owner',{dryRun:true}).plan.full).toBe(true);
  expect(()=>s.addNames(paste(many),'owner')).toThrow('up to 500 people');
  for(const bad of [{rows:[]},{source:{kind:'email'},rows:rows(['A'])},{source:{kind:'paste'},rows:[{row:0,name:'A',email:''}]},{source:{kind:'file',sha256:'nope'},rows:rows(['A'])},{source:{kind:'paste'},rows:[{row:1,name:'A',email:'',date:'15/01/2030'}]}])
   expect(()=>s.addNames(bad,'owner'),JSON.stringify(bad)).toThrow();
  expect(s.list().participants).toHaveLength(0);
 });
 test('control characters and formula-looking names are stored as plain text', () => {
  const s=fresh();
  s.addNames(paste(rows(['=HYPERLINK("x")\tRahman','']),),'owner');
  expect(s.list().participants[0]!.name).toBe('=HYPERLINK("x") Rahman');
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
  const done=await s.org('POST','/api/names',body);
  expect(done.body.written).toBe(true);
  expect(done.body.roster.participants.some((p:{name:string})=>p.name==='Rebecca Hartley')).toBe(true);
  expect((await s.org('POST','/api/names',body)).status).toBe(409);
 });
});
