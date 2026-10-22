// Prints a short summary of a `bun test --reporter=junit` file: the totals, then every failed test as file:line and name,
// so a CI log can be read without scrolling the full run. Also appended to the GitHub step summary when there is one.
// Usage: bun scripts/ci-test-summary.ts <junit.xml>
import {readFileSync,appendFileSync,existsSync} from 'node:fs';

const file=process.argv[2];
if(!file||!existsSync(file)){console.log(`No test report at ${file??'(none given)'}: the test step did not get as far as writing one.`);process.exit(0);}
const xml=readFileSync(file,'utf8');
const attr=(tag:string,name:string)=>new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]??'';
const unescape=(s:string)=>s.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const top=/<testsuites\b[^>]*>/.exec(xml)?.[0]??'';
const failed:string[]=[];const skipped:string[]=[];
for(const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)){
 const where=`${unescape(attr(m[1],'file'))}:${attr(m[1],'line')}`;const name=unescape(attr(m[1],'name'));
 if(m[3]?.includes('<failure'))failed.push(`${where}  ${name}`);
 else if(m[3]?.includes('<skipped'))skipped.push(`${where}  ${name}`);
}
const lines=[
 `Tests: ${attr(top,'tests')}, failed: ${attr(top,'failures')}, skipped: ${attr(top,'skipped')}.`,
 ...(failed.length?['','Failed:',...failed.map(f=>`  ${f}`)]:[]),
 ...(skipped.length?['','Skipped:',...skipped.map(f=>`  ${f}`)]:[]),
];
console.log(lines.join('\n'));
if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,['```',...lines,'```',''].join('\n'));
