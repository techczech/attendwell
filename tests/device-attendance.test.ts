import {test,expect,spyOn} from 'bun:test';
import {AttendanceStore} from '../server/store-attendance';
import {createHandler} from '../server/http-attendance';
import {setup,newCredential,hashOf,participantOrigin,organiserOrigin} from './device-helpers';

test('pairing: QR and code, hello does not spend, hash-only storage, one-time use with a 15-minute lost-reply replay',async()=>{
 const s=setup();const p=await s.pairing({label:'Front desk'});
 expect(p.shortCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);expect(p.qrPayload).toBe(`${participantOrigin}/pair#v=1&code=${p.shortCode}`);
 expect(Date.parse(p.expiresAt)-s.clock.t).toBe(5*60000);expect(p.eventCode).toMatch(/^[A-Z0-9]{4}$/);
 const offer=await s.dev('hello',{body:{code:p.shortCode.toLowerCase()}});expect(offer.status).toBe(200);
 expect(offer.body).toEqual({eventId:expect.stringMatching(/^evt_/),eventCode:p.eventCode,eventName:'Example Hands-On Workshop',eventDate:'2030-01-15',deviceLabel:'Front desk'});
 expect((await s.dev('hello',{body:{code:p.shortCode}})).status).toBe(200);
 const credential=newCredential(),hash=hashOf(credential);
 const first=await s.dev('pair',{body:{code:p.shortCode.replace('-',''),credentialHash:hash}});
 expect(first.status).toBe(201);expect(first.body).toEqual({eventId:offer.body.eventId,deviceId:expect.stringMatching(/^dev_/),deviceLabel:'Front desk',credentialHash:hash,organiserProofKey:expect.stringMatching(/^opk_[A-Za-z0-9_-]{43}$/)});
 // The plaintext credential and the plaintext code are nowhere in the database.
 const dump=JSON.stringify(['devices','pairing_sessions','audit','metadata'].map(t=>s.store.db.query(`SELECT * FROM ${t}`).all()));
 expect(dump).not.toContain(credential);expect(dump).not.toContain(p.shortCode.replace('-',''));expect(dump).toContain(hash);
 // Lost reply: same code and hash replays the same answer; anything else is the generic refusal.
 s.clock.t+=14*60000;expect((await s.dev('pair',{body:{code:p.shortCode,credentialHash:hash}})).body).toEqual(first.body);
 expect(await s.dev('pair',{body:{code:p.shortCode,credentialHash:hashOf(newCredential())}})).toMatchObject({status:401,body:{error:'invalid_or_expired_code'}});
 expect((await s.dev('hello',{body:{code:p.shortCode}})).status).toBe(401);
 s.clock.t+=60000;expect((await s.dev('pair',{body:{code:p.shortCode,credentialHash:hash}})).status).toBe(401);
 expect((await s.dev('roster',{bearer:credential})).status).toBe(200);
 expect(s.store.db.query("SELECT COUNT(*) AS n FROM audit WHERE verb='device-paired'").get()).toEqual({n:1});
 s.store.close();
});

test('pairing: codes expire after five minutes; a new code cancels the previous one',async()=>{
 const s=setup();const a=await s.pairing();s.clock.t+=5*60000;
 expect((await s.dev('hello',{body:{code:a.shortCode}})).status).toBe(401);
 expect((await s.dev('pair',{body:{code:a.shortCode,credentialHash:hashOf(newCredential())}})).status).toBe(401);
 const b=await s.pairing(),c=await s.pairing();
 expect((await s.dev('hello',{body:{code:b.shortCode}})).status).toBe(401);expect((await s.dev('hello',{body:{code:c.shortCode}})).status).toBe(200);
 expect((await s.org('GET','/api/organiser/devices')).body.pairing).toMatchObject({sessionId:c.sessionId,state:'waiting'});
 expect((await s.org('DELETE','/api/organiser/pairing-sessions/'+c.sessionId)).status).toBe(200);
 expect((await s.dev('hello',{body:{code:c.shortCode}})).status).toBe(401);expect((await s.org('DELETE','/api/organiser/pairing-sessions/'+c.sessionId)).status).toBe(404);
 s.store.close();
});

test('pairing: malformed and old codes never count; five well-formed wrong codes pause the open code for 30 s, then 60 s; it never locks for good',async()=>{
 const s=setup();const old=await s.pairing();const p=await s.pairing();
 const wrong=(i:number)=>'ZZZZZZZ'+'23456789'[i%8];
 const state=async()=>(await s.org('GET','/api/organiser/devices')).body.pairing;
 // Junk from anyone who learns the address: malformed codes and a scanned old QR are refused and not counted.
 for(let i=0;i<20;i++)expect((await s.dev('hello',{body:{code:i%2?'WRONG'+i:'ABCD00'+i+'1'}})).status).toBe(401);
 expect((await s.dev('hello',{body:{code:old.shortCode}})).status).toBe(401);
 expect(await state()).toMatchObject({sessionId:p.sessionId,state:'waiting',wrongAttempts:0,pausedUntil:null});
 expect((await s.dev('hello',{body:{code:p.shortCode}})).status).toBe(200);
 s.clock.t+=61000;
 // Four well-formed wrong codes: the right one still works.
 for(let i=0;i<4;i++)expect((await s.dev('hello',{body:{code:wrong(i)}})).status).toBe(401);
 expect((await s.dev('hello',{body:{code:p.shortCode}})).status).toBe(200);
 // The fifth pauses the code: during the pause every code is refused, the right one too, and nothing more is counted.
 expect((await s.dev('pair',{body:{code:wrong(4),credentialHash:hashOf(newCredential())}})).status).toBe(401);
 const paused=s.clock.t;
 expect((await s.dev('hello',{body:{code:p.shortCode}})).status).toBe(401);
 for(let i=0;i<3;i++)expect((await s.dev('hello',{body:{code:wrong(i)}})).status).toBe(401);
 expect(await state()).toMatchObject({state:'paused',wrongAttempts:5,pausedUntil:new Date(paused+30000).toISOString()});
 s.clock.t+=30000;expect(await state()).toMatchObject({state:'waiting',wrongAttempts:5,pausedUntil:null});
 expect((await s.dev('hello',{body:{code:p.shortCode}})).status).toBe(200);
 // Five more: the pause doubles.
 for(let i=0;i<5;i++)expect((await s.dev('hello',{body:{code:wrong(i)}})).status).toBe(401);
 expect(await state()).toMatchObject({state:'paused',wrongAttempts:10,pausedUntil:new Date(s.clock.t+60000).toISOString()});
 s.clock.t+=59000;expect((await s.dev('hello',{body:{code:p.shortCode}})).status).toBe(401);
 s.clock.t+=2000;expect((await s.dev('pair',{body:{code:p.shortCode,credentialHash:hashOf(newCredential())}})).status).toBe(201);
 expect(s.store.db.query("SELECT COUNT(*) AS n FROM audit WHERE verb='device-pairing-paused'").get()).toEqual({n:2});
 expect(s.store.db.query("SELECT COUNT(*) AS n FROM audit WHERE verb='device-pairing-locked'").get()).toEqual({n:0});
 s.store.close();
});

test('pairing requests are rate-limited in the listener itself',async()=>{
 const s=setup();let limited=0;
 for(let i=0;i<35;i++)if((await s.dev('hello',{body:{code:'ABCDEFG'+(i%10)}})).status===429)limited++;
 expect(limited).toBe(5);s.clock.t+=61000;expect((await s.dev('hello',{body:{code:'ABCDEFGH'}})).status).toBe(401);
 s.store.close();
});

test('every authenticated device route refuses unpaired, malformed, wrong and revoked credentials alike',async()=>{
 const s=setup();const {credential,deviceId}=await s.pairDevice();
 const eventId=(await s.roster(credential)).eventId;
 const calls:[string,unknown][]=[['roster',undefined],['operations',{eventId,operations:[s.op('pt_'+'0'.repeat(24),0)]}],['heartbeat',{}],['heartbeat',undefined]];
 for(const bearer of [null,'not-a-credential','dc_short',newCredential(),credential.slice(0,-1)+(credential.endsWith('A')?'B':'A')])
  for(const [name,body] of calls)expect(await s.dev(name,{bearer,body})).toMatchObject({status:401,body:{error:'device_revoked'}});
 for(const [name,body] of calls)expect((await s.dev(name,{bearer:credential,body})).status).toBe(200);
 expect((await s.org('POST',`/api/organiser/devices/${deviceId}/revoke`,{})).status).toBe(200);
 for(const [name,body] of calls)expect((await s.dev(name,{bearer:credential,body})).status).toBe(401);
 expect(s.store.db.query("SELECT actor,deviceId FROM audit WHERE verb='device-revoked'").get()).toEqual({actor:'local-organiser',deviceId});
 s.store.close();
});

test('device middleware: browser-shaped, wrong protocol, wrong type, oversize and unknown requests are refused before any work',async()=>{
 const s=setup();const {credential}=await s.pairDevice();
 for(const extra of [{Origin:participantOrigin},{Cookie:'attendance=x'},{'Sec-Fetch-Site':'same-origin'}] as Record<string,string>[])
  expect((await s.dev('roster',{bearer:credential,headers:extra})).status).toBe(403);
 expect((await s.dev('roster',{bearer:credential,headers:{'X-Attendance-Device-Protocol':'2'}})).body).toEqual({error:'protocol_unsupported',protocolVersions:[1]});
 const none=await s.participant(new Request(participantOrigin+'/device/v1/roster',{headers:{Authorization:'Bearer '+credential}}));expect(none.status).toBe(400);
 expect((await s.dev('roster',{bearer:credential,method:'OPTIONS'})).status).toBe(405);
 expect((await s.dev('roster',{bearer:credential,method:'POST',body:{}})).status).toBe(405);
 expect((await s.dev('hello',{method:'GET'})).status).toBe(405);
 expect((await s.dev('heartbeat',{bearer:credential,body:{},headers:{'Content-Type':'text/plain'}})).status).toBe(415);
 expect((await s.dev('heartbeat',{bearer:credential,raw:'{broken'})).status).toBe(400);
 expect((await s.dev('heartbeat',{bearer:credential,raw:'[]'})).status).toBe(400);
 expect((await s.dev('heartbeat',{bearer:credential,raw:JSON.stringify({pad:'x'.repeat(66000)})})).status).toBe(413);
 for(const name of ['events','hello/','../api/participant-names','register'])expect((await s.dev(name,{bearer:credential})).status).toBe(404);
 const page=await s.participant(new Request(participantOrigin+'/pair'));
 expect(page.status).toBe(200);expect(page.headers.get('content-type')).toContain('text/html');expect(page.headers.get('cache-control')).toBe('no-store');expect(page.headers.get('referrer-policy')).toBe('no-referrer');
 expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");expect(await page.text()).not.toContain('<script');
 expect((await s.participant(new Request(participantOrigin+'/pair',{method:'POST'}))).status).toBe(405);
 // Browser participant routes keep their own rules: a device header does not get past the Origin check.
 expect((await s.participant(new Request(participantOrigin+'/api/participant-check-in',{method:'POST',headers:{'Content-Type':'application/json','X-Attendance-Device-Protocol':'1',Authorization:'Bearer '+credential},body:'{}'}))).status).toBe(403);
 s.store.close();
});

test('organiser device routes exist only on the loopback organiser listener, behind its Origin and header rules',async()=>{
 const s=setup();const {deviceId}=await s.pairDevice();
 for(const [method,path] of [['GET','/api/organiser/devices'],['POST','/api/organiser/pairing-sessions'],['POST',`/api/organiser/devices/${deviceId}/revoke`]]){
  const r=await s.participant(new Request(participantOrigin+path,{method,headers:method==='GET'?{}:{Origin:participantOrigin,'Content-Type':'application/json','X-Attendance-Request':'1'},body:method==='GET'?undefined:'{}'}));
  expect(r.status).toBe(404);
 }
 // The organiser listener does not serve device routes.
 expect((await s.organiser(new Request(organiserOrigin+'/device/v1/roster',{headers:{'X-Attendance-Device-Protocol':'1'}}))).status).toBe(404);
 expect((await s.organiser(new Request(organiserOrigin+'/device/v1/hello',{method:'POST',headers:{'X-Attendance-Device-Protocol':'1','Content-Type':'application/json'},body:'{}'}))).status).toBe(403);
 // Writes need the exact Origin and custom header.
 for(const headers of [{'Content-Type':'application/json','X-Attendance-Request':'1'},{Origin:'https://evil.example','Content-Type':'application/json','X-Attendance-Request':'1'},{Origin:organiserOrigin,'Content-Type':'application/json'}] as Record<string,string>[])
  expect((await s.organiser(new Request(organiserOrigin+'/api/organiser/pairing-sessions',{method:'POST',headers,body:'{}'}))).status).toBe(403);
 // A remote (password) organiser listener has no device routes at all, even signed in.
 const hash=await Bun.password.hash('test-only-not-a-production-secret');const remote='https://attendance.example.org';
 const h=createHandler(s.store,{origin:remote,users:{owner:{hash,role:'owner'}}},'/tmp/missing');
 const login=await h(new Request(remote+'/api/login',{method:'POST',headers:{Origin:remote,'Content-Type':'application/json','X-Attendance-Request':'1'},body:JSON.stringify({identity:'owner',passphrase:'test-only-not-a-production-secret'})}));
 expect((await h(new Request(remote+'/api/organiser/devices',{headers:{Cookie:login.headers.get('set-cookie')!.split(';')[0]}}))).status).toBe(404);
 // Without a participant link there is nothing to pair through.
 const bare=setup({participantLink:false});expect((await bare.org('POST','/api/organiser/pairing-sessions',{})).status).toBe(409);bare.store.close();
 s.store.close();
});

test('re-pairing: Pair again and old-credential proof keep the device record; otherwise a second record appears',async()=>{
 const s=setup();const first=await s.pairDevice({label:'iPad 1'});
 // Pair again from the organiser's row: same device, new credential, old one stops working.
 const again=await s.pairDevice({targetDeviceId:first.deviceId});expect(again.deviceId).toBe(first.deviceId);expect(again.session.label).toBe('iPad 1');
 expect((await s.dev('roster',{bearer:first.credential})).status).toBe(401);expect((await s.dev('roster',{bearer:again.credential})).status).toBe(200);
 // The iPad's still-valid credential as proof: same record.
 const proven=await s.pairDevice({},again.credential);expect(proven.deviceId).toBe(first.deviceId);
 expect((await s.dev('roster',{bearer:again.credential})).status).toBe(401);
 // A revoked credential proves nothing: new record. Pair again on the revoked row restores it.
 await s.org('POST',`/api/organiser/devices/${first.deviceId}/revoke`,{});
 const fresh=await s.pairDevice({},proven.credential);expect(fresh.deviceId).not.toBe(first.deviceId);
 const restored=await s.pairDevice({targetDeviceId:first.deviceId});expect(restored.deviceId).toBe(first.deviceId);
 const list=(await s.org('GET','/api/organiser/devices')).body.devices;
 expect(list.map((d:any)=>[d.id,d.status])).toEqual([[first.deviceId,'active'],[fresh.deviceId,'active']]);
 for(const d of list)expect(d.credentialHash).toBeUndefined();
 expect((await s.org('PATCH','/api/organiser/devices/'+fresh.deviceId,{label:'Back door'})).body.devices[1].label).toBe('Back door');
 expect((await s.org('PATCH','/api/organiser/devices/'+fresh.deviceId,{label:'a@b.org'})).status).toBe(400);
 s.store.close();
});

test('check-in upload: idempotent by opId across devices and re-pairing; held, closed and moved cases',async()=>{
 const s=setup();const a=await s.pairDevice(),b=await s.pairDevice();
 const people=(await s.roster(a.credential)).people as any[];const alex=people.find(p=>p.displayName==='Alex Example');const bea=people.find(p=>p.displayName==='Bea Example');
 const op=s.op(alex.personToken,alex.revision);
 expect((await s.send(a.credential,op)).body.results).toEqual([{opId:op.opId,outcome:'applied'}]);
 expect((await s.send(a.credential,op)).body.results).toEqual([{opId:op.opId,outcome:'already_applied'}]);
 expect((await s.send(b.credential,op)).body.results).toEqual([{opId:op.opId,outcome:'already_applied'}]);
 // Re-paired iPad retries the same operation: still already_applied, attendance changed once.
 const again=await s.pairDevice({targetDeviceId:a.deviceId});
 expect((await s.send(again.credential,op)).body.results[0].outcome).toBe('already_applied');
 expect(s.store.list().participants.find(p=>p.id==='a')).toMatchObject({present:true,version:1});
 expect(s.store.db.query("SELECT kind,actor,deviceId FROM operations WHERE opId=?").get(op.opId)).toEqual({kind:'device-check-in',actor:'device:'+a.deviceId,deviceId:a.deviceId});
 // Someone already checked in by another route: acknowledged, not held.
 expect((await s.send(b.credential,s.op(alex.personToken,alex.revision))).body.results[0].outcome).toBe('already_applied');
 // An organiser change since the iPad saw the record: held as stale, waiting for the organiser like a browser conflict.
 const beaRow=s.store.list().participants.find(p=>p.id==='b')!;s.store.setAttendance('b',true,beaRow.version,'o');s.store.setAttendance('b',false,beaRow.version+1,'o');
 const stale=s.op(bea.personToken,bea.revision);
 expect((await s.send(again.credential,stale)).body.results).toEqual([{opId:stale.opId,outcome:'held',reason:'stale'}]);
 expect((await s.send(again.credential,stale)).body.results[0]).toMatchObject({outcome:'held',reason:'stale'});
 expect(s.store.conflicts()).toMatchObject([{participantId:'b',reason:'changed'}]);
 expect((await s.org('GET','/api/organiser/devices')).body.devices.find((d:any)=>d.id===a.deviceId)).toMatchObject({checkInsReceived:1,needsReview:1});
 // Unknown person: held, nothing recorded. Wrong event: 409. Batches answer in order.
 expect((await s.send(again.credential,s.op('pt_'+'f'.repeat(24),0))).body.results[0]).toMatchObject({outcome:'held',reason:'unknown_person'});
 expect(await s.dev('operations',{bearer:again.credential,body:{eventId:'evt_other',operations:[s.op(alex.personToken,0)]}})).toMatchObject({status:409,body:{error:'event_moved'}});
 const dup=people.find(p=>p.displayName==='Alex Duplicate'),missing=people.find(p=>p.displayName==='Missing Address');
 const batch=[s.op(dup.personToken,dup.revision),s.op(missing.personToken,missing.revision)];
 expect((await s.send(again.credential,...batch)).body.results.map((r:any)=>[r.opId,r.outcome])).toEqual(batch.map(o=>[o.opId,'applied']));
 for(const bad of [[],Array(51).fill(op),[{...op,baseRevision:-1}],[{...op,opId:'x'}],[{...op,recordedAt:'yesterday'}]])
  expect((await s.dev('operations',{bearer:again.credential,body:{eventId:(await s.roster(again.credential)).eventId,operations:bad}})).status).toBe(400);
 // Closed window: not recorded, stays pending on the iPad; reopening applies it.
 s.store.closeParticipantWindow('o',s.clock.t);const w=s.op(people.find(p=>p.displayName==='Bea Example').personToken,s.store.list().participants.find(p=>p.id==='b')!.version);
 const closed=await s.send(again.credential,w);expect(closed.body.results).toEqual([{opId:w.opId,outcome:'closed'}]);expect(closed.body.window.state).toBe('closed');
 expect(s.store.db.query('SELECT 1 FROM operations WHERE opId=?').get(w.opId)).toBeNull();
 expect((await s.send(again.credential,op)).body.results[0].outcome).toBe('already_applied');
 s.store.openParticipantWindow(10,'o',s.clock.t);expect((await s.send(again.credential,w)).body.results[0].outcome).toBe('applied');
 s.store.close();
});

test('snapshot: names-only list of eligible people, window and a version that changes with the register',async()=>{
 const s=setup();const {credential}=await s.pairDevice();
 const r=await s.roster(credential);
 expect(Object.keys(r).sort()).toEqual(['eventCode','eventDate','eventId','eventName','people','rosterVersion','serverTime','window']);
 expect(r.people.map((p:any)=>p.displayName).sort()).toEqual(['Alex Duplicate','Alex Example','Bea Example','Missing Address']);
 for(const p of r.people){expect(Object.keys(p).sort()).toEqual(['checkedIn','displayName','personToken','revision']);expect(p.personToken).toMatch(/^pt_[a-f0-9]{24}$/);}
 expect(JSON.stringify(r)).not.toMatch(/@|Cancelled|Waiting|Confirmed|fictional\.json/);
 expect(r.window).toEqual({state:'open',revision:1,openedAt:new Date(s.clock.t).toISOString(),closesAt:new Date(s.clock.t+3600000).toISOString()});
 expect((await s.roster(credential)).rosterVersion).toBe(r.rosterVersion);
 s.store.setAttendance('b',true,0,'o');const after=await s.roster(credential);expect(after.rosterVersion).not.toBe(r.rosterVersion);
 expect(after.people.find((p:any)=>p.displayName==='Bea Example')).toMatchObject({checkedIn:true,revision:1});
 // A closed window still serves the list, marked closed with a new window revision.
 s.store.closeParticipantWindow('o',s.clock.t);expect((await s.roster(credential)).window).toMatchObject({state:'closed',revision:2});
 // A full 500-person register stays inside the iPad's 64 KB response limit.
 const big=new AttendanceStore(':memory:');const people=Array.from({length:500},(_,i)=>({id:'p'+i,name:`Alexandra Montgomery-Smithson ${i}`,email:`p${i}@example.org`,booking:'confirmed' as const,sourceStatus:'Confirmed'}));
 big.import({sessionId:'example-session-001',date:'2030-01-15',source:{filename:'f.json',sha256:'a'.repeat(64),exportedAt:'2029-12-20T21:36:00Z'},participants:people},'t');
 const {deviceRegistry}=await import('../server/device-attendance');expect(JSON.stringify(deviceRegistry(big).snapshot()).length).toBeLessThan(65536);big.close();
 s.store.close();
});

test('heartbeat reports the iPad outbox summary to the device list; nothing is logged',async()=>{
 const spies=[spyOn(console,'log'),spyOn(console,'error'),spyOn(console,'warn'),spyOn(console,'info')];
 const s=setup();const {credential,deviceId}=await s.pairDevice();
 const hb=await s.dev('heartbeat',{bearer:credential,body:{pendingCount:3,heldCount:1,oldestPendingAt:'2030-01-15T12:49:00Z',appVersion:'1.0.0'}});
 expect(Object.keys(hb.body).sort()).toEqual(['eventId','rosterVersion','serverTime','window']);
 expect((await s.org('GET','/api/organiser/devices')).body.devices[0]).toMatchObject({id:deviceId,status:'active',reportedPending:3,reportedHeld:1,oldestPendingAt:'2030-01-15T12:49:00.000Z',appVersion:'1.0.0',lastSeenAt:new Date(s.clock.t).toISOString()});
 await s.dev('hello',{body:{code:'WRONGCODE'}});
 for(const spy of spies){expect(spy).not.toHaveBeenCalled();spy.mockRestore();}
 s.store.close();
});

test('body limits count UTF-8 bytes: 4 KB for browser check-ins and 64 KB for iPads on the same listener',async()=>{
 const s=setup();const {credential}=await s.pairDevice();
 const names=await (await s.participant(new Request(participantOrigin+'/api/participant-names'))).json() as any;const alex=names.participants.find((p:any)=>p.name==='Alex Example');
 const browser=(body:string)=>s.participant(new Request(participantOrigin+'/api/participant-check-in',{method:'POST',headers:{Origin:participantOrigin,'Content-Type':'application/json','X-Attendance-Request':'1'},body}));
 const checkIn=(pad:string)=>JSON.stringify({token:alex.token,opId:crypto.randomUUID(),basis:alex.rev,queuedAt:new Date(s.clock.t).toISOString(),pad});
 // Under 4,096 characters but over 4,096 bytes: refused before parsing, nothing recorded.
 const wide=checkIn('é'.repeat(2500));expect(wide.length).toBeLessThan(4096);expect(Buffer.byteLength(wide)).toBeGreaterThan(5000);
 expect((await browser(wide)).status).toBe(413);expect(s.store.db.query('SELECT COUNT(*) AS n FROM operations').get()).toEqual({n:0});
 // A wrong Content-Length does not get a large body past the limit either.
 expect((await s.participant(new Request(participantOrigin+'/api/participant-check-in',{method:'POST',headers:{Origin:participantOrigin,'Content-Type':'application/json','X-Attendance-Request':'1','Content-Length':'5000'},body:wide}))).status).toBe(413);
 const narrow=checkIn('x'.repeat(3800));expect(Buffer.byteLength(narrow)).toBeLessThanOrEqual(4096);expect((await browser(narrow)).status).toBe(200);
 // The device limit is separate: 30 KB is fine for an iPad, 66 KB is not.
 expect((await s.dev('heartbeat',{bearer:credential,raw:JSON.stringify({pad:'é'.repeat(15000)})})).status).toBe(200);
 expect((await s.dev('heartbeat',{bearer:credential,raw:JSON.stringify({pad:'é'.repeat(33000)})})).status).toBe(413);
 s.store.close();
});
