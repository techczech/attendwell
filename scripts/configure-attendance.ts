import {createInterface} from 'node:readline';
import {Writable} from 'node:stream';
import {resolve,dirname} from 'node:path';
import {mkdirSync,chmodSync} from 'node:fs';
const target=process.argv[2];if(!target||!process.stdin.isTTY)throw new Error('Run interactively with a private configuration-file destination.');
if(resolve(target).startsWith(resolve(import.meta.dir,'..')+'/'))throw new Error('Keep credential configuration outside the application folder.');
if(await Bun.file(target).exists())throw new Error('Configuration already exists. Choose a new file to preserve it.');
let muted=false;
const output=new Writable({write(chunk,_encoding,callback){if(!muted)process.stdout.write(chunk);callback()}});
const prompt=createInterface({input:process.stdin,output,terminal:true});
const ask=(label:string,secret=false)=>new Promise<string>(resolve=>{muted=false;prompt.question(label,value=>{muted=false;if(secret)process.stdout.write('\n');resolve(value)});muted=secret});
try{
 const origin=await ask('Browser origin (local loopback or approved HTTPS address): ');
 const users:Record<string,{hash:string;role:'owner'|'facilitator'}>={};
 for(const [label,role] of [['Roster owner','owner'],['Second facilitator','facilitator']] as const){
  const identity=(await ask(label+' identity: ')).trim();if(!identity||identity.length>100||Object.hasOwn(users,identity))throw new Error('Use unique facilitator identities.');
  const passphrase=await ask(label+' passphrase (hidden, at least 16 characters): ',true);
  const again=await ask('Repeat passphrase (hidden): ',true);
  if(passphrase.length<16||passphrase!==again)throw new Error('Passphrases must match and contain at least 16 characters.');
  users[identity]={role,hash:await Bun.password.hash(passphrase)};
 }
 const url=new URL(origin);if(url.origin!==origin||url.protocol!=='https:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Use an exact HTTPS origin or loopback.');
 const path=resolve(target);mkdirSync(dirname(path),{recursive:true,mode:0o700});await Bun.write(path,JSON.stringify({origin,users},null,2)+'\n');chmodSync(path,0o600);console.log('Private facilitator configuration saved. No credentials were printed.');
}finally{prompt.close()}
