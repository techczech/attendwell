// Browser check against a running fictional preview (bun run preview). Playwright is not a project dependency:
// point ATTENDANCE_PLAYWRIGHT_PACKAGE at the package.json of an existing Playwright install.
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
if(!process.env.ATTENDANCE_PLAYWRIGHT_PACKAGE)throw new Error('Set ATTENDANCE_PLAYWRIGHT_PACKAGE to the package.json of an existing Playwright install.');
const require=createRequire(process.env.ATTENDANCE_PLAYWRIGHT_PACKAGE);
const {chromium}=require('playwright');
// Password-free local organiser preview; override for an isolated preview on other loopback ports.
const admin=process.env.ATTENDANCE_ADMIN_TEST_ORIGIN??'http://127.0.0.1:4318';
const title=process.env.ATTENDANCE_TEST_TITLE??'Example Hands-On Workshop';
const csvName=process.env.ATTENDANCE_TEST_CSV??'recipients-example-session-001-2030-01-15.csv';
const shots=resolve('test-results');
const browser=await chromium.launch({headless:true});
const viewport={width:820,height:1180};
const first=await browser.newContext({viewport,hasTouch:true,permissions:['clipboard-read','clipboard-write']});
const second=await browser.newContext({viewport,hasTouch:true});
const a=await first.newPage(),b=await second.newPage();const errors=[];
for(const p of [a,b])p.on('pageerror',e=>errors.push(e.message));
async function assert(condition,label){if(!condition)throw new Error(label)}
async function open(p){await p.goto(admin);await p.getByRole('heading',{name:title,exact:true}).waitFor();}
const write=(p,path,data)=>p.request.post(admin+'/api/'+path,{headers:{Origin:admin,'X-Attendance-Request':'1'},data});
try{
 await open(a);
 await assert(await a.getByRole('heading',{name:'Facilitator sign-in'}).count()===0,'password-free local admin must not ask for sign-in');
 const reset=await a.request.get(admin+'/api/roster');for(const p of (await reset.json()).participants){if(p.present)await write(a,'attendance',{id:p.id,present:false,version:p.version});}
 const robin=(await (await a.request.get(admin+'/api/roster')).json()).participants.find(p=>p.name==='Robin Example');if(robin.admitted)await write(a,'admit',{id:robin.id,admitted:false,version:robin.version});
 await a.reload();await a.getByRole('button',{name:'Check in Alex Example',exact:true}).waitFor();
 await open(b);console.log('Opened two local organiser contexts and reset fictional check-ins.');
 await a.getByRole('button',{name:'Check in Alex Example',exact:true}).click();await a.getByRole('button',{name:'Undo check-in for Alex Example',exact:true}).waitFor({timeout:8000});
 await b.getByRole('button',{name:'Undo check-in for Alex Example',exact:true}).waitFor({timeout:9000});
 await a.reload();await a.getByRole('button',{name:'Undo check-in for Alex Example',exact:true}).waitFor();
 await a.getByRole('button',{name:'Waiting list',exact:true}).click();await assert(await a.getByText('Robin Example',{exact:true}).count()===1,'waiting filter');await assert(await a.getByRole('button',{name:'Check in Alex Example',exact:true}).count()===0,'filtered exclusions');
 // Waiting-list admission: separate approval, still pending until explicit check-in, reversible before check-in.
 await assert(await a.getByRole('button',{name:'Check in Robin Example',exact:true}).isDisabled(),'waiting booking must not be checkable before admission');
 await a.getByRole('button',{name:'Admit from waiting list Robin Example',exact:true}).click();await a.getByText('Waiting list · admitted',{exact:true}).waitFor();
 await assert(await a.getByRole('button',{name:'Check in Robin Example',exact:true}).isEnabled(),'admitted booking can be checked in');
 await a.getByRole('button',{name:'Withdraw admission for Robin Example',exact:true}).click();await a.getByRole('button',{name:'Admit from waiting list Robin Example',exact:true}).waitFor();
 await a.getByRole('button',{name:'All',exact:true}).click();await a.getByLabel('Select Alex Example for email',{exact:true}).check();
 await a.getByRole('button',{name:'Review recipients',exact:true}).click();await a.getByRole('button',{name:'Copy Bcc',exact:true}).click();await a.getByLabel('Text for manual copying').waitFor();await a.waitForFunction(()=>document.querySelector('textarea')?.value==='alex@example.org');await a.waitForFunction(async()=>await navigator.clipboard.readText()==='alex@example.org');
 await assert(await a.getByLabel('Text for manual copying').inputValue()==='alex@example.org','recipient bcc');
 const downloadEvent=a.waitForEvent('download');await a.getByRole('button',{name:'Download CSV',exact:true}).click();await assert((await downloadEvent).suggestedFilename()===csvName,'csv filename');
 await a.getByRole('button',{name:'Close recipient review',exact:true}).click();
 await b.getByRole('button',{name:'Undo check-in for Alex Example',exact:true}).click();await a.getByRole('button',{name:'Check in Alex Example',exact:true}).waitFor({timeout:9000});
 await assert(!(await a.getByLabel('Select Alex Example for email').isChecked()),'selection revoked on correction');
 await a.getByLabel('Search name or email',{exact:true}).fill('nobody');await a.getByRole('heading',{name:'No matching participants'}).waitFor();await a.getByLabel('Search name or email',{exact:true}).fill('');
 await a.getByRole('button',{name:'Open settings',exact:true}).click();await a.getByText('Local organiser access on this computer.',{exact:false}).waitFor();await a.getByRole('button',{name:'Close dialog',exact:true}).click();
 await a.getByRole('button',{name:'Check in Bea Example',exact:true}).click();await a.getByRole('button',{name:'Undo check-in for Bea Example',exact:true}).waitFor();await a.getByRole('button',{name:'Undo last change',exact:true}).click();await a.getByRole('button',{name:'Check in Bea Example',exact:true}).waitFor();
 // Local fallback: with the register unreachable, check-in and undo stay on this computer, labelled, then sync once.
 await a.route('**/api/**',route=>route.abort());
 await a.getByRole('button',{name:'Check in Cameron Example',exact:true}).click();await a.getByText('Saved on this computer · waiting to sync',{exact:true}).waitFor();
 await a.getByRole('alert').filter({hasText:'Connection interrupted'}).waitFor();
 await a.getByRole('button',{name:'Undo check-in for Cameron Example',exact:true}).waitFor();await a.getByRole('button',{name:'Undo last change',exact:true}).click();
 await a.getByRole('button',{name:'Check in Cameron Example',exact:true}).waitFor();
 const during=(await (await b.request.get(admin+'/api/roster')).json()).participants.find(p=>p.name==='Cameron Example');await assert(!during.present&&during.version===0,'offline changes must not reach the server early');
 await a.reload().catch(()=>undefined);await a.unroute('**/api/**');await a.reload();
 await a.getByRole('heading',{name:title,exact:true}).waitFor();await a.getByText('Saved on this computer · waiting to sync',{exact:true}).waitFor({state:'detached',timeout:9000});
 const after=(await (await b.request.get(admin+'/api/roster')).json()).participants.find(p=>p.name==='Cameron Example');await assert(!after.present&&after.version===2,'queued check-in and undo synced exactly once each: '+JSON.stringify(after));
 await assert(!(await a.evaluate(()=>JSON.stringify(localStorage))).includes('@'),'organiser queue stores no emails');
 await assert(await a.evaluate(async()=>!('serviceWorker' in navigator)||(await navigator.serviceWorker.getRegistrations()).length===0),'no service worker on organiser origin');
 await assert(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'tablet horizontal fit');
 mkdirSync(shots,{recursive:true});await a.screenshot({path:resolve(shots,'preview-attendance-tablet.png'),fullPage:true});
 await a.setViewportSize({width:390,height:844});await assert(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'phone horizontal fit');await a.screenshot({path:resolve(shots,'preview-attendance-phone.png'),fullPage:true});
 await assert(await a.getByRole('button',{name:'Sign out',exact:true}).count()===0,'local organiser has no sign-out');
 await assert(errors.length===0,'no browser errors: '+errors.join(', '));
 console.log(JSON.stringify({status:'passed',checks:['password-free-local-admin','two-device-shared-state','reload-persistence','filters','waiting-admission-and-withdrawal','bcc-copy','CSV-download','remote-correction','recipient-revocation','empty-search','settings','undo-last','offline-check-in-and-undo-queued','reload-while-down-keeps-queue','sync-once-on-reconnect','no-email-in-organiser-storage','no-organiser-service-worker','tablet-fit','phone-fit','no-browser-errors'],screenshots:'test-results/preview-attendance-{tablet,phone}.png',physicalIPadTested:false}));
}catch(error){console.error('Browser check failed:',error.message);console.error('Page errors:',errors);if(!a.isClosed()){console.error((await a.locator('body').innerText()).slice(0,3500));mkdirSync(shots,{recursive:true});await a.screenshot({path:resolve(shots,'preview-attendance-failure.png'),fullPage:true});}throw error;}finally{await browser.close();}
