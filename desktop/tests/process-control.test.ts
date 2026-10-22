import {test,expect,afterEach} from 'bun:test';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,existsSync,mkdirSync,symlinkSync,chmodSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {nodeProcessHost,parseLstart,killOrphan,reconcileOrphans,PidFile,START_TOLERANCE_MS,isExpectedExecutable} from '../runtime/process-control.ts';
import {fakeHost,simulatedAcl,SIM_WINDOWS} from './fakes.ts';

const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});

test('ps lstart (C locale, UTC) is read exactly; anything else is unreadable',()=>{
 expect(parseLstart('Thu Oct 22 00:47:42 2026')).toBe(Date.parse('2026-10-22T00:47:42Z'));
 expect(parseLstart('Sat Mar  4 09:05:00 2031')).toBe(Date.parse('2031-03-04T09:05:00Z'));
 for(const bad of ['','22 Oct 2026','jeu 22 oct 00:47:42 2026','Thu Okt 22 00:47:42 2026'])expect(parseLstart(bad)).toBeNull();
});

test.skipIf(process.platform!=='darwin')('macOS: the real process host reads the executable the kernel runs (not argv[0]) and the start time',async()=>{
 // argv[0] claims to be AttendWell's register; the system must still say /bin/sleep.
 const child=spawn('/bin/sleep',['5'],{stdio:'ignore',argv0:'/Applications/AttendWell.app/Contents/Resources/sidecar/darwin-arm64/attendwell-service'});
 const spawnedAt=Date.now();
 try{
  const id=nodeProcessHost.identityOf(child.pid!);
  expect(id?.executable).toBe('/bin/sleep');
  expect(Math.abs((id?.startedAtMs??0)-spawnedAt)).toBeLessThan(START_TOLERANCE_MS);
  expect(nodeProcessHost.isAlive(child.pid!)).toBe(true);
 }finally{child.kill('SIGKILL');}
});

test('an orphan is killed only when both its executable and its start time match the pidfile',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'attendwell-pc-'));dirs.push(dir);
 const exe=path.join(dir,'attendwell-service');const at=Date.parse('2031-03-04T09:00:00Z');
 const host=fakeHost();
 const file=(pid:number)=>{const f=new PidFile(path.join(dir,`service-${pid}.pid`));f.write({pid,executable:exe,startedAt:new Date(at).toISOString()});return f;};
 const cases:[number,string|null,number|null,string,boolean][]=[
  // pid, executable the system reports, start time it reports, outcome, record kept
  [1,exe,at+2000,'killed',false],
  [2,exe,at+START_TOLERANCE_MS+1000,'unproven',true],
  [3,exe,null,'unproven',true],
  [4,null,at,'unproven',true],
  [5,'/usr/bin/other',at,'stale',false],
 ];
 for(const [pid,reported,start,outcome,kept] of cases){
  const f=file(pid);host.alive.add(pid);
  if(reported)host.exes.set(pid,reported);if(start!==null)host.starts.set(pid,start);
  expect([pid,await killOrphan(host,f,exe) as string,existsSync(f.file)]).toEqual([pid,outcome,kept]);
 }
 expect(host.signalled.map(([p])=>p)).toEqual([1]);
 // Not running any more: the record is dropped.
 const gone=file(6);
 expect(await killOrphan(host,gone,exe)).toBe('stale');
 expect(existsSync(gone.file)).toBe(false);
});

test('a planted pidfile naming another program is never signalled, even when its PID and start time are right',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'attendwell-pc-'));dirs.push(dir);
 const ours=path.join(dir,'attendwell-service');const at=Date.parse('2031-03-04T09:00:00Z');
 const host=fakeHost();
 const victim='/Applications/Other.app/Contents/MacOS/Other';
 const f=new PidFile(path.join(dir,'service-7.pid'));f.write({pid:7,executable:victim,startedAt:new Date(at).toISOString()});
 host.alive.add(7);host.exes.set(7,victim);host.starts.set(7,at);
 expect(await killOrphan(host,f,ours)).toBe('foreign');
 expect(host.signalled).toEqual([]);
 expect(existsSync(f.file)).toBe(false);
});

test('PID reuse between SIGTERM and SIGKILL: identity is checked again before the hard kill, so nothing else is killed',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'attendwell-pc-'));dirs.push(dir);
 const exe=path.join(dir,'attendwell-service');const at=Date.parse('2031-03-04T09:00:00Z');
 for(const [after,outcome] of [['reused','killed'],['unreadable','survived']] as const){
  const host=fakeHost();
  let clock=0;host.now=()=>clock;host.sleep=async ms=>{clock+=ms;}; // the grace period passes at once
  // SIGTERM is "ignored", and meanwhile the system hands the PID to something else (or stops answering).
  host.signal=(pid,sig)=>{host.signalled.push([pid,sig]);if(sig!=='SIGTERM')return;
   if(after==='reused')host.starts.set(pid,at+3600_000);else{host.exes.delete(pid);host.starts.delete(pid);}};
  const f=new PidFile(path.join(dir,'service-9.pid'));f.write({pid:9,executable:exe,startedAt:new Date(at).toISOString()});
  host.alive.add(9);host.exes.set(9,exe);host.starts.set(9,at);
  expect(await killOrphan(host,f,exe)).toBe(outcome);
  expect(host.signalled).toEqual([[9,'SIGTERM']]);
 }
});

// The Windows process host asks CIM through Windows PowerShell; it must work whatever module path the caller inherited.
test.skipIf(process.platform!=='win32')('Windows: the real process host reads the executable and the start time of a running process',async()=>{
 const child=spawn(process.execPath,['-e','setTimeout(()=>{},15000)'],{stdio:'ignore',windowsHide:true});
 const spawnedAt=Date.now();
 try{
  const id=nodeProcessHost.identityOf(child.pid!);
  expect([id?.executable,isExpectedExecutable(id?.executable??'',process.execPath,'win32')]).toEqual([id?.executable,true]);
  expect(Math.abs((id?.startedAtMs??0)-spawnedAt)).toBeLessThan(START_TOLERANCE_MS);
  expect(nodeProcessHost.isAlive(child.pid!)).toBe(true);
 }finally{child.kill();}
},30000);

// reconcileOrphans with a fake system that would confirm the planted record if it were ever read.
async function reconcileWith(setup:(o:{dataRoot:string;runDir:string;elsewhere:string})=>void){
 const base=mkdtempSync(path.join(tmpdir(),'attendwell-pc-'));dirs.push(base);
 const dataRoot=path.join(base,'data'),runDir=path.join(dataRoot,'run'),elsewhere=path.join(base,'elsewhere');
 mkdirSync(dataRoot,{mode:0o700});mkdirSync(elsewhere,{mode:0o700});
 const exe=path.join(base,'attendwell-service');const at=Date.parse('2031-03-04T09:00:00Z');
 new PidFile(path.join(elsewhere,'service-11.pid')).write({pid:11,executable:exe,startedAt:new Date(at).toISOString()});
 const host=fakeHost();host.alive.add(11);host.exes.set(11,exe);host.starts.set(11,at);
 setup({dataRoot,runDir,elsewhere});
 // On Windows the access lists come from the simulated probe (all private); macOS checks the real permission bits.
 const report=await reconcileOrphans(host,{dataRoot,runDir,...simulatedAcl(),executables:{service:exe,cloudflared:path.join(base,'cloudflared')}});
 return {report,host,planted:path.join(elsewhere,'service-11.pid')};
}
const copyRecord=(elsewhere:string,runDir:string)=>new PidFile(path.join(runDir,'service-11.pid')).write(new PidFile(path.join(elsewhere,'service-11.pid')).read()!);

test('a linked run folder is refused before any record in it is read; nothing is signalled',async()=>{
 const {report,host,planted}=await reconcileWith(({runDir,elsewhere})=>symlinkSync(elsewhere,runDir));
 expect(host.signalled).toEqual([]);
 expect(existsSync(planted)).toBe(true); // not read, not removed
 expect(report.unresolved.join(' ')).toMatch(/not a private folder inside its data folder\. Nothing was stopped/);
});

// POSIX permission bits; the Windows counterpart (a shared access list) is 'Windows: a run folder whose access list…' below.
test.skipIf(SIM_WINDOWS)('a run folder other accounts can read is refused; nothing is signalled',async()=>{
 const {report,host}=await reconcileWith(({runDir,elsewhere})=>{mkdirSync(runDir);copyRecord(elsewhere,runDir);chmodSync(runDir,0o755);});
 expect(host.signalled).toEqual([]);
 expect(report.unresolved).toHaveLength(1);
});

test('a linked pidfile in a good run folder is removed unread; its target is untouched',async()=>{
 const {report,host,planted}=await reconcileWith(({runDir,elsewhere})=>{mkdirSync(runDir,{mode:0o700});symlinkSync(path.join(elsewhere,'service-11.pid'),path.join(runDir,'service-11.pid'));});
 expect(host.signalled).toEqual([]);
 expect(existsSync(planted)).toBe(true);
 expect(report.ignored.join(' ')).toMatch(/service-11\.pid.*not a private plain file/);
});

test('a proven orphan in a private run folder is stopped',async()=>{
 const {report,host}=await reconcileWith(({runDir,elsewhere})=>{mkdirSync(runDir,{mode:0o700});copyRecord(elsewhere,runDir);writeFileSync(path.join(runDir,'notes.txt'),'not a record');});
 expect(host.signalled).toEqual([[11,'SIGTERM']]);
 expect(report.killed).toHaveLength(1);
});

// Windows: mode bits mean nothing, so each pidfile's access list is read (with the injected probe) before the record is.
const USER='S-1-5-21-1111-2222-3333-1001';
const PRIVATE_SDDL=`O:${USER}G:${USER}D:(A;;FA;;;${USER})(A;;FA;;;SY)(A;;FA;;;BA)`;
const SHARED_SDDL=`O:${USER}G:${USER}D:(A;;FA;;;${USER})(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1301bf;;;BU)`;
async function reconcileWindows(acl:(file:string)=>string|null,opts:{probeFails?:boolean;runDirAcl?:string}={}){
 const base=mkdtempSync(path.join(tmpdir(),'attendwell-pc-'));dirs.push(base);
 const dataRoot=path.join(base,'data'),runDir=path.join(dataRoot,'run');
 mkdirSync(dataRoot,{mode:0o700});mkdirSync(runDir,{mode:0o700});
 const exe=path.join(base,'attendwell-service');const at=Date.parse('2031-03-04T09:00:00Z');
 const host=fakeHost(()=>{},'win32');
 // Both records would be confirmed and signalled if they were ever read.
 for(const pid of [21,22]){new PidFile(path.join(runDir,`service-${pid}.pid`)).write({pid,executable:exe,startedAt:new Date(at).toISOString()});host.alive.add(pid);host.exes.set(pid,exe);host.starts.set(pid,at);}
 const asked:string[]=[];const looked:number[]=[];
 const isAlive=host.isAlive;host.isAlive=pid=>{looked.push(pid);return isAlive(pid);};
 const identityOf=host.identityOf;host.identityOf=pid=>{looked.push(pid);return identityOf(pid);};
 const aclBatchProbe=(targets:string[])=>{
  asked.push(...targets);
  if(opts.probeFails&&targets.some(t=>t.endsWith('.pid')))throw new Error('PowerShell unavailable');
  const sddl=new Map<string,string>();for(const t of targets){const v=t.endsWith('.pid')?acl(t):t===runDir&&opts.runDirAcl?opts.runDirAcl:PRIVATE_SDDL;if(v)sddl.set(t,v);}
  return {userSid:USER,sddl};
 };
 const report=await reconcileOrphans(host,{dataRoot,runDir,platform:'win32',aclBatchProbe,executables:{service:exe,cloudflared:path.join(base,'cloudflared')}});
 return {report,host,asked,looked,file:(pid:number)=>path.join(runDir,`service-${pid}.pid`)};
}

test('Windows: a pidfile other accounts can open is removed unread and nothing is signalled; a private one is resolved',async()=>{
 const {report,host,asked,looked,file}=await reconcileWindows(f=>f.endsWith('service-21.pid')?SHARED_SDDL:PRIVATE_SDDL);
 // One probe call covers both records, after the data and run folders.
 expect(asked.filter(t=>t.endsWith('.pid')).sort()).toEqual([file(21),file(22)]);
 expect(existsSync(file(21))).toBe(false);
 expect(looked).not.toContain(21);           // never read: its PID was never looked at
 expect(host.signalled).toEqual([[22,'SIGTERM']]);
 expect(report.ignored.join(' ')).toMatch(/service-21\.pid.*not a private plain file\. Nothing was stopped/);
 expect(report.killed).toHaveLength(1);
});

test('Windows: a pidfile whose access list cannot be read is removed unread; if no list can be read, none is read',async()=>{
 const a=await reconcileWindows(f=>f.endsWith('service-21.pid')?null:PRIVATE_SDDL);
 expect(existsSync(a.file(21))).toBe(false);
 expect(a.looked).not.toContain(21);
 expect(a.host.signalled).toEqual([[22,'SIGTERM']]);
 const b=await reconcileWindows(()=>PRIVATE_SDDL,{probeFails:true});
 expect(b.host.signalled).toEqual([]);
 expect(b.looked).toEqual([]);
 expect(existsSync(b.file(21))&&existsSync(b.file(22))).toBe(true); // kept for the next run
 expect(b.report.unresolved.join(' ')).toMatch(/could not check its process records/);
});

test('Windows: a run folder whose access list grants another account is refused before any record in it is read; nothing is signalled',async()=>{
 const {report,host,looked}=await reconcileWindows(()=>PRIVATE_SDDL,{runDirAcl:SHARED_SDDL});
 expect(host.signalled).toEqual([]);
 expect(looked).toEqual([]);
 expect(report.unresolved.join(' ')).toMatch(/not a private folder inside its data folder\. Nothing was stopped/);
});
