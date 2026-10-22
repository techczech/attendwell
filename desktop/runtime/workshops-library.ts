// The workshops library: one private folder per workshop under the app's data folder.
//
//   <dataRoot>/workshops/<id>/workshop.json            the service's workshop file (server/workshop-config.ts format)
//   <dataRoot>/workshops/<id>/library.json             desktop bookkeeping: created, archived, last attended count
//   <dataRoot>/workshops/<id>/roster-provenance.json   where the name list came from (written when one is imported)
//   <dataRoot>/workshops/<id>/service.json             the service's loopback config, rewritten for each session
//   <dataRoot>/workshops/<id>/db/attendance.sqlite     the register
//
// No link (symlink, junction or other reparse point) anywhere from the data root down to a file AttendWell opens, and each
// path's canonical form is exactly where it should be: checked before anything is read, opened or chmod-ed
// (server/private-path.ts assertContained).
// macOS: every folder 0700 and every file 0600, checked after writing; the register and its SQLite -wal/-shm files are
// checked before opening. Windows: the data root's access list must be private; each workshop folder gets its own
// protected owner-only list at creation (icacls), and the folder, register and -wal/-shm lists are verified before
// opening. Anything that cannot be verified fails closed.
import path from 'node:path';
import fs from 'node:fs';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {parseWorkshopConfig,type WorkshopConfig} from '../../server/workshop-config.ts';
import {assertPrivateDir,assertPrivatePaths,assertContained,isInside,icaclsProtect,batchProbeFrom,powershellAclBatchProbe,PrivatePathError,chmodNoFollow,writeNewPrivateFile,type AclProbe,type AclBatchProbe,type AclProtector,type PrivateEntry,type FsHooks} from '../../server/private-path.ts';

export type LibraryMeta={createdAt:string;archived:boolean;archivedAt:string|null;attendedCount:number|null;attendedCountAt:string|null};
export type RosterProvenance={kind:'paste'|'spreadsheet'|'booking-export';filename:string|null;sha256:string|null;importedAt:string;count:number};
export type WorkshopPaths={root:string;dir:string;workshopFile:string;metaFile:string;provenanceFile:string;serviceFile:string;dbDir:string;database:string};
export type WorkshopRecord={id:string;config:WorkshopConfig;meta:LibraryMeta;provenance:RosterProvenance|null;paths:WorkshopPaths};
export type WorkshopSummary={id:string;title:string;date:string;startTime:string;endTime:string;archived:boolean;when:'upcoming'|'today'|'past';
 // Checked-in people from the register; the cached figure from the last session when the register cannot be read; null when unknown.
 attended:number|null};
export type WorkshopListing={upcoming:WorkshopSummary[];today:WorkshopSummary[];past:WorkshopSummary[];archived:WorkshopSummary[]};
export type NewWorkshop={title:string;date:string;startTime?:string;endTime?:string;organiserHelp?:string};
// Reads the attended count from a register without writing to it. Returns null when it cannot.
export type AttendedCounter=(database:string)=>number|null;

// fsHooks: test seam (see server/private-path.ts FsHooks).
export type LibraryOptions={dataRoot:string;platform?:NodeJS.Platform;aclProbe?:AclProbe;aclBatchProbe?:AclBatchProbe;aclProtect?:AclProtector;now?:()=>Date;countAttended?:AttendedCounter;fsHooks?:FsHooks};

const ID_RE=/^[a-z0-9][a-z0-9-]{0,79}$/;
export class LibraryError extends Error {}

// Default counter: Node's built-in SQLite (Electron's Node 22.13+), opened read-only so a running service is never disturbed.
export const sqliteAttendedCounter:AttendedCounter=database=>{
 if(!fs.existsSync(database))return 0;
 try{
  const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db=new DatabaseSync(database,{readOnly:true});
  try{const row=db.prepare('SELECT count(*) AS n FROM people WHERE present=1 AND active=1').get() as {n:number}|undefined;return typeof row?.n==='number'?row.n:null}
  finally{db.close()}
 }catch{return null}
};

const slug=(s:string)=>s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40).replace(/-+$/,'');
const localDate=(d:Date)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

export const HOST_SECRET_BYTES=32;

export function createWorkshopsLibrary(opts:LibraryOptions){
 const platform=opts.platform??process.platform;
 const posix=platform!=='win32';
 const now=opts.now??(()=>new Date());
 const count=opts.countAttended??sqliteAttendedCounter;
 const dataRoot=path.resolve(opts.dataRoot);
 const root=path.join(dataRoot,'workshops');
 const batchProbe:AclBatchProbe=opts.aclBatchProbe??(opts.aclProbe?batchProbeFrom(opts.aclProbe):powershellAclBatchProbe);
 const protect=opts.aclProtect??icaclsProtect;
 const PRIVATE=`AttendWell keeps workshops in a private folder (${dataRoot}).`;
 let userSid='';

 // Library errors carry plain words; the private-path detail is kept on the message for the log.
 const guard=<T>(fn:()=>T):T=>{try{return fn()}catch(e){if(e instanceof PrivatePathError)throw new LibraryError(e.message);throw e;}};
 const contained=(target:string)=>assertContained(dataRoot,target,{platform,message:PRIVATE});
 const exists=(p:string)=>{try{fs.lstatSync(p);return true}catch{return false}};

 const hooks=opts.fsHooks;
 // POSIX: 0700, set on the opened folder (never by path) and checked. Windows: folders inherit the private list of the
 // data root (checked in ready()), except workshop folders, which get their own protected list at creation.
 const ensureDir=(dir:string)=>{
  contained(dir);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  contained(dir);
  if(posix){chmodNoFollow(dir,0o700,'dir',{platform,recheck:()=>contained(dir),hooks});assertPrivateDir(dir,{platform,message:PRIVATE});}
 };
 // A fresh temporary file (created exclusively, never through a link, 0600 on the descriptor), then renamed into place.
 const writePrivate=(file:string,data:unknown)=>{
  contained(file);
  const tmp=`${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeNewPrivateFile(tmp,JSON.stringify(data,null,2)+'\n',{platform,recheck:()=>contained(tmp),hooks});
  fs.renameSync(tmp,file);
  const st=fs.lstatSync(file);
  if(!st.isFile()||(posix&&(st.mode&0o077)))throw new LibraryError(`Could not make ${file} private.`);
 };
 const readJson=(file:string):unknown=>{contained(file);return JSON.parse(fs.readFileSync(file,'utf8'));};

 let checked=false;
 const ready=()=>guard(()=>{
  if(checked)return;
  // The data root must exist before its own link check; a link in its place is then refused by ensureDir.
  fs.mkdirSync(dataRoot,{recursive:true,mode:0o700});
  ensureDir(dataRoot);
  if(!posix)userSid=assertPrivatePaths([{path:dataRoot,kind:'dir'}],{platform,aclBatchProbe:batchProbe,message:PRIVATE});
  ensureDir(root);
  checked=true;
 });

 const pathsFor=(id:string):WorkshopPaths=>{
  if(!ID_RE.test(id))throw new LibraryError('That workshop could not be found.');
  const dir=path.join(root,id);
  if(!isInside(root,dir)||dir===root)throw new LibraryError('That workshop could not be found.');
  const dbDir=path.join(dir,'db');
  return {root:dataRoot,dir,workshopFile:path.join(dir,'workshop.json'),metaFile:path.join(dir,'library.json'),provenanceFile:path.join(dir,'roster-provenance.json'),serviceFile:path.join(dir,'service.json'),dbDir,database:path.join(dbDir,'attendance.sqlite')};
 };
 const sqliteFiles=(p:WorkshopPaths)=>[p.database,`${p.database}-wal`,`${p.database}-shm`];

 // Link and containment checks for one workshop (cheap), plus the entries whose privacy must be verified.
 const storageEntries=(p:WorkshopPaths):PrivateEntry[]=>{
  for(const f of [p.dir,p.workshopFile,p.metaFile,p.provenanceFile,p.serviceFile,p.dbDir,...sqliteFiles(p)])contained(f);
  const entries:PrivateEntry[]=[{path:p.dir,kind:'dir',requireProtected:!posix}];
  if(exists(p.dbDir))entries.push({path:p.dbDir,kind:'dir'});
  for(const f of sqliteFiles(p))if(exists(f))entries.push({path:f,kind:'file'});
  return entries;
 };
 // Verifies several workshops with one access-list read on Windows. Returns the ids that passed.
 const verifyMany=(list:WorkshopPaths[]):Set<string>=>{
  const ok=new Set<string>();const pending:{p:WorkshopPaths;entries:PrivateEntry[]}[]=[];
  for(const p of list){try{pending.push({p,entries:storageEntries(p)})}catch{}}
  if(posix){for(const {p,entries} of pending){try{assertPrivatePaths(entries,{platform});ok.add(p.dir)}catch{}}return ok;}
  if(!pending.length)return ok;
  let sids:ReturnType<AclBatchProbe>;
  try{sids=batchProbe(pending.flatMap(x=>x.entries.map(e=>e.path)))}catch{return ok}
  const cached:AclBatchProbe=targets=>({userSid:sids.userSid,...(sids.userAlias?{userAlias:sids.userAlias}:{}),sddl:new Map(targets.map(t=>[t,sids.sddl.get(t)??''] as [string,string]))});
  for(const {p,entries} of pending){try{assertPrivatePaths(entries,{platform,aclBatchProbe:cached});ok.add(p.dir)}catch{}}
  return ok;
 };
 const verify=(p:WorkshopPaths)=>guard(()=>assertPrivatePaths(storageEntries(p),{platform,aclBatchProbe:batchProbe,message:PRIVATE}));

 const readMeta=(p:WorkshopPaths):LibraryMeta=>{
  const m=readJson(p.metaFile) as Partial<LibraryMeta>;
  return {createdAt:String(m.createdAt??''),archived:m.archived===true,archivedAt:typeof m.archivedAt==='string'?m.archivedAt:null,
   attendedCount:Number.isInteger(m.attendedCount)?m.attendedCount as number:null,attendedCountAt:typeof m.attendedCountAt==='string'?m.attendedCountAt:null};
 };

 // Reads a workshop whose storage has already been verified.
 function load(id:string,paths:WorkshopPaths):WorkshopRecord{
  const config=parseWorkshopConfig(readJson(paths.workshopFile));
  let provenance:RosterProvenance|null=null;if(exists(paths.provenanceFile))try{provenance=readJson(paths.provenanceFile) as RosterProvenance}catch{}
  return {id,config,meta:readMeta(paths),provenance,paths};
 }

 function get(id:string):WorkshopRecord{
  ready();
  const paths=pathsFor(id);
  // A workshop folder is a real folder: a link pointing elsewhere is not followed.
  let st:fs.Stats;try{st=fs.lstatSync(paths.dir)}catch{throw new LibraryError('That workshop could not be found.')}
  if(!st.isDirectory()||st.isSymbolicLink())throw new LibraryError('That workshop could not be found.');
  verify(paths);
  return guard(()=>load(id,paths));
 }

 function summarise(r:WorkshopRecord,today:string):WorkshopSummary{
  const live=count(r.paths.database);
  return {id:r.id,title:r.config.title,date:r.config.date,startTime:r.config.startTime,endTime:r.config.endTime,archived:r.meta.archived,
   when:r.config.date>today?'upcoming':r.config.date===today?'today':'past',attended:live??r.meta.attendedCount};
 }

 return {
  dataRoot,
  root,
  create(input:NewWorkshop):WorkshopRecord{
   ready();
   const base=slug(input.title)||'workshop';
   const id=`${String(input.date).slice(0,10)}-${base}-${randomBytes(3).toString('hex')}`.replace(/[^a-z0-9-]/g,'');
   const config=parseWorkshopConfig({sessionId:id.slice(0,64),title:input.title,date:input.date,
    ...(input.startTime?{startTime:input.startTime}:{}),...(input.endTime?{endTime:input.endTime}:{}),...(input.organiserHelp?{organiserHelp:input.organiserHelp}:{}),
    participantBasePath:`/w-${id.slice(-6)}`,publicOrigin:null});
   const paths=pathsFor(id);
   if(exists(paths.dir))throw new LibraryError('A workshop with that name already exists. Try again.');
   guard(()=>{
    ensureDir(paths.dir);
    // Windows: an explicit, protected owner-only list on the workshop folder; everything inside inherits it.
    if(!posix)protect(paths.dir,userSid);
    ensureDir(paths.dbDir);
    assertPrivatePaths([{path:paths.dir,kind:'dir',requireProtected:!posix}],{platform,aclBatchProbe:batchProbe,message:PRIVATE});
   });
   writePrivate(paths.workshopFile,config);
   writePrivate(paths.metaFile,{createdAt:now().toISOString(),archived:false,archivedAt:null,attendedCount:null,attendedCountAt:null} satisfies LibraryMeta);
   return get(id);
  },
  get,
  list({includeArchived=true}:{includeArchived?:boolean}={}):WorkshopListing{
   ready();
   const today=localDate(now());
   const out:WorkshopListing={upcoming:[],today:[],past:[],archived:[]};
   const candidates=fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.isSymbolicLink()&&ID_RE.test(e.name)).map(e=>pathsFor(e.name));
   const verified=verifyMany(candidates);
   for(const p of candidates){
    if(!verified.has(p.dir))continue; // a damaged or unsafe folder is skipped, never fatal to the list
    let r:WorkshopRecord;try{r=load(path.basename(p.dir),p)}catch{continue}
    const s=summarise(r,today);
    if(s.archived){if(includeArchived)out.archived.push(s);}else out[s.when].push(s);
   }
   const byStart=(a:WorkshopSummary,b:WorkshopSummary)=>(a.date+a.startTime).localeCompare(b.date+b.startTime);
   out.upcoming.sort(byStart);out.today.sort(byStart);out.past.sort((a,b)=>byStart(b,a));out.archived.sort((a,b)=>byStart(b,a));
   return out;
  },
  setArchived(id:string,archived:boolean):WorkshopRecord{
   const r=get(id);
   writePrivate(r.paths.metaFile,{...r.meta,archived,archivedAt:archived?now().toISOString():null});
   return get(id);
  },
  recordAttendedCount(id:string,attended:number){
   const r=get(id);if(!Number.isInteger(attended)||attended<0)return;
   writePrivate(r.paths.metaFile,{...r.meta,attendedCount:attended,attendedCountAt:now().toISOString()});
  },
  recordRosterProvenance(id:string,provenance:RosterProvenance){
   const r=get(id);
   if(!['paste','spreadsheet','booking-export'].includes(provenance.kind)||!Number.isInteger(provenance.count))throw new LibraryError('Roster provenance is incomplete.');
   writePrivate(r.paths.provenanceFile,{kind:provenance.kind,filename:provenance.filename??null,sha256:provenance.sha256??null,importedAt:provenance.importedAt,count:provenance.count});
  },
  // Writes the loopback service.json for this session and makes sure the register's folder and files are private.
  prepareService(id:string,organiserPort:number):WorkshopPaths{
   const r=get(id);
   if(!Number.isInteger(organiserPort)||organiserPort<1||organiserPort>65535)throw new LibraryError('Invalid organiser port.');
   guard(()=>{ensureDir(r.paths.dbDir);verify(r.paths);});
   writePrivate(r.paths.serviceFile,{origin:`http://127.0.0.1:${organiserPort}`,users:{}});
   return r.paths;
  },
  // The laptop's long-lived host secret (32 random bytes) that lets it prove itself to an iPad paired in an earlier
  // session. Created once, private like the register, never read by the runtime itself: only its path is passed to the
  // service (ATTENDANCE_HOST_SECRET_PATH).
  hostSecretPath():string{
   ready();
   const file=path.join(dataRoot,'host-secret');
   return guard(()=>{
    contained(file);
    if(!exists(file)){
     // Created exclusively, never through a link, 0600 set on the descriptor; then checked again below.
     try{writeNewPrivateFile(file,randomBytes(HOST_SECRET_BYTES),{platform,recheck:()=>contained(file),hooks})}
     catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
    }
    contained(file);
    const st=fs.lstatSync(file);
    if(!st.isFile()||st.size!==HOST_SECRET_BYTES)throw new LibraryError('The host secret file is damaged.');
    assertPrivatePaths([{path:file,kind:'file'}],{platform,aclBatchProbe:batchProbe,message:PRIVATE});
    return file;
   });
  },
 };
}
export type WorkshopsLibrary=ReturnType<typeof createWorkshopsLibrary>;
