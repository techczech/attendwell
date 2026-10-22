// The real register (server/start-attendance.ts under Bun, started through a stand-in for the sidecar) under the real service
// supervisor and process host, on the TCP path with a pinned certificate. Its secrets (organiser key, participant key and
// certificate) reach it on standard input only: none is in the environment `ps eww` shows for the running process, and the
// organiser bearer and the certificate pin still work. Fictional data only; nothing leaves 127.0.0.1. POSIX only (ps).
import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,chmodSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ServiceSupervisor,type ServiceLaunch} from '../runtime/service-supervisor.ts';
import {createWorkshopsLibrary} from '../runtime/workshops-library.ts';
import {nodeProcessHost,freeLoopbackPort,loopbackStatus,type ProcessHost,type SpawnRequest} from '../runtime/process-control.ts';
import {createParticipantTls,pinnedStatus,type ParticipantTls} from '../runtime/participant-tls.ts';

const entry=path.resolve(import.meta.dir,'../../server/start-attendance.ts');
const ORIGIN='https://gentle-example-river-test.trycloudflare.com';
const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});

test.skipIf(process.platform==='win32')('real register: secrets on standard input only; bearer and pin work; ps eww shows none of them',async()=>{
 const dataRoot=mkdtempSync(path.join(tmpdir(),'aw-secrets-'));dirs.push(dataRoot);
 // The stand-in sidecar replaces itself with Bun running the service, so the supervisor's child PID is the service.
 const sidecar=path.join(dataRoot,'attendwell-service');
 writeFileSync(sidecar,`#!/bin/sh\nexec "${process.execPath}" "${entry}"\n`);chmodSync(sidecar,0o700);
 const lib=createWorkshopsLibrary({dataRoot,countAttended:()=>0});
 const w=lib.create({title:'Fictional Secrets Lab',date:'2031-03-04'});
 const organiserPort=await freeLoopbackPort();let participantPort=await freeLoopbackPort();
 while(participantPort===organiserPort)participantPort=await freeLoopbackPort();
 const launch:ServiceLaunch={paths:lib.prepareService(w.id,organiserPort),organiserPort,participantPort,participantOrigin:ORIGIN,hostSecretPath:lib.hostSecretPath()};
 const spawned:SpawnRequest[]=[];const made:ParticipantTls[]=[];
 const host:ProcessHost={...nodeProcessHost,spawn:req=>{spawned.push(req);return nodeProcessHost.spawn(req);}};
 const lines:string[]=[];
 const sup=new ServiceSupervisor({host,sidecar,assets:path.resolve(import.meta.dir,'../../dist'),runDir:path.join(dataRoot,'run'),log:l=>lines.push(l),socketDir:()=>null,participantTls:()=>{const t=createParticipantTls();made.push(t);return t;}});
 try{
  await sup.start(launch);
  const bearer=sup.organiserBearer!;
  expect(bearer).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const tls=made[0];
  const secrets=[bearer,tls.key.toString('base64'),tls.cert.toString('base64')];
  // What the process host was asked to start: secrets on standard input, none in the environment or arguments.
  expect(JSON.parse(spawned[0].input!)).toEqual({organiserToken:bearer,tlsKey:secrets[1],tlsCert:secrets[2]});
  for(const v of secrets)expect(JSON.stringify([spawned[0].env,spawned[0].args])).not.toContain(v.slice(0,40));
  // What the system shows other programs of this account about the running register.
  const pid=sup.pid!;
  const listing=execFileSync('/bin/ps',['eww','-p',String(pid)],{encoding:'utf8',env:{PATH:'/bin:/usr/bin'}});
  expect(listing).toContain('ATTENDANCE_SECRETS=stdin');
  expect(listing).toContain(`ATTENDANCE_LISTEN_PORT=${organiserPort}`);
  for(const v of secrets)expect(listing).not.toContain(v.slice(0,40));
  // The organiser bearer works, and nothing works without it.
  const host127=`127.0.0.1:${organiserPort}`;
  expect(await loopbackStatus(organiserPort,'/api/check-in-window',host127,2000,bearer)).toBe(200);
  expect(await loopbackStatus(organiserPort,'/api/check-in-window',host127,2000)).toBe(401);
  // The participant listener serves HTTPS with the certificate it was given: the pin reaches it, another pin does not.
  const target={port:participantPort,fingerprint:tls.fingerprint};
  expect(await pinnedStatus(target,'/api/participant-names',new URL(ORIGIN).host)).toBe(200);
  expect(await pinnedStatus({...target,fingerprint:createParticipantTls().fingerprint},'/api/participant-names',new URL(ORIGIN).host)).toBe(0);
  expect(lines.join('\n')).not.toContain(bearer);
 }finally{expect((await sup.stop()).stopped).toBe(true);}
},30000);
