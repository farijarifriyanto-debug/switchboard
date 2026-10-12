import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost } from '../dist/index.js'
const require=createRequire(import.meta.url)
// Optional browser QA dependency is not added to the runtime package.
const puppeteer = process.env.SBX_TEST_PUPPETEER_PATH
  ? require(process.env.SBX_TEST_PUPPETEER_PATH)
  : require('puppeteer')
const dir=await mkdtemp(path.join(tmpdir(),'sbx-catalog-browser-'))
let host,browser
try {
  host=await createHost({
    llm:{baseURL:'http://127.0.0.1:9/v1',defaultModel:'stub',retries:0},
    metrics:{persist:'',load:false},sessions:{dir:'',load:false},settings:{dir},approval:{mode:'off'},
    web:{enabled:true,port:0,host:'127.0.0.1'},
  })
  browser=await puppeteer.launch({headless:true, executablePath:process.env.SBX_TEST_CHROME_PATH || undefined,args:['--no-sandbox','--disable-gpu']})
  const page=await browser.newPage();await page.setViewport({width:1365,height:820})
  const {url} = await host.ctx.web.ready()
  await page.goto(url+'?plugin=semgrep',{waitUntil:'domcontentloaded',timeout:20000})
  await page.waitForSelector('.settings-panel[data-settings-panel="plugins"] .plugin-catalog-card',{timeout:18000})
  await page.waitForFunction(()=>document.querySelectorAll('.plugin-catalog-card').length===2,{timeout:15000})
  let state=await page.evaluate(()=>({dialog:document.getElementById('settings-dialog')?.open,html:document.querySelector('.settings-panel[data-settings-panel="plugins"]')?.innerText.slice(0,800)}))
  assert.equal(state.dialog,true)
  assert.match(state.html,/Semgrep/);assert.match(state.html,/OpenSandbox/)
  console.log('CHROME_DESKTOP_CATALOG_RENDER_PASS')
  await page.click('button[data-action="catalog-install"][data-id="semgrep"]')
  await page.waitForFunction(()=>document.querySelector('article[data-catalog-id="semgrep"]')?.innerText.includes('tools connected'),{timeout:90000})
  state=await page.evaluate(()=>document.querySelector('article[data-catalog-id="semgrep"]')?.innerText)
  assert.match(state,/tools connected/)
  console.log('CHROME_REAL_CLICK_INSTALL_CONNECTED_PASS')
  await page.click('button[data-action="catalog-remove"][data-id="semgrep"]')
  await page.waitForSelector('button[data-action="catalog-install"][data-id="semgrep"]',{timeout:25000})
  console.log('CHROME_REAL_CLICK_REMOVE_PASS')
  await page.screenshot({path:'reports/plugin-catalog-desktop-20261013.png'})
  await page.setViewport({width:390,height:844})
  await page.screenshot({path:'reports/plugin-catalog-mobile-20261013.png'})
  const width=await page.evaluate(()=>({body:document.body.scrollWidth,viewport:window.innerWidth,card:document.querySelector('.plugin-catalog-card')?.getBoundingClientRect().width}))
  assert.ok(width.body<=width.viewport+2,JSON.stringify(width))
  console.log('CHROME_MOBILE_390_NO_OVERFLOW_PASS')
  console.log('PLUGIN_CATALOG_REAL_CHROME_E2E_PASS')
}finally{await browser?.close();await host?.dispose();await rm(dir,{recursive:true,force:true})}
