// Shared harness for paired-iPad tests: one register, a loopback organiser handler and a participant handler on a fake clock.
import {expect} from 'bun:test';
import {createHash,randomBytes} from 'node:crypto';
import {AttendanceStore} from '../server/store-attendance';
import {createHandler} from '../server/http-attendance';
import {fixture} from './fixtures-attendance';
export const organiserOrigin='http://127.0.0.1:4318';
export const participantOrigin='https://names.example.org';
export const newCredential=()=>'dc_'+randomBytes(32).toString('base64url');
export const hashOf=(credential:string)=>createHash('sha256').update(credential).digest('hex');

// The iPad's names-only rule (DeviceProtocol.privacyViolations in the iPad repo): no email/booking/source keys, no email-like values.
export function privacyViolations(value:unknown,path='$'):string[]{
 if(Array.isArray(value))return value.flatMap((v,i)=>privacyViolations(v,`${path}[${i}]`));
 if(value&&typeof value==='object')return Object.entries(value).flatMap(([k,v])=>{const n=k.toLowerCase().replace(/[^a-z0-9]/g,'');const bad=n.includes('email')||n.includes('booking')||n==='source'||n.endsWith('source');return [...(bad?[`${path}.${k}`]:[]),...privacyViolations(v,`${path}.${k}`)]});
 return typeof value==='string'&&/[^\s@]+@[^\s@]+\.[^\s@]+/.test(value)?[path]:[];
}

export function setup({open=true,participantLink=true,hostSecret}:{open?:boolean;participantLink?:boolean;hostSecret?:Buffer}={}){
 const clock={t:Date.parse('2030-01-15T12:50:00Z')};const now=()=>clock.t;
 const store=new AttendanceStore(':memory:');store.import(fixture,'test');store.initParticipantWindow(60,now());if(!open)store.closeParticipantWindow('test',now());
 const organiser=createHandler(store,{origin:organiserOrigin,users:{},localAdmin:true,participantOrigin:participantLink?participantOrigin:undefined,now,hostSecret},'/tmp/missing-assets');
 const participant=createHandler(store,{origin:participantOrigin,users:{},participantOnly:true,now,hostSecret},'/tmp/missing-assets');
 const org=async(method:string,path:string,data?:unknown)=>{
  const r=await organiser(new Request(organiserOrigin+path,{method,headers:method==='GET'?{}:{Origin:organiserOrigin,'Content-Type':'application/json','X-Attendance-Request':'1'},body:data===undefined?undefined:JSON.stringify(data)}));
  return {status:r.status,body:await r.json() as any};
 };
 // Device request shaped like the iPad's NativeDeviceAPI; every JSON answer is checked against the names-only rule.
 const dev=async(name:string,opts:{body?:unknown;bearer?:string|null;headers?:Record<string,string>;method?:string;raw?:string}={})=>{
  const method=opts.method??(opts.body===undefined&&opts.raw===undefined?'GET':'POST');
  const headers:Record<string,string>={Accept:'application/json','Content-Type':'application/json','X-Attendance-Device-Protocol':'1',...(opts.bearer?{Authorization:'Bearer '+opts.bearer}:{}),...opts.headers};
  const r=await participant(new Request(participantOrigin+'/device/v1/'+name,{method,headers,body:opts.raw??(opts.body===undefined?undefined:JSON.stringify(opts.body))}));
  expect(r.headers.get('content-type')?.split(';')[0]).toBe('application/json');
  expect(r.headers.get('access-control-allow-origin')).toBeNull();expect(r.headers.get('cache-control')).toBe('no-store');
  const body=await r.json() as any;expect(privacyViolations(body)).toEqual([]);
  return {status:r.status,body,headers:r.headers};
 };
 const pairing=async(data:unknown={})=>{const r=await org('POST','/api/organiser/pairing-sessions',data);expect(r.status).toBe(200);return r.body};
 // Full first pairing as the iPad does it: hello with the code, then pair with its own credential's hash.
 const pairDevice=async(data:unknown={},bearer?:string)=>{
  const s=await pairing(data);const credential=newCredential();
  expect((await dev('hello',{body:{code:s.shortCode}})).status).toBe(200);
  const r=await dev('pair',{body:{code:s.shortCode.replace('-',''),credentialHash:hashOf(credential)},bearer});expect(r.status).toBe(201);
  return {credential,deviceId:r.body.deviceId as string,session:s};
 };
 const roster=async(bearer:string)=>(await dev('roster',{bearer})).body;
 const op=(personToken:string,baseRevision:number,opId:string=crypto.randomUUID())=>({opId,personToken,baseRevision,windowRevisionSeen:1,recordedAt:new Date(clock.t).toISOString()});
 const send=async(bearer:string,...operations:unknown[])=>dev('operations',{bearer,body:{eventId:(await roster(bearer)).eventId,operations}});
 return {clock,store,organiser,participant,org,dev,pairing,pairDevice,roster,op,send};
}
