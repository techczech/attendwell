import {test,expect} from 'bun:test';
import {AttendanceStore, type RosterImport} from '../server/store-attendance';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture} from './fixtures-attendance';
test('attendance persists after reopening and stale updates cannot overwrite',()=>{
 const dir=mkdtempSync(join(tmpdir(),'attendance-test-'));const path=join(dir,'check.sqlite');
 const s=new AttendanceStore(path);s.import(fixture,'test');expect(s.list().participants.every(p=>!p.present)).toBe(true);
 s.setAttendance('a',true,0,'first');expect(()=>s.setAttendance('a',false,0,'second')).toThrow('conflict');s.close();
 const t=new AttendanceStore(path);expect(t.list().participants.find(p=>p.id==='a')?.present).toBe(true);t.setAttendance('a',false,1,'correction');expect(t.list().participants.find(p=>p.id==='a')?.present).toBe(false);t.close();rmSync(dir,{recursive:true});
});
test('exports exclude pending, cancelled, waiting, inactive and missing addresses and deduplicate',()=>{
 const s=new AttendanceStore(':memory:');s.import(fixture,'test');for(const id of ['a','d','m'])s.setAttendance(id,true,0,'test');
 expect(()=>s.setAttendance('c',true,0,'test')).toThrow();expect(()=>s.setAttendance('w',true,0,'test')).toThrow();
 const r=s.recipients(['a','b','c','w','d','m']);expect(r.recipients.length).toBe(1);expect(r.bcc).toBe('alex@example.org');expect(r.excluded).toBe(4);expect(r.duplicates).toBe(1);s.close();
});
test('atomic import validates session, date, source status and IDs; preserves attendance and inactivates missing rows',()=>{
 const s=new AttendanceStore(':memory:');s.import(fixture,'test');s.setAttendance('a',true,0,'test');
 for(const bad of [{...fixture,sessionId:'other'},{...fixture,date:'2030-01-16'},{...fixture,participants:[{...fixture.participants[0],sourceStatus:'Cancelled'}]},{...fixture,participants:[{...fixture.participants[0],sourceStatus:'Manual addition'}]},{...fixture,participants:[{...fixture.participants[0],sourceStatus:'Unknown'}]},{...fixture,participants:[fixture.participants[0],fixture.participants[0]]}])expect(()=>s.import(bad,'test')).toThrow();
 expect(s.list().participants.length).toBe(6);s.import({...fixture,participants:[fixture.participants[0]]},'test');expect(s.list().participants[0].present).toBe(true);expect(s.recipients(['b']).recipients).toEqual([]);s.close();
});
test('changed booking revokes export without pretending attendance vanished',()=>{
 const s=new AttendanceStore(':memory:');s.import(fixture,'test');s.setAttendance('a',true,0,'test');s.import({...fixture,participants:[{...fixture.participants[0],booking:'cancelled',sourceStatus:'Cancelled'}]},'test');
 expect(s.list().participants[0].present).toBe(true);expect(s.recipients(['a']).bcc).toBe('');s.setAttendance('a',false,2,'correction');s.close();
});

test('manual additions remain pending, preserve provenance and survive a booking refresh',()=>{const s=new AttendanceStore(':memory:');s.import(fixture,'test');s.addParticipant({name:'Pat Example',email:'pat@example.org'},'local-organiser');s.addParticipant({name:'Name Only Example'},'local-organiser');let person=s.list().participants.find(p=>p.name==='Pat Example')!;expect(person.present).toBe(false);expect(person.sourceStatus).toBe('Manual addition');s.import(fixture,'test');person=s.list().participants.find(p=>p.id===person.id)!;expect(person.active).toBe(true);s.participantCheckIn(person.id);expect(s.recipients([person.id]).bcc).toBe('pat@example.org');const blank=s.list().participants.find(p=>p.name==='Name Only Example')!;s.participantCheckIn(blank.id);expect(s.recipients([blank.id]).recipients).toHaveLength(0);s.close()});
