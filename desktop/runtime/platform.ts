// Which bundled binaries belong to this computer, and where they sit under the resources folder.
import path from 'node:path';

export type PlatformKey='darwin-arm64'|'darwin-x64'|'windows-x64';
export const PLATFORM_KEYS:readonly PlatformKey[]=['darwin-arm64','darwin-x64','windows-x64'];

export function platformKey(platform:NodeJS.Platform=process.platform,arch:string=process.arch):PlatformKey{
 if(platform==='darwin'&&(arch==='arm64'||arch==='x64'))return `darwin-${arch}`;
 if(platform==='win32'&&arch==='x64')return 'windows-x64';
 throw new Error(`AttendWell does not run on ${platform} ${arch}.`);
}

const exe=(key:PlatformKey,name:string)=>key==='windows-x64'?`${name}.exe`:name;
export const SIDECAR_NAME='attendwell-service';

// Layout shared by the build scripts (desktop/resources/…) and the packaged app (process.resourcesPath/…):
//   <resourcesRoot>/sidecar/<platform>/attendwell-service[.exe]   compiled service
//   <resourcesRoot>/sidecar/<platform>/dist/                       built organiser and participant pages
//   <resourcesRoot>/cloudflared/<platform>/cloudflared[.exe]       pinned, checksum-verified cloudflared
export function resourcePaths(resourcesRoot:string,key:PlatformKey=platformKey()){
 const sidecarDir=path.join(resourcesRoot,'sidecar',key);
 return {
  sidecar:path.join(sidecarDir,exe(key,SIDECAR_NAME)),
  assets:path.join(sidecarDir,'dist'),
  cloudflared:path.join(resourcesRoot,'cloudflared',key,exe(key,'cloudflared')),
 };
}
