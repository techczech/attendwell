import {Database} from 'bun:sqlite';
import {randomUUID,randomBytes,createHmac} from 'node:crypto';
import {isEligible,eligibleSql} from './eligibility-attendance';
import {exampleWorkshop,MANUAL_SOURCE_STATUS,type Booking,type WorkshopConfig} from './workshop-config';
import {planNames,MAX_LIST_ROWS,type AddedLists,type NameListRecord,type NameRow,type NamesPlan} from './names-list';
export type {Booking} from './workshop-config';
export type ImportedPerson={id:string;name:string;email:string;booking:Booking;sourceStatus:string};
export type RosterImport={sessionId:string;date:string;source:{filename:string;sha256:string;exportedAt:string};participants:ImportedPerson[]};
export type Person=ImportedPerson & {present:boolean;version:number;updatedAt:string|null;active:boolean;admitted:boolean};
export type Conflict={participantId:string;name:string;reason:string;queuedAt:string|null;receivedAt:string;count:number};
export type ParticipantWindow={open:boolean;openedAt:number|null;closesAt:number|null;minutes:number|null;closedEarly:boolean;remainingMs:number};
type Row=Omit<Person,'present'|'active'|'admitted'>&{present:number;active:number;admitted:number};
type Operation={participantId:string;kind:string;outcome:string;reason:string|null};
export class InputError extends Error {constructor(message:string,public status=400){super(message)}}
const text=(x:unknown,max:number)=>typeof x==='string'&&x.length<=max&&!/[\x00-\x1f\x7f]/.test(x);
// Normalised roster import (docs/reference-roster-import.md): session, date and every source label are checked against the workshop configuration.
export function validateRoster(input:unknown,workshop:WorkshopConfig=exampleWorkshop):RosterImport {
 const r=input as RosterImport;
 if(!r||r.sessionId!==workshop.sessionId||r.date!==workshop.date)throw new InputError(`This export does not match the configured workshop (session ${workshop.sessionId} on ${workshop.date}).`);
 if(!r.source||!text(r.source.filename,250)||!r.source.filename||!/^[a-f0-9]{64}$/.test(r.source.sha256)||!Number.isFinite(Date.parse(r.source.exportedAt)))throw new InputError('Export source, timestamp and checksum are required.');
 if(!Array.isArray(r.participants)||!r.participants.length||r.participants.length>500)throw new InputError('Import between 1 and 500 booking records.');
 const ids=new Set<string>();
 for(const p of r.participants){
  if(!p||!text(p.id,100)||!p.id||!text(p.name,200)||!p.name.trim()||!text(p.email,254)||!Object.hasOwn(workshop.sourceStatuses,p.sourceStatus)||workshop.sourceStatuses[p.sourceStatus]!==p.booking)throw new InputError('A booking record has invalid fields or a source status the workshop configuration does not map.');
  if(ids.has(p.id))throw new InputError('Duplicate participant ID.');ids.add(p.id);
 }
 return r;
}
// Body of an add-names request: where the list came from (no copy of it) and its rows as the desktop app read them.
function validateNames(input:unknown):{source:{kind:'paste'|'file';filename:string|null;sha256:string|null};rows:NameRow[]}{
 const i=input as {source?:{kind?:unknown;filename?:unknown;sha256?:unknown};rows?:unknown};
 const s=i?.source;
 if(!s||(s.kind!=='paste'&&s.kind!=='file'))throw new InputError('Say where the list came from.');
 const filename=s.filename===undefined||s.filename===null?null:s.filename;
 if(filename!==null&&(!text(filename,250)||!filename))throw new InputError('The file name is not valid.');
 const sha256=s.sha256===undefined||s.sha256===null?null:s.sha256;
 if(sha256!==null&&(typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256)))throw new InputError('The checksum is not valid.');
 if(!Array.isArray(i.rows)||!i.rows.length||i.rows.length>MAX_LIST_ROWS)throw new InputError(`A list holds between 1 and ${MAX_LIST_ROWS} rows.`);
 const rows=i.rows.map((x:unknown)=>{
  const r=x as Record<string,unknown>;
  const str=(v:unknown,max:number)=>typeof v==='string'&&v.length<=max;
  if(!r||!Number.isInteger(r.row)||(r.row as number)<1||(r.row as number)>1000000||!str(r.name,2000)||!str(r.email,2000)||(r.status!==undefined&&!str(r.status,200))
   ||(r.date!==undefined&&r.date!==null&&!(typeof r.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(r.date))))throw new InputError('A row of the list is not valid.');
  return {row:r.row as number,name:r.name as string,email:r.email as string,...(r.status!==undefined?{status:r.status as string}:{}),...(typeof r.date==='string'?{date:r.date}:{})};
 });
 return {source:{kind:s.kind,filename:filename as string|null,sha256:sha256 as string|null},rows};
}
const emailOK=(s:string)=>/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(s);
const opOK=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9-]{8,80}$/.test(x);
const csvCell=(s:string)=>'"'+(/^[=+\-@\t\r]/.test(s)?"'"+s:s).replaceAll('"','""')+'"';
export const participantNameKey=(s:string)=>s.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en-GB');
// bun:sqlite keeps the statements made by db.query() in a cache of Database.MAX_QUERY_CACHE_SIZE (20 by default). A
// statement pushed out of that cache is finalized only by garbage collection, and until then close() (sqlite3_close_v2)
// leaves the connection open, still holding the register and its -wal and -shm files; on Windows a held file cannot be
// removed or renamed. The register and device code use fewer than 100 statements, all fixed text, so a larger cache
// keeps every one of them and close() finalizes them all (tests/device-organiser-proof.test.ts checks this with close(true)).
const sqliteCache=Database as unknown as {MAX_QUERY_CACHE_SIZE?:number};
if(typeof sqliteCache.MAX_QUERY_CACHE_SIZE==='number'&&sqliteCache.MAX_QUERY_CACHE_SIZE<512)sqliteCache.MAX_QUERY_CACHE_SIZE=512;
export class AttendanceStore {
 readonly db:Database;
 private readonly secret:string;
 constructor(path:string,readonly workshop:WorkshopConfig=exampleWorkshop){
  this.db=new Database(path,{create:true});this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,booking TEXT NOT NULL,sourceStatus TEXT NOT NULL,present INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 0,updatedAt TEXT,active INTEGER NOT NULL DEFAULT 1);
   CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,at TEXT NOT NULL,actor TEXT NOT NULL,verb TEXT NOT NULL,participantId TEXT);
   CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,actor TEXT NOT NULL,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS operations(opId TEXT PRIMARY KEY,kind TEXT NOT NULL,participantId TEXT NOT NULL,actor TEXT NOT NULL,outcome TEXT NOT NULL,reason TEXT,queuedAt TEXT,receivedAt TEXT NOT NULL,resolvedAt TEXT,resolution TEXT);`);
  // Additive migration: organiser admission is kept separate from the source waiting-list provenance.
  if(!(this.db.query('PRAGMA table_info(people)').all() as {name:string}[]).some(c=>c.name==='admitted'))this.db.exec('ALTER TABLE people ADD COLUMN admitted INTEGER NOT NULL DEFAULT 0');
  // Additive migration: paired iPads (server/device-attendance.ts) are named on their operations and audit rows; browser rows stay null.
  for(const table of ['operations','audit'])if(!(this.db.query(`PRAGMA table_info(${table})`).all() as {name:string}[]).some(c=>c.name==='deviceId'))this.db.exec(`ALTER TABLE ${table} ADD COLUMN deviceId TEXT`);
  // A per-database secret keeps public selection tokens stable across restarts without exposing source IDs.
  this.db.query("INSERT OR IGNORE INTO metadata(key,value) VALUES('participant-token-secret',?)").run(randomBytes(32).toString('hex'));
  this.secret=(this.db.query("SELECT value FROM metadata WHERE key='participant-token-secret'").get() as {value:string}).value;
 }
 close(){this.db.close()}
 // Participant check-in window, shared by every participant listener on this database and kept across restarts.
 // No stored window means closed; only an organiser action or first-run initialisation opens it.
 participantWindow(now=Date.now()):ParticipantWindow{
  const row=this.db.query("SELECT value FROM metadata WHERE key='participant-window'").get() as {value:string}|null;
  if(!row)return {open:false,openedAt:null,closesAt:null,minutes:null,closedEarly:false,remainingMs:0};
  const w=JSON.parse(row.value) as {openedAt:number;closesAt:number;minutes:number;closedEarly?:boolean};
  return {open:now<w.closesAt,openedAt:w.openedAt,closesAt:w.closesAt,minutes:w.minutes,closedEarly:!!w.closedEarly,remainingMs:Math.max(0,w.closesAt-now)};
 }
 openParticipantWindow(minutes:unknown,actor:string,now=Date.now()){
  if(!Number.isInteger(minutes)||(minutes as number)<1||(minutes as number)>1440)throw new InputError('Choose a check-in duration between 1 and 1440 whole minutes.');
  this.writeWindow({openedAt:now,closesAt:now+(minutes as number)*60000,minutes:minutes as number});this.audit(actor,'open-participant-window');return this.participantWindow(now);
 }
 closeParticipantWindow(actor:string,now=Date.now()){
  const w=this.participantWindow(now);
  if(w.open)this.writeWindow({openedAt:w.openedAt!,closesAt:now,minutes:w.minutes!,closedEarly:true});
  this.audit(actor,'close-participant-window');return this.participantWindow(now);
 }
 // First run only: an existing window (open or closed) is never reopened by a restart.
 initParticipantWindow(minutes=30,now=Date.now()){if(!this.db.query("SELECT 1 FROM metadata WHERE key='participant-window'").get())this.openParticipantWindow(minutes,'service-start',now);return this.participantWindow(now);}
 // Every explicit open or close bumps the window revision paired iPads see; natural expiry does not.
 private writeWindow(w:object){this.db.transaction(()=>{this.db.query("INSERT INTO metadata(key,value) VALUES('participant-window',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(w));this.db.query("INSERT INTO metadata(key,value) VALUES('participant-window-revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1").run();})()}
 windowRevision(){return Number((this.db.query("SELECT value FROM metadata WHERE key='participant-window-revision'").get() as {value:string}|null)?.value??0)}
 participantToken(id:string){return createHmac('sha256',this.secret).update('participant:'+id).digest('hex').slice(0,48)}
 participantSession(){return createHmac('sha256',this.secret).update('session').digest('hex').slice(0,16)}
 participantIdForToken(token:unknown){if(typeof token!=='string'||!/^[a-f0-9]{48}$/.test(token))return undefined;return (this.db.query('SELECT id FROM people WHERE active=1').all() as {id:string}[]).find(p=>this.participantToken(p.id)===token)?.id;}
 participantNames(){return (this.db.query(`SELECT id,name,present,version,EXISTS(SELECT 1 FROM operations o WHERE o.participantId=people.id AND o.outcome='conflict' AND o.resolvedAt IS NULL) AS review FROM people WHERE active=1 AND ${eligibleSql} ORDER BY name COLLATE NOCASE,id`).all() as {id:string;name:string;present:number;version:number;review:number}[]).map(p=>({...p,checkedIn:!!p.present,review:!!p.review}));}
 // Replayable self-check-in: the device's operation ID makes retries idempotent; basis is the record version the device saw.
 // A stale basis on a pending record means an organiser changed it meanwhile (for example undo): hold for review, never overwrite.
 // `by` names the channel: the browser page by default, or a paired iPad (kind device-check-in) whose replays must match that kind.
 participantCheckIn(id:string,op:{opId?:unknown;basis?:unknown;queuedAt?:unknown}={},by:{kind:string;actor:string;deviceId?:string|null}={kind:'participant-check-in',actor:'participant-self-check-in'}){
  const opId=op.opId===undefined?randomUUID():op.opId;const basis=op.basis===undefined?null:op.basis;
  if(!opOK(opId)||basis!==null&&(!Number.isInteger(basis)||(basis as number)<0))throw new InputError('Invalid check-in request.');
  const queuedAt=typeof op.queuedAt==='string'&&op.queuedAt.length<=40&&Number.isFinite(Date.parse(op.queuedAt))?op.queuedAt:null;
  return this.db.transaction(()=>{
   const p=this.db.query('SELECT * FROM people WHERE id=? AND active=1').get(id) as Row|null;
   if(!p)throw new InputError('Please find your name again.');
   const prior=this.db.query('SELECT participantId,kind,outcome,reason FROM operations WHERE opId=?').get(opId) as Operation|null;
   if(prior){if(prior.participantId!==id||prior.kind!==by.kind)throw new InputError('This check-in request was already used for another record.',409);return {name:p.name,already:true,outcome:prior.outcome,reason:prior.reason};}
   let outcome='applied',reason:string|null=null;
   if(!isEligible(p)){outcome='conflict';reason='not-eligible';}
   else if(this.participantNames().filter(n=>participantNameKey(n.name)===participantNameKey(p.name)).length>1){outcome='conflict';reason='duplicate-name';}
   else if(p.present)outcome='already';
   else if(basis!==null&&basis!==p.version){outcome='conflict';reason='changed';}
   else{this.db.query('UPDATE people SET present=1,version=version+1,updatedAt=? WHERE id=? AND present=0').run(new Date().toISOString(),id);this.audit(by.actor,'check-in',id,by.deviceId??null);}
   this.db.query('INSERT INTO operations(opId,kind,participantId,actor,outcome,reason,queuedAt,receivedAt,deviceId) VALUES(?,?,?,?,?,?,?,?,?)').run(opId,by.kind,id,by.actor,outcome,reason,queuedAt,new Date().toISOString(),by.deviceId??null);
   return {name:p.name,already:outcome==='already',outcome,reason};
  })();
 }
 // Held for review without trying to apply: a paired iPad's check-in for a booking a later import removed (reason not-in-roster).
 // Kept in the conflict queue so the organiser sees it; a replay of the same opId returns this row's answer.
 holdForReview(id:string,op:{opId:string;queuedAt?:string|null},reason:string,by:{kind:string;actor:string;deviceId?:string|null}){
  this.db.query('INSERT OR IGNORE INTO operations(opId,kind,participantId,actor,outcome,reason,queuedAt,receivedAt,deviceId) VALUES(?,?,?,?,?,?,?,?,?)').run(op.opId,by.kind,id,by.actor,'conflict',reason,op.queuedAt??null,new Date().toISOString(),by.deviceId??null);
 }
 // Inactive bookings stay out of the queue except for not-in-roster holds, which exist only because the booking left the roster.
 conflicts(){return this.db.query("SELECT o.participantId,p.name,o.reason,MIN(o.queuedAt) AS queuedAt,MAX(o.receivedAt) AS receivedAt,COUNT(*) AS count FROM operations o JOIN people p ON p.id=o.participantId WHERE o.outcome='conflict' AND o.resolvedAt IS NULL AND (p.active=1 OR o.reason='not-in-roster') GROUP BY o.participantId ORDER BY receivedAt").all() as Conflict[];}
 resolveConflict(id:unknown,action:unknown,actor:string){
  if(!text(id,100)||!['check-in','dismiss'].includes(action as string))throw new InputError('Choose how to resolve this check-in.');
  this.db.transaction(()=>{
   const p=this.db.query('SELECT * FROM people WHERE id=?').get(id as string) as Row|null;
   const open=this.db.query("SELECT COUNT(*) AS n,SUM(reason='not-in-roster') AS gone FROM operations WHERE participantId=? AND outcome='conflict' AND resolvedAt IS NULL").get(id as string) as {n:number;gone:number|null};
   if(!p||!open.n||!p.active&&!open.gone)throw new InputError('This check-in was already resolved. Refresh the register.',404);
   if(action==='check-in'&&!p.active)throw new InputError('This booking is no longer in the imported roster. Import it again or add the person, then check them in.',409);
   if(action==='check-in'){if(!isEligible(p))throw new InputError('Only an eligible booking can be checked in. Admit or refresh the booking first.');if(!p.present)this.db.query('UPDATE people SET present=1,version=version+1,updatedAt=? WHERE id=?').run(new Date().toISOString(),id as string);}
   this.db.query("UPDATE operations SET resolvedAt=?,resolution=? WHERE participantId=? AND outcome='conflict' AND resolvedAt IS NULL").run(new Date().toISOString(),action as string,id as string);
   this.audit(actor,action==='check-in'?'resolve-check-in':'resolve-dismiss',id as string);
  })();return this.list();
 }
 admit(id:unknown,admitted:unknown,version:unknown,actor:string){
  if(!text(id,100)||typeof admitted!=='boolean'||!Number.isInteger(version)||(version as number)<0)throw new InputError('Invalid admission change.');
  this.db.transaction(()=>{
   const p=this.db.query('SELECT * FROM people WHERE id=? AND active=1').get(id as string) as Row|null;
   if(!p)throw new InputError('Participant is no longer in the active roster.',404);
   if(p.booking!=='waiting')throw new InputError('Only a waiting-list booking can be admitted.');
   if(p.version!==version)throw new InputError('Admission conflict: this record changed. Refresh and try again.',409);
   if(!admitted&&p.present)throw new InputError('Undo the check-in before withdrawing admission.',409);
   this.db.query('UPDATE people SET admitted=?,version=version+1 WHERE id=? AND version=?').run(+admitted,id as string,version as number);this.audit(actor,admitted?'admit-waiting':'withdraw-admission',id as string);
  })();return this.list();
 }
 addParticipant(input:unknown,actor:string){
  const p=input as {name?:unknown;email?:unknown};
  if(!p||!text(p.name,200)||!(p.name as string).trim()||!text(p.email??'',254))throw new InputError('Enter a name and, if available, a valid email address.');
  const name=(p.name as string).trim().replace(/\s+/g,' ');const email=((p.email??'') as string).trim().toLowerCase();
  if(email&&!emailOK(email))throw new InputError('Check the email address, or leave it blank.');
  this.db.transaction(()=>{
   if(this.list().participants.some(person=>participantNameKey(person.name)===participantNameKey(name)))throw new InputError('That name is already in the register. Check the existing record first.',409);
   if(this.list().participants.length>=500)throw new InputError('The register is full.');
   const id='manual-'+randomUUID();
   this.db.query("INSERT INTO people(id,name,email,booking,sourceStatus) VALUES(?,?,?,'confirmed',?)").run(id,name,email,MANUAL_SOURCE_STATUS);
   this.audit(actor,'add-participant',id);
  })();return this.list();
 }
 audit(actor:string,verb:string,id:string|null=null,deviceId:string|null=null){this.db.query('INSERT INTO audit(at,actor,verb,participantId,deviceId) VALUES(?,?,?,?,?)').run(new Date().toISOString(),actor,verb,id,deviceId)}
 list(){
  const rows=this.db.query('SELECT * FROM people WHERE active=1 ORDER BY name COLLATE NOCASE,id').all() as Row[];
  const meta=this.db.query("SELECT value FROM metadata WHERE key='source'").get() as {value:string}|null;
  const w=this.workshop;
  return {sessionId:w.sessionId,title:w.title,date:w.date,time:`${w.startTime}–${w.endTime}`,organiserHelp:w.organiserHelp,participantBasePath:w.participantBasePath,publicOrigin:w.publicOrigin,source:meta?JSON.parse(meta.value):null,participants:rows.map(r=>({...r,present:!!r.present,active:!!r.active,admitted:!!r.admitted})),conflicts:this.conflicts(),nameLists:this.nameLists()};
 }
 import(input:unknown,actor:string){
  const r=validateRoster(input,this.workshop);
  this.db.transaction(()=>{
   // Inactive rows remain recoverable; attendance is never inferred or erased by import.
   const before=this.db.query('SELECT * FROM people').all() as Person[];const seen=new Set(r.participants.map(p=>p.id));
   for(const old of before)if(!seen.has(old.id)&&old.active&&old.sourceStatus!==MANUAL_SOURCE_STATUS)this.db.query('UPDATE people SET active=0,version=version+1 WHERE id=?').run(old.id);
   const insert=this.db.query('INSERT INTO people(id,name,email,booking,sourceStatus) VALUES(?,?,?,?,?)');
   // A booking status transition revokes organiser admission; an unchanged waiting-list row keeps it.
   const update=this.db.query('UPDATE people SET name=?1,email=?2,admitted=CASE WHEN booking=?3 AND sourceStatus=?4 THEN admitted ELSE 0 END,booking=?3,sourceStatus=?4,active=1,version=version+1 WHERE id=?5');
   for(const p of r.participants){const old=before.find(o=>o.id===p.id);if(!old)insert.run(p.id,p.name.trim(),p.email.trim().toLowerCase(),p.booking,p.sourceStatus);else if(!old.active||old.name!==p.name.trim()||old.email!==p.email.trim().toLowerCase()||old.booking!==p.booking||old.sourceStatus!==p.sourceStatus)update.run(p.name.trim(),p.email.trim().toLowerCase(),p.booking,p.sourceStatus,p.id);}
   this.db.query("INSERT INTO metadata(key,value) VALUES('source',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(r.source));this.audit(actor,'import');
  })();return this.list();
 }
 // Name lists added from the desktop app (server/names-list.ts): newest last, with where each came from and what it did.
 nameLists():NameListRecord[]{
  const row=this.db.query("SELECT value FROM metadata WHERE key='name-lists'").get() as {value:string}|null;
  try{const v=row?JSON.parse(row.value):[];return Array.isArray(v)?v:[]}catch{return []}
 }
 // Every list ever added, by listKey, for refusing the same list again. Kept apart from nameLists() (the last 100, for display) and
 // never truncated; registers written before it existed fall back on the keys their display list still holds.
 nameListKeys():AddedLists{
  const row=this.db.query("SELECT value FROM metadata WHERE key='name-list-keys'").get() as {value:string}|null;
  const out:AddedLists=Object.create(null);
  for(const l of this.nameLists())if(typeof l?.listKey==='string')out[l.listKey]={addedAt:l.addedAt,filename:l.filename};
  try{const v=row?JSON.parse(row.value):{};if(v&&typeof v==='object'&&!Array.isArray(v))Object.assign(out,v)}catch{}
  return out;
 }
 // Adds a pasted or imported list next to the people already here: merged by email (case-insensitive, never by name alone),
 // same-email rows of one list merged, rows refused with their reason. dryRun answers the same plan and writes nothing.
 // Attendance is never touched; the same list twice changes nothing; the list itself is never stored, only its provenance.
 addNames(input:unknown,actor:string,{dryRun=false}:{dryRun?:boolean}={}):{plan:NamesPlan;written:boolean}{
  const v=validateNames(input);
  return this.db.transaction(()=>{
   const existing=this.db.query('SELECT name,email FROM people WHERE active=1').all() as {name:string;email:string}[];
   const lists=this.nameLists();
   const keys=this.nameListKeys();
   const plan=planNames({existing,addedLists:keys,rows:v.rows,workshopDate:this.workshop.date,statuses:this.workshop.sourceStatuses});
   if(dryRun)return {plan,written:false};
   if(plan.alreadyAdded)throw new InputError('This list was already added. Nothing was changed.',409);
   if(plan.full)throw new InputError(`The register holds up to 500 people; with this list it would hold ${plan.total}.`,409);
   if(!plan.counts.added)return {plan,written:false};
   // Ids from an email are stable (the same person from a later list is the same record); without an email each row is new.
   const upsert=this.db.query('INSERT INTO people(id,name,email,booking,sourceStatus) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET name=?2,email=?3,booking=?4,sourceStatus=?5,admitted=0,active=1,version=version+1 WHERE active=0');
   for(const r of plan.rows){
    if(r.result!=='added')continue;
    const id='list-'+(r.email?createHmac('sha256',this.secret).update('name-list-email:'+r.email).digest('hex').slice(0,24):randomUUID());
    upsert.run(id,r.name,r.email,r.booking!,r.sourceStatus!);
   }
   const record:NameListRecord={kind:v.source.kind,filename:v.source.filename,sha256:v.source.sha256,listKey:plan.listKey,addedAt:new Date().toISOString(),rows:plan.rows.length,added:plan.counts.added,merged:plan.counts.merged,known:plan.counts.known,skipped:plan.counts.skipped};
   this.db.query("INSERT INTO metadata(key,value) VALUES('name-lists',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify([...lists,record].slice(-100)));
   keys[plan.listKey]={addedAt:record.addedAt,filename:record.filename};
   this.db.query("INSERT INTO metadata(key,value) VALUES('name-list-keys',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(keys));
   this.audit(actor,'add-names');
   return {plan,written:true};
  })();
 }
 // Optional opId makes a replayed organiser change idempotent when the first response was lost.
 setAttendance(id:string,present:boolean,version:number,actor:string,opId?:unknown){
  if(!text(id,100)||typeof present!=='boolean'||!Number.isInteger(version)||version<0||opId!==undefined&&!opOK(opId))throw new InputError('Invalid attendance change.');
  this.db.transaction(()=>{
   const prior=opId?this.db.query('SELECT participantId,kind,outcome,reason FROM operations WHERE opId=?').get(opId as string) as Operation|null:null;
   if(prior){if(prior.participantId!==id||prior.kind!=='organiser-attendance'||prior.outcome!==(present?'check-in':'undo'))throw new InputError('This change ID was already used for another change.',409);return;}
   const p=this.db.query('SELECT * FROM people WHERE id=? AND active=1').get(id) as Row|null;
   if(!p)throw new InputError('Participant is no longer in the active roster.',404);
   if(p.version!==version)throw new InputError('Attendance conflict: another facilitator updated this record. Refresh and try again.',409);
   if(present&&!isEligible(p))throw new InputError('Only a confirmed or admitted waiting-list booking can be checked in. Refresh the booking records first.');
   this.db.query('UPDATE people SET present=?,version=version+1,updatedAt=? WHERE id=? AND version=?').run(+present,new Date().toISOString(),id,version);this.audit(actor,present?'check-in':'undo',id);
   if(opId)this.db.query('INSERT INTO operations(opId,kind,participantId,actor,outcome,receivedAt) VALUES(?,?,?,?,?,?)').run(opId as string,'organiser-attendance',id,actor,present?'check-in':'undo',new Date().toISOString());
  })();return this.list();
 }
 recipients(ids:unknown){
  if(!Array.isArray(ids)||ids.length>500||ids.some(id=>!text(id,100)))throw new InputError('Select valid participant records.');
  const wanted=new Set(ids);const roster=this.list().participants;const seen=new Set<string>();const recipients:{id:string;name:string;email:string}[]=[];let excluded=0,duplicates=0;
  for(const id of wanted){const p=roster.find(p=>p.id===id);if(!p||!p.present||!isEligible(p)||!emailOK(p.email)){excluded++;continue;}if(seen.has(p.email)){duplicates++;continue;}seen.add(p.email);recipients.push({id:p.id,name:p.name,email:p.email});}
  recipients.sort((a,b)=>a.name.localeCompare(b.name));
  return {recipients,excluded,duplicates,bcc:recipients.map(p=>p.email).join('; '),names:recipients.map(p=>`${p.name} <${p.email}>`).join('\n'),csv:'Name,Email\r\n'+recipients.map(p=>[csvCell(p.name),csvCell(p.email)].join(',')).join('\r\n'),generatedAt:new Date().toISOString()};
 }
}
