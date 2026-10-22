// Runs `bun test` once per test file, so a crash of Bun itself (seen on Windows: a segfault part-way through the suite,
// after which the step hung until it was cancelled) costs one file, not the run. Each file gets a time limit; a file
// whose run crashed Bun is run once more. Every file's JUnit report is merged into one, which ci-test-summary.ts reads.
// Output goes to files, never pipes, so a process left behind by a crashed run cannot hold this script open.
// Bun 1.3.10 on Windows prints its crash banner and then does not exit: the log is watched while the file runs, and a run
// that printed the banner is ended a few seconds later and counted as a crash (so it is retried), not left to the time limit.
// A file that crashed or ran out of time names the last test that finished and the test declared after it.
// Usage: bun scripts/run-tests-per-file.ts <out-dir> <test folder or file>...
//   ATTENDWELL_TEST_FILE_TIMEOUT_MS  time limit per file (default 240000)
// Exit code: 0 when every file ran and nothing failed; 1 otherwise.
import {spawn,spawnSync} from 'node:child_process';
import {readdirSync,statSync,mkdirSync,rmSync,openSync,closeSync,readFileSync,writeFileSync,existsSync,appendFileSync} from 'node:fs';
import path from 'node:path';

const [outDir='',...roots]=process.argv.slice(2);
const timeoutMs=Number(process.env.ATTENDWELL_TEST_FILE_TIMEOUT_MS??240000);
const TEST_FILE=/[._](test|spec)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const SKIP_DIRS=new Set(['node_modules','fixtures']);

export function findTestFiles(root:string):string[]{
 if(statSync(root).isFile())return [root];
 const out:string[]=[];
 for(const e of readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  const p=path.join(root,e.name);
  if(e.isDirectory()){if(!SKIP_DIRS.has(e.name))out.push(...findTestFiles(p));}
  else if(TEST_FILE.test(e.name))out.push(p);
 }
 return out;
}

const xmlEscape=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
// Bun's crash banner; a run that printed it did not finish its file, whatever its report says.
const crashed=(log:string)=>/Bun has crashed|panic\(main thread\)|Segmentation fault at address/.test(log);

// How long a run that printed the crash banner is given to exit on its own before it is ended.
const CRASH_EXIT_GRACE_MS=5000;
const CRASH_POLL_MS=500;

// The last test the reporter finished in this log, and the test declared after it in the source (the one that was
// running when the file stopped, unless the stop came between tests). Bun prints `(pass) <name> [12.00ms]`, with any
// describe names joined by ` > `.
export function lastFinishedTest(log:string):string|null{
 let last:string|null=null;
 for(const line of log.split(/\r?\n/)){
  const m=/^\((?:pass|fail|skip|todo)\) (.+?)(?: \[[\d.]+m?s\])?$/.exec(line.trim());
  if(m)last=m[1];
 }
 return last;
}
export function testTitlesInSource(src:string):string[]{
 const out:string[]=[];
 const re=/\b(?:test|it)(?:\.(?:skip|only|todo|if|skipIf|failing)(?:\([^()]*(?:\([^()]*\))?[^()]*\))?)?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
 for(const m of src.matchAll(re))out.push(m[2].replace(/\\(.)/g,'$1'));
 return out;
}
export function whereItStopped(log:string,src:string|null):string{
 const last=lastFinishedTest(log);
 const titles=src?testTitlesInSource(src):[];
 const at=last===null?-1:titles.findIndex(t=>last===t||last.endsWith(` > ${t}`));
 const next=last===null?titles[0]:at>=0?titles[at+1]:undefined;
 const parts=[last===null?'no finished test in its output':`last test finished: "${last}"`];
 if(next!==undefined)parts.push(`next test declared: "${next}"`);
 return parts.join('; ');
}

type Run={code:number|null;signal:string|null;timedOut:boolean;log:string;report:string|null};
function runFile(file:string,stem:string):Promise<Run>{
 const report=path.join(outDir,'files',`${stem}.xml`),logFile=path.join(outDir,'files',`${stem}.log`);
 rmSync(report,{force:true});
 const fd=openSync(logFile,'w');
 // A path starting with ./ is a file to run, not a name filter.
 const child=spawn(process.execPath,['test',path.isAbsolute(file)?file:`./${file.split(path.sep).join('/')}`,'--reporter=junit',`--reporter-outfile=${report}`],
  {stdio:['ignore',fd,fd],windowsHide:true,detached:process.platform!=='win32'});
 closeSync(fd);
 return new Promise(resolve=>{
  let timedOut=false;let crashSeenAt=0;
  const timer=setTimeout(()=>{timedOut=true;killTree(child.pid);},timeoutMs);
  // A run that printed the crash banner and has not exited after the grace period is ended; it counts as a crash.
  const watch=setInterval(()=>{
   if(!crashSeenAt){let text='';try{text=readFileSync(logFile,'utf8')}catch{}if(crashed(text))crashSeenAt=Date.now();return;}
   if(Date.now()-crashSeenAt>=CRASH_EXIT_GRACE_MS)killTree(child.pid);
  },CRASH_POLL_MS);
  // 'exit', not 'close': nothing here waits on a pipe a leftover process could hold.
  child.once('exit',(code,signal)=>{
   clearTimeout(timer);clearInterval(watch);
   killTree(child.pid); // anything the test file started and left running
   const log=readFileSync(logFile,'utf8');
   resolve({code,signal,timedOut,log,report:existsSync(report)?readFileSync(report,'utf8'):null});
  });
 });
}
function killTree(pid:number|undefined){
 if(!pid)return;
 if(process.platform==='win32'){spawnSync('taskkill',['/PID',String(pid),'/T','/F'],{stdio:'ignore',windowsHide:true});return;}
 try{process.kill(-pid,'SIGKILL')}catch{}
}

type Outcome={file:string;suites:string;tests:number;failures:number;skipped:number;note:string|null};
const attr=(tag:string,name:string)=>Number(new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]??0);
// A file passes only when its child exited normally with code 0, was not killed by a signal or timed out, did not
// crash Bun, and left a well-formed report. Any other case is a failure, and an exit-status failure is added to
// whatever the report already recorded so the merged JUnit shows both.
function outcomeOf(file:string,run:Run):{ok:boolean;outcome:Outcome}{
 const name=file.split(path.sep).join('/');
 let src:string|null=null;try{src=readFileSync(file,'utf8')}catch{}
 const hasReport=!!run.report&&/<testsuites\b/.test(run.report);
 // A timed-out or crashed file's report is partial; it is not counted.
 const usable=hasReport&&!run.timedOut&&!crashed(run.log);
 const top=usable?/<testsuites\b[^>]*>/.exec(run.report!)?.[0]??'':'';
 const childSuites=usable?/<testsuites\b[^>]*>([\s\S]*)<\/testsuites>/.exec(run.report!)?.[1]??'':'';
 const childTests=attr(top,'tests'),childFailures=attr(top,'failures'),childSkipped=attr(top,'skipped');
 const exitWord=run.signal?`killed by signal ${run.signal}`:`exited with code ${run.code}`;
 const stopped=run.timedOut||crashed(run.log)?` (${whereItStopped(run.log,src)})`:'';
 const why=crashed(run.log)?`crashed Bun${stopped}`
  :run.timedOut?`did not finish within ${Math.round(timeoutMs/1000)} s${stopped}`
  :run.signal?`was ${exitWord}`
  :run.code!==0?`${exitWord}`
  :!hasReport?`wrote no valid report (${exitWord})`
  :null;
 if(why===null){
  return {ok:true,outcome:{file:name,suites:childSuites,tests:childTests,failures:childFailures,skipped:childSkipped,note:null}};
 }
 const tail=run.log.split(/\r?\n/).slice(-40).join('\n');
 const failureSuite=`<testsuite name="${xmlEscape(name)}" file="${xmlEscape(name)}" tests="1" failures="1" skipped="0"><testcase name="${xmlEscape(`the test file ${why}`)}" classname="" file="${xmlEscape(name)}" line="0"><failure message="${xmlEscape(why)}">${xmlEscape(tail)}</failure></testcase></testsuite>`;
 const suites=childSuites.trim()?`${childSuites.trim()}\n${failureSuite}`:failureSuite;
 return {ok:false,outcome:{file:name,suites,tests:childTests+1,failures:childFailures+1,skipped:childSkipped,note:why}};
}

if(import.meta.main){
 if(!outDir||!roots.length){console.error('Usage: bun scripts/run-tests-per-file.ts <out-dir> <test folder or file>...');process.exit(2);}
 mkdirSync(path.join(outDir,'files'),{recursive:true});
 const files=roots.flatMap(findTestFiles);
 const outcomes:Outcome[]=[];const notes:string[]=[];
 const ci=!!process.env.GITHUB_ACTIONS;
 for(const [i,file] of files.entries()){
  const stem=`${String(i).padStart(3,'0')}-${file.replace(/[\\/:]/g,'_')}`;
  let run=await runFile(file,stem);
  let result=outcomeOf(file,run);
  // A crash of Bun itself is retried once (also one that ran into the time limit after printing its banner); a timeout or
  // an ordinary failure is not.
  if(!result.ok&&crashed(run.log)){
   notes.push(`${result.outcome.file}: Bun crashed; ran it again.`);
   run=await runFile(file,`${stem}-retry`);result=outcomeOf(file,run);
   if(result.ok)notes.push(`${result.outcome.file}: the second run finished.`);
  }
  if(!result.ok)notes.push(`${result.outcome.file}: ${result.outcome.note}.`);
  outcomes.push(result.outcome);
  console.log(ci?`::group::${result.outcome.file}`:`--- ${result.outcome.file}`);
  console.log(run.log.trimEnd());
  if(ci)console.log('::endgroup::');
 }
 const sum=(k:'tests'|'failures'|'skipped')=>outcomes.reduce((n,o)=>n+o[k],0);
 const merged=`<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test (per file)" tests="${sum('tests')}" failures="${sum('failures')}" skipped="${sum('skipped')}">\n${outcomes.map(o=>o.suites.trim()).join('\n')}\n</testsuites>\n`;
 writeFileSync(path.join(outDir,'junit.xml'),merged);
 const lines=[`Ran ${files.length} test files one at a time: ${sum('tests')} tests, ${sum('failures')} failed, ${sum('skipped')} skipped.`,...(notes.length?['',...notes]:[])];
 console.log(lines.join('\n'));
 if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,['```',...lines,'```',''].join('\n'));
 process.exit(sum('failures')||outcomes.some(o=>o.note)?1:0);
}
