// Build time only: downloads the pinned cloudflared for each platform into desktop/resources/cloudflared/<platform>/,
// refusing anything whose SHA-256 differs from desktop/third-party/cloudflared.json. The app never downloads it at runtime.
//   bun desktop/scripts/fetch-cloudflared.ts [darwin-arm64 darwin-x64 windows-x64]
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync,chmodSync,existsSync,renameSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PLATFORM_KEYS,type PlatformKey} from '../runtime/platform.ts';

const desktop=path.resolve(import.meta.dirname,'..');
const pin=JSON.parse(readFileSync(path.join(desktop,'third-party','cloudflared.json'),'utf8'));
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');

async function download(url:string):Promise<Uint8Array>{
 const res=await fetch(url,{redirect:'follow'});
 if(!res.ok)throw new Error(`Download failed (${res.status}): ${url}`);
 return new Uint8Array(await res.arrayBuffer());
}

export async function fetchCloudflared(key:PlatformKey){
 const p=pin.platforms[key];if(!p)throw new Error(`No pinned cloudflared for ${key}.`);
 const outDir=path.join(desktop,'resources','cloudflared',key);
 const outFile=path.join(outDir,key==='windows-x64'?'cloudflared.exe':'cloudflared');
 if(existsSync(outFile)&&sha(readFileSync(outFile))===p.binarySha256){console.log(`${key}: cloudflared ${pin.version} already present and verified.`);return outFile;}
 const archive=await download(p.url);
 if(sha(archive)!==p.archiveSha256)throw new Error(`${key}: checksum mismatch for ${p.url}. Refusing it.`);
 // Untrusted download: unpacked in its own empty folder, and only the expected single file is taken.
 const work=mkdtempSync(path.join(tmpdir(),'attendwell-cloudflared-'));
 try{
  let binary:Uint8Array;
  if(p.archive==='tgz'){
   const tgz=path.join(work,'archive.tgz');writeFileSync(tgz,archive);
   const unpack=path.join(work,'unpacked');mkdirSync(unpack);
   const listing=execFileSync('tar',['-tzf',tgz],{encoding:'utf8'}).split('\n').filter(Boolean);
   if(listing.length!==1||listing[0].replace(/^\.\//,'')!=='cloudflared')throw new Error(`${key}: unexpected archive contents: ${listing.join(', ')}`);
   execFileSync('tar',['-xzf',tgz,'-C',unpack]);
   binary=readFileSync(path.join(unpack,'cloudflared'));
  }else binary=archive;
  if(sha(binary)!==p.binarySha256)throw new Error(`${key}: binary checksum mismatch. Refusing it.`);
  mkdirSync(outDir,{recursive:true});
  const tmp=outFile+'.tmp';writeFileSync(tmp,binary);chmodSync(tmp,0o755);renameSync(tmp,outFile);
 }finally{rmSync(work,{recursive:true,force:true})}
 console.log(`${key}: cloudflared ${pin.version} verified (${p.binarySha256.slice(0,12)}…).`);
 return outFile;
}

export async function fetchLicence(){
 const out=path.join(desktop,'resources','cloudflared','LICENSE');
 const text=await download(pin.licenceText.url);
 if(sha(text)!==pin.licenceText.sha256)throw new Error('cloudflared licence text checksum mismatch.');
 mkdirSync(path.dirname(out),{recursive:true});writeFileSync(out,text);
 writeFileSync(path.join(desktop,'resources','cloudflared','about.json'),JSON.stringify({name:pin.name,version:pin.version,licence:pin.licence,homepage:pin.homepage,copyright:pin.copyright},null,2)+'\n');
}

if(import.meta.main){
 const keys=(process.argv.slice(2).length?process.argv.slice(2):PLATFORM_KEYS) as PlatformKey[];
 for(const k of keys)if(!PLATFORM_KEYS.includes(k))throw new Error(`Unknown platform ${k}.`);
 for(const k of keys)await fetchCloudflared(k);
 await fetchLicence();
}
