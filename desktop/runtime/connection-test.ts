// Settings > Connection > Test connection: asks the current public check-in address to answer a request that only this
// runtime's gateway can answer (participant-gateway.ts, expectProbe). The request carries a random single-use token and
// nothing else: no name, pairing code, key or workshop. Success takes both the expected answer and the gateway's own
// receipt of the token, so another server sending the same bytes fails. A success means that address reached this
// laptop's gateway just now.
import {randomBytes} from 'node:crypto';
import {PROBE_ANSWER,PROBE_PREFIX,type ParticipantGateway} from './participant-gateway.ts';

export type ConnectionTestResult={ok:true}|{ok:false;reason:string;advice:string};
export const PROBE_TIMEOUT_MS=8000;

const fail=(reason:string,advice:string):ConnectionTestResult=>({ok:false,reason,advice});
const IDLE_ADVICE='There is no check-in address to test. Open a workshop and start check-in first; the address exists only while check-in is open.';

// Answers when no probe can be made: the session or the tunnel is not in a state with a live public address.
export function noAddressResult(session:string,tunnel:{state:string;message?:string}):ConnectionTestResult{
 if(session==='idle')return fail('no-session',IDLE_ADVICE);
 if(session!=='running'||tunnel.state==='starting')return fail('not-ready','The check-in address is still opening. Try again in a minute.');
 if(tunnel.state==='reconnecting')return fail('reconnecting','The check-in address is reconnecting. Try again in a minute.');
 if(tunnel.state==='failed')return fail('failed',tunnel.message||'The check-in address is not connected. Use Try again on the session screen, or a phone hotspot.');
 return fail('no-address',IDLE_ADVICE);
}

// The response body up to the length of the expected answer; a longer body is not the answer and is not read further.
async function readAnswer(res:Response):Promise<string|null>{
 if(!res.body)return null;
 const limit=Buffer.byteLength(PROBE_ANSWER);
 const reader=res.body.getReader();const parts:Uint8Array[]=[];let size=0;
 for(;;){
  const {done,value}=await reader.read();
  if(done)return Buffer.concat(parts).toString('utf8');
  size+=value.length;if(size>limit)return null;
  parts.push(value);
 }
}

export async function probeAddress(o:{url:string;gateway:ParticipantGateway;fetchImpl:typeof fetch;timeoutMs?:number;signal:AbortSignal;current:()=>boolean}):Promise<ConnectionTestResult>{
 const token=randomBytes(16).toString('hex');
 const receipt=o.gateway.expectProbe(token);
 const timeout=AbortSignal.timeout(o.timeoutMs??PROBE_TIMEOUT_MS);
 const finished=new AbortController();
 const signal=AbortSignal.any([o.signal,timeout,finished.signal]);
 // Every wait below ends with the signal, whether or not the fetch honours it, so the deadline and a cancel always hold.
 const aborted=new Promise<never>((_,reject)=>{
  const stop=()=>reject(new Error('Probe aborted.'));
  if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});
 });
 aborted.catch(()=>{});
 // A cancel is final: the address can come back unchanged after it, so `current` alone cannot clear a cancelled probe.
 const stale=()=>o.signal.aborted||!o.current();
 const changed=()=>fail('changed','The check-in address changed while testing. Run the test again.');
 try{
  const res=await Promise.race([o.fetchImpl(new URL(PROBE_PREFIX+token,o.url).href,{method:'GET',redirect:'manual',cache:'no-store',headers:{Accept:'application/json'},signal}),aborted]);
  const answer=res.status===200?await Promise.race([readAnswer(res),aborted]):null;
  if(stale())return changed();
  if(answer===PROBE_ANSWER&&receipt.received)return {ok:true};
  if(res.status<500)return fail('other-server','The address answered, but not from AttendWell on this laptop. Wait a minute and test again, or restart check-in.');
  return fail('not-ready','The address is not answering yet (Cloudflare reported a problem). Wait a few seconds and test again.');
 }catch{
  if(stale())return changed();
  if(timeout.aborted)return fail('timeout','The address did not answer within a few seconds. Check the internet connection, or try a phone hotspot. Some school and office networks block Cloudflare.');
  return fail('unreachable','This laptop could not reach the check-in address. If the address just opened, wait a minute and test again. Check the internet connection, or try a phone hotspot. Some school and office networks block Cloudflare.');
 }finally{receipt.withdraw();finished.abort();}
}
