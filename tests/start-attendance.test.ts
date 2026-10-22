import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,statSync,mkdirSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {serviceTestEnv,removeTempDir,removeLink} from './service-spawn';
const windows=process.platform==='win32';
// Runs the real non-preview entry point (bun run start) against a private temporary folder: fictional data only.
const entry=resolve(import.meta.dir,'../server/start-attendance.ts');
const workshopPath=resolve(import.meta.dir,'../examples/workshop.example.json');
const roster=await Bun.file(resolve(import.meta.dir,'../examples/roster.example.json')).json();
const tunnel='https://origin.example.net';
async function start(dir:string,port:number,participantPort:number){
 const proc=Bun.spawn(['bun',entry],{env:serviceTestEnv({ATTENDANCE_CONFIG_PATH:join(dir,'service.json'),ATTENDANCE_DATABASE_PATH:join(dir,'db','attendance.sqlite'),ATTENDANCE_WORKSHOP_PATH:workshopPath,ATTENDANCE_PARTICIPANT_ORIGIN:tunnel,ATTENDANCE_PARTICIPANT_PORT:String(participantPort)}),stdout:'pipe',stderr:'pipe'});
 const reader=proc.stdout.getReader();let out='';
 while(!out.includes('Names-only participant listener')){const {done,value}=await reader.read();if(done)throw new Error('Service exited: '+await new Response(proc.stderr).text());out+=new TextDecoder().decode(value);}
 reader.releaseLock();return proc;
}
// Ports the system has just handed out on 127.0.0.1 (port 0), so parallel test runs on this machine cannot collide.
function freePorts(n:number){const servers=Array.from({length:n},()=>Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response(null)}));const ports=servers.map(s=>s.port!);for(const s of servers)s.stop(true);return ports}
test('documented start: loopback admin without password, roster import, tunnel participant listener, durable restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'attendance-start-'));const [port,participantPort]=freePorts(2);const local=`http://127.0.0.1:${port}`;
 writeFileSync(join(dir,'service.json'),JSON.stringify({origin:local,users:{}}));
 const admin=(path:string,data?:unknown)=>fetch(local+'/api/'+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{Origin:local,'Content-Type':'application/json','X-Attendance-Request':'1'},body:data===undefined?undefined:JSON.stringify(data)});
 // cloudflared forwards the tunnel hostname as Host; the participant listener checks it.
 const participant=(path:string,data?:unknown)=>fetch(`http://127.0.0.1:${participantPort}/api/participant-`+path,{method:data===undefined?'GET':'POST',headers:{Host:'origin.example.net',...(data===undefined?{}:{Origin:tunnel,'Content-Type':'application/json','X-Attendance-Request':'1'})},body:data===undefined?undefined:JSON.stringify(data)});
 let proc=await start(dir,port,participantPort);
 try{
  // POSIX modes; on Windows the folder's access list was checked at start (a shared one is refused: see the next test).
  if(!windows){expect(statSync(join(dir,'db')).mode&0o777).toBe(0o700);expect(statSync(join(dir,'db','attendance.sqlite')).mode&0o777).toBe(0o600);}
  const empty=await (await admin('roster')).json();expect(empty.localAdmin).toBe(true);expect(empty.participants).toHaveLength(0);expect(empty.participantWindow.open).toBe(true);
  expect((await admin('import',roster)).status).toBe(200);
  expect((await admin('add-participant',{name:'Pat Example'})).status).toBe(200);
  const names=await (await participant('names')).json();
  expect(names.participants.map((p:any)=>p.name).sort()).toEqual(['Alex Example','Bea Example','Pat Example']);expect(JSON.stringify(names)).not.toContain('@');
  const alex=names.participants.find((p:any)=>p.name==='Alex Example');
  expect((await participant('check-in',{token:alex.token,opId:crypto.randomUUID(),basis:alex.rev,queuedAt:new Date().toISOString()})).status).toBe(200);
  // Organiser APIs never answer on the participant listener.
  expect((await fetch(`http://127.0.0.1:${participantPort}/api/roster`,{headers:{Host:'origin.example.net'}})).status).toBe(404);
  expect((await admin('check-in-window',{action:'close'})).status).toBe(200);expect((await participant('names')).status).toBe(410);
  proc.kill();await proc.exited;
  // Restart on the same database: attendance, tokens and the organiser's closure are kept.
  proc=await start(dir,port,participantPort);
  const after=await (await admin('roster')).json();expect(after.participants.find((p:any)=>p.name==='Alex Example').present).toBe(true);expect(after.participantWindow.open).toBe(false);
  expect((await admin('check-in-window',{action:'open',minutes:5})).status).toBe(200);
  expect((await (await participant('names')).json()).participants.find((p:any)=>p.name==='Alex Example')).toMatchObject({token:alex.token,checkedIn:true});
 }finally{proc.kill();await proc.exited;removeTempDir(dir);}
},20000);

test('startup refuses a linked register folder or file, and register files others can read, before opening anything',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'attendance-start-links-'));
 try{
  const data=join(dir,'data'),outside=join(dir,'outside');mkdirSync(data,{mode:0o700});mkdirSync(outside,{mode:0o755});
  writeFileSync(join(data,'service.json'),JSON.stringify({origin:'http://127.0.0.1:43999',users:{}}));
  // Every case is refused before any listener is bound, so the organiser port in service.json is never opened.
  const run=async()=>{
   const proc=Bun.spawn(['bun',entry],{env:serviceTestEnv({ATTENDANCE_CONFIG_PATH:join(data,'service.json'),ATTENDANCE_DATABASE_PATH:join(data,'db','attendance.sqlite'),ATTENDANCE_DATA_ROOT:data,ATTENDANCE_WORKSHOP_PATH:workshopPath}),stdout:'pipe',stderr:'pipe'});
   const t=setTimeout(()=>proc.kill(),10000);const code=await proc.exited;clearTimeout(t);
   return {code,err:await new Response(proc.stderr).text()};
  };
  symlinkSync(outside,join(data,'db'));
  let r=await run();
  expect(r.code).not.toBe(0);expect(r.err).toMatch(/is a link/);
  if(!windows)expect(statSync(outside).mode&0o777).toBe(0o755);expect(existsSync(join(outside,'attendance.sqlite'))).toBe(false);
  removeLink(join(data,'db'));mkdirSync(join(data,'db'),{mode:0o700});
  writeFileSync(join(outside,'attendance.sqlite'),'',{mode:0o644});symlinkSync(join(outside,'attendance.sqlite'),join(data,'db','attendance.sqlite'));
  r=await run();
  expect(r.code).not.toBe(0);expect(r.err).toMatch(/is a link/);
  if(!windows)expect(statSync(join(outside,'attendance.sqlite')).mode&0o777).toBe(0o644);
  removeLink(join(data,'db','attendance.sqlite'));
  // A journal file other accounts can read: POSIX mode 644; Windows an access list that also grants Everyone (S-1-1-0).
  const wal=join(data,'db','attendance.sqlite-wal');
  writeFileSync(wal,'',{mode:0o644});
  if(windows)execFileSync('icacls.exe',[wal,'/grant','*S-1-1-0:(R)'],{stdio:'ignore',windowsHide:true});
  r=await run();
  expect(r.code).not.toBe(0);expect(r.err).toMatch(/private/);
  expect(existsSync(join(data,'db','attendance.sqlite'))).toBe(false);
 }finally{removeTempDir(dir);}
},30000);

test.skipIf(process.platform==='win32')('desktop mode: the participant listener is a Unix socket in a private folder; no participant TCP port; unsafe socket paths are refused',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'attendance-sock-'));
 const port=43000+Math.floor(Math.random()*2000);const local=`http://127.0.0.1:${port}`;
 writeFileSync(join(dir,'service.json'),JSON.stringify({origin:local,users:{}}));
 const run=mkdtempSync(join(dir,'run-'));
 const env=(socket:string)=>({PATH:process.env.PATH??'',ATTENDANCE_CONFIG_PATH:join(dir,'service.json'),ATTENDANCE_DATABASE_PATH:join(dir,'db','attendance.sqlite'),ATTENDANCE_WORKSHOP_PATH:workshopPath,ATTENDANCE_PARTICIPANT_ORIGIN:tunnel,ATTENDANCE_PARTICIPANT_SOCKET:socket});
 const refused=async(socket:string)=>{const p=Bun.spawn(['bun',entry],{env:env(socket),stdout:'pipe',stderr:'pipe'});const t=setTimeout(()=>p.kill(),10000);const code=await p.exited;clearTimeout(t);return {code,err:await new Response(p.stderr).text()};};
 try{
  // Refused before any listener is bound: an existing path, a folder others can read, a linked folder, a relative path.
  writeFileSync(join(run,'taken.sock'),'');
  expect((await refused(join(run,'taken.sock'))).err).toMatch(/already in use/);
  const open=join(dir,'open');mkdirSync(open,{mode:0o755});
  expect((await refused(join(open,'p.sock'))).err).toMatch(/private/);
  symlinkSync(run,join(dir,'linked'));
  expect((await refused(join(dir,'linked','p.sock'))).err).toMatch(/real folder/);
  expect((await refused('p.sock')).err).toMatch(/absolute/);
  const socket=join(run,'p.sock');
  const proc=Bun.spawn(['bun',entry],{env:env(socket),stdout:'pipe',stderr:'pipe'});
  try{
   const reader=proc.stdout.getReader();let out='';
   while(!out.includes('Names-only participant listener')){const {done,value}=await reader.read();if(done)throw new Error('Service exited: '+await new Response(proc.stderr).text());out+=new TextDecoder().decode(value);}
   reader.releaseLock();
   expect(out).toContain('private socket');
   const names=await fetch('http://origin.example.net/api/participant-names',{unix:socket,headers:{Host:'origin.example.net'}} as RequestInit);
   expect(names.status).toBe(200);
   expect((await fetch('http://origin.example.net/api/roster',{unix:socket,headers:{Host:'origin.example.net'}} as RequestInit)).status).toBe(404);
   expect((await fetch(local+'/api/check-in-window')).status).toBe(200);
  }finally{proc.kill();await proc.exited;}
 }finally{removeTempDir(dir);}
},30000);

test('desktop mode, TCP path (Windows): the participant listener serves HTTPS with the certificate it was given; only that certificate\'s pin reaches it',async()=>{
 const {createParticipantTls,participantTlsSecrets,pinnedStatus,pinnedRequest}=await import('../desktop/runtime/participant-tls.ts');
 const dir=mkdtempSync(join(tmpdir(),'attendance-tls-'));
 const port=43000+Math.floor(Math.random()*2000),participantPort=port+2001;const local=`http://127.0.0.1:${port}`;
 writeFileSync(join(dir,'service.json'),JSON.stringify({origin:local,users:{}}));
 const creds=createParticipantTls();
 const base=serviceTestEnv({ATTENDANCE_CONFIG_PATH:join(dir,'service.json'),ATTENDANCE_DATABASE_PATH:join(dir,'db','attendance.sqlite'),ATTENDANCE_WORKSHOP_PATH:workshopPath,ATTENDANCE_PARTICIPANT_ORIGIN:tunnel,ATTENDANCE_SECRETS:'stdin'});
 // Key and certificate go on standard input with the organiser key, as the desktop runtime sends them.
 const organiserToken=(await import('node:crypto')).randomBytes(32).toString('base64url');
 const secrets=participantTlsSecrets(creds);
 const input=(o:Record<string,string>)=>new Blob([JSON.stringify({organiserToken,...o})+'\n']);
 try{
  // Refused before any file is created or listener bound: a TCP participant listener without a certificate, a certificate
  // without a key, a malformed key, a key and certificate that do not belong together, or a certificate given with a
  // Unix socket.
  const tcp={...base,ATTENDANCE_PARTICIPANT_PORT:String(participantPort)};
  const other=participantTlsSecrets(createParticipantTls());
  for(const [env,stdin] of [[tcp,input({})],[tcp,input({tlsCert:secrets.tlsCert})],[tcp,input({tlsKey:'not base64!',tlsCert:secrets.tlsCert})],[tcp,input({tlsKey:other.tlsKey,tlsCert:secrets.tlsCert})],[{...base,ATTENDANCE_PARTICIPANT_SOCKET:join(dir,'p.sock')},input(secrets)]] as const){
   const p=Bun.spawn(['bun',entry],{env,stdin,stdout:'pipe',stderr:'pipe'});const t=setTimeout(()=>p.kill(),10000);const code=await p.exited;clearTimeout(t);
   expect(code).not.toBe(0);const err=await new Response(p.stderr).text();expect(err).toMatch(/participant certificate/);expect(err).not.toContain(secrets.tlsKey.slice(0,40));expect(err).not.toContain(other.tlsKey.slice(0,40));
   expect(existsSync(join(dir,'db'))).toBe(false);
   expect(await fetch(local+'/api/check-in-window').then(r=>r.status,()=>0)).toBe(0);
  }
  const proc=Bun.spawn(['bun',entry],{env:tcp,stdin:input(secrets),stdout:'pipe',stderr:'pipe'});
  try{
   const reader=proc.stdout.getReader();let out='';
   while(!out.includes('Names-only participant listener')){const {done,value}=await reader.read();if(done)throw new Error('Service exited: '+await new Response(proc.stderr).text());out+=new TextDecoder().decode(value);}
   reader.releaseLock();
   expect(out).toContain('pinned certificate');
   expect(out).not.toContain(secrets.tlsKey.slice(0,40));
   // Neither the key nor the certificate is in the process's environment.
   if(process.platform!=='win32'){const listing=Bun.spawnSync(['/bin/ps','eww','-p',String(proc.pid)],{env:{PATH:'/bin:/usr/bin'}}).stdout.toString();expect(listing).toContain('ATTENDANCE_PARTICIPANT_PORT');for(const v of [secrets.tlsKey,secrets.tlsCert,organiserToken])expect(listing).not.toContain(v.slice(0,40));}
   const target={port:participantPort,fingerprint:creds.fingerprint};
   expect(await pinnedStatus(target,'/api/participant-names','origin.example.net')).toBe(200);
   expect(await pinnedStatus(target,'/api/roster','origin.example.net')).toBe(404);
   expect(await pinnedStatus({...target,fingerprint:createParticipantTls().fingerprint},'/api/participant-names','origin.example.net')).toBe(0);
   // Plain HTTP gets nothing from it.
   expect(await fetch(`http://127.0.0.1:${participantPort}/api/participant-names`,{headers:{Host:'origin.example.net'}}).then(r=>r.status,()=>0)).not.toBe(200);
   const names=await pinnedRequest(target,{method:'GET',path:'/api/participant-names',headers:{Host:'origin.example.net'}});
   let body='';for await(const c of names.body)body+=c;
   expect(JSON.parse(body).participants).toEqual([]);
   expect((await fetch(local+'/api/check-in-window',{headers:{Authorization:`Bearer ${organiserToken}`}})).status).toBe(200); // the organiser listener stays plain loopback HTTP
  }finally{proc.kill();await proc.exited;}
 }finally{removeTempDir(dir);}
},30000);
