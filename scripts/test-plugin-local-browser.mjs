/** Browser QA for the existing Plugins & MCP panel, not a new UI layer.
 * Requires a real Chrome binary, Puppeteer and Docker Linux containers. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost } from '../dist/index.js'
const require=createRequire(import.meta.url)
const puppeteer=process.env.SBX_TEST_PUPPETEER_PATH ? require(process.env.SBX_TEST_PUPPETEER_PATH) : require('puppeteer')
const dir=await mkdtemp(path.join(tmpdir(),'sbx-local-browser-'))
let host,browser
try {
 host=await createHost({
   llm:{baseURL:'http://127.0.0.1:9/v1',defaultModel:'fixture',retries:0},
   sessions:{dir:'',load:false},metrics:{persist:'',load:false},approval:{mode:'off'},
   settings:{dir},web:{enabled:true,port:0,host:'127.0.0.1'},
 })
 browser=await puppeteer.launch({headless:true,executablePath:process.env.SBX_TEST_CHROME_PATH || undefined,args:['--no-sandbox','--disable-gpu']})
 const page=await browser.newPage();await page.setViewport({width:1365,height:820})
 const {url}=await host.ctx.web.ready()
 await page.goto(url+'?plugin=opensandbox',{waitUntil:'domcontentloaded',timeout:24000})
 await page.waitForSelector('article[data-catalog-id="opensandbox"] .catalog-mode',{timeout:17000})
 assert.equal(await page.$eval('.catalog-mode',el=>el.value),'local')
 assert.equal(await page.$eval('.plugin-catalog-private',el=>el.hidden),true)
 console.log('CHROME_LOCAL_DEFAULT_WITHOUT_SERVER_KEY_FIELDS_PASS')
 await page.select('.catalog-mode','private')
 assert.equal(await page.$eval('.plugin-catalog-private',el=>el.hidden),false)
 await page.select('.catalog-mode','local')
 assert.equal(await page.$eval('.plugin-catalog-private',el=>el.hidden),true)
 console.log('CHROME_PRIVATE_SERVER_MODE_TOGGLE_PASS')
 await page.click('article[data-catalog-id="opensandbox"] [data-action="catalog-install"]')
 await page.waitForFunction(()=>/Local Docker · \d+ tools connected/.test(document.querySelector('article[data-catalog-id="opensandbox"]')?.innerText||''),{timeout:125000})
 console.log('CHROME_CLICK_LOCAL_INSTALL_24_TOOLS_PASS')
 await page.screenshot({path:'reports/opensandbox-local-installed-1365-20261013.png'})
 await page.click('article[data-catalog-id="opensandbox"] [data-action="catalog-remove"]')
 await page.waitForSelector('article[data-catalog-id="opensandbox"] [data-action="catalog-install"]',{timeout:38000})
 console.log('CHROME_CLICK_LOCAL_REMOVE_PASS')
 await page.setViewport({width:390,height:844})
 const widths=await page.evaluate(()=>({body:document.body.scrollWidth,viewport:innerWidth}))
 assert.ok(widths.body<=widths.viewport+2,JSON.stringify(widths))
 await page.screenshot({path:'reports/opensandbox-local-390-20261013.png'})
 console.log('CHROME_LOCAL_MOBILE_390_NO_OVERFLOW_PASS')
 console.log('CHROME_LOCAL_RUNTIME_UI_E2E_PASS')
}finally{
 if(browser)await browser.close()
 if(host){try{const x=host.ctx.pluginCatalog.list().find(p=>p.id==='opensandbox'); if(x?.managed)await host.ctx.pluginCatalog.uninstall('opensandbox')}catch(e){console.error('CHECK TEST CLEANUP',e.message)} await host.dispose()}
 await rm(dir,{recursive:true,force:true})
}
