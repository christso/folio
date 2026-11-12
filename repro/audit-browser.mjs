import {writeFileSync} from 'node:fs';
import {root,fixture,authenticate,openEditor,browser} from './harness.mjs';
const state=await authenticate(),session='folio-retirement-route-audit',results=[];
try{
 for(const [key,page] of Object.entries(fixture.pages)){
  await openEditor(session,page,state);
  const errors=browser(session,'errors').errors??[];
  const messages=browser(session,'console').messages??[];
  results.push({case:key,route:'/s/'+fixture.space+'/p/'+page.id,status:'PASS',sourceEditorRendered:true,cumulativeUncaughtErrorCount:errors.length,cumulativeConsoleErrorCount:messages.filter(x=>x.type==='error'||x.level==='error').length});
 }
 writeFileSync(root+'/route-audit.json',JSON.stringify({scope:'Post-run route reload/Source render audit, not retroactive capture of console events during all earlier interactions.',results},null,2)+'\n');
 console.log('Post-run editor routes rendered:',results.length,'; final error counts:',results.at(-1).cumulativeUncaughtErrorCount,results.at(-1).cumulativeConsoleErrorCount);
}finally{browser(session,'close');}
