// The host secret behind organiser-proof keys (docs/reference-device-api.md, "Organiser proof").
// One file of 32 random bytes that outlives any one register database, so a laptop can prove itself to an iPad it paired in an
// earlier session. Created owner-only if missing; refused if the path is a symbolic link (on every platform) or is not a private
// regular file of exactly 32 bytes.
import {openSync,closeSync,writeSync,readSync,fstatSync,lstatSync,fsyncSync,unlinkSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {CREATE_NEW_FLAGS,READ_NOFOLLOW_FLAGS} from './private-path';

export const HOST_SECRET_BYTES=32;

export function loadHostSecret(path:string,platform:string=process.platform):Buffer{
 const posix=platform!=='win32';
 // Exclusive create: never truncates or replaces an existing secret, and never follows a planted symlink.
 let created=false;
 try{
  const fd=openSync(path,CREATE_NEW_FLAGS,0o600);created=true; // flags: see private-path.ts
  try{writeSync(fd,randomBytes(HOST_SECRET_BYTES));fsyncSync(fd)}catch(err){closeSync(fd);unlinkSync(path);throw err}
  closeSync(fd);
 }catch(err){if(created||(err as NodeJS.ErrnoException)?.code!=='EEXIST')throw err}
 // On every platform: the path itself must not be a symlink (lstat), and the file opened must be the very file lstat saw
 // (same device and inode), so a link swapped in between is refused too. O_NOFOLLOW adds the same guard where the platform has it.
 // bigint stats: Windows file ids can exceed 2^53.
 const link=lstatSync(path,{bigint:true});
 if(link.isSymbolicLink())throw new Error('The host secret must be a regular file, not a symbolic link.');
 if(!link.isFile())throw new Error('The host secret must be a regular file.');
 const fd=openSync(path,READ_NOFOLLOW_FLAGS);
 try{
  const st=fstatSync(fd,{bigint:true});
  if(!st.isFile())throw new Error('The host secret must be a regular file.');
  if(st.dev!==link.dev||st.ino!==link.ino)throw new Error('The host secret file changed while it was being opened.');
  // POSIX only: Windows mode bits do not describe its access lists; there the desktop app keeps the file in its private data folder.
  if(posix&&st.mode&0o077n)throw new Error('The host secret file must be readable by its owner only (chmod 600).');
  if(posix&&typeof process.getuid==='function'&&st.uid!==BigInt(process.getuid()))throw new Error('The host secret file must belong to the user running the service.');
  if(st.size!==BigInt(HOST_SECRET_BYTES))throw new Error(`The host secret file must hold exactly ${HOST_SECRET_BYTES} bytes.`);
  const out=Buffer.alloc(HOST_SECRET_BYTES);
  if(readSync(fd,out,0,HOST_SECRET_BYTES,0)!==HOST_SECRET_BYTES)throw new Error('The host secret file could not be read in full.');
  return out;
 }finally{closeSync(fd)}
}
