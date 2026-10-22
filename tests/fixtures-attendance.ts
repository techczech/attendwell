import type {RosterImport} from '../server/store-attendance';
import {exampleWorkshop} from '../server/workshop-config';
// Fictional roster for the fictional example workshop; statuses use the example source labels.
export const fixture: RosterImport={sessionId:exampleWorkshop.sessionId,date:exampleWorkshop.date,source:{filename:'fictional.json',sha256:'a'.repeat(64),exportedAt:'2029-12-20T21:36:00Z'},participants:[
{id:'a',name:'Alex Example',email:'alex@example.org',booking:'confirmed',sourceStatus:'Confirmed'},
{id:'b',name:'Bea Example',email:'bea@example.org',booking:'confirmed',sourceStatus:'Confirmed'},
{id:'c',name:'Cancelled Example',email:'cancel@example.org',booking:'cancelled',sourceStatus:'Cancelled'},
{id:'w',name:'Waiting Example',email:'wait@example.org',booking:'waiting',sourceStatus:'Waiting list'},
{id:'d',name:'Alex Duplicate',email:'ALEX@example.org',booking:'confirmed',sourceStatus:'Confirmed'},
{id:'m',name:'Missing Address',email:'',booking:'confirmed',sourceStatus:'Confirmed'}]};
