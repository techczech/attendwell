import {test,expect} from 'bun:test';
// @ts-ignore plain JS worker module
import {handle,route,configure,validPrefix} from '../worker/_worker.js';
import {buildPages} from '../build-pages';
import {validBasePath} from '../../server/workshop-config';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// Fictional deployment settings, supplied as Pages environment variables.
const env={CHECKIN_PUBLIC_ORIGIN:'https://check-in.example.org',CHECKIN_PREFIX:'/example-check-in',CHECKIN_ORIGIN_HOST:'origin.example.net'};
const pub=env.CHECKIN_PUBLIC_ORIGIN,s=pub+env.CHECKIN_PREFIX,p=env.CHECKIN_PREFIX;
const writeHeaders={Origin:pub,'X-Attendance-Request':'1','Content-Type':'application/json'};
// Records every upstream request; `reply` stands in for the tunnel.
function backend(reply:(r:Request)=>Response|Promise<Response>=()=>Response.json({ok:true})){
 const seen:Request[]=[];return {seen,fetch:async(r:Request)=>{seen.push(r);return reply(r)}};
}
const call=(b:ReturnType<typeof backend>,url:string,init:RequestInit={},settings:Record<string,string>=env)=>handle(new Request(url,init),settings,b.fetch);

test('allowlisted paths map to backend paths; bare session path redirects to trailing slash',async()=>{
 const b=backend(r=>new Response('x',{headers:{'Content-Type':new URL(r.url).pathname==='/check-in'?'text/html':new URL(r.url).pathname.endsWith('.css')?'text/css':'text/javascript'}}));
 for(const [path,up] of [['/','/check-in'],['/sw.js','/sw.js'],['/assets/index-AbC_12.js','/assets/index-AbC_12.js'],['/assets/app.9f.css','/assets/app.9f.css']]){const r=await call(b,s+path+'?q=1');expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('no-store');expect(b.seen.at(-1)!.url).toBe('https://'+env.CHECKIN_ORIGIN_HOST+up);expect(b.seen.at(-1)!.redirect).toBe('manual');}
 expect((await call(b,s+'/sw.js')).headers.get('service-worker-allowed')).toBe(p+'/');
 const head=await call(b,s+'/',{method:'HEAD'});expect(head.status).toBe(200);expect(b.seen.at(-1)!.method).toBe('HEAD');
 const bare=await call(b,s);expect(bare.status).toBe(301);expect(bare.headers.get('location')).toBe(p+'/');
 const root=await call(b,pub+'/');expect(root.status).toBe(200);expect(await root.text()).toContain('Workshop check-in');expect(b.seen).toHaveLength(6);
});

test('private routes, other sessions, traversal and wrong methods are 404 at the edge',async()=>{
 const b=backend();
 for(const path of ['/check-in',p+'/check-in',p+'/index.html','/api/participant-names',p+'/api/roster',p+'/api/login',p+'/api/attendance',p+'/api/import',p+'/api/recipients',p+'/api/participant-names/','/example-other/',p+'/assets/../server/store-attendance.ts',p+'/assets/%2e%2e%2fattendance.sqlite',p+'/assets/.env',p+'/assets/a/b.js',p+'/attendance.sqlite','/sw.js'])expect((await call(b,pub+path)).status).toBe(404);
 expect(route('POST',p+'/api/participant-names',p)).toBeNull();expect(route('GET',p+'/api/participant-check-in',p)).toBeNull();expect(route('HEAD',p+'/api/participant-names',p)).toBeNull();expect(route('POST',p+'/',p)).toBeNull();expect(route('OPTIONS',p+'/api/participant-check-in',p)).toBeNull();
 expect((await call(b,s+'/api/participant-check-in',{method:'PUT',headers:writeHeaders,body:'{}'})).status).toBe(404);expect(b.seen).toHaveLength(0);
});

test('writes need the exact public origin, custom header, JSON and a small body; previews never write',async()=>{
 const b=backend();const post=(url:string,extra:Record<string,string>={},body='{"token":"t"}')=>call(b,url,{method:'POST',headers:{...writeHeaders,...extra},body});
 for(const extra of <Record<string,string>[]>[{Origin:'https://evil.example'},{Origin:'https://abc123.check-in.example.org'},{Origin:'null'},{Origin:pub+'/'},{'X-Attendance-Request':'0'},{'X-Attendance-Request':''}])expect((await post(s+'/api/participant-check-in',extra)).status).toBe(403);
 // A preview deployment presenting the production Origin is still refused.
 expect((await post('https://abc123.check-in.example.org'+p+'/api/participant-check-in')).status).toBe(403);
 expect((await post('http://localhost:8788'+p+'/api/participant-check-in',{Origin:'http://localhost:8788'})).status).toBe(403);
 expect((await post(s+'/api/participant-check-in',{'Content-Type':'text/plain'})).status).toBe(415);
 expect((await post(s+'/api/participant-check-in',{},'{broken')).status).toBe(400);
 expect((await post(s+'/api/participant-check-in',{},JSON.stringify({token:'x'.repeat(4100)}))).status).toBe(413);
 expect(b.seen).toHaveLength(0);
 const ok=await post(s+'/api/participant-check-in',{},JSON.stringify({token:'x'.repeat(4000)}));expect(ok.status).toBe(200);expect(b.seen).toHaveLength(1);
});

test('forwarded requests carry no cookies or auth; Origin is rewritten only after validation',async()=>{
 const b=backend(()=>Response.json({ok:true},{headers:{'Set-Cookie':'attendance=abc; Path=/','Access-Control-Allow-Origin':'*'}}));
 const secret={Cookie:'attendance='+'a'.repeat(64),Authorization:'Bearer x','X-Forwarded-For':'1.2.3.4','CF-Access-Client-Secret':'x'};
 const r=await call(b,s+'/api/participant-check-in',{method:'POST',headers:{...writeHeaders,...secret},body:'{"token":"t"}'});
 const sent=b.seen[0];expect(sent.url).toBe('https://'+env.CHECKIN_ORIGIN_HOST+'/api/participant-check-in');expect(sent.headers.get('origin')).toBe('https://'+env.CHECKIN_ORIGIN_HOST);expect(sent.headers.get('x-attendance-request')).toBe('1');expect(await sent.text()).toBe('{"token":"t"}');
 for(const h of Object.keys(secret))expect(sent.headers.get(h)).toBeNull();
 expect(r.headers.get('set-cookie')).toBeNull();expect(r.headers.get('access-control-allow-origin')).toBeNull();expect(r.headers.get('cache-control')).toBe('no-store');expect(r.headers.get('content-security-policy')).toContain("default-src 'self'");
 await call(b,s+'/api/participant-names',{headers:secret});const read=b.seen[1];expect(read.headers.get('origin')).toBeNull();for(const h of Object.keys(secret))expect(read.headers.get(h)).toBeNull();
});

test('tunnel outages give a controlled 503; redirects and unexpected content never pass through',async()=>{
 const down=backend(()=>{throw new TypeError('connection refused')});
 const api=await call(down,s+'/api/participant-names');expect(api.status).toBe(503);expect((await api.json()).unavailable).toBe(true);
 const page=await call(down,s+'/');expect(page.status).toBe(503);expect(page.headers.get('content-type')).toContain('text/html');expect(await page.text()).toContain('offline');
 for(const status of [502,530]){const r=await call(backend(()=>new Response('<html>Error 1033</html>',{status,headers:{'Content-Type':'text/html'}})),s+'/api/participant-names');expect(r.status).toBe(503);expect(await r.text()).not.toContain('1033');}
 const moved=await call(backend(()=>new Response(null,{status:302,headers:{Location:'/'}})),s+'/');expect(moved.status).toBe(502);expect(moved.headers.get('location')).toBeNull();
 expect((await call(backend(()=>new Response('<html>',{headers:{'Content-Type':'text/html'}})),s+'/api/participant-names')).status).toBe(502);
 const closed=await call(backend(()=>Response.json({error:'Check-in has closed.'},{status:410})),s+'/api/participant-names');expect(closed.status).toBe(410);
});

test('deployment settings are validated; a missing or invalid setting forwards nothing',async()=>{
 expect(configure(env)).toMatchObject({...{publicOrigin:env.CHECKIN_PUBLIC_ORIGIN,prefix:p,originHost:env.CHECKIN_ORIGIN_HOST},maxBody:4096});
 const bad:Record<string,string>[]=[{},{...env,CHECKIN_PUBLIC_ORIGIN:'http://check-in.example.org'},{...env,CHECKIN_PUBLIC_ORIGIN:pub+'/'},{...env,CHECKIN_PREFIX:'example'},{...env,CHECKIN_PREFIX:'/Example'},{...env,CHECKIN_PREFIX:'/check-in'},{...env,CHECKIN_PREFIX:'/api'},{...env,CHECKIN_ORIGIN_HOST:'https://origin.example.net'},{...env,CHECKIN_ORIGIN_HOST:'localhost'},{...env,CHECKIN_ORIGIN_HOST:'check-in.example.org'}];
 const b=backend();
 for(const settings of bad){expect(configure(settings)).toBeNull();expect((await call(b,s+'/api/participant-names',{},settings)).status).toBe(503);expect((await call(b,s+'/',{},settings)).status).toBe(503);}
 expect(b.seen).toHaveLength(0);
 // The edge prefix rule and the workshop configuration rule agree.
 for(const x of ['/example-check-in','/a','/a-b-1','/check-in','/api','/assets','/sw.js','/A','/a/','/-a','/a-','//a','/'+'a'.repeat(64),'/'+'a'.repeat(65)])expect(validPrefix(x)).toBe(validBasePath(x));
});

test('generated Pages output holds only the proxy',()=>{
 const dir=join(mkdtempSync(join(tmpdir(),'check-in-pages-')),'dist');buildPages(dir);expect(readdirSync(dir)).toEqual(['_worker.js']);rmSync(dir,{recursive:true,force:true});
});
