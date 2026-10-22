import {AttendanceStore} from './store-attendance';
import {createHandler,type Config} from './http-attendance';
import {resolve,dirname,isAbsolute} from 'node:path';
import {mkdirSync,existsSync,lstatSync} from 'node:fs';
import {isInside,assertPrivateDir,assertContained,assertPrivatePaths,chmodNoFollow,type PrivateEntry} from './private-path';
import {parseWorkshopConfig} from './workshop-config';
import {loadHostSecret} from './host-secret-attendance';
import {X509Certificate,createPrivateKey} from 'node:crypto';
const configPath=process.env.ATTENDANCE_CONFIG_PATH;
const databasePath=process.env.ATTENDANCE_DATABASE_PATH;
const workshopPath=process.env.ATTENDANCE_WORKSHOP_PATH;
// Optional: the organiser-proof host secret that outlives this register database (docs/reference-configuration.md).
const hostSecretPath=process.env.ATTENDANCE_HOST_SECRET_PATH||undefined;
if(!configPath||!databasePath)throw new Error('Set ATTENDANCE_CONFIG_PATH and ATTENDANCE_DATABASE_PATH to private files outside the source folder. See README.');
if(!workshopPath)throw new Error('Set ATTENDANCE_WORKSHOP_PATH to the workshop configuration JSON (see examples/workshop.example.json).');
// Explicit workshop identity: title, date and session ID must be set; the fictional example is never used silently.
const workshop=parseWorkshopConfig(await Bun.file(workshopPath).json());
const appRoot=resolve(import.meta.dir,'..');
// path.relative, not a string prefix: works with Windows separators and drive-letter case, and `/app-other` is not inside `/app`.
if([configPath,databasePath,...(hostSecretPath?[hostSecretPath]:[])].some(p=>isInside(appRoot,p)))throw new Error('Keep credential configuration and the database outside the application folder.');
const config=await Bun.file(configPath).json() as Config;
const origin=new URL(config.origin);
config.localAdmin=['localhost','127.0.0.1','[::1]'].includes(origin.hostname);
config.users??={};
if(config.localAdmin&&process.env.ATTENDANCE_BIND&&process.env.ATTENDANCE_BIND!=='127.0.0.1')throw new Error('Password-free organiser access requires a loopback listener.');
if(!config.localAdmin&&(!Object.keys(config.users).length||Object.values(config.users).some(u=>!u.hash?.startsWith('$argon2')||!['owner','facilitator'].includes(u.role))))throw new Error('Remote facilitator access requires Argon2 passphrase hashes.');
const port=Number(process.env.ATTENDANCE_LISTEN_PORT||(origin.port||443));
const participantOrigin=process.env.ATTENDANCE_PARTICIPANT_ORIGIN;
const participantPort=Number(process.env.ATTENDANCE_PARTICIPANT_PORT??4319);
// The desktop app (macOS) passes a Unix socket in its private run folder instead of a port: only this account can bind
// that path, so once this process ends nothing else can take its place behind the app's participant gateway.
const participantSocket=process.env.ATTENDANCE_PARTICIPANT_SOCKET||null;
// Secrets never come through the environment, which other programs of this account can read (`ps eww`) for as long as
// this process runs. With ATTENDANCE_SECRETS=stdin (set by the desktop app), the service reads them from its standard input
// (a pipe only the app holds) before any file is created and any listener bound: one JSON line within 5 seconds, or it
// refuses to start. Standard input is closed once the line is read.
//   organiserToken  required: a fresh 32-byte key (base64url) for this start; every request to the organiser listener
//                   must carry it as a bearer.
//   tlsKey, tlsCert required for a TCP participant listener (the desktop app on Windows), never otherwise: a key and
//                   certificate made for this process (base64 DER, PKCS#8 and X.509). The participant listener serves HTTPS
//                   with them and the app's gateway accepts only that certificate, so a program that takes the port after
//                   this process ends gets no request.
// None of them is logged, and no refusal names a value.
const SECRET_ENV=['ATTENDANCE_ORGANISER_TOKEN','ATTENDANCE_PARTICIPANT_TLS_KEY','ATTENDANCE_PARTICIPANT_TLS_CERT'];
if(SECRET_ENV.some(k=>process.env[k]!==undefined)){
 for(const k of SECRET_ENV)delete process.env[k];
 throw new Error('The organiser key and participant certificate are no longer read from the environment. Set ATTENDANCE_SECRETS=stdin and pass them on standard input.');
}
const secretsMode=process.env.ATTENDANCE_SECRETS;
if(secretsMode!==undefined&&secretsMode!=='stdin')throw new Error('ATTENDANCE_SECRETS must be stdin.');
const SECRETS_TIMEOUT_MS=5000,SECRETS_MAX_BYTES=32768;
// Exactly one line, ended by a newline, of at most SECRETS_MAX_BYTES bytes (counted on every chunk, before a newline or
// the end of input is accepted), then the end of input. The desktop app writes the line and closes the pipe, so the end
// always follows; the line is accepted only once it arrives, within the same timeout. Anything else is refused: nothing
// within the timeout, input that ends before its newline, a longer line, any byte after the newline (in the same chunk or
// a later one), or a pipe left open after the line.
function readSecretLine():Promise<{line:string}|{problem:string}>{
 return new Promise(done=>{
  const input=process.stdin;const chunks:Buffer[]=[];let bytes=0;let finished=false;let line:string|null=null;
  const finish=(v:{line:string}|{problem:string})=>{if(finished)return;finished=true;clearTimeout(timer);input.removeAllListeners('data');input.removeAllListeners('end');input.pause();input.destroy();done(v);};
  const none={problem:'The service expected its keys on standard input and received none.'};
  const oneLine={problem:'The keys on standard input must be one line.'};
  const timer=setTimeout(()=>finish(line===null?none:{problem:'Standard input stayed open after the keys.'}),SECRETS_TIMEOUT_MS);
  input.on('data',(chunk:Buffer|string)=>{
   const b=typeof chunk==='string'?Buffer.from(chunk,'utf8'):chunk;
   if(!b.length)return;
   if(line!==null)return finish(oneLine);
   const i=b.indexOf(0x0a);
   if(bytes+(i<0?b.length:i)>SECRETS_MAX_BYTES)return finish({problem:'The keys on standard input are too long.'});
   if(i<0){chunks.push(b);bytes+=b.length;return;}
   if(i<b.length-1)return finish(oneLine);
   chunks.push(b.subarray(0,i));
   line=Buffer.concat(chunks).toString('utf8').replace(/\r$/,'');
  });
  input.on('end',()=>finish(line!==null?{line}:bytes?{problem:'The keys on standard input did not end with a new line.'}:none));
  input.on('error',()=>finish(none));
 });
}
const base64=(v:unknown):v is string=>typeof v==='string'&&v.length<16384&&/^[A-Za-z0-9+/]+={0,2}$/.test(v);
const pem=(label:string,b64:string)=>`-----BEGIN ${label}-----\n${b64.replace(/(.{64})/g,'$1\n').replace(/\n$/,'')}\n-----END ${label}-----\n`;
let organiserBearer:string|undefined;
let participantTls:{key:string;cert:string}|null=null;
if(secretsMode==='stdin'){
 const read=await readSecretLine();
 if('problem' in read)throw new Error(read.problem);
 const line=read.line;
 let secrets:Record<string,unknown>;
 try{const v=JSON.parse(line);if(!v||typeof v!=='object'||Array.isArray(v))throw 0;secrets=v;}
 catch{throw new Error('The keys on standard input are not one JSON object.');}
 if(Object.keys(secrets).some(k=>!['organiserToken','tlsKey','tlsCert'].includes(k)))throw new Error('The keys on standard input hold an unknown entry.');
 const token=secrets.organiserToken;
 if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)||!config.localAdmin)throw new Error('The organiser key must be 32 bytes in base64url, for a loopback organiser listener.');
 organiserBearer=token;
 const tcpParticipant=!!participantOrigin&&!participantSocket;
 const {tlsKey,tlsCert}=secrets;
 if(tcpParticipant||tlsKey!==undefined||tlsCert!==undefined){
  if(!tcpParticipant||!base64(tlsKey)||!base64(tlsCert))throw new Error('The participant certificate is only for a TCP participant listener, which needs both a key and a certificate.');
  // The pair must belong together, checked before any file is created or listener bound.
  let matches=false;
  try{matches=new X509Certificate(Buffer.from(tlsCert,'base64')).checkPrivateKey(createPrivateKey({key:Buffer.from(tlsKey,'base64'),format:'der',type:'pkcs8'}))}catch{}
  if(!matches)throw new Error('The participant certificate does not match its key, or one of them is damaged.');
  participantTls={key:pem('PRIVATE KEY',tlsKey),cert:pem('CERTIFICATE',tlsCert)};
 }
}
const validPort=(p:number)=>Number.isInteger(p)&&p>0&&p<65536;
if(!validPort(port))throw new Error('Invalid organiser port.');
const windows=process.platform==='win32';
if(participantOrigin){
 if(!['localhost','127.0.0.1','[::1]'].includes(origin.hostname)||process.env.ATTENDANCE_BIND&&process.env.ATTENDANCE_BIND!=='127.0.0.1')throw new Error('Participant mode requires the organiser listener to stay on loopback.');
 const publicOrigin=new URL(participantOrigin);
 if(publicOrigin.protocol!=='https:'||publicOrigin.origin!==participantOrigin||publicOrigin.host===origin.host||!participantSocket&&(!validPort(participantPort)||participantPort===port))throw new Error('Use a distinct exact HTTPS participant origin and a separate local port.');
 if(participantSocket){
  // A fresh absolute path in a private real folder (not a link); never a path that already exists.
  const dir=dirname(participantSocket);
  if(windows||!isAbsolute(participantSocket)||Buffer.byteLength(participantSocket)>=104)throw new Error('Use an absolute participant socket path in a private folder.');
  const st=lstatSync(dir);if(st.isSymbolicLink()||!st.isDirectory())throw new Error('The participant socket folder must be a real folder.');
  assertPrivateDir(dir,{message:'The participant socket folder must be private (700).'});
  let taken=true;try{lstatSync(participantSocket)}catch{taken=false}
  if(taken)throw new Error('The participant socket path is already in use.');
 }
}
if(!windows)process.umask(0o077);
// The host secret is checked (and created when missing) before the register is created, so a damaged or shared one
// refuses the start without leaving a register behind.
const hostSecret=hostSecretPath?loadHostSecret(hostSecretPath):undefined;
// No link anywhere from the data root to the database (the desktop app passes its data folder; otherwise the database's
// own folder is the root), checked before anything is created, opened or chmod-ed, and again once the folder exists.
const databaseFile=resolve(databasePath),databaseDir=dirname(databaseFile);
const storageRoot=process.env.ATTENDANCE_DATA_ROOT?resolve(process.env.ATTENDANCE_DATA_ROOT):databaseDir;
const sqliteFiles=[databaseFile,`${databaseFile}-wal`,`${databaseFile}-shm`];
if(process.env.ATTENDANCE_DATA_ROOT||existsSync(databaseDir))for(const f of sqliteFiles)assertContained(storageRoot,f);
mkdirSync(databaseDir,{recursive:true,mode:0o700});
for(const f of sqliteFiles)assertContained(storageRoot,f);
// POSIX: the directory must be mode 700. Windows: its access list must allow only this user, SYSTEM and Administrators
// (see server/private-path.ts); mode bits do not exist there, so the check is the ACL, never skipped.
assertPrivateDir(databaseDir);
// An existing register and its SQLite journal files must already be private plain files (POSIX 0600; Windows ACL).
const existingFiles:PrivateEntry[]=sqliteFiles.filter(f=>{try{lstatSync(f);return true}catch{return false}}).map(f=>({path:f,kind:'file'}));
assertPrivatePaths(existingFiles,{message:'The register files must be private to this account.'});
const store=new AttendanceStore(databaseFile,workshop);
// Permissions are set on the opened register (never by path), after the containment check is repeated.
chmodNoFollow(databaseFile,0o600,'file',{recheck:()=>assertContained(storageRoot,databaseFile)});
// The desktop app runs the service as a compiled sidecar, whose built interface sits beside the executable.
const assets=process.env.ATTENDANCE_ASSETS_PATH?resolve(process.env.ATTENDANCE_ASSETS_PATH):resolve(import.meta.dir,'../dist');
// Construct and validate both handlers before binding either listener.
const handler=createHandler(store,{...config,participantOrigin:participantOrigin||undefined,hostSecret,...(organiserBearer!==undefined?{organiserBearer}:{})},assets);
const participantHandler=participantOrigin?createHandler(store,{origin:participantOrigin,users:{},participantOnly:true,hostSecret},assets):null;
const server=Bun.serve({hostname:process.env.ATTENDANCE_BIND??'127.0.0.1',port,maxRequestBodySize:300000,fetch:handler});
console.log(`Workshop check-in for "${workshop.title}" (${workshop.date}) listening on ${server.url}; configured browser origin ${config.origin}.`);
if(participantHandler){
 // First start opens the default 30-minute window; a restart keeps whatever window the organiser last set.
 // The listener stays up after closing so the organiser can reopen at the same address; closed means API 410.
 const checkIn=store.initParticipantWindow(30);
 // 64 KB for paired-iPad uploads; browser participant writes keep their own 4 KB limit in the handler.
 const participant=participantSocket
  ?Bun.serve({unix:participantSocket,maxRequestBodySize:65536,fetch:participantHandler})
  :Bun.serve({hostname:'127.0.0.1',port:participantPort,maxRequestBodySize:65536,fetch:participantHandler,...(participantTls?{tls:participantTls}:{})});
 if(workshop.publicOrigin)console.log(`Participant link through the edge proxy: ${workshop.publicOrigin}${workshop.participantBasePath}/`);
 console.log(`Names-only participant listener: ${participantSocket?'private socket':participant.url}${participantTls?' (pinned certificate)':''}. Check-in ${checkIn.open?`open until ${new Date(checkIn.closesAt!).toLocaleTimeString('en-GB')}`:'closed'}; open, close or reopen it from the local register.`);
}
