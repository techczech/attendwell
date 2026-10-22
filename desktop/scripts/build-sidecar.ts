// Build time only: compiles the attendance service into a single executable per platform with `bun build --compile`,
// and copies the built organiser and participant pages beside it.
//   bun desktop/scripts/build-sidecar.ts [--skip-web] [darwin-arm64 darwin-x64 windows-x64]
// Output (git-ignored): desktop/resources/sidecar/<platform>/attendwell-service[.exe] and …/dist/
import {execFileSync} from 'node:child_process';
import {cpSync,rmSync,mkdirSync,existsSync} from 'node:fs';
import path from 'node:path';
import {PLATFORM_KEYS,SIDECAR_NAME,type PlatformKey} from '../runtime/platform.ts';

const repo=path.resolve(import.meta.dirname,'..','..');
const BUN_TARGET:Record<PlatformKey,string>={'darwin-arm64':'bun-darwin-arm64','darwin-x64':'bun-darwin-x64','windows-x64':'bun-windows-x64'};

export function buildWeb(){
 execFileSync(process.execPath,['run','build'],{cwd:repo,stdio:'inherit'});
}

export function buildSidecar(key:PlatformKey){
 const outDir=path.join(repo,'desktop','resources','sidecar',key);
 rmSync(outDir,{recursive:true,force:true});mkdirSync(outDir,{recursive:true});
 const outfile=path.join(outDir,key==='windows-x64'?`${SIDECAR_NAME}.exe`:SIDECAR_NAME);
 execFileSync(process.execPath,['build','--compile',`--target=${BUN_TARGET[key]}`,'--minify',path.join(repo,'server','start-attendance.ts'),'--outfile',outfile],{cwd:repo,stdio:'inherit'});
 if(!existsSync(path.join(repo,'dist','index.html')))throw new Error('Build the interface first (bun run build).');
 cpSync(path.join(repo,'dist'),path.join(outDir,'dist'),{recursive:true});
 console.log(`${key}: ${path.relative(repo,outfile)}`);
 return outfile;
}

if(import.meta.main){
 const args=process.argv.slice(2);
 const keys=(args.filter(a=>!a.startsWith('--')).length?args.filter(a=>!a.startsWith('--')):PLATFORM_KEYS) as PlatformKey[];
 for(const k of keys)if(!PLATFORM_KEYS.includes(k))throw new Error(`Unknown platform ${k}.`);
 if(!args.includes('--skip-web'))buildWeb();
 for(const k of keys)buildSidecar(k);
}
