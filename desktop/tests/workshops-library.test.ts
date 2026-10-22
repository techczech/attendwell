import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,rmSync,statSync,readFileSync,symlinkSync,mkdirSync,writeFileSync,existsSync,chmodSync,renameSync,unlinkSync,rmdirSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createWorkshopsLibrary,LibraryError} from '../runtime/workshops-library.ts';
import {parseWorkshopConfig} from '../../server/workshop-config.ts';
import {simulatedAcl,SIM_PLATFORM,SIM_WINDOWS} from './fakes.ts';
// This computer's branch: POSIX permission bits on macOS; on Windows (or ATTENDWELL_SIMULATE_WINDOWS=1) the Windows branch
// with simulated access lists. The real Windows probe and icacls are exercised by the last test.
const sim=()=>({platform:SIM_PLATFORM,...simulatedAcl()});

const dirs:string[]=[];
const temp=()=>{const d=mkdtempSync(path.join(tmpdir(),'attendwell-lib-'));dirs.push(d);return d;};
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const mode=(p:string)=>statSync(p).mode&0o777;
// Removes a planted link, never its target. Bun on Windows refuses rmSync on a link to a folder (EFAULT); a folder link
// there is removed as a folder entry (rmdir removes the link, not what it points at).
const removeLink=(p:string)=>{try{unlinkSync(p)}catch(e){if(process.platform!=='win32')throw e;rmdirSync(p)}};
const now=()=>new Date(2031,2,4,10,0,0); // 4 March 2031, local time

// POSIX modes; the Windows counterpart is 'Windows branch: …' below.
test.skipIf(SIM_WINDOWS)('create writes a valid service workshop file and owner-only folders and files (POSIX)',()=>{
 const root=temp();
 const lib=createWorkshopsLibrary({dataRoot:path.join(root,'data'),now,countAttended:()=>null});
 const w=lib.create({title:'Spring Lab: Data Basics',date:'2031-03-04',startTime:'09:30',endTime:'12:00'});
 expect(w.id).toMatch(/^2031-03-04-spring-lab-data-basics-[a-f0-9]{6}$/);
 expect(parseWorkshopConfig(JSON.parse(readFileSync(w.paths.workshopFile,'utf8')))).toMatchObject({sessionId:w.id,title:'Spring Lab: Data Basics',startTime:'09:30',publicOrigin:null});
 for(const d of [path.join(root,'data'),lib.root,w.paths.dir,w.paths.dbDir])expect(mode(d)).toBe(0o700);
 for(const f of [w.paths.workshopFile,w.paths.metaFile])expect(mode(f)).toBe(0o600);
 const paths=lib.prepareService(w.id,45123);
 expect(JSON.parse(readFileSync(paths.serviceFile,'utf8'))).toEqual({origin:'http://127.0.0.1:45123',users:{}});
 expect(mode(paths.serviceFile)).toBe(0o600);
 expect(()=>lib.create({title:'',date:'2031-03-04'})).toThrow();
 expect(()=>lib.create({title:'Bad date',date:'2031-02-30'})).toThrow();
});

test('list sorts into upcoming, today, past and archived with attended counts; damaged folders are skipped',()=>{
 const counts=new Map<string,number|null>();
 const lib=createWorkshopsLibrary({dataRoot:temp(),now,countAttended:db=>counts.get(db)??null,...sim()});
 const past=lib.create({title:'Winter Lab',date:'2031-01-10'});
 const today=lib.create({title:'Spring Lab',date:'2031-03-04'});
 const later=lib.create({title:'Summer Lab',date:'2031-06-01'});
 const old=lib.create({title:'Old Lab',date:'2030-11-01'});
 counts.set(past.paths.database,12);
 lib.recordAttendedCount(today.id,7); // cached figure used when the register cannot be read
 lib.setArchived(old.id,true);
 mkdirSync(path.join(lib.root,'2031-01-01-broken-000000'),{mode:0o700}); // no workshop.json
 const l=lib.list();
 expect(l.upcoming.map(s=>s.id)).toEqual([later.id]);
 expect(l.today.map(s=>[s.id,s.attended])).toEqual([[today.id,7]]);
 expect(l.past.map(s=>[s.id,s.attended])).toEqual([[past.id,12]]);
 expect(l.archived.map(s=>s.id)).toEqual([old.id]);
 expect(lib.list({includeArchived:false}).archived).toEqual([]);
 expect(lib.setArchived(old.id,false).meta.archived).toBe(false);
});

test('ids cannot leave the library; linked folders are not followed',()=>{
 const root=temp();const lib=createWorkshopsLibrary({dataRoot:path.join(root,'data'),now,countAttended:()=>0,...sim()});
 for(const id of ['../x','..','a/b','A','', 'x'.repeat(81),'..\\x','/etc'])expect(()=>lib.get(id)).toThrow(LibraryError);
 const outside=path.join(root,'outside');mkdirSync(outside);writeFileSync(path.join(outside,'workshop.json'),JSON.stringify({sessionId:'x',title:'Planted',date:'2031-01-01'}));
 lib.list();symlinkSync(outside,path.join(lib.root,'2031-01-01-planted-000000'));
 expect(()=>lib.get('2031-01-01-planted-000000')).toThrow(LibraryError);
 expect(lib.list().past).toEqual([]);
});

// POSIX modes; on Windows a shared data root is refused instead ('Windows branch: …' below).
test.skipIf(SIM_WINDOWS)('POSIX: an existing data root that others can read is tightened to 700 before use',()=>{
 const root=temp();const data=path.join(root,'data');mkdirSync(data,{mode:0o755});
 createWorkshopsLibrary({dataRoot:data,now,countAttended:()=>0}).list();
 expect(mode(data)).toBe(0o700);
});

test('Windows branch: no chmod; the data root list is checked; each workshop folder gets a protected owner-only list',()=>{
 const USER='S-1-5-21-1-2-3-1001';
 const inherited=`O:${USER}D:(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER})`;
 const protectedList=`O:${USER}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER})`;
 const protectedDirs=new Set<string>();const probed:string[][]=[];
 const opts=(extra:object={})=>({platform:'win32' as const,now,countAttended:()=>0,
  aclBatchProbe:(targets:string[])=>{probed.push(targets);return {userSid:USER,sddl:new Map(targets.map(t=>[t,protectedDirs.has(t)?protectedList:inherited] as [string,string]))}},
  aclProtect:(dir:string,sid:string)=>{expect(sid).toBe(USER);protectedDirs.add(dir);},...extra});
 const lib=createWorkshopsLibrary({dataRoot:temp(),...opts()});
 const w=lib.create({title:'Windows Lab',date:'2031-03-04'});
 expect([...protectedDirs]).toEqual([w.paths.dir]);
 expect(probed[0]).toEqual([lib.dataRoot]);
 expect(existsSync(w.paths.workshopFile)).toBe(true);
 // The register and its journal files are checked before the service opens them.
 mkdirSync(w.paths.dbDir,{recursive:true});writeFileSync(w.paths.database,'');writeFileSync(w.paths.database+'-wal','');
 probed.length=0;lib.prepareService(w.id,45000);
 expect(probed.flat()).toEqual(expect.arrayContaining([w.paths.dir,w.paths.dbDir,w.paths.database,w.paths.database+'-wal']));
 // A workshop folder that lost its protected list (inherits from above) is refused, and skipped in the list.
 protectedDirs.clear();
 expect(()=>lib.get(w.id)).toThrow(/inherits/);
 expect(lib.list().today).toEqual([]);
 // A register file that grants another account is refused.
 protectedDirs.add(w.paths.dir);
 const sharedFile=createWorkshopsLibrary({dataRoot:lib.dataRoot,...opts({aclBatchProbe:(targets:string[])=>({userSid:USER,sddl:new Map(targets.map(t=>[t,protectedDirs.has(t)?protectedList:t.endsWith('-wal')?inherited+'(A;;FA;;;AU)':inherited] as [string,string]))})})});
 expect(()=>sharedFile.prepareService(w.id,45000)).toThrow(/another account/);
 // A shared data root is refused before anything is created.
 const shared=createWorkshopsLibrary({dataRoot:temp(),platform:'win32',now,countAttended:()=>0,aclProbe:()=>({userSid:USER,sddl:inherited+'(A;OICI;FA;;;AU)'}),aclProtect:()=>{throw new Error('not reached')}});
 expect(()=>shared.create({title:'Shared',date:'2031-03-04'})).toThrow(/private folder.*another account/);
 // Protection that cannot be applied fails closed.
 const failing=createWorkshopsLibrary({dataRoot:temp(),...opts({aclProtect:()=>{throw new Error('icacls failed')}})});
 expect(()=>failing.create({title:'No icacls',date:'2031-03-04'})).toThrow();
});

test('links anywhere on the storage path are refused before anything is opened or chmod-ed',()=>{
 const root=temp();const data=path.join(root,'data');
 const outside=path.join(root,'outside');mkdirSync(outside,{mode:0o755});
 const lib=createWorkshopsLibrary({dataRoot:data,now,countAttended:()=>0,...sim()});
 const w=lib.create({title:'Linked Lab',date:'2031-03-04'});
 // The register folder replaced by a link to a folder elsewhere.
 rmSync(w.paths.dbDir,{recursive:true});symlinkSync(outside,w.paths.dbDir);
 expect(()=>lib.prepareService(w.id,45000)).toThrow(LibraryError);
 expect(()=>lib.get(w.id)).toThrow(/link/);
 expect(lib.list().today).toEqual([]);
 if(!SIM_WINDOWS)expect(statSync(outside).mode&0o777).toBe(0o755); // never chmod-ed through the link
 // The register file itself a link.
 removeLink(w.paths.dbDir);mkdirSync(w.paths.dbDir,{mode:0o700});
 writeFileSync(path.join(outside,'attendance.sqlite'),'',{mode:0o644});symlinkSync(path.join(outside,'attendance.sqlite'),w.paths.database);
 expect(()=>lib.prepareService(w.id,45000)).toThrow(/link/);
 if(!SIM_WINDOWS)expect(statSync(path.join(outside,'attendance.sqlite')).mode&0o777).toBe(0o644);
 removeLink(w.paths.database);
 // A SQLite journal file others can read (POSIX bits; the Windows access-list case is in 'Windows branch: …').
 writeFileSync(w.paths.database,'',{mode:0o600});writeFileSync(w.paths.database+'-shm','',{mode:0o644});
 if(!SIM_WINDOWS){
  expect(()=>lib.prepareService(w.id,45000)).toThrow(/other accounts/);
  chmodSync(w.paths.database+'-shm',0o600);
 }
 expect(()=>lib.prepareService(w.id,45000)).not.toThrow();
 // The workshops folder, or the data root itself, replaced by a link.
 const real=path.join(root,'real-workshops');renameSync(lib.root,real);symlinkSync(real,lib.root);
 expect(()=>createWorkshopsLibrary({dataRoot:data,now,countAttended:()=>0,...sim()}).list()).toThrow(LibraryError);
 const linkedData=path.join(root,'linked-data');symlinkSync(data,linkedData);
 expect(()=>createWorkshopsLibrary({dataRoot:linkedData,now,countAttended:()=>0,...sim()}).list()).toThrow(/link/);
});

test('host secret: created once inside the data root, 32 bytes, owner-only; a link or damaged file is refused',()=>{
 const root=temp();const data=path.join(root,'data');
 const lib=createWorkshopsLibrary({dataRoot:data,now,countAttended:()=>0,...sim()});
 const file=lib.hostSecretPath();
 expect(file).toBe(path.join(data,'host-secret'));
 const first=readFileSync(file);
 expect(first.length).toBe(32);
 expect(createWorkshopsLibrary({dataRoot:data,now,countAttended:()=>0,...sim()}).hostSecretPath()).toBe(file);
 expect(readFileSync(file).equals(first)).toBe(true); // never regenerated
 if(!SIM_WINDOWS){ // POSIX bits; on Windows the file's access list is checked like the register's
  expect(mode(file)).toBe(0o600);
  chmodSync(file,0o644);
  expect(()=>lib.hostSecretPath()).toThrow(/other accounts/);
 }
 rmSync(file);writeFileSync(file,'short',{mode:0o600});
 expect(()=>lib.hostSecretPath()).toThrow(/damaged/);
 rmSync(file);const elsewhere=path.join(root,'planted');writeFileSync(elsewhere,Buffer.alloc(32),{mode:0o600});symlinkSync(elsewhere,file);
 expect(()=>lib.hostSecretPath()).toThrow(/link/);
});

// Junctions are Windows' other kind of folder link (no privilege needed to make one). Each place on the storage path where
// one could be planted is refused, and nothing is created in the folder it points at.
test.skipIf(process.platform!=='win32')('Windows: a junction anywhere on the storage path is refused like a link',()=>{
 const root=temp();const data=path.join(root,'data');
 const outside=path.join(root,'outside');mkdirSync(outside);
 const lib=createWorkshopsLibrary({dataRoot:data,now,countAttended:()=>0,...sim()});
 const w=lib.create({title:'Junction Lab',date:'2031-03-04'});
 // The register folder.
 rmSync(w.paths.dbDir,{recursive:true});symlinkSync(outside,w.paths.dbDir,'junction');
 expect(()=>lib.prepareService(w.id,45000)).toThrow(LibraryError);
 expect(()=>lib.get(w.id)).toThrow(LibraryError);
 expect(lib.list().today).toEqual([]);
 expect(readdirSync(outside)).toEqual([]);
 removeLink(w.paths.dbDir);
 // The workshop folder.
 const realWorkshop=path.join(root,'real-workshop');renameSync(w.paths.dir,realWorkshop);symlinkSync(realWorkshop,w.paths.dir,'junction');
 expect(()=>lib.get(w.id)).toThrow(LibraryError);
 expect(()=>lib.prepareService(w.id,45000)).toThrow(LibraryError);
 expect(lib.list().today).toEqual([]);
 removeLink(w.paths.dir);renameSync(realWorkshop,w.paths.dir);
 expect(lib.get(w.id).id).toBe(w.id); // back in place: accepted again
 // The workshops folder, and the data root itself.
 const realWorkshops=path.join(root,'real-workshops');renameSync(lib.root,realWorkshops);symlinkSync(realWorkshops,lib.root,'junction');
 expect(()=>createWorkshopsLibrary({dataRoot:data,now,countAttended:()=>0,...sim()}).list()).toThrow(LibraryError);
 // Remove the workshops-folder junction and restore the real folder, so the data-root junction is the only link on the path.
 removeLink(lib.root);renameSync(realWorkshops,lib.root);
 const junctionData=path.join(root,'junction-data');symlinkSync(data,junctionData,'junction');
 expect(()=>createWorkshopsLibrary({dataRoot:junctionData,now,countAttended:()=>0,...sim()}).list()).toThrow(LibraryError);
 expect(readdirSync(outside)).toEqual([]);
},30000);

// Deterministic interleaving: the hook swaps the path for a link to an outside file at the worst moment, immediately
// before permissions are set. They must land on the opened file, never on the link's target.
test.skipIf(SIM_WINDOWS)('host secret and library files: a link raced in before the chmod never changes the outside file',()=>{
 for(const which of ['host-secret','workshop.json'] as const){
  const root=temp();const data=path.join(root,'data');
  const outside=path.join(root,'outside.txt');writeFileSync(outside,'not AttendWell');chmodSync(outside,0o644);
  let swapped=false;
  const fsHooks={beforeChmod:(target:string)=>{
   if(swapped||!path.basename(target).startsWith(which))return;
   swapped=true;rmSync(target);symlinkSync(outside,target);
  }};
  const lib=createWorkshopsLibrary({dataRoot:data,now,countAttended:()=>0,fsHooks});
  if(which==='host-secret')expect(()=>lib.hostSecretPath()).toThrow();
  else expect(()=>lib.create({title:'Raced Lab',date:'2031-03-04'})).toThrow();
  expect(swapped).toBe(true);
  expect(mode(outside)).toBe(0o644);
  expect(readFileSync(outside,'utf8')).toBe('not AttendWell');
 }
});

// The real Windows branch on this computer: PowerShell reads the access lists, icacls protects each workshop folder.
test.skipIf(process.platform!=='win32')('Windows, real access lists: a library in the temporary folder creates, lists, prepares a register and a host secret',()=>{
 const lib=createWorkshopsLibrary({dataRoot:path.join(temp(),'data'),now,countAttended:()=>0});
 const w=lib.create({title:'Windows Lab',date:'2031-03-04'});
 expect(lib.list().today.map(s=>s.id)).toEqual([w.id]);
 mkdirSync(w.paths.dbDir,{recursive:true});writeFileSync(w.paths.database,'');
 expect(lib.prepareService(w.id,45000).database).toBe(w.paths.database);
 expect(readFileSync(lib.hostSecretPath()).length).toBe(32);
},120000);
