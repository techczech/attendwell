// electron-builder afterPack hook (macOS): signs the two programs AttendWell ships beside the app before electron-builder
// signs the app itself, each with only the entitlements it needs, under the hardened runtime and with a secure timestamp:
//   Contents/Resources/sidecar/<platform>/attendwell-service   build/entitlements.sidecar.plist (JIT for Bun)
//   Contents/Resources/cloudflared/<platform>/cloudflared     no entitlements (a Go program)
// electron-builder.yml signIgnore keeps its own signing pass from re-signing them with the helpers' entitlements; the app's
// signature then seals them as they are. Unsigned builds (no mac.identity) are left unsigned.
const {execFileSync}=require('node:child_process');
const {existsSync,readdirSync}=require('node:fs');
const path=require('node:path');

const qualified=id=>/^[0-9A-F]{40}$/i.test(id)||id.includes(':')?id:`Developer ID Application: ${id}`;

exports.default=async function signBundledPrograms(context){
 if(context.electronPlatformName!=='darwin')return;
 const identity=context.packager.platformSpecificBuildOptions.identity;
 if(!identity)return;
 const app=path.join(context.appOutDir,`${context.packager.appInfo.productFilename}.app`);
 const resources=path.join(app,'Contents','Resources');
 const sidecarEntitlements=path.join(context.packager.info.buildResourcesDir,'entitlements.sidecar.plist');
 const programs=[];
 for(const [folder,name,entitlements] of [['sidecar','attendwell-service',sidecarEntitlements],['cloudflared','cloudflared',null]]){
  const base=path.join(resources,folder);
  if(!existsSync(base))continue;
  for(const platform of readdirSync(base)){const file=path.join(base,platform,name);if(existsSync(file))programs.push([file,entitlements]);}
 }
 if(programs.length!==2)throw new Error(`Expected the register program and cloudflared in ${resources}; found ${programs.length}.`);
 for(const [file,entitlements] of programs){
  execFileSync('codesign',['--force','--sign',qualified(identity),'--options','runtime','--timestamp',...(entitlements?['--entitlements',entitlements]:[]),file],{stdio:'inherit'});
 }
};
