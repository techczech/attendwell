// Adding a pasted or imported name list to the register (docs/reference-roster-import.md, "Adding a name list").
// Pure: given who is already in the register, the lists added before and the rows of a new list, decides row by row what adding
// it would do. The store runs the same plan for the preview (nothing written) and for the write, inside one transaction, so the
// preview the organiser confirms is the change that happens. No imports beyond node:crypto, so the desktop app's fake register
// uses this same function.
import {createHash} from 'node:crypto';
import type {Booking} from './workshop-config';

/** One row of a list as the desktop app read it: its row number in the source, and the cells it mapped. */
export type NameRow={row:number;name:string;email:string;status?:string;date?:string|null};
export type SkipReason='no-name'|'name-too-long'|'bad-email'|'cancelled'|'other-date'|'no-status-label';
export type RowResult={
 row:number;name:string;email:string;
 /** added: a new person. merged: the same email as an earlier row of this list (`mergedWith`). known: the same email as someone
  *  already in the register. skipped: not added (`reason`). */
 result:'added'|'merged'|'known'|'skipped';
 mergedWith?:number;reason?:SkipReason;
 /** For other-date: the row's date (YYYY-MM-DD). */
 date?:string;
 booking?:Booking;sourceStatus?:string;
};
/** What the register keeps about each list added: where it came from and what it did. Never a copy of the list. */
// Every list ever added to a register, by listKey: never truncated (each write adds at least one person, so it stays small).
export type AddedLists=Record<string,{addedAt:string;filename:string|null}>;
export type NameListRecord={kind:'paste'|'file';filename:string|null;sha256:string|null;listKey:string;addedAt:string;rows:number;added:number;merged:number;known:number;skipped:number};
export type NamesPlan={
 rows:RowResult[];
 counts:{added:number;merged:number;known:number;skipped:number;blank:number};
 /** Names that would be on the list more than once with no email to tell them apart: both are kept, and a self check-in under
  *  that name is held for the organiser (store-attendance duplicate-name). */
 sameName:string[];
 /** People on the register after adding. */
 total:number;
 /** Identity of the list's content: the same rows give the same key, however they were pasted or saved. */
 listKey:string;
 /** This exact list was added before: adding it again changes nothing. */
 alreadyAdded:{addedAt:string;filename:string|null}|null;
 /** Adding would take the register past its limit. */
 full:boolean;
};

export const MAX_REGISTER=500;
export const MAX_LIST_ROWS=2000;
const EMAIL=/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
const DAY=/^\d{4}-\d{2}-\d{2}$/;

/** Plain one-line text: control characters become spaces, runs of white space one space. */
export const cleanText=(s:string)=>s.replace(/[\x00-\x1f\x7f\u2028\u2029]/g,' ').replace(/\s+/g,' ').trim();
/** Email as the register keeps it: trimmed, lower case, without mailto: or angle brackets. Plus addresses stay as written. */
export const cleanEmail=(s:string)=>cleanText(s).replace(/^mailto:/i,'').replace(/^<(.*)>$/,'$1').trim().toLowerCase();
export const nameKey=(s:string)=>s.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en-GB');

/**
 * A booking status from a list: a label the workshop maps wins; otherwise words decide (cancelled, withdrawn, declined or refunded
 * is cancelled; anything with "wait" is the waiting list; anything else, blank included, is a confirmed place). Returns the
 * workshop label the register stores, or null when the workshop maps no label to that booking.
 */
export function classifyStatus(status:string|undefined,statuses:Record<string,Booking>):{booking:Booking;sourceStatus:string|null}{
 const s=cleanText(status??'');
 const exact=Object.keys(statuses).find(k=>k.toLowerCase()===s.toLowerCase());
 if(s&&exact)return {booking:statuses[exact]!,sourceStatus:exact};
 const booking:Booking=/cancel|withdr|declin|refund/i.test(s)?'cancelled':/wait/i.test(s)?'waiting':'confirmed';
 return {booking,sourceStatus:Object.keys(statuses).find(k=>statuses[k]===booking)??null};
}

export function listKeyOf(rows:NameRow[]):string{
 const canon=rows.map(r=>[cleanText(r.name),cleanEmail(r.email),cleanText(r.status??''),r.date??'']).filter(r=>r.some(Boolean));
 return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

export function planNames(input:{existing:{name:string;email:string}[];addedLists:AddedLists;rows:NameRow[];workshopDate:string;statuses:Record<string,Booking>;limit?:number}):NamesPlan{
 const known=new Map<string,true>();
 for(const p of input.existing){const e=cleanEmail(p.email);if(e)known.set(e,true);}
 const firstByEmail=new Map<string,number>();
 const rows:RowResult[]=[];let blank=0;
 for(const r of input.rows){
  const name=cleanText(r.name);const email=cleanEmail(r.email);
  if(!name&&!email&&!cleanText(r.status??'')){blank+=1;continue;}
  const base={row:r.row,name,email};
  if(!name){rows.push({...base,result:'skipped',reason:'no-name'});continue;}
  if(name.length>200){rows.push({...base,name:name.slice(0,200),result:'skipped',reason:'name-too-long'});continue;}
  if(email&&(email.length>254||!EMAIL.test(email))){rows.push({...base,result:'skipped',reason:'bad-email'});continue;}
  if(r.date&&DAY.test(r.date)&&r.date!==input.workshopDate){rows.push({...base,result:'skipped',reason:'other-date',date:r.date});continue;}
  const {booking,sourceStatus}=classifyStatus(r.status,input.statuses);
  if(booking==='cancelled'){rows.push({...base,result:'skipped',reason:'cancelled'});continue;}
  if(!sourceStatus){rows.push({...base,result:'skipped',reason:'no-status-label'});continue;}
  if(email&&known.has(email)){rows.push({...base,result:'known',booking,sourceStatus});continue;}
  if(email&&firstByEmail.has(email)){rows.push({...base,result:'merged',mergedWith:firstByEmail.get(email)!,booking,sourceStatus});continue;}
  if(email)firstByEmail.set(email,r.row);
  rows.push({...base,result:'added',booking,sourceStatus});
 }
 const count=(k:RowResult['result'])=>rows.filter(r=>r.result===k).length;
 const added=rows.filter(r=>r.result==='added');
 // Same name twice with nothing to tell them apart, counting the people already in the register.
 const seen=new Map<string,{name:string;n:number}>();
 for(const n of [...input.existing.map(p=>p.name),...added.map(r=>r.name)]){const k=nameKey(n);const e=seen.get(k);if(e)e.n+=1;else seen.set(k,{name:cleanText(n),n:1});}
 const addedKeys=new Set(added.map(r=>nameKey(r.name)));
 const sameName=[...seen.entries()].filter(([k,v])=>v.n>1&&addedKeys.has(k)).map(([,v])=>v.name);
 const listKey=listKeyOf(input.rows);
 const prior=Object.prototype.hasOwnProperty.call(input.addedLists,listKey)?input.addedLists[listKey]:undefined;
 const total=input.existing.length+added.length;
 return {rows,counts:{added:added.length,merged:count('merged'),known:count('known'),skipped:count('skipped'),blank},sameName,total,listKey,
  alreadyAdded:prior?{addedAt:prior.addedAt,filename:prior.filename}:null,full:total>(input.limit??MAX_REGISTER)};
}
