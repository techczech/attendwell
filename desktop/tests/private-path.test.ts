import {test,expect,afterEach} from 'bun:test';
import path from 'node:path';
import {mkdtempSync,rmSync,mkdirSync,symlinkSync,writeFileSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {isInside,assertPrivateDir,assertPrivatePaths,assertContained,windowsAclProblem,parseSddl,parseSddlAces,PrivatePathError,chmodNoFollow,writeNewPrivateFile,powershellAclBatchProbe,icaclsProtect} from '../../server/private-path.ts';
import {execFileSync} from 'node:child_process';
import {statSync,chmodSync,readFileSync} from 'node:fs';

const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});

const USER='S-1-5-21-1111111111-2222222222-3333333333-1001';
// Get-Acl Sddl of a folder under %APPDATA% on a default Windows 11 install (SIDs fictional).
const APPDATA=`O:${USER}G:${USER}D:(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER})`;

test('isInside: POSIX paths use path.relative, not a string prefix',()=>{
 const p=path.posix;
 expect(isInside('/apps/check-in','/apps/check-in/db/a.sqlite',p)).toBe(true);
 expect(isInside('/apps/check-in','/apps/check-in',p)).toBe(true);
 expect(isInside('/apps/check-in','/apps/check-in-private/db.sqlite',p)).toBe(false);
 expect(isInside('/apps/check-in','/apps/check-in/../outside/db.sqlite',p)).toBe(false);
 expect(isInside('/apps/check-in','/home/u/private/service.json',p)).toBe(false);
});

test('isInside: Windows paths handle backslashes, drive-letter case and other drives',()=>{
 const w=path.win32;
 expect(isInside('C:\\Program Files\\AttendWell','C:\\Program Files\\AttendWell\\resources\\db.sqlite',w)).toBe(true);
 expect(isInside('C:\\Program Files\\AttendWell','c:\\program files\\attendwell\\db.sqlite',w)).toBe(true);
 expect(isInside('C:\\Program Files\\AttendWell','C:\\Program Files\\AttendWell-data\\db.sqlite',w)).toBe(false);
 expect(isInside('C:\\Program Files\\AttendWell','D:\\AttendWell\\db.sqlite',w)).toBe(false);
 expect(isInside('C:\\Program Files\\AttendWell','C:\\Users\\pat\\AppData\\Roaming\\AttendWell\\db.sqlite',w)).toBe(false);
});

test('POSIX: a directory with any group or other bit is refused; 700 passes',()=>{
 for(const mode of [0o40700,0o40500])expect(()=>assertPrivateDir('/d',{platform:'darwin',stat:()=>({mode})})).not.toThrow();
 for(const mode of [0o40750,0o40705,0o40777,0o40710])expect(()=>assertPrivateDir('/d',{platform:'linux',stat:()=>({mode})})).toThrow(PrivatePathError);
});

test('Windows: mode bits are ignored; the access list decides',()=>{
 // Windows reports synthetic 0o666/0o777 modes: they must not be consulted.
 const probe=(sddl:string)=>()=>({userSid:USER,sddl});
 expect(()=>assertPrivateDir('C:\\x',{platform:'win32',stat:()=>({mode:0o40777}),aclProbe:probe(APPDATA)})).not.toThrow();
 const everyone=APPDATA+'(A;OICI;0x1200a9;;;WD)';
 expect(()=>assertPrivateDir('C:\\x',{platform:'win32',aclProbe:probe(everyone)})).toThrow(/another account \(WD\)/);
 expect(()=>assertPrivateDir('C:\\x',{platform:'win32',aclProbe:probe(APPDATA.replace('D:','D:(A;OICI;FA;;;BU)'))})).toThrow(/BU/);
 expect(()=>assertPrivateDir('C:\\x',{platform:'win32',aclProbe:probe(APPDATA+'(A;;FA;;;S-1-5-21-9-9-9-1002)')})).toThrow(/another account/);
 // Never silently skipped: an unreadable list fails closed.
 expect(()=>assertPrivateDir('C:\\x',{platform:'win32',aclProbe:()=>{throw new Error('powershell missing')}})).toThrow(/access control list/);
 expect(()=>assertPrivateDir('C:\\x',{platform:'win32',aclProbe:()=>({userSid:USER,sddl:''})})).toThrow(PrivatePathError);
});

test('Windows ACL rules: owner, null DACL, deny entries and trusted system accounts',()=>{
 expect(windowsAclProblem(APPDATA,USER)).toBeNull();
 expect(windowsAclProblem(APPDATA.replace(`O:${USER}`,'O:BA'),USER)).toBeNull();
 expect(windowsAclProblem(APPDATA.replace(`O:${USER}`,'O:S-1-5-21-9-9-9-1002'),USER)).toMatch(/owned by another account/);
 expect(windowsAclProblem(`O:${USER}G:${USER}D:NO_ACCESS_CONTROL`,USER)).toMatch(/no access control list/);
 expect(windowsAclProblem(APPDATA+'(D;OICI;FA;;;WD)',USER)).toBeNull(); // a deny entry only narrows access
 expect(windowsAclProblem(APPDATA,'not-a-sid')).toMatch(/current Windows user/);
 expect(parseSddlAces(APPDATA)?.map(a=>a.sid)).toEqual(['SY','BA',USER]);
});

test('Windows ACL rules: the built-in Administrator account is written LA, and only the probe\'s alias counts as the user',()=>{
 // Recorded on a GitHub Windows runner (account runneradmin, RID 500): the temporary folder's list names the user as LA.
 const admin='S-1-5-21-4239583824-265399229-1323058055-500';
 const recorded='O:BAG:S-1-5-21-4239583824-265399229-1323058055-513D:(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;LA)';
 expect(windowsAclProblem(recorded,admin)).toMatch(/another account \(LA\)/); // without the alias: refused, as before
 expect(windowsAclProblem(recorded,admin,{userAlias:'LA'})).toBeNull();
 expect(windowsAclProblem(recorded.replace('O:BA','O:LA'),admin,{userAlias:'LA'})).toBeNull();
 // The alias stands for the user only: any other account is still refused, and an alias that is not one is ignored.
 expect(windowsAclProblem(recorded+'(A;;FR;;;LG)',admin,{userAlias:'LA'})).toMatch(/another account \(LG\)/);
 expect(windowsAclProblem(recorded+'(A;;FR;;;WD)',admin,{userAlias:'LA'})).toMatch(/another account \(WD\)/);
 expect(windowsAclProblem(recorded,admin,{userAlias:'la'})).toMatch(/another account \(LA\)/);
 expect(windowsAclProblem(recorded.replace('O:BA','O:LG'),admin,{userAlias:'LA'})).toMatch(/owned by another account/);
 // Through the folder and batch checks, as the service and the desktop runtime call them.
 expect(()=>assertPrivateDir('C:\\x',{platform:'win32',aclProbe:()=>({userSid:admin,sddl:recorded,userAlias:'LA'})})).not.toThrow();
 expect(()=>assertPrivateDir('C:\\x',{platform:'win32',aclProbe:()=>({userSid:admin,sddl:recorded})})).toThrow(/another account \(LA\)/);
});

test('Windows DACL flags in any order: null DACL and unrecognised syntax fail closed',()=>{
 const aces=`(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER})`;
 const O=`O:${USER}G:${USER}`;
 // [SDDL, problem pattern or null when private]
 const table:[string,RegExp|null][]=[
  [`${O}D:${aces}`,null],
  [`${O}D:P${aces}`,null],
  [`${O}D:PAI${aces}`,null],
  [`${O}D:AIP${aces}`,null],
  [`${O}D:PARAI${aces}`,null],
  [`${O}D:NO_ACCESS_CONTROL`,/no access control list/],
  [`${O}D:PNO_ACCESS_CONTROL`,/no access control list/],
  [`${O}D:AINO_ACCESS_CONTROL`,/no access control list/],
  [`${O}D:PAINO_ACCESS_CONTROL`,/no access control list/],
  [`${O}D:NO_ACCESS_CONTROLP`,/no access control list/],
  [`${O}D:PAIS:(AU;SA;FA;;;WD)`,null], // empty DACL (no entries) grants nothing; a SACL may follow
  [`${O}`,/no access control list/],    // no DACL section at all
  [`${O}D:QQ${aces}`,/Could not read/],
  [`${O}D:P${aces}junk`,/Could not read/],
  [`${O}D:(A;OICI;FA;;;SY`,/Could not read/],
  [`${O}D:(A;OICI;FA)`,/Could not read/],
  [`${O}D:P${aces}AI`,/Could not read/], // flags only before the entries
  [`${O}D:(ZZ;OICI;FA;;;${USER})`,/does not recognise/],
  [`${O}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;WD)`,/another account \(WD\)/],
  [`${O}D:P(D;OICI;FA;;;WD)${aces}`,null],
  [`O:${USER}D:${aces}O:BA`,/Could not read/], // a repeated section
  [`X:${aces}`,/Could not read/],
 ];
 for(const [sddl,problem] of table){
  const got=windowsAclProblem(sddl,USER);
  if(problem===null)expect([sddl,got]).toEqual([sddl,null]);
  else expect([sddl,got??'']).toEqual([sddl,expect.stringMatching(problem)]);
 }
 expect(parseSddl(`${O}D:PAI${aces}`)?.dacl?.flags).toEqual(['P','AI']);
 expect(parseSddlAces(`${O}D:PAINO_ACCESS_CONTROL`)).toBeNull();
 // requireProtected: a workshop folder must not inherit from above.
 expect(windowsAclProblem(`${O}D:AI${aces}`,USER,{requireProtected:true})).toMatch(/inherits/);
 expect(windowsAclProblem(`${O}D:PAI${aces}`,USER,{requireProtected:true})).toBeNull();
});

test('containment: no link anywhere from the root down; canonical path must match; missing parts are allowed',()=>{
 const base=mkdtempSync(path.join(tmpdir(),'attendwell-pp-'));dirs.push(base);
 const root=path.join(base,'data');mkdirSync(path.join(root,'workshops','w1','db'),{recursive:true});
 const outside=path.join(base,'outside');mkdirSync(outside);writeFileSync(path.join(outside,'attendance.sqlite'),'');
 const db=path.join(root,'workshops','w1','db','attendance.sqlite');
 expect(()=>assertContained(root,db)).not.toThrow(); // file not created yet
 writeFileSync(db,'');
 expect(()=>assertContained(root,db)).not.toThrow();
 expect(()=>assertContained(root,path.join(base,'elsewhere.sqlite'))).toThrow(/outside/);
 expect(()=>assertContained(root,path.join(root,'..','outside','attendance.sqlite'))).toThrow(/outside/);
 // A link as the file, as a folder on the way, or as the root itself.
 rmSync(db);symlinkSync(path.join(outside,'attendance.sqlite'),db);
 expect(()=>assertContained(root,db)).toThrow(/is a link/);
 expect(()=>assertContained(root,db+'-wal')).not.toThrow();
 rmSync(db);
 const w2=path.join(root,'workshops','w2');symlinkSync(outside,w2);
 expect(()=>assertContained(root,path.join(w2,'attendance.sqlite'))).toThrow(/is a link/);
 const linkedRoot=path.join(base,'linked-data');symlinkSync(root,linkedRoot);
 expect(()=>assertContained(linkedRoot,path.join(linkedRoot,'workshops'))).toThrow(/is a link/);
 // Canonical mismatch without a symlink (as a junction or other reparse point would give): realpath decides.
 expect(()=>assertContained(root,path.join(root,'workshops'),{realpath:p=>p.endsWith('workshops')?outside:p})).toThrow(/somewhere else/);
 // Windows: the same rule with lstat reporting a junction as a link.
 expect(()=>assertContained('C:\\Data','C:\\Data\\workshops\\w1',{platform:'win32',lstat:(p=>({isSymbolicLink:()=>p.endsWith('w1')}) as never),realpath:p=>p})).toThrow(/is a link/);
});

// Permission bits mean nothing on Windows; there the same files are checked through their access lists (the next test and
// the real probe test below).
test.skipIf(process.platform==='win32')('private files: POSIX modes of the register and its journal files; hard links and links refused',()=>{
 const base=mkdtempSync(path.join(tmpdir(),'attendwell-pp-'));dirs.push(base);
 const db=path.join(base,'attendance.sqlite');
 writeFileSync(db,'',{mode:0o600});writeFileSync(db+'-wal','',{mode:0o644});
 expect(()=>assertPrivatePaths([{path:db,kind:'file'}],{platform:'darwin'})).not.toThrow();
 expect(()=>assertPrivatePaths([{path:db,kind:'file'},{path:db+'-wal',kind:'file'}],{platform:'darwin'})).toThrow(/other accounts/);
 const hard=path.join(base,'hard.sqlite');linkSync(db,hard);
 expect(()=>assertPrivatePaths([{path:db,kind:'file'}],{platform:'darwin'})).toThrow(/plain file/);
 rmSync(hard);
 const soft=path.join(base,'soft.sqlite');symlinkSync(db,soft);
 expect(()=>assertPrivatePaths([{path:soft,kind:'file'}],{platform:'darwin'})).toThrow(/is a link/);
});

test('private files on Windows: a journal file whose list grants another account, a hard link and a link are refused',()=>{
 const base=mkdtempSync(path.join(tmpdir(),'attendwell-pp-'));dirs.push(base);
 const db=path.join(base,'attendance.sqlite');
 writeFileSync(db,'');writeFileSync(db+'-wal','');
 const aclBatchProbe=(targets:string[])=>({userSid:USER,sddl:new Map(targets.map(t=>[t,t.endsWith('-wal')?APPDATA+'(A;;FR;;;WD)':APPDATA] as [string,string]))});
 expect(()=>assertPrivatePaths([{path:db,kind:'file'}],{platform:'win32',aclBatchProbe})).not.toThrow();
 expect(()=>assertPrivatePaths([{path:db,kind:'file'},{path:db+'-wal',kind:'file'}],{platform:'win32',aclBatchProbe})).toThrow(/another account/);
 const hard=path.join(base,'hard.sqlite');linkSync(db,hard);
 expect(()=>assertPrivatePaths([{path:db,kind:'file'}],{platform:'win32',aclBatchProbe})).toThrow(/plain file/);
 rmSync(hard);
 const soft=path.join(base,'soft.sqlite');symlinkSync(db,soft);
 expect(()=>assertPrivatePaths([{path:soft,kind:'file'}],{platform:'win32',aclBatchProbe})).toThrow(/is a link/);
});

// The real probe (Windows PowerShell through .NET) and icacls on this computer's temporary folder.
test.skipIf(process.platform!=='win32')('Windows: the real probe reads private lists, sees a grant to Everyone, and icacls protection reads back protected',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'attendwell-pp-'));dirs.push(dir);
 const file=path.join(dir,'attendance.sqlite');writeFileSync(file,'');
 const r=powershellAclBatchProbe([dir,file]);
 expect(r.userSid).toMatch(/^S-1-5-21-/);
 // The built-in Administrator (RID 500, the GitHub runner's account) is written LA in SDDL; the probe reports that alias.
 expect(r.userAlias).toBe(r.userSid.endsWith('-500')?'LA':undefined);
 const userAlias=r.userAlias;
 for(const t of [dir,file]){const sddl=r.sddl.get(t)??'';expect([t,sddl,windowsAclProblem(sddl,r.userSid,{userAlias})]).toEqual([t,sddl,null]);}
 execFileSync('icacls.exe',[file,'/grant','*S-1-1-0:(R)'],{stdio:'ignore',windowsHide:true});
 expect(windowsAclProblem(powershellAclBatchProbe([file]).sddl.get(file)??'',r.userSid,{userAlias})).toMatch(/another account \(WD\)/);
 icaclsProtect(dir,r.userSid);
 const own=powershellAclBatchProbe([dir]).sddl.get(dir)??'';
 expect([own,windowsAclProblem(own,r.userSid,{requireProtected:true,userAlias})]).toEqual([own,null]);
 expect(()=>assertPrivatePaths([{path:dir,kind:'dir',requireProtected:true}])).not.toThrow();
},60000);

test.skipIf(process.platform==='win32')('chmodNoFollow and writeNewPrivateFile: never through a link, permissions set on the descriptor',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'attendwell-pp-'));dirs.push(dir);
 const outside=path.join(dir,'outside');writeFileSync(outside,'x');chmodSync(outside,0o644);
 const mode=(p:string)=>statSync(p).mode&0o777;
 const untouched=()=>expect([mode(outside),readFileSync(outside,'utf8')]).toEqual([0o644,'x']);
 // A link already in place: refused.
 const link=path.join(dir,'link');symlinkSync(outside,link);
 expect(()=>chmodNoFollow(link,0o600,'file')).toThrow();
 expect(()=>writeNewPrivateFile(link,'secret')).toThrow();
 untouched();
 // A link raced in after the open, immediately before the chmod: the opened file changes, the link's target does not.
 const swap={beforeChmod:(t:string)=>{rmSync(t);symlinkSync(outside,t);}};
 const existing=path.join(dir,'existing');writeFileSync(existing,'mine');chmodSync(existing,0o644);
 chmodNoFollow(existing,0o600,'file',{hooks:swap});
 untouched();
 writeNewPrivateFile(path.join(dir,'fresh'),'secret',{hooks:swap});
 untouched();
 // A folder: a file is refused, a real folder gets its mode.
 const sub=path.join(dir,'sub');mkdirSync(sub,{mode:0o755});
 expect(()=>chmodNoFollow(outside,0o700,'dir')).toThrow();
 chmodNoFollow(sub,0o700,'dir');expect(mode(sub)).toBe(0o700);
});
