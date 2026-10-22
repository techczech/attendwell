import {test,expect} from 'bun:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {AttendanceStore} from '../server/store-attendance';
import {createHandler} from '../server/http-attendance';
import {fixture} from './fixtures-attendance';
import {serviceTestEnv,participantTransport,removeTempDir} from './service-spawn';
// The desktop app's organiser listener: a per-start key (32 bytes, base64url) that every request must carry as a bearer, so
// another process or account on the same computer cannot use the loopback organiser listener. Fictional data only.
const origin='http://127.0.0.1:4318';
const participantOrigin='https://names.example.org';
const key=()=>randomBytes(32).toString('base64url');

function handlers(bearer:string){
 const store=new AttendanceStore(':memory:');store.import(fixture,'test');store.initParticipantWindow(60);
 const organiser=createHandler(store,{origin,users:{},localAdmin:true,participantOrigin,organiserBearer:bearer},'/tmp/missing-assets');
 const participant=createHandler(store,{origin:participantOrigin,users:{},participantOnly:true},'/tmp/missing-assets');
 return {store,organiser,participant};
}
const post=(path:string,auth?:string)=>new Request(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Attendance-Request':'1',...(auth!==undefined?{Authorization:auth}:{})},body:JSON.stringify({name:'Pat Example'})});

test('every organiser route is refused without the key, with a wrong key or a malformed header; the right key passes',async()=>{
 const k=key();const {store,organiser}=handlers(k);
 const paths=['/api/roster','/api/check-in-window','/api/organiser/devices','/','/index.html','/assets/x.js'];
 for(const auth of [undefined,'',`Bearer ${key()}`,`Bearer ${k.slice(0,-1)}`,`Bearer ${k}x`,`bearer ${k}`,`Basic ${k}`,k,`Bearer  ${k}`])for(const p of paths){
  const r=await organiser(new Request(origin+p,{headers:auth!==undefined?{Authorization:auth}:{}}));
  expect([p,auth,r.status]).toEqual([p,auth,401]);
 }
 // Writes too, including the name list and recovery import, and the loopback alias redirect.
 for(const p of ['/api/add-participant','/api/names','/api/organiser/pairing-sessions','/api/organiser/recovery-import'])expect((await organiser(post(p))).status).toBe(401);
 expect((await organiser(new Request('http://localhost:4318/')) ).status).toBe(401);
 const ok=await organiser(new Request(origin+'/api/roster',{headers:{Authorization:`Bearer ${k}`}}));
 expect(ok.status).toBe(200);
 expect((await organiser(post('/api/add-participant',`Bearer ${k}`))).status).toBe(200);
 // The refusal never echoes the key.
 const refused=await (await organiser(new Request(origin+'/api/roster',{headers:{Authorization:`Bearer ${key()}`}}))).text();
 expect(refused).not.toContain(k);
 store.close();
});

test('the participant listener is unaffected, and the key is only for a loopback organiser listener',async()=>{
 const k=key();const {store,participant}=handlers(k);
 const names=await participant(new Request(participantOrigin+'/api/participant-names'));
 expect(names.status).toBe(200);
 expect(()=>createHandler(store,{origin:participantOrigin,users:{},participantOnly:true,organiserBearer:k},'/tmp')).toThrow(/loopback/);
 expect(()=>createHandler(store,{origin:'https://public.example.org',users:{},organiserBearer:k},'/tmp')).toThrow();
 for(const bad of ['short','x'.repeat(44),k.slice(0,42)+'=','',' '+k.slice(1)])expect(()=>createHandler(store,{origin,users:{},localAdmin:true,organiserBearer:bad},'/tmp')).toThrow(/32 bytes/);
 store.close();
});

// The real entry point (bun run start) with the key on its standard input, as the desktop runtime starts it.
const entry=resolve(import.meta.dir,'../server/start-attendance.ts');
const workshopPath=resolve(import.meta.dir,'../examples/workshop.example.json');
function freePorts(n:number){const servers=Array.from({length:n},()=>Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response(null)}));const ports=servers.map(s=>s.port!);for(const s of servers)s.stop(true);return ports}
// stdin: the text written to the service's standard input (then closed); 'open': a pipe that is never written or closed;
// {chunks}: each chunk written separately, 300 ms apart (so each arrives on its own), then closed unless `keepOpen`.
type Input=string|'open'|{chunks:string[];keepOpen?:boolean};
function spawn(dir:string,env:Record<string,string>,stdin?:Input){
 const proc=Bun.spawn(['bun',entry],{env:serviceTestEnv({ATTENDANCE_CONFIG_PATH:join(dir,'service.json'),ATTENDANCE_DATABASE_PATH:join(dir,'db','attendance.sqlite'),ATTENDANCE_WORKSHOP_PATH:workshopPath,...env}),
  stdin:typeof stdin==='object'||stdin==='open'?'pipe':stdin===undefined?'ignore':new Blob([stdin]),stdout:'pipe',stderr:'pipe'});
 if(typeof stdin==='object')void (async()=>{
  const sink=proc.stdin as import('bun').FileSink;
  try{for(const c of stdin.chunks){sink.write(c);await sink.flush();await Bun.sleep(300);}if(!stdin.keepOpen)await sink.end();}catch{}
 })();
 return proc;
}
const line=(o:unknown)=>JSON.stringify(o)+'\n';

test('start: the service takes the key from its standard input, refuses the organiser API without it, never prints it; participants unaffected',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'attendance-bearer-'));const [port,participantPort]=freePorts(2);const local=`http://127.0.0.1:${port}`;
 writeFileSync(join(dir,'service.json'),JSON.stringify({origin:local,users:{}}));
 const k=key();
 // The participant listener as the desktop app runs it here: a private socket (macOS), or TCP with a pinned certificate
 // whose key and certificate join the organiser key on standard input (Windows).
 const participant=participantTransport(dir,participantPort);
 const proc=spawn(dir,{ATTENDANCE_SECRETS:'stdin',ATTENDANCE_PARTICIPANT_ORIGIN:'https://origin.example.net',...participant.env},line({organiserToken:k,...participant.secrets}));
 let out='';
 try{
  const reader=proc.stdout.getReader();
  while(!out.includes('Names-only participant listener')){const {done,value}=await reader.read();if(done)throw new Error('Service exited: '+await new Response(proc.stderr).text());out+=new TextDecoder().decode(value);}
  reader.releaseLock();
  expect((await fetch(`${local}/api/check-in-window`)).status).toBe(401);
  expect((await fetch(`${local}/api/roster`,{headers:{Authorization:`Bearer ${key()}`}})).status).toBe(401);
  expect((await fetch(`${local}/api/check-in-window`,{headers:{Authorization:`Bearer ${k}`}})).status).toBe(200);
  expect(await participant.status('/api/participant-names','origin.example.net')).toBe(200);
  // The key is in no part of the process's environment or arguments that other programs can read.
  if(process.platform==='darwin'||process.platform==='linux'){
   const ps=Bun.spawnSync(['/bin/ps','eww','-p',String(proc.pid)],{env:{PATH:'/bin:/usr/bin'}});
   const listing=ps.stdout.toString();
   expect(listing).toContain('ATTENDANCE_SECRETS=stdin');
   expect(listing).not.toContain(k);
  }
 }finally{proc.kill();await proc.exited;}
 const err=await new Response(proc.stderr).text();
 expect(out+err).not.toContain(k);
 removeTempDir(dir);
},20000);

test('start: no, short, malformed or late keys refuse to start before any listener is bound; keys in the environment are refused',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'attendance-bearer-bad-'));const [port]=freePorts(1);
 writeFileSync(join(dir,'service.json'),JSON.stringify({origin:`http://127.0.0.1:${port}`,users:{}}));
 const k=key();
 const cases:[string,Record<string,string>,Input|undefined,RegExp][]=[
  ['no input',{ATTENDANCE_SECRETS:'stdin'},undefined,/received none/],
  ['empty input',{ATTENDANCE_SECRETS:'stdin'},'',/received none/],
  ['input never sent',{ATTENDANCE_SECRETS:'stdin'},'open',/received none/],
  ['short key',{ATTENDANCE_SECRETS:'stdin'},line({organiserToken:'too-short'}),/organiser key/],
  ['padded key',{ATTENDANCE_SECRETS:'stdin'},line({organiserToken:`${k}=`}),/organiser key/],
  ['no key',{ATTENDANCE_SECRETS:'stdin'},line({}),/organiser key/],
  ['not JSON',{ATTENDANCE_SECRETS:'stdin'},`organiserToken=${k}\n`,/not one JSON object/],
  ['a JSON array',{ATTENDANCE_SECRETS:'stdin'},line([k]),/not one JSON object/],
  ['unknown entry',{ATTENDANCE_SECRETS:'stdin'},line({organiserToken:k,extra:k}),/unknown entry/],
  ['certificate without a TCP participant listener',{ATTENDANCE_SECRETS:'stdin'},line({organiserToken:k,tlsKey:'QUJD',tlsCert:'QUJD'}),/participant certificate/],
  ['key in the environment',{ATTENDANCE_ORGANISER_TOKEN:k},undefined,/no longer read from the environment/],
  ['key in the environment beside stdin',{ATTENDANCE_SECRETS:'stdin',ATTENDANCE_ORGANISER_TOKEN:k},line({organiserToken:k}),/no longer read from the environment/],
  ['unknown secrets mode',{ATTENDANCE_SECRETS:'env'},undefined,/must be stdin/],
  // The 32 KB limit counts bytes before a newline is accepted: a valid key padded past it, newline included, is refused.
  ['a line over 32 KB',{ATTENDANCE_SECRETS:'stdin'},JSON.stringify({organiserToken:k}).padEnd(40065,' ')+'\n',/too long/],
  ['input that ends before its newline',{ATTENDANCE_SECRETS:'stdin'},JSON.stringify({organiserToken:k}),/did not end with a new line/],
  ['more than one line',{ATTENDANCE_SECRETS:'stdin'},line({organiserToken:k})+line({organiserToken:k}),/one line/],
  // The line, then more input in a later chunk: refused, whatever the later chunk holds.
  ['a second line in a later chunk',{ATTENDANCE_SECRETS:'stdin'},{chunks:[line({organiserToken:k}),line({organiserToken:k})]},/one line/],
  ['one byte in a later chunk',{ATTENDANCE_SECRETS:'stdin'},{chunks:[line({organiserToken:k}),' ']},/one line/],
  // The line, then a pipe that is never closed: the end of input must follow within the same 5 seconds.
  ['input left open after the line',{ATTENDANCE_SECRETS:'stdin'},{chunks:[line({organiserToken:k})],keepOpen:true},/stayed open/],
 ];
 try{
  for(const [what,env,stdin,why] of cases){
   const started=Date.now();
   const proc=spawn(dir,env,stdin);
   const t=setTimeout(()=>proc.kill(),15000);const code=await proc.exited;clearTimeout(t);
   const out=await new Response(proc.stdout).text(),err=await new Response(proc.stderr).text();
   expect([what,code===0]).toEqual([what,false]);
   expect([what,why.test(err)]).toEqual([what,true]);
   expect([what,out.includes('listening')]).toEqual([what,false]);
   expect([what,(out+err).includes(k)||(out+err).includes('too-short')]).toEqual([what,false]);
   if(stdin==='open'||typeof stdin==='object'&&stdin.keepOpen)expect(Date.now()-started).toBeLessThan(12000);
  }
 }finally{removeTempDir(dir);}
},120000);
