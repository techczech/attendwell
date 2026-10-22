// Participant offline shell. Caches only the check-in page and its hashed build assets.
// Never caches /api/ responses or organiser pages: names and the check-in queue live in the page's own storage.
// Registered at /sw.js (local, shell /check-in) or /<prefix>/sw.js (public, shell /<prefix>/); the scope gives the prefix.
const BASE=new URL(self.registration.scope).pathname.replace(/\/$/,'');
// One cache per participant path, so sessions sharing an origin never read or delete each other's shell.
const SHELL_PREFIX='attendance-participant-shell-v',SCOPE_KEY=':'+(BASE||'/');
const SHELL=SHELL_PREFIX+'3'+SCOPE_KEY;
const own=()=>caches.open(SHELL);
const PAGE=BASE?BASE+'/':'/check-in';
const PAGES=BASE?[BASE+'/']:['/','/check-in'];
const assetsIn=html=>[...new Set([...html.matchAll(/(?:\.\/|\/)assets\/[A-Za-z0-9_.-]+/g)].map(m=>new URL(m[0],new URL(PAGE,self.location.origin)).pathname))];
async function storeShell(response){
 if(!response.ok||response.redirected||response.type!=='basic')return;
 const html=await response.clone().text();const assets=assetsIn(html);const cache=await own();
 await Promise.all(assets.map(async path=>{if(!await cache.match(path)){const r=await fetch(path,{cache:'no-store'});if(r.ok)await cache.put(path,r);}}));
 await cache.put(PAGE,response);
 // Drop superseded hashed assets once the new shell is complete.
 for(const request of await cache.keys()){const path=new URL(request.url).pathname;if(path.startsWith(BASE+'/assets/')&&!assets.includes(path))await cache.delete(request);}
}
const unavailable=()=>new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Check-in unavailable</title><p>Check-in is not available on this device right now. Please speak to the workshop organisers.</p>',{status:503,headers:{'Content-Type':'text/html;charset=utf-8'}});
self.addEventListener('install',event=>{event.waitUntil(fetch(PAGE,{cache:'no-store'}).then(storeShell).catch(()=>undefined).then(()=>self.skipWaiting()));});
// Removes only superseded versions of this path's own shell; other sessions' and unrelated caches are left alone.
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==SHELL&&k.startsWith(SHELL_PREFIX)&&k.endsWith(SCOPE_KEY)).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith(BASE+'/api/')||url.pathname.startsWith('/api/'))return;
 if(event.request.mode==='navigate'&&PAGES.includes(url.pathname)){
  // Network first so a new build is used when online; the cached shell answers during outages.
  // A stopped tunnel answers with its own 5xx page rather than a network error, so non-OK also falls back.
  event.respondWith(fetch(event.request).then(async response=>{
   if(url.pathname!==PAGE)return response;
   if(!response.ok)return await (await own()).match(PAGE)??response;
   event.waitUntil(storeShell(response.clone()).catch(()=>undefined));return response;
  }).catch(async()=>{
   if(url.pathname!==PAGE)return Response.redirect(new URL(PAGE,self.location.origin).href,302);
   return await (await own()).match(PAGE)??unavailable();
  }));
  return;
 }
 if(url.pathname.startsWith(BASE+'/assets/'))event.respondWith(own().then(cache=>cache.match(event.request)).then(hit=>hit??fetch(event.request)));
});
