// Generates the Pages upload directory. It holds only the proxy (which also serves the landing page);
// the private app tree, roster, database and build output are never copied.
import {mkdirSync,readdirSync,rmSync,copyFileSync} from 'node:fs';
import {resolve} from 'node:path';
export const OUTPUT=['_worker.js'];
export function buildPages(out=resolve(import.meta.dir,'dist')){
 if(!out.endsWith('dist'))throw new Error('Refusing to clear a directory not named dist.');
 rmSync(out,{recursive:true,force:true});mkdirSync(out,{recursive:true});
 copyFileSync(resolve(import.meta.dir,'worker/_worker.js'),resolve(out,'_worker.js'));
 const files=readdirSync(out).sort();
 if(JSON.stringify(files)!==JSON.stringify(OUTPUT))throw new Error(`Unexpected Pages output: ${files.join(', ')}`);
 return out;
}
if(import.meta.main)console.log(`Pages output ready: ${buildPages()}`);
