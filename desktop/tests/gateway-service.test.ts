import {test,expect} from 'bun:test';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createParticipantGateway} from '../runtime/participant-gateway.ts';
import {freeLoopbackPort} from '../runtime/process-control.ts';
import {serviceTestEnv,participantTransport} from '../../tests/service-spawn.ts';

// The real register service (server/start-attendance.ts, as the sidecar runs it) behind the real participant gateway, on
// this platform's path: a Unix socket in a private folder (macOS), or loopback TCP with a pinned certificate (Windows). The device routes reach the service through the gateway; the organiser
// routes, the name list and the organiser device routes never do. Fictional data only; nothing leaves 127.0.0.1.
const entry=path.resolve(import.meta.dir,'../../server/start-attendance.ts');
const workshopPath=path.resolve(import.meta.dir,'../../examples/workshop.example.json');
const PUBLIC='https://gentle-example-river-test.trycloudflare.com';

function viaGateway(port:number,method:string,p:string,body?:unknown,extra:Record<string,string>={}):Promise<{status:number;body:string}>{
 return new Promise(resolve=>{
  const data=body===undefined?undefined:JSON.stringify(body);
  const req=http.request({host:'127.0.0.1',port,path:p,method,agent:false,headers:{Host:new URL(PUBLIC).host,Connection:'close',...(data?{'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(data))}:{}),...extra}},res=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>resolve({status:res.statusCode??0,body:b}));});
  req.on('error',()=>resolve({status:0,body:''}));if(data)req.write(data);req.end();
 });
}

test('through the gateway: device routes and /pair reach the service; organiser routes, /api/names and /api/organiser/* never do',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'aw-gw-svc-'));
 const port=await freeLoopbackPort();const local=`http://127.0.0.1:${port}`;
 let participantPort=await freeLoopbackPort();while(participantPort===port)participantPort=await freeLoopbackPort();
 const participant=participantTransport(dir,participantPort);
 writeFileSync(path.join(dir,'service.json'),JSON.stringify({origin:local,users:{}}));
 const bearer=randomBytes(32).toString('base64url');
 const proc=Bun.spawn(['bun',entry],{env:serviceTestEnv({ATTENDANCE_CONFIG_PATH:path.join(dir,'service.json'),ATTENDANCE_DATABASE_PATH:path.join(dir,'db','attendance.sqlite'),
  ATTENDANCE_WORKSHOP_PATH:workshopPath,ATTENDANCE_PARTICIPANT_ORIGIN:PUBLIC,...participant.env,ATTENDANCE_SECRETS:'stdin',ATTENDANCE_BIND:'127.0.0.1',ATTENDANCE_LISTEN_PORT:String(port)}),stdin:new Blob([JSON.stringify({organiserToken:bearer,...participant.secrets})+'\n']),stdout:'pipe',stderr:'pipe'});
 const g=createParticipantGateway({upstreamTimeoutMs:3000});
 try{
  const reader=proc.stdout.getReader();let out='';
  while(!out.includes('Names-only participant listener')){const {done,value}=await reader.read();if(done)throw new Error('Service exited: '+await new Response(proc.stderr).text());out+=new TextDecoder().decode(value);}
  reader.releaseLock();
  const gw=await g.start();g.setUpstream(participant.upstream);
  const org=(method:string,p:string,body?:unknown)=>fetch(local+p,{method,headers:{Authorization:`Bearer ${bearer}`,...(method==='GET'?{}:{Origin:local,'Content-Type':'application/json','X-Attendance-Request':'1'})},body:body===undefined?undefined:JSON.stringify(body)});
  for(const name of ['Imogen Pryce','Lars Eriksson'])expect((await org('POST','/api/add-participant',{name})).status).toBe(200);
  const offer=await (await org('POST','/api/organiser/pairing-sessions',{label:'Front desk'})).json() as {shortCode:string};
  // Participant and device routes pass, and the service answers them.
  expect((await viaGateway(gw,'GET','/api/participant-names')).status).toBe(200);
  const pair=await viaGateway(gw,'GET','/pair');
  expect(pair.status).toBe(200);expect(pair.body).toContain('Pair an iPad');
  const hello=await viaGateway(gw,'POST','/device/v1/hello',{code:offer.shortCode},{'X-Attendance-Device-Protocol':'1'});
  expect(hello.status).toBe(200);
  expect(JSON.parse(hello.body)).toMatchObject({eventName:expect.any(String),deviceLabel:'Front desk'});
  // A device route without its protocol header is the service's own refusal (400), not the gateway's.
  expect((await viaGateway(gw,'GET','/device/v1/roster')).status).toBe(400);
  // Organiser routes never pass, with or without the organiser key.
  for(const [m,p] of [['GET','/api/roster'],['POST','/api/names'],['GET','/api/organiser/devices'],['POST','/api/organiser/pairing-sessions'],['POST','/api/organiser/recovery-import'],['GET','/api/check-in-window'],['POST','/api/add-participant'],['POST','/api/attendance']] as const){
   for(const extra of [{},{Authorization:`Bearer ${bearer}`}] as Record<string,string>[]){
    const r=await viaGateway(gw,m,p,m==='POST'?{}:undefined,extra);
    expect([m,p,r.status]).toEqual([m,p,404]);
   }
  }
 }finally{await g.close();proc.kill();await proc.exited;rmSync(dir,{recursive:true,force:true});}
},20000);
