// The host against the iPad's device-v1 contract fixtures (copied into tests/fixtures/device-v1, see SOURCE.md there).
// Shapes must match key for key; the roster has no host-only fields left.
import {test,expect} from 'bun:test';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {setup,privacyViolations,participantOrigin,newCredential,hashOf} from './device-helpers';
const dir=join(import.meta.dir,'fixtures/device-v1');
const load=(name:string)=>{const {_provisional,...rest}=JSON.parse(readFileSync(join(dir,name),'utf8'));return rest as any};
// The contract now carries every roster field the host sends (eventName, eventDate, rosterVersion); no additions remain.
const ROSTER_ADDITIONS:string[]=[];
// The iPad's RosterSnapshot.isValidRosterVersion: compared for equality only.
const ROSTER_VERSION=/^[A-Za-z0-9._~-]{1,128}$/;
const DATE=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/;
// Key-by-key type shape; arrays by their first element; ISO dates as their own type.
function shape(x:unknown):unknown{
 if(Array.isArray(x))return x.length?[shape(x[0])]:[];
 if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,shape(v)]));
 return typeof x==='string'&&DATE.test(x)?'date':typeof x;
}
const without=(x:any,keys:string[])=>Object.fromEntries(Object.entries(x).filter(([k])=>!keys.includes(k)));

test('the copied fixtures themselves pass the names-only rule',()=>{
 const names=readdirSync(dir).filter(n=>n.endsWith('.json'));expect(names.length).toBe(14);
 for(const name of names)expect(privacyViolations(load(name))).toEqual([]);
});

test('roster: the host snapshot has exactly the fixture shape',async()=>{
 const s=setup();const {credential}=await s.pairDevice();await s.send(credential,s.op((await s.roster(credential)).people[0].personToken,0));
 const host=await s.roster(credential);const fixture=load('roster.example.json');
 expect(Object.keys(host).filter(k=>!(k in fixture)).sort()).toEqual(ROSTER_ADDITIONS);
 expect(shape(without(host,ROSTER_ADDITIONS))).toEqual(shape(fixture));
 expect(host.eventCode).toHaveLength(4);expect(host.people.some((p:any)=>p.checkedIn)).toBe(true);
 // No cursor: the contract's change token is rosterVersion, in the iPad's accepted alphabet.
 expect(host.cursor).toBeUndefined();expect(host.rosterVersion).toMatch(ROSTER_VERSION);expect(fixture.rosterVersion).toMatch(ROSTER_VERSION);
 for(const p of [...host.people,...fixture.people])expect(p.personToken).toMatch(/^pt_[a-f0-9]{24}$/);
 s.store.close();
});

test('heartbeat: the fixture request is accepted and the reply has the fixture shape and the roster version',async()=>{
 const s=setup();const {credential,deviceId}=await s.pairDevice();
 const r=await s.dev('heartbeat',{bearer:credential,body:load('heartbeat-request.example.json')});
 expect(r.status).toBe(200);expect(shape(r.body)).toEqual(shape(load('heartbeat-response.example.json')));
 expect(r.body.rosterVersion).toBe((await s.roster(credential)).rosterVersion);
 expect((await s.org('GET','/api/organiser/devices')).body.devices.find((d:any)=>d.id===deviceId)).toMatchObject({reportedPending:2,reportedHeld:0,appVersion:'0.2.0'});
 s.store.close();
});

test('pairing and error replies match the offer, success, revoked and protocol fixtures',async()=>{
 const s=setup();const p=await s.pairing();
 expect(shape((await s.dev('hello',{body:{code:p.shortCode}})).body)).toEqual(shape(load('pairing-offer.example.json')));
 const credential=newCredential();const paired=await s.dev('pair',{body:{code:p.shortCode,credentialHash:hashOf(credential)}});
 expect(paired.status).toBe(201);expect(shape(paired.body)).toEqual(shape(load('pairing-success.example.json')));
 // The success fixture's hash is the SHA-256 of dc_ + 43 'a' characters, the same rule the host stores.
 expect(hashOf('dc_'+'a'.repeat(43))).toBe(load('pairing-success.example.json').credentialHash);
 expect((await s.dev('roster',{bearer:newCredential()})).body).toEqual(load('error-device-revoked.example.json'));
 expect((await s.dev('roster',{bearer:credential,headers:{'X-Attendance-Device-Protocol':'2'}})).body).toEqual(load('error-protocol-unsupported.example.json'));
 s.store.close();
});

test('operations: the fixture request, re-addressed to this event, gets the fixture response shape and outcomes',async()=>{
 const s=setup();const {credential}=await s.pairDevice();const host=await s.roster(credential);
 const request=load('operations-request.example.json');const byName=(n:string)=>host.people.find((p:any)=>p.displayName===n);const alex=byName('Alex Example'),bea=byName('Bea Example');
 request.eventId=host.eventId;request.operations[0].personToken=alex.personToken;request.operations[0].baseRevision=alex.revision;request.operations[0].recordedAt=new Date(s.clock.t).toISOString();
 const stale={...request.operations[0],opId:'c4d5e6f7-0a1b-4c2d-9e3f-4a5b6c7d8e9f',personToken:bea.personToken,baseRevision:bea.revision};
 s.store.setAttendance('b',true,0,'o');s.store.setAttendance('b',false,1,'o');
 await s.dev('operations',{bearer:credential,body:request});
 const replayed=await s.dev('operations',{bearer:credential,body:{...request,operations:[request.operations[0],{...request.operations[0],opId:'8a1d2c3b-5e6f-4a7b-8c9d-0e1f2a3b4c5d'},stale]}});
 const fixture=load('operations-response.example.json');
 expect(replayed.status).toBe(200);
 expect(shape({...replayed.body,results:[]})).toEqual(shape({...fixture,results:[]}));
 expect(replayed.body.results).toEqual([{opId:request.operations[0].opId,outcome:'already_applied'},{opId:'8a1d2c3b-5e6f-4a7b-8c9d-0e1f2a3b4c5d',outcome:'already_applied'},{opId:stale.opId,outcome:'held',reason:'stale'}]);
 // The fixture's first result is the first-time answer.
 const first=await s.dev('operations',{bearer:credential,body:{...request,operations:[{...request.operations[0],opId:crypto.randomUUID(),personToken:byName('Missing Address').personToken,baseRevision:byName('Missing Address').revision}]}});
 expect(Object.keys(first.body.results[0]).sort()).toEqual(Object.keys(fixture.results[0]).sort());expect(first.body.results[0].outcome).toBe(fixture.results[0].outcome);
 for(const r of fixture.results)expect(['applied','already_applied','held','closed']).toContain(r.outcome);
 s.store.close();
});

test('operations: a closed window answers like the closed fixture and records nothing',async()=>{
 const s=setup();const {credential}=await s.pairDevice();const host=await s.roster(credential);
 s.store.closeParticipantWindow('o',s.clock.t);
 const request=load('operations-request.example.json');request.eventId=host.eventId;request.operations[0].personToken=host.people[0].personToken;
 const r=await s.dev('operations',{bearer:credential,body:request});const fixture=load('operations-response-closed.example.json');
 expect(shape(r.body)).toEqual(shape(fixture));expect(r.body.results).toEqual(fixture.results);expect(r.body.window.state).toBe('closed');
 expect(s.store.db.query('SELECT COUNT(*) AS n FROM operations').get()).toEqual({n:0});
 s.store.close();
});

test('pairing: request and reply shapes, generic refusal and QR form follow pairing.md',async()=>{
 const s=setup();const p=await s.pairing();
 // `{base}/pair#v=1&code=K7QM-4TZP`: exactly two fragment parameters, base without query or fragment.
 const qr=new URL(p.qrPayload);expect(qr.origin+qr.pathname).toBe(participantOrigin+'/pair');expect(qr.search).toBe('');
 const params=new URLSearchParams(qr.hash.slice(1));expect([...params.keys()]).toEqual(['v','code']);expect(params.get('v')).toBe('1');
 expect(params.get('code')!.toUpperCase().replace(/-/g,'')).toMatch(/^[A-Z0-9]{8}$/);
 const offer=await s.dev('hello',{body:{code:params.get('code')}});
 expect(Object.keys(offer.body).sort()).toEqual(['deviceLabel','eventCode','eventDate','eventId','eventName']);
 expect(await s.dev('hello',{body:{code:'K7QM4TZP'}})).toMatchObject({status:401,body:{error:'invalid_or_expired_code'}});
 const {deviceId}=await s.pairDevice();expect(deviceId).toMatch(/^dev_/);
 const again=await s.pairing();const r=await s.dev('pair',{body:{code:again.shortCode,credentialHash:'f'.repeat(64)}});
 expect(r.status).toBe(201);expect(Object.keys(r.body).sort()).toEqual(['credentialHash','deviceId','deviceLabel','eventId','organiserProofKey']);
 expect(r.body.eventId).toBe(offer.body.eventId);
 s.store.close();
});
