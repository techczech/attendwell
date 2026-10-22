// Paired iPads (device protocol v1, docs/reference-device-api.md). One registry per register database:
// event identity, pairing sessions, device credentials (SHA-256 hashes only), the names-only snapshot and check-in operations.
// Pure decisions over SQLite; HTTP framing, headers and rate limits live in server/http-device-attendance.ts.
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {AttendanceStore,InputError} from './store-attendance';

export const PAIRING_TTL_MS=5*60000;          // a pairing code works for five minutes
export const PAIRING_REPLAY_MS=15*60000;      // same code + same hash returns the same answer after a lost reply
export const PAIRING_MAX_FAILURES=5;          // well-formed wrong codes per pause of the open session
export const PAIRING_PAUSE_MS=30000;          // first pause; each further five wrong codes double it
export const MAX_BATCH=50;
const ALPHABET='ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no I, L, O, U, 0 or 1: nothing to misread when typed by hand
const sha256=(s:string)=>createHash('sha256').update(s).digest('hex');
const same=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const iso=(ms:number|null)=>ms===null?null:new Date(ms).toISOString();
const plain=(x:unknown,max:number):x is string=>typeof x==='string'&&!!x.trim()&&x.length<=max&&!/[\x00-\x1f\x7f<>@]/.test(x);
// The iPad refuses a whole answer that holds an email-like value (DeviceProtocol.privacyViolations, /[^\s@]+@[^\s@]+\.[^\s@]+/).
// Here only ASCII spaces separate words, so this matches everything the iPad's pattern matches (its \s is wider) and a little more.
export const EMAIL_LIKE=/[^@ \t\n\r\f\v]+@[^@ \t\n\r\f\v]+\.[^@ \t\n\r\f\v]+/;
// Device-visible text: an email-like value drops every word holding an @, then empty brackets and stray separators left behind.
// The remaining words hold no @, so the result can never look like an address. Text without an address is returned unchanged.
export function deviceText(x:string,fallback:string){
 if(!EMAIL_LIKE.test(x))return x;
 // Odd parts are separators (spaces, brackets, quotes, commas) and never hold an @; even parts holding one are dropped.
 const out=x.split(/([ \t\n\r\f\v<>()[\]{}"',;]+)/).map((w,i)=>i%2||!w.includes('@')?w:'').join('')
  .replace(/<\s*>|\(\s*\)|\[\s*\]|\{\s*\}|"\s*"|'\s*'/g,' ').replace(/\s+/g,' ').replace(/ ([,;)\]}>])/g,'$1').replace(/([(\[{<]) /g,'$1').replace(/^[\s,;:|\-\u2013\u2014]+|[\s,;:|\-\u2013\u2014]+$/g,'');
 return out||fallback;
}
export const HIDDEN_NAME='Name hidden';
function randomCode(length:number){let out='';while(out.length<length){for(const b of randomBytes(length*2)){if(b<240&&out.length<length)out+=ALPHABET[b%30];}}return out}
// Same normalisation as the iPad: upper case, separators removed.
export const normaliseCode=(x:unknown)=>typeof x==='string'&&x.length<=64?x.trim().toUpperCase().replace(/[-\s]/g,''):'';
export const formatCode=(code:string)=>code.slice(0,4)+'-'+code.slice(4);
export const CREDENTIAL=/^dc_[A-Za-z0-9_-]{43}$/;
const HASH=/^[a-f0-9]{64}$/;

// ---- Organiser proof (contract/device-v1/pairing.md, ADR-0003 amendment) ----
// The key a device gets at pairing: opk_ + 43 base64url characters (32 bytes, unpadded). Derived, never stored, so a restart or a
// new tunnel address recomputes the same key from the same host secret.
export const ORGANISER_PROOF_KEY=/^opk_[A-Za-z0-9_-]{43}$/;
export const organiserProofKey=(hostSecret:Buffer,deviceId:string)=>'opk_'+createHmac('sha256',hostSecret).update('organiser-proof-key:'+deviceId,'utf8').digest('base64url');
// Lowercase hex HMAC-SHA256 keyed by the UTF-8 bytes of the whole opk_ key over the given lines joined by LF, no trailing LF.
export const organiserProofMac=(key:string,lines:string[])=>createHmac('sha256',Buffer.from(key,'utf8')).update(lines.join('\n'),'utf8').digest('hex');
// Six lines: version label, device, offered event, normalised code, the iPad's nonce, and the participant origin the QR points at,
// so a proof relayed through another address does not verify there.
export const organiserProof=(key:string,p:{deviceId:string;eventId:string;code:string;nonce:string;origin:string})=>
 organiserProofMac(key,['attendwell-organiser-proof-v1',p.deviceId,p.eventId,p.code,p.nonce,p.origin]);
const NONCE=/^[a-f0-9]{64}$/;
const DEVICE_ID=/^[A-Za-z0-9_-]{1,64}$/;

export type Window={state:'open'|'closed';revision:number;openedAt:string|null;closesAt:string|null};
export type Device={id:string;label:string;credentialHash:string;pairedAt:string;lastSeenAt:string|null;revokedAt:string|null;appVersion:string|null;protocolVersion:number|null;reportedPending:number|null;reportedHeld:number|null;oldestPendingAt:string|null;reportedAt:string|null};
type Session={id:string;codeHash:string;label:string;targetDeviceId:string|null;createdAt:number;expiresAt:number;failedAttempts:number;pausedUntil:number|null;cancelledAt:number|null;spentAt:number|null;spentHash:string|null;deviceId:string|null};
export type RecoveryRow={opId:string;name:string;outcome:'recorded'|'already'|'review'|'refused';reason?:string};
export type RecoveryReport={eventCode:string;deviceId:string;deviceLabel:string|null;exportedAt:string|null;rows:RecoveryRow[];counts:{recorded:number;already:number;review:number;refused:number};written:boolean};
export type Outcome={opId:string;outcome:'applied'|'already_applied'|'held'|'closed';reason?:string};
// Register conflict reasons as the iPad sees them; "stale" is the contract fixture's word for a record changed since the iPad saw it.
// "not-in-roster": the person's booking was removed by an import after the iPad saw it; the protocol's nearest reason is not_on_form.
const HELD_REASON:Record<string,string>={changed:'stale','duplicate-name':'duplicate_name','not-eligible':'not_on_form','not-in-roster':'not_on_form'};

export class DeviceRegistry {
 private readonly secret:string;
 // Keys organiser-proof keys. From ATTENDANCE_HOST_SECRET_PATH when set (outlives the database); otherwise one per database.
 readonly proofSecret:Buffer;
 constructor(readonly store:AttendanceStore,readonly now:()=>number=Date.now,hostSecret?:Buffer){
  const db=store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,label TEXT NOT NULL,credentialHash TEXT NOT NULL UNIQUE,pairedAt TEXT NOT NULL,lastSeenAt TEXT,revokedAt TEXT,appVersion TEXT,protocolVersion INTEGER,reportedPending INTEGER,reportedHeld INTEGER,oldestPendingAt TEXT,reportedAt TEXT);
   CREATE TABLE IF NOT EXISTS pairing_sessions(id TEXT PRIMARY KEY,codeHash TEXT NOT NULL,label TEXT NOT NULL,targetDeviceId TEXT,createdAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL,failedAttempts INTEGER NOT NULL DEFAULT 0,pausedUntil INTEGER,cancelledAt INTEGER,spentAt INTEGER,spentHash TEXT,deviceId TEXT);
   CREATE TABLE IF NOT EXISTS device_holds(id INTEGER PRIMARY KEY,opId TEXT NOT NULL,deviceId TEXT NOT NULL,reason TEXT NOT NULL,recordedAt TEXT,receivedAt TEXT NOT NULL,dismissedAt TEXT,UNIQUE(opId,deviceId,reason));`);
  // A register opened by the first device build has the old permanent-lock column instead of pausedUntil.
  if(!(db.query('PRAGMA table_info(pairing_sessions)').all() as {name:string}[]).some(c=>c.name==='pausedUntil'))db.exec('ALTER TABLE pairing_sessions ADD COLUMN pausedUntil INTEGER');
  // Generated once per register database and kept in its backups (ADR-0004): the iPad's outbox is keyed by this, never by address.
  const put=db.query('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)');
  put.run('device-secret',randomBytes(32).toString('hex'));put.run('device-event-id','evt_'+randomCode(16).toLowerCase());put.run('device-event-code',randomCode(4));
  this.secret=this.meta('device-secret');
  if(hostSecret&&hostSecret.length<32)throw new Error('The host secret must be at least 32 bytes.');
  if(!hostSecret)put.run('organiser-proof-secret',randomBytes(32).toString('hex'));
  this.proofSecret=hostSecret?Buffer.from(hostSecret):Buffer.from(this.meta('organiser-proof-secret'),'hex');
 }
 private meta(key:string){return (this.store.db.query('SELECT value FROM metadata WHERE key=?').get(key) as {value:string}).value}
 private mac(s:string){return createHmac('sha256',this.secret).update(s).digest('hex')}
 event(){const w=this.store.workshop;return {eventId:this.meta('device-event-id'),eventCode:this.meta('device-event-code'),eventName:deviceText(w.title,'Workshop'),eventDate:w.date}}
 window():Window{const w=this.store.participantWindow(this.now());return {state:w.open?'open':'closed',revision:this.store.windowRevision(),openedAt:iso(w.openedAt),closesAt:iso(w.closesAt)}}
 // Person tokens for iPads: a separate HMAC domain from the browser page's tokens, short enough to keep a full register under 64 KB.
 personToken(id:string){return 'pt_'+this.mac('device-person:'+id).slice(0,24)}
 // Inactive records are kept by imports, so a token the iPad cached before a re-import still names its person.
 private person(token:unknown){if(typeof token!=='string'||!/^pt_[a-f0-9]{24}$/.test(token))return undefined;return (this.store.db.query('SELECT id,active FROM people').all() as {id:string;active:number}[]).find(p=>same(this.personToken(p.id),token))}

 // ---- Organiser side (loopback listener only) ----
 // At most one open pairing session: creating one cancels any other, so wrong codes always count against the session on screen.
 createPairing(input:{label?:unknown;targetDeviceId?:unknown},actor:string){
  const now=this.now();
  return this.store.db.transaction(()=>{
   let label:string;let target:string|null=null;
   if(input.targetDeviceId!==undefined&&input.targetDeviceId!==null){
    const d=typeof input.targetDeviceId==='string'?this.device(input.targetDeviceId):null;
    if(!d)throw new InputError('That iPad is no longer in the device list.',404);
    target=d.id;label=d.label;
   }else if(input.label===undefined||input.label===''){
    const n=(this.store.db.query('SELECT COUNT(*) AS n FROM devices').get() as {n:number}).n;label=`iPad ${n+1}`;
   }else if(plain(input.label,40))label=input.label.trim().replace(/\s+/g,' ');
   else throw new InputError('Name the iPad in up to 40 characters (no @ < >).');
   this.store.db.query('UPDATE pairing_sessions SET cancelledAt=? WHERE cancelledAt IS NULL AND spentAt IS NULL AND expiresAt>?').run(now,now);
   const code=randomCode(8);const id='ps_'+randomCode(12).toLowerCase();
   this.store.db.query('INSERT INTO pairing_sessions(id,codeHash,label,targetDeviceId,createdAt,expiresAt) VALUES(?,?,?,?,?,?)').run(id,this.mac('pairing-code:'+code),label,target,now,now+PAIRING_TTL_MS);
   this.store.audit(actor,'device-pairing-issued',null,target);
   return {sessionId:id,code,label,targetDeviceId:target,expiresAt:iso(now+PAIRING_TTL_MS)!};
  })();
 }
 cancelPairing(id:unknown,actor:string){
  const r=this.store.db.query('UPDATE pairing_sessions SET cancelledAt=? WHERE id=? AND cancelledAt IS NULL AND spentAt IS NULL').run(this.now(),typeof id==='string'?id:'');
  if(!r.changes)throw new InputError('That pairing code is no longer open.',404);
  this.store.audit(actor,'device-pairing-cancelled');
 }
 device(id:string){return this.store.db.query('SELECT * FROM devices WHERE id=?').get(id) as Device|null}
 renameDevice(id:unknown,label:unknown,actor:string){
  if(typeof id!=='string'||!this.device(id))throw new InputError('That iPad is no longer in the device list.',404);
  if(!plain(label,40))throw new InputError('Name the iPad in up to 40 characters (no @ < >).');
  this.store.db.query('UPDATE devices SET label=? WHERE id=?').run(label.trim().replace(/\s+/g,' '),id);this.store.audit(actor,'device-renamed',null,id);
 }
 // Revocation keeps every operation the iPad already sent; the iPad keeps its unsent ones (Pair again recovers them).
 revokeDevice(id:unknown,actor:string){
  const d=typeof id==='string'?this.device(id):null;
  if(!d)throw new InputError('That iPad is no longer in the device list.',404);
  if(!d.revokedAt){this.store.db.query('UPDATE devices SET revokedAt=? WHERE id=?').run(iso(this.now()),d.id);this.store.audit(actor,'device-revoked',null,d.id);}
 }
 devices(){
  const now=this.now();
  const open=this.store.db.query('SELECT * FROM pairing_sessions WHERE cancelledAt IS NULL AND spentAt IS NULL ORDER BY createdAt DESC LIMIT 1').get() as Session|null;
  const counts=this.store.db.query("SELECT deviceId,SUM(outcome IN ('applied','already')) AS received,SUM(outcome='conflict' AND resolvedAt IS NULL) AS needsReview FROM operations WHERE deviceId IS NOT NULL GROUP BY deviceId").all() as {deviceId:string;received:number;needsReview:number}[];
  const rows=this.store.db.query('SELECT * FROM devices ORDER BY rowid').all() as Device[];
  const holds=this.store.db.query('SELECT h.id,h.opId,h.deviceId,d.label AS deviceLabel,h.reason,h.recordedAt,h.receivedAt FROM device_holds h LEFT JOIN devices d ON d.id=h.deviceId WHERE h.dismissedAt IS NULL ORDER BY h.id DESC LIMIT 100').all() as {deviceId:string}[];
  const held=this.store.db.query('SELECT deviceId,COUNT(*) AS n FROM device_holds WHERE dismissedAt IS NULL GROUP BY deviceId').all() as {deviceId:string;n:number}[];
  // Register text the iPads see differently: an address removed from a name or the workshop title (see deviceText).
  const title=this.store.workshop.title;
  const adjusted=[...(deviceText(title,'Workshop')!==title?[{participantId:null,original:title,shownAs:deviceText(title,'Workshop')}]:[]),
   ...this.store.participantNames().filter(p=>deviceText(p.name,HIDDEN_NAME)!==p.name).map(p=>({participantId:p.id,original:p.name,shownAs:deviceText(p.name,HIDDEN_NAME)}))];
  return {...this.event(),serverTime:iso(now),
   // paused: wrong codes from outside stopped the code for a while (pausedUntil); wrongAttempts counts them. Showing a new code starts afresh.
   pairing:open?{sessionId:open.id,label:open.label,targetDeviceId:open.targetDeviceId,expiresAt:iso(open.expiresAt),state:open.expiresAt<=now?'expired':open.pausedUntil&&open.pausedUntil>now?'paused':'waiting',wrongAttempts:open.failedAttempts,pausedUntil:open.pausedUntil&&open.pausedUntil>now?iso(open.pausedUntil):null}:null,
   devices:rows.map(({credentialHash:_,...d})=>{const c=counts.find(x=>x.deviceId===d.id);return {...d,status:d.revokedAt?'revoked':'active',checkInsReceived:c?.received??0,needsReview:c?.needsReview??0,unmatchedCheckIns:held.find(x=>x.deviceId===d.id)?.n??0}}),
   unmatchedCheckIns:holds,adjustedText:adjusted};
 }
 // The organiser has seen an unmatched check-in (unknown person or reused opId) and clears it from the list.
 dismissHold(id:unknown,actor:string){
  const r=this.store.db.query('UPDATE device_holds SET dismissedAt=? WHERE id=? AND dismissedAt IS NULL').run(iso(this.now()),typeof id==='number'?id:Number(id));
  if(!r.changes)throw new InputError('That check-in was already cleared. Refresh the device list.',404);
  this.store.audit(actor,'device-hold-dismissed');
 }

 // ---- Device side (participant listener) ----
 // Finds the session a code belongs to among recent ones. Every candidate is compared in constant time.
 private session(code:string){
  const hash=this.mac('pairing-code:'+code);const since=this.now()-PAIRING_TTL_MS-PAIRING_REPLAY_MS;
  let found:Session|null=null;
  // Cancelled sessions are found too: an old QR scanned again is a known code, not a guess, and never counts against the open one.
  for(const s of this.store.db.query('SELECT * FROM pairing_sessions WHERE createdAt>?').all(since) as Session[])if(same(s.codeHash,hash))found=s;
  return found;
 }
 // A paused session refuses every code, the right one included, so guesses made during a pause can never succeed.
 private usable(s:Session|null):s is Session{const now=this.now();return !!s&&!s.spentAt&&!s.cancelledAt&&now<s.expiresAt&&!(s.pausedUntil&&now<s.pausedUntil)}
 // A well-formed wrong code counts against the one open session. Every fifth pauses it: 30 s, then 60, 120, 240 (a code lives 5 minutes).
 // Malformed codes are refused without counting, and nothing locks for good: wrong codes from outside cannot spend the organiser's code.
 private fail(code:string){
  const now=this.now();
  this.store.audit('device-pairing','device-pair-failed');
  if(!/^[A-HJKMNP-TV-Z2-9]{8}$/.test(code))return;
  const open=this.store.db.query('SELECT * FROM pairing_sessions WHERE cancelledAt IS NULL AND spentAt IS NULL AND expiresAt>? ORDER BY createdAt DESC LIMIT 1').get(now) as Session|null;
  if(!open||open.pausedUntil&&now<open.pausedUntil)return;
  const n=open.failedAttempts+1;const pause=n%PAIRING_MAX_FAILURES===0?now+PAIRING_PAUSE_MS*2**(n/PAIRING_MAX_FAILURES-1):open.pausedUntil;
  this.store.db.query('UPDATE pairing_sessions SET failedAttempts=?,pausedUntil=? WHERE id=?').run(n,pause,open.id);
  if(pause!==open.pausedUntil)this.store.audit('device-pairing','device-pairing-paused');
 }
 private offer(s:Session){return {...this.event(),deviceLabel:s.label}}
 // `hello`: shows the iPad which event and label it is about to join. Does not spend the code.
 // origin: the participant origin the QR points at (the device listener's own configured origin), bound into the organiser proof.
 hello(input:unknown,origin:string){
  return this.store.db.transaction(()=>{
   const body=input as {code?:unknown;organiserProof?:unknown};
   const code=normaliseCode(body?.code);
   const s=/^[A-Z0-9]{8}$/.test(code)?this.session(code):null;
   if(!s){this.fail(code);return null;}
   if(!this.usable(s))return null;
   const offer=this.offer(s);
   const proof=this.proofFor(body.organiserProof,offer.eventId,code,origin,s.targetDeviceId);
   return proof===null?offer:{...offer,organiserProof:proof};
  })();
 }
 // Only after a valid, usable code. A malformed request is treated as absent. For a well-formed one the key and proof are always
 // computed and every unrevoked device id is compared in constant time, so the work done does not depend on whether the id exists;
 // only the presence of the field differs. Revoked devices get no proof: the organiser removed them, so only the PIN (or Pair again
 // on the laptop) may replace their pairing. A device whose credential was replaced keeps its id and row, so it still gets one.
 // Only devices paired in this register qualify: a device new to this workshop needs the organiser PIN or a fresh pairing.
 // A code made by Pair again for one iPad (target) proves the organiser to that iPad only, never to another paired one.
 private proofFor(request:unknown,eventId:string,code:string,origin:string,target:string|null):string|null{
  const r=request as {deviceId?:unknown;nonce?:unknown};
  if(!r||typeof r!=='object'||Array.isArray(r)||typeof r.deviceId!=='string'||!DEVICE_ID.test(r.deviceId)||typeof r.nonce!=='string'||!NONCE.test(r.nonce))return null;
  const proof=organiserProof(organiserProofKey(this.proofSecret,r.deviceId),{deviceId:r.deviceId,eventId,code,nonce:r.nonce,origin});
  const wanted=createHash('sha256').update(r.deviceId).digest();let known=false;
  const rows=(target?this.store.db.query('SELECT id FROM devices WHERE revokedAt IS NULL AND id=?').all(target):this.store.db.query('SELECT id FROM devices WHERE revokedAt IS NULL').all()) as {id:string}[];
  for(const d of rows)if(timingSafeEqual(createHash('sha256').update(d.id).digest(),wanted))known=true;
  return known?proof:null;
 }
 // `pair`: the iPad sends only the SHA-256 hash of the credential it generated. The host never sees the credential.
 pair(input:unknown,oldProof:string|null){
  return this.store.db.transaction(()=>{
   const body=input as {code?:unknown;credentialHash?:unknown};
   const code=normaliseCode(body?.code);const hash=body?.credentialHash;
   const s=/^[A-Z0-9]{8}$/.test(code)?this.session(code):null;
   if(!s){this.fail(code);return null;}
   if(typeof hash!=='string'||!HASH.test(hash))return null;
   const now=this.now();
   // Lost reply: the same code and the same hash within 15 minutes get the same answer, while that device still holds that credential.
   if(s.spentAt&&s.spentHash&&s.deviceId){
    if(now>=s.spentAt+PAIRING_REPLAY_MS||!same(s.spentHash,hash))return null;
    const d=this.device(s.deviceId);
    return d&&!d.revokedAt&&same(d.credentialHash,hash)?this.success(d):null;
   }
   if(!this.usable(s))return null;
   if(this.store.db.query('SELECT 1 FROM devices WHERE credentialHash=?').get(hash))return null;
   // Same device record only for organiser-targeted Pair again, or a request carrying that device's current credential.
   // A targeted code sent with another paired iPad's credential is refused like a wrong code and changes nothing: it must not
   // replace the target's credential while the sender's own stays active.
   const bearer=oldProof?this.authenticate(oldProof,false):null;
   if(s.targetDeviceId&&bearer&&bearer.id!==s.targetDeviceId)return null;
   const proven=s.targetDeviceId?this.device(s.targetDeviceId):bearer;
   let id:string;
   if(proven){
    id=proven.id;
    this.store.db.query('UPDATE devices SET credentialHash=?,label=?,revokedAt=NULL,pairedAt=? WHERE id=?').run(hash,s.label,iso(now),id);
    this.store.audit('device:'+id,'device-repaired',null,id);
   }else{
    id='dev_'+randomCode(12).toLowerCase();
    this.store.db.query('INSERT INTO devices(id,label,credentialHash,pairedAt,protocolVersion) VALUES(?,?,?,?,1)').run(id,s.label,hash,iso(now));
    this.store.audit('device:'+id,'device-paired',null,id);
   }
   this.store.db.query('UPDATE pairing_sessions SET spentAt=?,spentHash=?,deviceId=? WHERE id=?').run(now,hash,id,s.id);
   return this.success(this.device(id)!);
  })();
 }
 // The organiser-proof key is derived here and only here; it is never stored, audited, logged or put on an organiser route.
 private success(d:Device){return {eventId:this.event().eventId,deviceId:d.id,deviceLabel:d.label,credentialHash:d.credentialHash,organiserProofKey:organiserProofKey(this.proofSecret,d.id)}}
 // Bearer check: hash, look up, compare in constant time. Revoked and unknown credentials are indistinguishable to the caller.
 authenticate(credential:unknown,touch=true):Device|null{
  if(typeof credential!=='string'||!CREDENTIAL.test(credential))return null;
  const hash=sha256(credential);
  const d=this.store.db.query('SELECT * FROM devices WHERE credentialHash=? AND revokedAt IS NULL').get(hash) as Device|null;
  if(!d||!same(d.credentialHash,hash))return null;
  if(touch)this.store.db.query('UPDATE devices SET lastSeenAt=? WHERE id=?').run(iso(this.now()),d.id);
  return d;
 }
 // Everything the iPad needs to run the session offline: identity, window and the names-only list of eligible people.
 snapshot(){
  const window=this.window();
  const people=this.store.participantNames().map(p=>({personToken:this.personToken(p.id),displayName:deviceText(p.name,HIDDEN_NAME),revision:p.version,checkedIn:p.checkedIn}));
  const rosterVersion='rv_'+sha256(JSON.stringify([this.event(),window,people])).slice(0,16);
  return {...this.event(),serverTime:iso(this.now())!,rosterVersion,window,people};
 }
 // Check-in upload. Idempotent by opId within this event (ADR-0003/0004), whichever device sends it; a closed window records nothing.
 submit(device:Device,input:unknown):{status:number;body:unknown}{
  const body=input as {eventId?:unknown;operations?:unknown};
  if(body?.eventId!==this.event().eventId)return {status:409,body:{error:'event_moved'}};
  const ops=body.operations;
  if(!Array.isArray(ops)||!ops.length||ops.length>MAX_BATCH||!ops.every(validOperation))return {status:400,body:{error:'bad_request'}};
  const results=this.store.db.transaction(()=>ops.map(op=>this.apply(device,op)))();
  return {status:200,body:{eventId:this.event().eventId,serverTime:iso(this.now()),window:this.window(),results}};
 }
 // Recovery file (iPad contract device-v1, format attendance-recovery): the check-ins an iPad saved but could not send. Each one
 // goes through apply(), exactly like a live upload from that iPad and keyed by its opId (ADR-0004), so importing the file twice, or
 // the iPad sending the same check-ins live after it is paired again, records each check-in once. One difference: the check-in
 // window is not consulted, because the iPad recorded them while its own window was open and the organiser is importing them now.
 // dryRun runs the same steps and rolls them back, so the preview is what the import will do.
 importRecovery(input:unknown,actor:string,{dryRun=false}:{dryRun?:boolean}={}):RecoveryReport{
  const f=input as {format?:unknown;version?:unknown;eventId?:unknown;eventCode?:unknown;deviceId?:unknown;exportedAt?:unknown;operations?:unknown};
  if(!f||typeof f!=='object'||f.format!=='attendance-recovery')throw new InputError('This is not an iPad recovery file.');
  if(f.version!==1)throw new InputError('This recovery file comes from a newer version of the Check-in app. Update AttendWell, then import it again.');
  const event=this.event();
  if(f.eventId!==event.eventId)throw new InputError(`This recovery file is from another workshop${typeof f.eventCode==='string'&&/^[A-Z0-9]{1,8}$/.test(f.eventCode)?` (event code ${f.eventCode})`:''}. Open that workshop, then import it there.`,409);
  if(f.deviceId!==undefined&&f.deviceId!==null&&(typeof f.deviceId!=='string'||!DEVICE_ID.test(f.deviceId)))throw new InputError('This recovery file names its iPad in a way AttendWell does not recognise.');
  if(!Array.isArray(f.operations)||f.operations.length>1000)throw new InputError('This recovery file holds more check-ins than AttendWell can import at once (1000).');
  const known=typeof f.deviceId==='string'?this.device(f.deviceId):null;
  const device={id:known?.id??(typeof f.deviceId==='string'?f.deviceId:'recovery-file')} as Device;
  const label=known?.label??null;
  const names=new Map((this.store.db.query('SELECT id,name FROM people').all() as {id:string;name:string}[]).map(p=>[this.personToken(p.id),p.name] as [string,string]));
  const rows:RecoveryRow[]=[];
  const run=()=>{
   for(const raw of f.operations as unknown[]){
    const o=raw as {opId?:unknown;personToken?:unknown;displayName?:unknown};
    const shown=typeof o?.displayName==='string'?deviceText(o.displayName.slice(0,200),HIDDEN_NAME):HIDDEN_NAME;
    if(!validOperation(raw)){rows.push({opId:typeof o?.opId==='string'?o.opId.slice(0,80):'',name:shown,outcome:'refused',reason:'invalid'});continue;}
    const r=this.apply(device,raw,{ignoreWindow:true,actor:'recovery-file:'+device.id});
    rows.push({opId:r.opId,name:names.get(raw.personToken)??shown,outcome:r.outcome==='applied'?'recorded':r.outcome==='already_applied'?'already':'review',...(r.reason?{reason:r.reason}:{})});
   }
  };
  const ROLLBACK=new Error('dry run');
  try{this.store.db.transaction(()=>{run();if(dryRun)throw ROLLBACK;if(rows.length)this.store.audit(actor,'recovery-import',null,known?.id??null);})();}
  catch(e){if(e!==ROLLBACK)throw e;}
  const n=(k:RecoveryRow['outcome'])=>rows.filter(r=>r.outcome===k).length;
  return {eventCode:event.eventCode,deviceId:device.id,deviceLabel:label,exportedAt:typeof f.exportedAt==='string'&&Number.isFinite(Date.parse(f.exportedAt))?new Date(f.exportedAt).toISOString():null,
   rows,counts:{recorded:n('recorded'),already:n('already'),review:n('review'),refused:n('refused')},written:!dryRun};
 }
 private apply(device:Device,op:WireOperation,opts:{ignoreWindow?:boolean;actor?:string}={}):Outcome{
  const prior=this.store.db.query('SELECT participantId,kind,outcome,reason FROM operations WHERE opId=?').get(op.opId) as {participantId:string;kind:string;outcome:string;reason:string|null}|null;
  if(prior){
   // An opId reused for another person or channel is never applied twice; it goes to the organiser instead.
   if(prior.kind!=='device-check-in'||!same(this.personToken(prior.participantId),op.personToken))return this.unmatched(device,op,'invalid');
   // A replay never reports "applied" twice: the first answer may have been lost, but the change happened once.
   return this.outcome(op.opId,prior.outcome==='applied'?'already':prior.outcome,prior.reason);
  }
  if(!opts.ignoreWindow&&!this.store.participantWindow(this.now()).open)return {opId:op.opId,outcome:'closed'};
  const person=this.person(op.personToken);
  if(!person)return this.unmatched(device,op,'unknown_person');
  const by={kind:'device-check-in',actor:opts.actor??'device:'+device.id,deviceId:device.id};
  // Checked in on the iPad, then removed by a re-import before the upload: held in the register's conflict queue, never applied.
  if(!person.active){this.store.holdForReview(person.id,{opId:op.opId,queuedAt:op.recordedAt},'not-in-roster',by);return this.outcome(op.opId,'conflict','not-in-roster');}
  const id=person.id;
  const r=this.store.participantCheckIn(id,{opId:op.opId,basis:op.baseRevision,queuedAt:op.recordedAt},by);
  return this.outcome(op.opId,r.outcome,r.reason);
 }
 private outcome(opId:string,outcome:string,reason:string|null):Outcome{
  if(outcome==='applied')return {opId,outcome:'applied'};
  if(outcome==='already')return {opId,outcome:'already_applied'};
  return {opId,outcome:'held',reason:HELD_REASON[reason??'']??'not_on_form'};
 }
 // Held with no register record to attach to (unknown person, or an opId already used elsewhere): kept for the organiser's device list.
 private unmatched(device:Device,op:WireOperation,reason:'unknown_person'|'invalid'):Outcome{
  this.store.db.query('INSERT OR IGNORE INTO device_holds(opId,deviceId,reason,recordedAt,receivedAt) VALUES(?,?,?,?,?)').run(op.opId,device.id,reason,op.recordedAt,iso(this.now()));
  return {opId:op.opId,outcome:'held',reason};
 }
 // Heartbeat: the iPad's own outbox summary (no names) for the organiser's device list; returns the window and roster version.
 heartbeat(device:Device,input:unknown){
  const r=(input??{}) as Record<string,unknown>;
  const count=(x:unknown)=>Number.isInteger(x)&&(x as number)>=0&&(x as number)<=100000?x as number:null;
  const when=typeof r.oldestPendingAt==='string'&&r.oldestPendingAt.length<=40&&Number.isFinite(Date.parse(r.oldestPendingAt))?new Date(r.oldestPendingAt).toISOString():null;
  const version=typeof r.appVersion==='string'&&/^[0-9A-Za-z.+-]{1,32}$/.test(r.appVersion)?r.appVersion:null;
  if(input!==undefined)this.store.db.query('UPDATE devices SET reportedPending=?,reportedHeld=?,oldestPendingAt=?,appVersion=COALESCE(?,appVersion),reportedAt=? WHERE id=?').run(count(r.pendingCount),count(r.heldCount),when,version,iso(this.now()),device.id);
  const s=this.snapshot();
  return {eventId:s.eventId,serverTime:s.serverTime,window:s.window,rosterVersion:s.rosterVersion};
 }
}
type WireOperation={opId:string;personToken:string;baseRevision:number;windowRevisionSeen:number;recordedAt:string};
function validOperation(x:unknown):x is WireOperation{
 const o=x as WireOperation;
 return !!o&&typeof o==='object'&&typeof o.opId==='string'&&/^[A-Za-z0-9-]{8,80}$/.test(o.opId)&&typeof o.personToken==='string'&&o.personToken.length<=64
  &&Number.isInteger(o.baseRevision)&&o.baseRevision>=0&&(o.windowRevisionSeen===undefined||Number.isInteger(o.windowRevisionSeen))
  &&typeof o.recordedAt==='string'&&o.recordedAt.length<=40&&Number.isFinite(Date.parse(o.recordedAt));
}
// One registry per store, shared by the organiser and participant handlers so both see the same sessions.
const registries=new WeakMap<AttendanceStore,DeviceRegistry>();
// A second caller passing a different host secret is a wiring error: both listeners must prove with the same key.
export function deviceRegistry(store:AttendanceStore,now?:()=>number,hostSecret?:Buffer){
 let r=registries.get(store);
 if(!r){r=new DeviceRegistry(store,now,hostSecret);registries.set(store,r);}
 else if(hostSecret&&!r.proofSecret.equals(hostSecret))throw new Error('Both listeners must use the same host secret.');
 return r;
}
