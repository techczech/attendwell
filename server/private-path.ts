// Private-folder rules shared by the service (start-attendance.ts, run by Bun) and the desktop runtime (run by Electron's Node).
// Node APIs only. Every platform branch is strict: POSIX checks permission bits; Windows checks the access control list.
// Storage paths are also checked for links: no symlink, junction or other reparse point between a data root and a file
// in it, and the canonical path must be the expected one, so a planted link cannot point the register elsewhere.
import path from 'node:path';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';

type PathApi=Pick<typeof path,'relative'|'isAbsolute'|'resolve'|'sep'>;

// True when `child` is `parent` itself or lies anywhere beneath it. Uses path.relative, so `/app-other` is not inside `/app`
// and, on Windows, `C:\App\db` is inside `c:\app` (path.win32.relative compares case-insensitively).
export function isInside(parent:string,child:string,api:PathApi=path):boolean{
 const rel=api.relative(api.resolve(parent),api.resolve(child));
 if(rel==='')return true;
 if(api.isAbsolute(rel))return false; // another drive on Windows
 return rel!=='..'&&!rel.startsWith('..'+api.sep);
}

export class PrivatePathError extends Error {}

// ---------------------------------------------------------------------------------------------------------------------
// Windows access control lists (SDDL from Get-Acl)

// SIDs that may hold Allow entries on a private folder or file. The per-user AppData folder grants exactly these by default.
const WINDOWS_TRUSTED=new Set(['SY','S-1-5-18','BA','S-1-5-32-544','OW','S-1-3-4','CO','S-1-3-0']);
const SID_RE=/^(S-1-\d+(?:-\d+)+|[A-Z]{2})/;
const DENY_TYPES=new Set(['D','OD','XD']);
// Every ACE type a DACL may hold. Anything else is unrecognised and fails closed.
const KNOWN_TYPES=new Set(['A','D','OA','OD','XA','XD','ZA']);
const DACL_FLAGS=['NO_ACCESS_CONTROL','AR','AI','P'];

export type SddlAce={type:string;flags:string;rights:string;sid:string};
export type ParsedSddl={owner:string|null;group:string|null;dacl:{flags:string[];aces:SddlAce[]}|null};

// Parses a full SDDL string: owner, group, DACL flags in any order (P, AI, AR, NO_ACCESS_CONTROL) and its entries.
// Returns null for anything it does not recognise, so callers fail closed. NO_ACCESS_CONTROL among the DACL flags means
// a null DACL. Exported for tests (recorded Get-Acl output).
export function parseSddl(sddl:string):ParsedSddl|null{
 const out:ParsedSddl={owner:null,group:null,dacl:null};
 const seen=new Set<string>();
 let i=0;
 while(i<sddl.length){
  const section=/^([OGDS]):/.exec(sddl.slice(i))?.[1];
  if(!section||seen.has(section))return null;
  seen.add(section);i+=2;
  if(section==='O'||section==='G'){
   const sid=SID_RE.exec(sddl.slice(i))?.[1];if(!sid)return null;
   if(section==='O')out.owner=sid;else out.group=sid;
   i+=sid.length;continue;
  }
  const flags:string[]=[];const aces:SddlAce[]=[];
  for(;;){
   const rest=sddl.slice(i);
   if(rest===''||/^[OGDS]:/.test(rest))break;
   const flag=DACL_FLAGS.find(f=>rest.startsWith(f));
   if(flag){if(aces.length)return null;flags.push(flag);i+=flag.length;continue;}
   if(rest[0]!=='(')return null;
   // An entry runs to its matching parenthesis (conditional entries nest them).
   let depth=0,j=0;
   for(;j<rest.length;j++){if(rest[j]==='(')depth++;else if(rest[j]===')'&&--depth===0)break;}
   if(depth!==0||j>=rest.length)return null;
   const f=rest.slice(1,j).split(';');
   if(f.length<6)return null;
   const sid=f[5];
   if(!sid||SID_RE.exec(sid)?.[1]!==sid)return null;
   aces.push({type:f[0],flags:f[1],rights:f[2],sid});
   i+=j+1;
  }
  if(section==='D')out.dacl={flags,aces};
 }
 return out;
}

// The DACL entries only: null for a null DACL or unrecognised syntax.
export function parseSddlAces(sddl:string):SddlAce[]|null{
 const p=parseSddl(sddl);
 if(!p?.dacl||p.dacl.flags.includes('NO_ACCESS_CONTROL'))return null;
 return p.dacl.aces;
}

// Decides from the SDDL and the current user's SID whether only this user (plus SYSTEM and Administrators, as on every
// AppData folder) can reach the object. Returns a plain-words problem, or null when private.
// `requireProtected`: the DACL must also be protected from inheritance (flag P), as AttendWell sets on workshop folders.
// `userAlias`: the two-letter SDDL alias Windows itself writes for the current user's SID, when it has one (the built-in
// Administrator account, RID 500, is written LA; Guest, RID 501, LG). The probe asks Windows for it, so it names exactly
// this user; anything else that is not the full SID is still another account.
export function windowsAclProblem(sddl:string,userSid:string,opts:{requireProtected?:boolean;userAlias?:string}={}):string|null{
 if(!/^S-1-5-21-[\d-]+$/.test(userSid))return 'Could not identify the current Windows user.';
 const alias=opts.userAlias&&/^[A-Z]{2}$/.test(opts.userAlias)?opts.userAlias:null;
 const isUser=(sid:string)=>sid===userSid||alias!==null&&sid===alias;
 const p=parseSddl(sddl);
 if(!p)return 'Could not read the access control list.';
 if(!p.owner||!(isUser(p.owner)||WINDOWS_TRUSTED.has(p.owner)))return 'It is owned by another account.';
 if(!p.dacl||p.dacl.flags.includes('NO_ACCESS_CONTROL'))return 'It has no access control list, so every account can open it.';
 for(const ace of p.dacl.aces){
  if(!KNOWN_TYPES.has(ace.type))return 'Its access control list has an entry AttendWell does not recognise.';
  if(DENY_TYPES.has(ace.type))continue; // deny entries only narrow access
  if(!isUser(ace.sid)&&!WINDOWS_TRUSTED.has(ace.sid))return `It grants access to another account (${ace.sid}).`;
 }
 if(opts.requireProtected&&!p.dacl.flags.includes('P'))return 'Its access control list still inherits from the folder above.';
 return null;
}

// `userAlias`: see windowsAclProblem; absent when the user's SID has no alias (every ordinary account).
export type AclProbe=(target:string)=>{userSid:string;sddl:string;userAlias?:string};
// One PowerShell call for several paths (a listing touches many files; each call costs about a second).
export type AclBatchProbe=(targets:string[])=>{userSid:string;sddl:Map<string,string>;userAlias?:string};

// Runs Windows PowerShell 5.1 (powershell.exe) without the caller's PSModulePath. Started from PowerShell 7 (a pwsh
// terminal, or a CI shell), the inherited PSModulePath points 5.1 at PowerShell 7's modules, which it cannot load, so
// cmdlets such as Get-Acl or Get-CimInstance fail and every check that needs them would fail closed. Without the
// variable, 5.1 uses its own module folders. No shell: the script is one argument, and values go through `extraEnv`.
export function runWindowsPowerShell(script:string,extraEnv:Record<string,string>={},timeoutMs=30000):string{
 const env:Record<string,string>={};
 for(const [k,v] of Object.entries(process.env))if(v!==undefined&&k.toUpperCase()!=='PSMODULEPATH')env[k]=v;
 Object.assign(env,extraEnv);
 return execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{env,encoding:'utf8',windowsHide:true,timeout:timeoutMs});
}

// Reads the current user's SID and each path's SDDL (owner, group and access list) through .NET directly, so no
// PowerShell module has to load. Paths go through the environment, one per line (a Windows path cannot hold a line
// break), never through the command text. SDDL uses SIDs, so the check does not depend on the Windows display language.
// SDDL writes a few well-known SIDs as two-letter aliases, among them the built-in Administrator account (LA), which is
// the account GitHub's Windows runners use. The probe therefore also asks Windows how it writes the current user's SID
// (the owner of a descriptor holding only that SID) and reports the alias when there is one.
export const powershellAclBatchProbe:AclBatchProbe=targets=>{
 const script='$u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;"USER $u";try{"USERSDDL "+[System.Security.AccessControl.RawSecurityDescriptor]::new("O:"+$u).GetSddlForm([System.Security.AccessControl.AccessControlSections]\'Owner\')}catch{};$i=0;foreach($p in $env:ATTENDANCE_ACL_PATHS.Split([char]10)){try{if([System.IO.Directory]::Exists($p)){$a=[System.IO.Directory]::GetAccessControl($p)}else{$a=[System.IO.File]::GetAccessControl($p)};"SDDL $i "+$a.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]\'Owner,Group,Access\')}catch{"SDDL $i "};$i++}';
 if(targets.some(t=>/[\r\n]/.test(t)))throw new PrivatePathError('A path holds a line break.');
 const out=runWindowsPowerShell(script,{ATTENDANCE_ACL_PATHS:targets.join('\n')});
 const sddl=new Map<string,string>();
 for(const m of out.matchAll(/^SDDL (\d+) ?(\S*)\r?$/gm)){const t=targets[Number(m[1])];if(t!==undefined&&m[2])sddl.set(t,m[2]);}
 const userSid=/^USER (\S+)/m.exec(out)?.[1]??'';
 const own=/^USERSDDL O:(\S+?)\r?$/m.exec(out)?.[1];
 return {userSid,sddl,...(own&&own!==userSid&&/^[A-Z]{2}$/.test(own)?{userAlias:own}:{})};
};
export const powershellAclProbe:AclProbe=target=>{const r=powershellAclBatchProbe([target]);return {userSid:r.userSid,sddl:r.sddl.get(target)??'',...(r.userAlias?{userAlias:r.userAlias}:{})};};
export const batchProbeFrom=(single:AclProbe):AclBatchProbe=>targets=>{
 let userSid='',userAlias:string|undefined;const sddl=new Map<string,string>();
 for(const t of targets){const r=single(t);userSid||=r.userSid;userAlias??=r.userAlias;if(r.sddl)sddl.set(t,r.sddl);}
 return {userSid,sddl,...(userAlias?{userAlias}:{})};
};

// Windows: gives a folder an explicit, protected access list: full control for the current user, SYSTEM and
// Administrators, inherited by everything created inside it, and nothing inherited from above. icacls gets the path
// and SIDs as separate arguments (no shell).
export type AclProtector=(dir:string,userSid:string)=>void;
export const icaclsProtect:AclProtector=(dir,userSid)=>{
 if(!/^S-1-5-21-[\d-]+$/.test(userSid))throw new PrivatePathError('Could not identify the current Windows user.');
 execFileSync('icacls.exe',[dir,'/inheritance:r','/grant:r',`*${userSid}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F'],{windowsHide:true,timeout:30000,stdio:'ignore'});
};

// ---------------------------------------------------------------------------------------------------------------------
// Private folders and files

export type PrivateDirOptions={platform?:NodeJS.Platform;stat?:(p:string)=>{mode:number};aclProbe?:AclProbe;message?:string};
// Throws unless `dir` is private to the current user.
// POSIX: no group or other permission bits (mode 700 or narrower).
// Windows: the access control list allows only the current user, SYSTEM and Administrators (the default for a folder
// under %APPDATA% or %LOCALAPPDATA%); POSIX mode bits mean nothing there, so they are not consulted.
export function assertPrivateDir(dir:string,opts:PrivateDirOptions={}):void{
 const platform=opts.platform??process.platform;
 const message=opts.message??'Use a dedicated private database directory with permissions 700.';
 if(platform==='win32'){
  let problem:string|null;
  try{const {userSid,sddl,userAlias}=(opts.aclProbe??powershellAclProbe)(dir);problem=sddl?windowsAclProblem(sddl,userSid,{userAlias}):'Could not read the folder\'s access control list.';}
  catch{problem='Could not read the folder\'s access control list.';}
  if(problem)throw new PrivatePathError(`${message} On Windows, keep it inside your own AppData folder. ${problem}`);
  return;
 }
 if(((opts.stat??fs.statSync)(dir).mode&0o077)!==0)throw new PrivatePathError(message);
}

export type PrivateEntry={path:string;kind:'dir'|'file';requireProtected?:boolean};
export type PrivatePathsOptions={platform?:NodeJS.Platform;aclProbe?:AclProbe;aclBatchProbe?:AclBatchProbe;lstat?:(p:string)=>fs.Stats;message?:string};
// Checks several existing folders and files at once. POSIX: each is a real folder, or a regular file with a single
// link, with no group or other bits. Windows: one PowerShell call reads every access list; each must pass
// windowsAclProblem. Returns the current Windows user's SID (empty on POSIX), so a caller can protect new folders.
export function assertPrivatePaths(entries:PrivateEntry[],opts:PrivatePathsOptions={}):string{
 const platform=opts.platform??process.platform;
 const message=opts.message??'AttendWell keeps the register in a private folder.';
 const lstat=opts.lstat??fs.lstatSync;
 for(const e of entries){
  let st:fs.Stats;try{st=lstat(e.path)}catch{throw new PrivatePathError(`${message} ${e.path} is missing.`)}
  if(st.isSymbolicLink())throw new PrivatePathError(`${message} ${e.path} is a link.`);
  if(e.kind==='dir'?!st.isDirectory():!st.isFile()||st.nlink>1)throw new PrivatePathError(`${message} ${e.path} is not a plain ${e.kind==='dir'?'folder':'file'}.`);
  if(platform!=='win32'&&(st.mode&0o077)!==0)throw new PrivatePathError(`${message} ${e.path} can be read by other accounts.`);
 }
 if(platform!=='win32'||!entries.length)return '';
 let result:ReturnType<AclBatchProbe>;
 try{result=(opts.aclBatchProbe??(opts.aclProbe?batchProbeFrom(opts.aclProbe):powershellAclBatchProbe))(entries.map(e=>e.path))}
 catch{throw new PrivatePathError(`${message} Could not read the access control list.`)}
 for(const e of entries){
  const sddl=result.sddl.get(e.path);
  const problem=sddl?windowsAclProblem(sddl,result.userSid,{requireProtected:e.requireProtected,userAlias:result.userAlias}):'Could not read the access control list.';
  if(problem)throw new PrivatePathError(`${message} ${e.path}: ${problem}`);
 }
 return result.userSid;
}

// ---------------------------------------------------------------------------------------------------------------------
// Links and canonical containment

export type ContainmentOptions={platform?:NodeJS.Platform;lstat?:(p:string)=>fs.Stats;realpath?:(p:string)=>string;message?:string};
const samePath=(a:string,b:string,platform:NodeJS.Platform)=>platform==='win32'?path.win32.normalize(a).toLowerCase()===path.win32.normalize(b).toLowerCase():path.posix.normalize(a)===path.posix.normalize(b);

// Throws unless `target` lies inside `root` with no link anywhere from `root` down to `target` (both included), and the
// canonical path of each existing component is exactly the canonical root plus the same relative path. lstat reports
// symlinks and, on Windows, junctions; the canonical comparison also catches any other reparse point (realpath.native
// resolves them all). Components that do not exist yet are allowed: the caller creates them, then checks again.
export function assertContained(root:string,target:string,opts:ContainmentOptions={}):void{
 // Path rules follow the file system being walked: the real one (this computer's rules), or an injected one (tests
 // that simulate Windows pass lstat and realpath with platform 'win32').
 const simulated=!!(opts.lstat&&opts.realpath);
 const platform=simulated?(opts.platform??process.platform):process.platform;
 const api=platform==='win32'?path.win32:path.posix;
 const lstat=opts.lstat??fs.lstatSync;
 const realpath=opts.realpath??fs.realpathSync.native;
 const message=opts.message??'AttendWell keeps the register inside its own data folder.';
 const absRoot=api.resolve(root),absTarget=api.resolve(target);
 if(!isInside(absRoot,absTarget,api))throw new PrivatePathError(`${message} ${target} is outside it.`);
 const parts=api.relative(absRoot,absTarget).split(api.sep).filter(Boolean);
 let st:fs.Stats;
 try{st=lstat(absRoot)}catch{throw new PrivatePathError(`${message} ${root} is missing.`)}
 if(st.isSymbolicLink())throw new PrivatePathError(`${message} ${root} is a link.`);
 let canonicalRoot:string;
 try{canonicalRoot=realpath(absRoot)}catch{throw new PrivatePathError(`${message} ${root} cannot be read.`)}
 let current=absRoot;
 for(let k=0;k<parts.length;k++){
  current=api.join(current,parts[k]);
  try{st=lstat(current)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw new PrivatePathError(`${message} ${current} cannot be read.`)}
  if(st.isSymbolicLink())throw new PrivatePathError(`${message} ${current} is a link.`);
  let canonical:string;try{canonical=realpath(current)}catch{throw new PrivatePathError(`${message} ${current} cannot be read.`)}
  if(!samePath(canonical,api.join(canonicalRoot,...parts.slice(0,k+1)),platform))throw new PrivatePathError(`${message} ${current} leads somewhere else.`);
 }
}

// ---------------------------------------------------------------------------------------------------------------------
// Permissions through a descriptor, never through a path

// Test seam: called with the target path immediately before permissions are set on the opened descriptor, so a test can
// swap the path for a link at the worst moment and prove the change lands on the opened file, not on the link's target.
export type FsHooks={beforeChmod?:(target:string)=>void};
const O_NOFOLLOW=fs.constants.O_NOFOLLOW??0;
const O_DIRECTORY=fs.constants.O_DIRECTORY??0;
// Open flags follow the file system actually being opened (this computer), never an injected platform. On Windows they are
// strings: Bun (the register sidecar and the test runner) reads numeric flags there with its own values, so
// O_WRONLY|O_CREAT|O_EXCL from fs.constants does not create the file (ENOENT). 'wx' and 'r' mean the same in Bun and
// Node. Windows has no O_NOFOLLOW; there the lstat/fstat identity checks refuse a link instead (an exclusive create
// also fails on an existing link).
const WINDOWS_FS=process.platform==='win32';
export const CREATE_NEW_FLAGS:string|number=WINDOWS_FS?'wx':fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|O_NOFOLLOW;
export const READ_NOFOLLOW_FLAGS:string|number=WINDOWS_FS?'r':fs.constants.O_RDONLY|O_NOFOLLOW;
const sameObject=(a:fs.Stats,b:fs.Stats)=>a.dev===b.dev&&a.ino===b.ino;

// Opens `target` without following a link in its last component, checks it is the expected kind, runs `recheck` (the
// caller's containment check) and confirms the path still names the opened object, then sets `mode` on the descriptor.
// Nothing is ever chmod-ed by path. Windows: mode bits mean nothing there, so only the checks run.
export function chmodNoFollow(target:string,mode:number,kind:'file'|'dir',opts:{platform?:NodeJS.Platform;recheck?:()=>void;hooks?:FsHooks}={}):void{
 const posix=(opts.platform??process.platform)!=='win32';
 const fd=fs.openSync(target,WINDOWS_FS?'r':fs.constants.O_RDONLY|O_NOFOLLOW|(kind==='dir'?O_DIRECTORY:0));
 try{
  const st=fs.fstatSync(fd);
  if(kind==='dir'?!st.isDirectory():!st.isFile())throw new PrivatePathError(`${target} is not a plain ${kind==='dir'?'folder':'file'}.`);
  opts.recheck?.();
  if(!sameObject(st,fs.lstatSync(target)))throw new PrivatePathError(`${target} changed while it was being made private.`);
  opts.hooks?.beforeChmod?.(target);
  if(posix)fs.fchmodSync(fd,mode);
 }finally{fs.closeSync(fd);}
}

// Creates a new file that must not exist yet (O_CREAT|O_EXCL|O_NOFOLLOW, mode 0600), sets 0600 on the descriptor and
// writes `data` through it. A link or file already at `target` makes it fail with EEXIST. `recheck` runs after the file
// is created and before anything is written (the caller's containment check).
export function writeNewPrivateFile(target:string,data:string|Uint8Array,opts:{platform?:NodeJS.Platform;recheck?:()=>void;hooks?:FsHooks}={}):void{
 const posix=(opts.platform??process.platform)!=='win32';
 const fd=fs.openSync(target,CREATE_NEW_FLAGS,0o600);
 try{
  opts.recheck?.();
  if(!sameObject(fs.fstatSync(fd),fs.lstatSync(target)))throw new PrivatePathError(`${target} changed while it was being created.`);
  opts.hooks?.beforeChmod?.(target);
  if(posix)fs.fchmodSync(fd,0o600);
  const buf=typeof data==='string'?Buffer.from(data,'utf8'):data;
  for(let off=0;off<buf.length;)off+=fs.writeSync(fd,buf,off,buf.length-off);
 }finally{fs.closeSync(fd);}
}
