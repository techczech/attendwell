// Shared by the tests that start the real register service (server/start-attendance.ts) as a child process.
import {mkdirSync,rmSync,unlinkSync,rmdirSync} from 'node:fs';
import {join} from 'node:path';
import {createParticipantTls,participantTlsSecrets,pinnedStatus} from '../desktop/runtime/participant-tls.ts';

// The environment for a spawned service: PATH, plus on Windows what any Windows program needs to run (SystemRoot for
// sockets, the profile folders), as the desktop app gives its register (process-control.ts baseChildEnv). Without
// SystemRoot a Windows child cannot open a socket or start PowerShell, so the service never comes up.
const WINDOWS_KEEP=['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','HOMEDRIVE','HOMEPATH','COMSPEC','PATHEXT'];
export function serviceTestEnv(extra:Record<string,string>={}):Record<string,string>{
 const env:Record<string,string>={};
 if(process.platform==='win32'){for(const [k,v] of Object.entries(process.env))if(v!==undefined&&WINDOWS_KEEP.includes(k.toUpperCase()))env[k]=v;}
 else env.PATH=process.env.PATH??'';
 return {...env,...extra};
}

// Where the service's participant listener goes, as the desktop app sets it on this platform: macOS (and Linux) a Unix
// socket in a private folder; Windows loopback TCP serving HTTPS with a certificate made for this start, which only a
// client pinned to it reaches. `secrets` joins the organiser key on standard input; `status` asks the listener.
export type ParticipantTransport={env:Record<string,string>;secrets:Record<string,string>;upstream:{socketPath:string}|{port:number;fingerprint:string};status:(path:string,host:string)=>Promise<number>};
export function participantTransport(dir:string,port:number):ParticipantTransport{
 // ATTENDWELL_TEST_PARTICIPANT_TRANSPORT=tcp-tls runs the Windows path on another computer.
 if(process.platform!=='win32'&&process.env.ATTENDWELL_TEST_PARTICIPANT_TRANSPORT!=='tcp-tls'){
  mkdirSync(join(dir,'run'),{mode:0o700});const socket=join(dir,'run','p.sock');
  return {env:{ATTENDANCE_PARTICIPANT_SOCKET:socket},secrets:{},upstream:{socketPath:socket},
   status:async(path,host)=>(await fetch(`http://${host}${path}`,{unix:socket,headers:{Host:host}} as RequestInit)).status};
 }
 const tls=createParticipantTls();const target={port,fingerprint:tls.fingerprint};
 return {env:{ATTENDANCE_PARTICIPANT_PORT:String(port)},secrets:participantTlsSecrets(tls),upstream:target,status:(path,host)=>pinnedStatus(target,path,host)};
}

// Removes a test's temporary folder. Windows can hold a just-closed file for a moment (EBUSY or EPERM, often a virus
// scan of a new file), so removal is retried there for up to two seconds before it fails.
export function removeTempDir(dir:string){
 for(let i=0;;i++){
  try{rmSync(dir,{recursive:true,force:true});return;}
  catch(e){const code=(e as NodeJS.ErrnoException).code;if(process.platform!=='win32'||i>=20||(code!=='EBUSY'&&code!=='EPERM'))throw e;Bun.sleepSync(100);}
 }
}

// Removes a symbolic link itself, never its target. Windows keeps file and folder links apart, and Bun's rmSync on a link
// to a folder fails there (EFAULT): a folder link is removed with rmdir, a file link with unlink.
export function removeLink(link:string){
 try{unlinkSync(link);}
 catch(e){if(process.platform!=='win32')throw e;rmdirSync(link);}
}
