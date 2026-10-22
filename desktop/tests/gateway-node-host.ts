// Runs the participant gateway under Node (as in Electron's main process) for the client-abort tests: Bun 1.3's
// node:http server reports nothing when a client disconnects, so the gateway's abort guard can only be observed under
// Node. Usage: node desktop/tests/gateway-node-host.ts '<upstream JSON>|null'. Prints `PORT <n>`, then `ESCAPE <message>`
// for any uncaught exception or unhandled rejection; exits when its stdin closes. Lines on stdin: `close` closes the
// gateway and prints `CLOSED <port> <upstream>` (both null once closed); `start` starts it again and prints `PORT <n>`.
import {createParticipantGateway} from '../runtime/participant-gateway.ts';

process.on('uncaughtException',e=>process.stdout.write(`ESCAPE uncaughtException: ${e?.message}\n`));
process.on('unhandledRejection',e=>process.stdout.write(`ESCAPE unhandledRejection: ${(e as Error)?.message??e}\n`));
const g=createParticipantGateway();
const port=await g.start();
const upstream=JSON.parse(process.argv[2]);
if(upstream)g.setUpstream(upstream);
process.stdout.write(`PORT ${port}\n`);
let pending='';let queue=Promise.resolve();
process.stdin.on('data',d=>{
 pending+=d;let i;
 while((i=pending.indexOf('\n'))>=0){
  const cmd=pending.slice(0,i).trim();pending=pending.slice(i+1);
  queue=queue.then(async()=>{
   if(cmd==='close'){await g.close();process.stdout.write(`CLOSED ${g.port} ${JSON.stringify(g.upstream)}\n`);}
   else if(cmd==='start')process.stdout.write(`PORT ${await g.start()}\n`);
  });
 }
});
process.stdin.on('end',()=>{void g.close().then(()=>process.exit(0));});
