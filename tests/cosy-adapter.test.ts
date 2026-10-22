import {test,expect} from 'bun:test';
import {AttendanceStore} from '../server/store-attendance';
import {parseWorkshopConfig} from '../server/workshop-config';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const python=Bun.which('python3');
const adapter=resolve(import.meta.dir,'../scripts/convert-cosy-roster.py');
// Writes a minimal fictional CoSy-shaped XLSX (inline strings, one sheet) using the Python standard library.
const makeXlsx=`import sys,zipfile
rows=[['User Fullname','User Email','Start Date','Status'],['Alex Example','ALEX@example.org','15/01/2030 13:00','Booked'],['Robin Example','robin@example.org','47498.5416666667','Waiting List'],['Taylor Example','','15/01/2030 13:00','Cancelled']]
cell=lambda r,c,v:f'<c r="{"ABCD"[c]}{r}" t="inlineStr"><is><t>{v}</t></is></c>'
body=''.join(f'<row r="{r+1}">'+''.join(cell(r+1,c,v) for c,v in enumerate(row))+'</row>' for r,row in enumerate(rows))
with zipfile.ZipFile(sys.argv[1],'w') as z:z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+body+'</sheetData></worksheet>')`;
const cosyWorkshop={sessionId:'example-session-001',title:'Example Hands-On Workshop',date:'2030-01-15',startTime:'13:00',sourceStatuses:{Booked:'confirmed',Cancelled:'cancelled','Waiting List':'waiting'}};

test.skipIf(!python)('CoSy adapter output passes the service import checks for the configured workshop',()=>{
 const dir=mkdtempSync(join(tmpdir(),'cosy-adapter-'));const xlsx=join(dir,'fictional.xlsx'),out=join(dir,'roster.json'),config=join(dir,'workshop.json');
 writeFileSync(config,JSON.stringify(cosyWorkshop));
 expect(Bun.spawnSync([python!,'-c',makeXlsx,xlsx]).exitCode).toBe(0);
 const run=Bun.spawnSync([python!,adapter,xlsx,out,'--workshop',config,'--exported-at','2030-01-10T09:00:00Z']);
 expect(run.stderr.toString()).toBe('');expect(JSON.parse(run.stdout.toString())).toMatchObject({records:3,status_counts:{confirmed:1,cancelled:1,waiting:1}});
 const roster=JSON.parse(readFileSync(out,'utf8'));
 expect(roster).toMatchObject({sessionId:'example-session-001',date:'2030-01-15',source:{filename:'fictional.xlsx'}});
 expect(roster.participants.map((p:any)=>[p.name,p.email,p.booking,p.sourceStatus])).toEqual([['Alex Example','alex@example.org','confirmed','Booked'],['Robin Example','robin@example.org','waiting','Waiting List'],['Taylor Example','','cancelled','Cancelled']]);
 const store=new AttendanceStore(':memory:',parseWorkshopConfig(cosyWorkshop));expect(store.import(roster,'test').participants).toHaveLength(3);store.close();
 // A different workshop date stops the conversion rather than producing a mismatched roster.
 writeFileSync(config,JSON.stringify({...cosyWorkshop,date:'2030-01-16'}));
 const wrong=Bun.spawnSync([python!,adapter,xlsx,join(dir,'other.json'),'--workshop',config,'--exported-at','2030-01-10T09:00:00Z']);
 expect(wrong.exitCode).not.toBe(0);expect(wrong.stderr.toString()).toContain('Wrong session date');
 rmSync(dir,{recursive:true});
});
