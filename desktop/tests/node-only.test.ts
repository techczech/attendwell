import {test,expect} from 'bun:test';
import {readdirSync,readFileSync} from 'node:fs';
import path from 'node:path';

test('desktop runtime code uses Node APIs only (it runs in Electron\'s main process)',()=>{
 const dir=path.join(import.meta.dirname,'..','runtime');
 for(const f of readdirSync(dir).filter(f=>f.endsWith('.ts'))){
  const src=readFileSync(path.join(dir,f),'utf8');
  expect({f,bun:/\bBun\.|from 'bun:|import\.meta\.(dir|main)\b/.test(src)}).toEqual({f,bun:false});
 }
 const shared=readFileSync(path.join(import.meta.dirname,'..','..','server','private-path.ts'),'utf8');
 expect(/\bBun\.|from 'bun:/.test(shared)).toBe(false);
});
