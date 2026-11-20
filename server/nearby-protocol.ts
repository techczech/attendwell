import {createHash} from 'node:crypto';

export interface NearbyCheckIn {
 opId:string;
 nameId:string;
 at:string;
}

export interface NearbyReceipt { recorded:boolean }

// Source booking IDs can contain addresses. The iPad gets only a stable, opaque ID.
export const nearbyNameId=(id:string)=>createHash('sha256').update(id).digest('hex');

export function isNearbyCheckIn(input:unknown):input is NearbyCheckIn {
 const op=input as Partial<NearbyCheckIn>|null;
 return typeof op?.opId==='string'&&/^[A-Za-z0-9-]{8,80}$/.test(op.opId)
  &&typeof op.nameId==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(op.nameId)
  &&typeof op.at==='string'&&op.at.length<=40&&Number.isFinite(Date.parse(op.at));
}
