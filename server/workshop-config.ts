// Runtime workshop configuration: what this register is for and how its public participant link is shaped.
// Holds no credentials. Every value is validated here once; the store, HTTP handler and scripts read the result.
export type Booking='confirmed'|'cancelled'|'waiting';
export type WorkshopConfig={
 sessionId:string;title:string;date:string;startTime:string;endTime:string;
 organiserHelp:string;participantBasePath:string;publicOrigin:string|null;
 // Source booking label -> normalised booking. Import rejects a record whose label and booking disagree.
 sourceStatuses:Record<string,Booking>;
};
// Clearly fictional defaults for previews and tests. A real service must name its session, date and title explicitly.
export const exampleWorkshop:WorkshopConfig=Object.freeze({
 sessionId:'example-session-001',title:'Example Hands-On Workshop',date:'2030-01-15',startTime:'13:00',endTime:'16:00',
 organiserHelp:'Please speak to the workshop organisers.',participantBasePath:'/example-check-in',publicOrigin:null,
 sourceStatuses:Object.freeze({'Confirmed':'confirmed','Cancelled':'cancelled','Waiting list':'waiting'}) as Record<string,Booking>,
});
// Paths the participant page, service worker or organiser register already use; a public prefix must not shadow them.
const reservedPaths=new Set(['/check-in','/api','/assets','/sw.js','/index.html']);
export const MANUAL_SOURCE_STATUS='Manual addition';
const plain=(x:unknown,max:number):x is string=>typeof x==='string'&&!!x.trim()&&x.length<=max&&!/[\x00-\x1f\x7f<>]/.test(x);
// An impossible month or day (2030-13-15) is an invalid Date, whose toISOString would throw a RangeError; check first.
const realDate=(s:string)=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;const d=new Date(s+'T00:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().startsWith(s)};
const clock=(s:unknown):s is string=>typeof s==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(s);
export const validBasePath=(p:unknown):p is string=>typeof p==='string'&&/^\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(p)&&!reservedPaths.has(p);
export class WorkshopConfigError extends Error {}
// `required` fields must be present; everything else falls back to the fictional example.
const required=['sessionId','title','date'] as const;
export function parseWorkshopConfig(input:unknown,{allowExampleIdentity=false}={}):WorkshopConfig{
 if(!input||typeof input!=='object'||Array.isArray(input))throw new WorkshopConfigError('Workshop configuration must be a JSON object.');
 const raw=input as Record<string,unknown>;
 const known=new Set(Object.keys(exampleWorkshop));
 const unknown=Object.keys(raw).filter(k=>!known.has(k));
 if(unknown.length)throw new WorkshopConfigError(`Unknown workshop configuration field: ${unknown.join(', ')}.`);
 if(!allowExampleIdentity)for(const k of required)if(raw[k]===undefined)throw new WorkshopConfigError(`Set "${k}" in the workshop configuration.`);
 const c={...exampleWorkshop,...raw} as Record<string,unknown>;
 const fail=(m:string)=>{throw new WorkshopConfigError(m)};
 if(typeof c.sessionId!=='string'||!/^[A-Za-z0-9._-]{1,64}$/.test(c.sessionId))fail('"sessionId" must be 1–64 letters, digits, dots, dashes or underscores.');
 if(!plain(c.title,200))fail('"title" must be plain text up to 200 characters.');
 if(typeof c.date!=='string'||!realDate(c.date))fail('"date" must be a real calendar date written YYYY-MM-DD.');
 if(!clock(c.startTime)||!clock(c.endTime)||c.startTime>=c.endTime)fail('"startTime" and "endTime" must be HH:MM (24-hour), start before end.');
 if(!plain(c.organiserHelp,300))fail('"organiserHelp" must be plain text up to 300 characters.');
 if(!validBasePath(c.participantBasePath))fail('"participantBasePath" must look like /my-session: lower-case letters, digits and dashes, not a reserved path.');
 if(c.publicOrigin!==null){
  let url:URL|null=null;try{url=new URL(c.publicOrigin as string)}catch{}
  if(!url||url.protocol!=='https:'||url.origin!==c.publicOrigin)fail('"publicOrigin" must be an exact HTTPS origin such as https://check-in.example.org, or null.');
 }
 const statuses=c.sourceStatuses as Record<string,unknown>;
 if(!statuses||typeof statuses!=='object'||Array.isArray(statuses)||!Object.keys(statuses).length||Object.keys(statuses).length>20)fail('"sourceStatuses" must map 1–20 source labels to confirmed, cancelled or waiting.');
 for(const [label,booking] of Object.entries(statuses))if(!plain(label,100)||label===MANUAL_SOURCE_STATUS||!['confirmed','cancelled','waiting'].includes(booking as string))fail(`"sourceStatuses" entry "${label}" is invalid.`);
 return Object.freeze({...c,sourceStatuses:Object.freeze({...statuses})} as WorkshopConfig);
}
// Fields safe to show on the names-only participant page (and cache on the participant device).
export const publicWorkshop=(w:WorkshopConfig)=>({title:w.title,date:w.date,startTime:w.startTime,endTime:w.endTime,organiserHelp:w.organiserHelp});
export type PublicWorkshop=ReturnType<typeof publicWorkshop>;
