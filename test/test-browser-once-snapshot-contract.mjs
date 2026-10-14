import assert from 'node:assert/strict';
import {createHost} from '../dist/index.js';

// One native Chrome allow-once grant covers one *read-only* user tool.
// Its preflight capture must not be repeated by hidden revalidation.
const host=await createHost({
  sessions:{dir:'',load:false},
  metrics:{persist:'',load:false},
  approval:{mode:'off'},
  browser:{defaultMode:'skip'},
  tools:{shell:{disabled:true}}
});
try{
 const svc=host.ctx.browserCompanion;
 Object.defineProperty(svc,'currentMode',{configurable:true,get:()=> 'skip'});
 const commands=[]; svc.isClientConnected=()=>true;
 svc.executeOnBrowser=async(tool,args)=>{
   commands.push(tool);
   if(tool==='browser_dom_snapshot')return {
     ok:true,tabId:42,title:'Only One Grant',url:'http://qa.example/',
     origin:'http://qa.example',text:'Single snapshot content',hash:'dom-safe-1',
     elements:[{ref:'@e1',selector:'#safe',tag:'BUTTON',text:'Safe',disabled:false}]
   };
   if(tool==='browser_tabs_list')return {ok:true,tabs:[{id:42,url:'http://qa.example/',title:'Only One Grant'}]};
   throw Error('Unexpected browser operation '+tool);
 };
 const result=await host.ctx.tools.call('browser_dom_snapshot',{tabId:42},{sessionId:'test-one-grant',userIntent:'Read the safe QA page',model:'local'});
 console.log('ONE_GRANT_TEST_RESULT='+result.slice(0,600));assert.match(result,/Single snapshot content/);
 assert.deepEqual(commands,['browser_dom_snapshot','browser_tabs_list'],
   'read-only tool may take one consented DOM read and a tab identity-only check');
 console.log('PASS_SINGLE_NATIVE_GRANT_ONE_SCREENED_DOM_READ_NO_HIDDEN_SECOND_CAPTURE');
}finally{await host.dispose()}
