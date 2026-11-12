import assert from 'node:assert/strict';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {fixture,authenticate,mcpConnection,browser,evaluate,openEditor,rendered,until,sleep,recording,verifyReadbacks} from './harness.mjs';
const exec=promisify(execFile),page=fixture.pages.twoBrowsers,a='folio-retirement-browser-a',b='folio-retirement-browser-b';
const state=await authenticate(),client=await mcpConnection();await openEditor(a,page,state);await openEditor(b,page,state);
const video=await recording(a,'twoBrowsers');
try{
 video.caption('UPSTREAM + PR14 | Two independent real browser sessions\nBoth edit the same synthetic page using native keyboard input.');await sleep(2000);
 browser(a,'click','.cm-content[contenteditable=true]');browser(a,'press','Control+End');browser(a,'press','Enter');
 const n=evaluate(b,'(()=>{const el=Array.from(document.querySelectorAll(".cm-content > .cm-line")).find(x=>x.innerText.includes("Middle: original."));return Array.from(el.parentElement.children).indexOf(el)+1})()');
 browser(b,'click','.cm-content > .cm-line:nth-child('+n+')');browser(b,'press','End');browser(b,'press','Enter');
 const words=['Browser A: first simultaneous sentence.','Browser B: second simultaneous sentence.'];
 await Promise.all([a,b].map(async(s,i)=>{const {stdout}=await exec('agent-browser',['--json','--session',s,'keyboard','type',words[i]],{timeout:30000});assert(JSON.parse(stdout).success);}));
 await until(()=>[a,b].every(s=>words.every(w=>rendered(s).includes(w))),'both browsers converge');
 const after=await client.call('read_page',{id:page.id});for(const word of words)assert.equal(after.markdown.split(word).length-1,1);
 video.caption('PASS: both simultaneous sentences appear ONCE in both browsers.\nReload, REST, MCP and current-file checks follow.');await sleep(3000);
 const readbacks=await verifyReadbacks(client,page,a,words);browser(b,'reload');await until(()=>words.every(w=>evaluate(b,'document.body.innerText').includes(w)),'second browser reload');
 browser(a,'screenshot',video.out+'/result.png');await sleep(3000);
 video.finish({case:'twoBrowsers',status:'PASS',independentBrowserContexts:2,keyboardCallsStartedTogether:true,bothSentencesOnce:true,bothBrowsersRetainAfterReload:true,...readbacks});console.log('twoBrowsers: PASS');
}finally{await client.close();browser(a,'close');browser(b,'close');}
