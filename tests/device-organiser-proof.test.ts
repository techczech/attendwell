// Organiser proof for re-pairing (contract/device-v1/pairing.md, ADR-0003 amendment): the pair key, the hello proof bound to the
// participant origin, the host secret file, and that the key never leaves the pair reply.
import {test,expect,spyOn} from 'bun:test';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,statSync,chmodSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {AttendanceStore} from '../server/store-attendance';
import {DeviceRegistry,organiserProof,organiserProofKey,organiserProofMac,ORGANISER_PROOF_KEY} from '../server/device-attendance';
import {loadHostSecret} from '../server/host-secret-attendance';
import {setup,newCredential,hashOf,participantOrigin} from './device-helpers';
import {fixture} from './fixtures-attendance';
import {removeTempDir} from './service-spawn';
const dir=join(import.meta.dir,'fixtures/device-v1');
const load=(name:string)=>JSON.parse(readFileSync(join(dir,name),'utf8'));
const nonce=()=>randomBytes(32).toString('hex');
const OFFER_KEYS=['deviceLabel','eventCode','eventDate','eventId','eventName'];
const tmp=()=>mkdtempSync(join(tmpdir(),'attendwell-proof-'));

test('fixtures: the HMAC framing reproduces the iPad\'s recorded proof, and the origin-bound proof is pinned',()=>{
 const success=load('pairing-success.example.json'),request=load('hello-request-organiser-proof.example.json');
 const recorded=load('pairing-offer-organiser-proof.example.json'),bound=load('hello-reply-organiser-proof-origin-bound.example.json');
 const key=success.organiserProofKey;expect(key).toMatch(ORGANISER_PROOF_KEY);expect(request.organiserProof.deviceId).toBe(success.deviceId);
 // The iPad's five-line fixture (before the origin was added): same key encoding, separator and hex output.
 expect(organiserProofMac(key,['attendwell-organiser-proof-v1',success.deviceId,recorded.eventId,request.code,request.organiserProof.nonce])).toBe(recorded.organiserProof);
 // The six-line rule the host serves: the origin-bound fixture, with its inputs spelled out in the file.
 const i=bound._inputs;
 expect(i).toEqual({organiserProofKey:key,deviceId:success.deviceId,code:request.code,nonce:request.organiserProof.nonce,origin:'https://quiet-river-fixture.trycloudflare.com'});
 expect(organiserProof(i.organiserProofKey,{deviceId:i.deviceId,eventId:bound.eventId,code:i.code,nonce:i.nonce,origin:i.origin})).toBe(bound.organiserProof);
 expect(bound.organiserProof).toBe('2933b19538938fcfcfdea6c262e724291a2d15074b533d7375cfa070ffb1847c');
 // Any change to a line changes the proof; the five-line and six-line proofs differ.
 expect(organiserProof(key,{deviceId:i.deviceId,eventId:bound.eventId,code:i.code,nonce:i.nonce,origin:'https://evil.example.org'})).not.toBe(bound.organiserProof);
 expect(bound.organiserProof).not.toBe(recorded.organiserProof);
 const {_provisional:_a,_inputs:_b,...reply}=bound;const {_provisional:_c,...old}=recorded;
 expect(Object.keys(reply).sort()).toEqual(Object.keys(old).sort());
});

test('pair: the key is opk_ + 43 base64url, derived from the host secret, the same on a lost-reply replay and different per device',async()=>{
 const hostSecret=randomBytes(32);const s=setup({hostSecret});
 const p=await s.pairing();const hash=hashOf(newCredential());
 const first=await s.dev('pair',{body:{code:p.shortCode,credentialHash:hash}});expect(first.status).toBe(201);
 expect(first.body.organiserProofKey).toMatch(ORGANISER_PROOF_KEY);
 expect(first.body.organiserProofKey).toBe(organiserProofKey(hostSecret,first.body.deviceId));
 s.clock.t+=10*60000;
 expect((await s.dev('pair',{body:{code:p.shortCode,credentialHash:hash}})).body.organiserProofKey).toBe(first.body.organiserProofKey);
 const other=await s.pairDevice();
 const second=organiserProofKey(hostSecret,other.deviceId);expect(second).not.toBe(first.body.organiserProofKey);
 // Pair again on the laptop keeps the device id, so the iPad's key stays valid.
 const again=await s.pairing({targetDeviceId:first.body.deviceId});
 const repaired=await s.dev('pair',{body:{code:again.shortCode,credentialHash:hashOf(newCredential())}});
 expect(repaired.body).toMatchObject({deviceId:first.body.deviceId,organiserProofKey:first.body.organiserProofKey});
 // close(true) refuses while any statement is unfinalized: every statement of this flow is still in bun:sqlite's cache,
 // so the store's close() releases the register at once (server/store-attendance.ts, MAX_QUERY_CACHE_SIZE).
 expect(()=>s.store.db.close(true)).not.toThrow();
});

test('hello: proof only with a usable code and a paired, unrevoked device; otherwise the same reply without the field',async()=>{
 const hostSecret=randomBytes(32);const s=setup({hostSecret});
 const {deviceId}=await s.pairDevice();const revoked=(await s.pairDevice()).deviceId;
 expect((await s.org('POST',`/api/organiser/devices/${revoked}/revoke`)).status).toBe(200);
 const key=organiserProofKey(hostSecret,deviceId);
 const p=await s.pairing();const code=p.shortCode.replace('-','');const n=nonce();
 const ok=await s.dev('hello',{body:{code:p.shortCode.toLowerCase(),organiserProof:{deviceId,nonce:n}}});
 expect(ok.status).toBe(200);expect(Object.keys(ok.body).sort()).toEqual([...OFFER_KEYS,'organiserProof'].sort());
 expect(ok.body.organiserProof).toMatch(/^[a-f0-9]{64}$/);
 // What the iPad checks: its stored key, its device id, the offer's event, the normalised code, its nonce and the QR's origin.
 expect(ok.body.organiserProof).toBe(organiserProof(key,{deviceId,eventId:ok.body.eventId,code,nonce:n,origin:participantOrigin}));
 expect(ok.body.organiserProof).not.toBe(organiserProof(key,{deviceId,eventId:ok.body.eventId,code,nonce:n,origin:'https://quiet-river-fixture.trycloudflare.com'}));
 expect((await s.dev('hello',{body:{code,organiserProof:{deviceId,nonce:nonce()}}})).body.organiserProof).not.toBe(ok.body.organiserProof);
 const plain=(await s.dev('hello',{body:{code}})).body;
 // Unknown, revoked, revoked-then-unknown alike: the plain offer, no error.
 for(const id of ['dev_aaaaaaaaaaaa','dev_fixture_ipad2',revoked]){
  const r=await s.dev('hello',{body:{code,organiserProof:{deviceId:id,nonce:n}}});
  expect(r.status).toBe(200);expect(r.body).toEqual(plain);
 }
 // A wrong code gets the generic refusal and never a proof.
 const wrong=await s.dev('hello',{body:{code:'ZZZZZZZ2',organiserProof:{deviceId,nonce:n}}});
 expect(wrong).toMatchObject({status:401,body:{error:'invalid_or_expired_code'}});
 // A spent code: no offer, no proof.
 await s.dev('pair',{body:{code,credentialHash:hashOf(newCredential())}});
 expect((await s.dev('hello',{body:{code,organiserProof:{deviceId,nonce:n}}})).status).toBe(401);
 s.store.close();
});

test('Pair again for one iPad: no proof for another iPad, and its code refused with that iPad\'s credential, changing nothing',async()=>{
 const hostSecret=randomBytes(32);const s=setup({hostSecret});
 const x=await s.pairDevice({label:'Front desk'});const y=await s.pairDevice({label:'Side door'});
 const p=await s.pairing({targetDeviceId:x.deviceId});const code=p.shortCode.replace('-','');
 const plain=(await s.dev('hello',{body:{code}})).body;
 // Y asks for a proof with X's code: the plain offer, exactly as for an unknown device.
 const forY=await s.dev('hello',{body:{code,organiserProof:{deviceId:y.deviceId,nonce:nonce()}}});
 expect(forY.status).toBe(200);expect(forY.body).toEqual(plain);
 const rows=()=>s.store.db.query('SELECT id,label,credentialHash,revokedAt,pairedAt FROM devices ORDER BY rowid').all();
 const session=()=>s.store.db.query('SELECT spentAt,spentHash,deviceId,failedAttempts,pausedUntil FROM pairing_sessions WHERE id=?').get(p.sessionId);
 const audits=()=>s.store.db.query('SELECT COUNT(*) AS n FROM audit').get();
 const before={rows:rows(),session:session(),audits:audits()};
 // Y pairs with X's code while carrying its own credential: the generic wrong-code refusal, and nothing changes.
 const refused=await s.dev('pair',{body:{code,credentialHash:hashOf(newCredential())},bearer:y.credential});
 expect(refused).toMatchObject({status:401,body:{error:'invalid_or_expired_code'}});
 expect(rows()).toEqual(before.rows);expect(session()).toEqual(before.session);expect(audits()).toEqual(before.audits);
 expect(refused.body).toEqual((await s.dev('pair',{body:{code:'ZZZZZZZ2',credentialHash:hashOf(newCredential())}})).body);
 expect((await s.dev('roster',{bearer:x.credential})).status).toBe(200);expect((await s.dev('roster',{bearer:y.credential})).status).toBe(200);
 // The same code still serves X: a proof under X's key, then the re-pair keeps X's id and replaces only X's credential.
 const n=nonce();const forX=await s.dev('hello',{body:{code,organiserProof:{deviceId:x.deviceId,nonce:n}}});
 expect(forX.body.organiserProof).toBe(organiserProof(organiserProofKey(hostSecret,x.deviceId),{deviceId:x.deviceId,eventId:forX.body.eventId,code,nonce:n,origin:participantOrigin}));
 const fresh=newCredential();
 const repaired=await s.dev('pair',{body:{code,credentialHash:hashOf(fresh)},bearer:x.credential});
 expect(repaired.status).toBe(201);expect(repaired.body.deviceId).toBe(x.deviceId);
 expect((await s.dev('roster',{bearer:x.credential})).status).toBe(401);expect((await s.dev('roster',{bearer:fresh})).status).toBe(200);
 expect((await s.dev('roster',{bearer:y.credential})).status).toBe(200);
 // An untargeted code keeps proving the organiser to any paired iPad.
 const open=await s.pairing();
 expect((await s.dev('hello',{body:{code:open.shortCode,organiserProof:{deviceId:y.deviceId,nonce:nonce()}}})).body.organiserProof).toMatch(/^[a-f0-9]{64}$/);
 s.store.close();
});

test('another workshop\'s register, same host secret: no proof for a device paired only elsewhere',async()=>{
 const hostSecret=randomBytes(32);const here=setup({hostSecret});const elsewhere=setup({hostSecret});
 const {deviceId}=await elsewhere.pairDevice();
 const p=await here.pairing();const plain=(await here.dev('hello',{body:{code:p.shortCode}})).body;
 const r=await here.dev('hello',{body:{code:p.shortCode,organiserProof:{deviceId,nonce:nonce()}}});
 expect(r.status).toBe(200);expect(r.body).toEqual(plain);
 here.store.close();elsewhere.store.close();
});

test('hello: a malformed organiserProof is treated as absent, is not an error and does not count as a wrong code',async()=>{
 const s=setup({hostSecret:randomBytes(32)});const {deviceId}=await s.pairDevice();
 const p=await s.pairing();const plain=(await s.dev('hello',{body:{code:p.shortCode}})).body;
 const bad=[null,'x',42,[deviceId,nonce()],{deviceId},{nonce:nonce()},{deviceId,nonce:nonce().toUpperCase()},{deviceId,nonce:nonce().slice(1)},
  {deviceId,nonce:nonce()+'0'},{deviceId,nonce:'g'.repeat(64)},{deviceId:deviceId+'\nx',nonce:nonce()},{deviceId:'',nonce:nonce()},{deviceId:'d'.repeat(65),nonce:nonce()},{deviceId:7,nonce:nonce()}];
 for(const organiserProof of bad){
  const r=await s.dev('hello',{body:{code:p.shortCode,organiserProof}});
  expect(r.status).toBe(200);expect(r.body).toEqual(plain);
 }
 expect((await s.org('GET','/api/organiser/devices')).body.pairing).toMatchObject({state:'waiting',wrongAttempts:0});
 expect(s.store.db.query("SELECT COUNT(*) AS n FROM audit WHERE verb='device-pair-failed'").get()).toEqual({n:0});
 s.store.close();
});

test('host secret file: created 600 with 32 bytes, reused, refused when shared, short, a symlink or a directory',()=>{
 const d=tmp();
 try{
  const path=join(d,'host-secret');const a=loadHostSecret(path);
  expect(a.length).toBe(32);expect(statSync(path).size).toBe(32);
  expect(loadHostSecret(path).equals(a)).toBe(true);
  // POSIX permission bits. Windows has none to set here: the desktop app keeps the file in its private data folder, whose
  // access list it checks (desktop/tests/workshops-library.test.ts).
  if(process.platform!=='win32'){
   expect(statSync(path).mode&0o777).toBe(0o600);
   chmodSync(path,0o640);expect(()=>loadHostSecret(path)).toThrow('owner only');
   chmodSync(path,0o604);expect(()=>loadHostSecret(path)).toThrow('owner only');
   // Windows mode bits do not describe its access lists: the check is POSIX only.
   expect(loadHostSecret(path,'win32').equals(a)).toBe(true);
   chmodSync(path,0o600);
  }
  expect(readFileSync(path).equals(a)).toBe(true);
  const short=join(d,'short');writeFileSync(short,randomBytes(16),{mode:0o600});expect(()=>loadHostSecret(short)).toThrow('exactly 32 bytes');
  const link=join(d,'link');symlinkSync(path,link);expect(()=>loadHostSecret(link)).toThrow('symbolic link');
  // Windows has no O_NOFOLLOW: the lstat check alone must refuse a link to a valid 32-byte secret there too.
  expect(()=>loadHostSecret(link,'win32')).toThrow('symbolic link');
  const dangling=join(d,'dangling');symlinkSync(join(d,'absent'),dangling);
  expect(()=>loadHostSecret(dangling,'win32')).toThrow();expect(()=>loadHostSecret(dangling)).toThrow();
  expect(()=>loadHostSecret(d)).toThrow();expect(()=>loadHostSecret(d,'win32')).toThrow();
 }finally{rmSync(d,{recursive:true,force:true})}
});

test('restart: the same secret file gives the same key and a proof that verifies at a new tunnel address',()=>{
 const d=tmp();
 try{
  const db=join(d,'register.sqlite'),secretPath=join(d,'host-secret');const t=Date.parse('2030-01-15T12:50:00Z');const now=()=>t;
  const store=new AttendanceStore(db);store.import(fixture,'test');
  const reg=new DeviceRegistry(store,now,loadHostSecret(secretPath));
  const s1=reg.createPairing({},'test');const hash=hashOf(newCredential());
  const paired=reg.pair({code:s1.code,credentialHash:hash},null)!;expect(paired.organiserProofKey).toMatch(ORGANISER_PROOF_KEY);
  expect(()=>store.db.close(true)).not.toThrow(); // released at once, so the file can be removed (Windows)
  const again=new AttendanceStore(db);const reg2=new DeviceRegistry(again,now,loadHostSecret(secretPath));
  // Lost reply after the restart: the same key comes back.
  expect(reg2.pair({code:s1.code,credentialHash:hash},null)!.organiserProofKey).toBe(paired.organiserProofKey);
  const s2=reg2.createPairing({},'test');const n=nonce();const origin='https://quiet-river-fixture.trycloudflare.com';
  const offer=reg2.hello({code:s2.code,organiserProof:{deviceId:paired.deviceId,nonce:n}},origin) as {eventId:string;organiserProof?:string};
  expect(offer.organiserProof).toBe(organiserProof(paired.organiserProofKey,{deviceId:paired.deviceId,eventId:offer.eventId,code:s2.code,nonce:n,origin}));
  // The secret lives only in its file, never in the register.
  const secret=readFileSync(secretPath);const dump=JSON.stringify(again.db.query('SELECT * FROM metadata').all());
  expect(dump).not.toContain(secret.toString('hex'));expect(dump).not.toContain('organiser-proof-secret');
  expect(()=>again.db.close(true)).not.toThrow();
  // Another register with the same secret file derives the same key for the same device id.
  const other=new AttendanceStore(':memory:');expect(new DeviceRegistry(other,now,secret).proofSecret.equals(secret)).toBe(true);other.close();
 }finally{removeTempDir(d)}
});

test('without a secret file: one secret per register database, kept across a restart, different in another database',()=>{
 const d=tmp();
 try{
  const db=join(d,'register.sqlite');
  const a=new AttendanceStore(db);const keyA=organiserProofKey(new DeviceRegistry(a).proofSecret,'dev_aaaaaaaaaaaa');a.close();
  const b=new AttendanceStore(db);expect(organiserProofKey(new DeviceRegistry(b).proofSecret,'dev_aaaaaaaaaaaa')).toBe(keyA);b.close();
  const c=new AttendanceStore(':memory:');expect(organiserProofKey(new DeviceRegistry(c).proofSecret,'dev_aaaaaaaaaaaa')).not.toBe(keyA);c.close();
 }finally{rmSync(d,{recursive:true,force:true})}
});

test('the key appears only in the pair reply: not in logs, the audit, the database or any organiser answer',async()=>{
 const spies=(['log','info','warn','error','debug'] as const).map(m=>spyOn(console,m));
 const hostSecret=randomBytes(32);const s=setup({hostSecret});const organiserText:string[]=[];
 const org=async(method:string,path:string,data?:unknown)=>{const r=await s.org(method,path,data);organiserText.push(JSON.stringify(r.body));return r};
 const keys:string[]=[];
 const pair=async(data:unknown={})=>{const p=(await org('POST','/api/organiser/pairing-sessions',data)).body;const hash=hashOf(newCredential());
  const r=await s.dev('pair',{body:{code:p.shortCode,credentialHash:hash}});keys.push(r.body.organiserProofKey);
  await s.dev('pair',{body:{code:p.shortCode,credentialHash:hash}});return r.body.deviceId as string};
 const first=await pair({label:'Front desk'});const second=await pair();
 await org('PATCH',`/api/organiser/devices/${first}`,{label:'Door'});
 const p=(await org('POST','/api/organiser/pairing-sessions',{})).body;
 await s.dev('hello',{body:{code:p.shortCode,organiserProof:{deviceId:first,nonce:nonce()}}});
 await s.dev('hello',{body:{code:'ZZZZZZZ2',organiserProof:{deviceId:first,nonce:nonce()}}});
 await pair({targetDeviceId:first});
 await org('POST',`/api/organiser/devices/${second}/revoke`);await org('GET','/api/organiser/devices');
 organiserText.push(JSON.stringify((await s.org('GET','/api/roster')).body));
 const tables=(s.store.db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(t=>t.name);
 const dump=JSON.stringify(tables.map(t=>s.store.db.query(`SELECT * FROM ${t}`).all()));
 const logged=JSON.stringify(spies.map(x=>x.mock.calls));for(const x of spies)x.mockRestore();
 expect(keys.length).toBe(3);expect(new Set(keys).size).toBe(2);
 for(const key of keys)for(const text of [dump,logged,...organiserText]){expect(text).not.toContain(key);expect(text).not.toContain(key.slice(4));}
 for(const text of [dump,logged,...organiserText])expect(text).not.toContain(hostSecret.toString('hex'));
 expect(tables).toContain('audit');expect(logged).toBe('[[],[],[],[],[]]');
 s.store.close();
});
