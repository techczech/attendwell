// Browser check against a running fictional preview (bun run preview). Playwright is not a project dependency:
// point ATTENDANCE_PLAYWRIGHT_PACKAGE at the package.json of an existing Playwright install.
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
if(!process.env.ATTENDANCE_PLAYWRIGHT_PACKAGE)throw new Error('Set ATTENDANCE_PLAYWRIGHT_PACKAGE to the package.json of an existing Playwright install.');
const require=createRequire(process.env.ATTENDANCE_PLAYWRIGHT_PACKAGE);
const {chromium}=require('playwright');
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:820,height:1180},hasTouch:true});
const participantOrigin=process.env.ATTENDANCE_PARTICIPANT_TEST_ORIGIN??'http://127.0.0.1:4319';
const adminOrigin=process.env.ATTENDANCE_ADMIN_TEST_ORIGIN??'http://127.0.0.1:4318';
const title=process.env.ATTENDANCE_TEST_TITLE??'Example Hands-On Workshop';
const help=process.env.ATTENDANCE_TEST_HELP??'Please speak to the workshop organisers.';
const shots='test-results';mkdirSync(shots,{recursive:true});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
const assert=(condition,message)=>{if(!condition)throw new Error(message)};
const checked=name=>page.getByRole('region',{name:'Checked in',exact:true}).locator('.list-person-name').filter({hasText:name});
const pendingButton=name=>page.getByRole('region',{name:'Not checked in',exact:true}).getByRole('button',{name,exact:true});
async function checkIn(name){await pendingButton(name).click();await page.getByRole('button',{name:'That’s me — check in',exact:true}).click();}
try{
 const local=await browser.newContext();const admin=await local.newPage();admin.on('pageerror',e=>errors.push(e.message));
 await admin.goto(adminOrigin);await admin.getByRole('heading',{name:title,exact:true}).waitFor();
 const roster=await (await admin.request.get(adminOrigin+'/api/roster')).json();
 for(const p of roster.participants)if(p.present)await admin.request.post(adminOrigin+'/api/attendance',{headers:{Origin:adminOrigin,'X-Attendance-Request':'1'},data:{id:p.id,present:false,version:p.version}});
 for(const c of roster.conflicts??[])await admin.request.post(adminOrigin+'/api/resolve-conflict',{headers:{Origin:adminOrigin,'X-Attendance-Request':'1'},data:{id:c.participantId,action:'dismiss'}});
 await page.goto(participantOrigin+'/check-in');
 await pendingButton('Alex Example').waitFor();
 assert(!(await page.locator('body').innerText()).includes('@'),'Participant screen leaked email');
 const names=await (await page.request.get(participantOrigin+'/api/participant-names')).json();
 assert(!JSON.stringify(names).includes('@'),'Participant API leaked email');
 await page.screenshot({path:shots+'/participant-check-in-tablet.png'});
 await page.getByLabel('Find your name').fill('Alex');
 await pendingButton('Alex Example').click();
 await page.getByRole('heading',{name:'Is this you?'}).waitFor();
 await page.getByRole('button',{name:'Go back',exact:true}).click();
 assert(await page.getByLabel('Find your name').inputValue()==='Alex','Go back should preserve search');
 // Immediate acknowledgement: the confirmation closes at once and the banner then follows delivery.
 await checkIn('Alex Example');
 await page.getByRole('dialog').waitFor({state:'detached',timeout:250});
 await page.getByRole('status').filter({hasText:'You’re checked in, Alex Example'}).waitFor();
 assert(await checked('Alex Example').count()===1,'Saved name did not move to checked-in section');
 assert(await pendingButton('Alex Example').count()===0,'Saved name remained pending');
 await page.screenshot({path:shots+'/participant-check-in-confirmed.png'});
 await admin.reload();await admin.getByRole('button',{name:'Undo check-in for Alex Example',exact:true}).waitFor();
 await page.getByRole('status').filter({hasText:'You’re checked in, Alex Example'}).waitFor({state:'hidden',timeout:8000});
 await admin.getByRole('button',{name:'Undo check-in for Alex Example',exact:true}).click();
 await pendingButton('Alex Example').waitFor({timeout:9000});
 assert(await checked('Alex Example').count()===0,'Admin undo left name checked in');
 assert(await page.getByLabel('Find your name').inputValue()==='','Automatic reset failed');
 await page.getByLabel('Find your name').fill('Nobody');await page.getByText('No matching name. '+help,{exact:true}).waitFor();
 await page.setViewportSize({width:390,height:844});await page.getByLabel('Find your name').fill('');
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Phone overflow');
 await page.screenshot({path:shots+'/participant-check-in-phone.png'});
 await page.setViewportSize({width:820,height:1180});
 // A failed server save is kept on the device and labelled; it is never reported as saved to the register.
 await page.route('**/api/participant-check-in',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporarily unavailable.'})}));
 await checkIn('Bea Example');await page.getByRole('status').filter({hasText:'Saved on this device, Bea Example'}).waitFor();
 assert(await page.getByRole('status').filter({hasText:'You’re checked in'}).count()===0,'False saved confirmation');
 await checked('Bea Example').waitFor();assert((await page.getByRole('region',{name:'Checked in',exact:true}).innerText()).includes('Saved on this device · waiting to sync'),'Queued label missing');
 await page.unroute('**/api/participant-check-in');
 await page.getByText('Saved on this device · waiting to sync',{exact:true}).waitFor({state:'detached',timeout:9000});
 let saved=(await (await admin.request.get(adminOrigin+'/api/roster')).json()).participants.find(p=>p.name==='Bea Example');assert(saved.present&&saved.version===1,'Queued check-in not synced exactly once');
 // Offline reload: the service worker serves the shell; names and queue come from this device's storage.
 await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}))});
 await page.getByLabel('Find your name').fill('Cam');
 await context.setOffline(true);
 await page.getByText('Offline.',{exact:false}).waitFor({timeout:9000});
 assert(await page.getByLabel('Find your name').inputValue()==='Cam','Search lost on disconnect');
 await page.reload();await pendingButton('Cameron Example').waitFor();
 await checkIn('Cameron Example');await page.getByRole('status').filter({hasText:'Saved on this device, Cameron Example'}).waitFor();
 // Meanwhile the organiser checks Cameron in and undoes it; the stale device record must not overwrite that.
 const cameron=(await (await admin.request.get(adminOrigin+'/api/roster')).json()).participants.find(p=>p.name==='Cameron Example');
 await admin.request.post(adminOrigin+'/api/attendance',{headers:{Origin:adminOrigin,'X-Attendance-Request':'1'},data:{id:cameron.id,present:true,version:cameron.version}});
 await admin.request.post(adminOrigin+'/api/attendance',{headers:{Origin:adminOrigin,'X-Attendance-Request':'1'},data:{id:cameron.id,present:false,version:cameron.version+1}});
 await page.reload();await checked('Cameron Example').waitFor();
 const stored=await page.evaluate(async()=>JSON.stringify(localStorage)+JSON.stringify(await Promise.all((await caches.keys()).map(async k=>(await (await caches.open(k)).keys()).map(r=>r.url)))));
 assert(!stored.includes('@')&&!stored.includes('/api/'),'Participant origin stored emails or API responses');
 await context.setOffline(false);
 await page.getByText('Held for an organiser to check',{exact:true}).waitFor({timeout:12000});
 saved=(await (await admin.request.get(adminOrigin+'/api/roster')).json());assert(!saved.participants.find(p=>p.name==='Cameron Example').present,'Stale offline check-in overwrote admin undo');
 assert(saved.conflicts.some(c=>c.name==='Cameron Example'&&c.reason==='changed'),'Conflict not visible to organiser');
 await admin.reload();await admin.getByText('Participant check-ins held for your decision',{exact:true}).waitFor();
 await admin.getByRole('button',{name:'Keep not checked in',exact:true}).click();await pendingButton('Cameron Example').waitFor({timeout:9000});
 assert(errors.length===0,'Browser errors: '+errors.join('; '));
 console.log('Participant browser checks passed: immediate acknowledgement, list movement, admin undo, names only, confirmation/back, automatic reset, missing name, phone fit, failed save kept on device and synced once, offline reload from service worker, search kept on disconnect, stale offline check-in held after admin undo and resolved by organiser, no email or API data in device storage.');
}catch(error){console.error('Participant browser check failed:',error.message,errors);if(!page.isClosed())console.error((await page.locator('body').innerText()).slice(0,3000));throw error;}finally{await browser.close()}
