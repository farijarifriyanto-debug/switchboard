import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { createHost } from '../dist/index.js'

const PORT = 7794
const BASE = 'http://127.0.0.1:' + PORT
const EXTENSION_ORIGIN = 'chrome-extension://' + 'a'.repeat(32)
const TOKEN = 'browser-ws-test-credential-1234'

async function pair(body) {
  return fetch(BASE + '/api/browser-companion/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
    body: JSON.stringify(body),
  })
}

function createSocket(token, origin = EXTENSION_ORIGIN) {
  return new WebSocket('ws://127.0.0.1:' + PORT + '/api/browser-companion/socket',
    ['switchboard-bridge-v1', 'sb-auth-' + token], { origin })
}

async function rejected(token, origin) {
  const socket = createSocket(token, origin)
  const accepted = await new Promise(resolve => {
    socket.once('open', () => resolve(true))
    socket.once('error', () => resolve(false))
    socket.once('unexpected-response', (_req, res) => {
      res.resume()
      resolve(false)
    })
    setTimeout(() => resolve(false), 2000).unref()
  })
  socket.terminate()
  return !accepted
}

const host = await createHost({
  sessions: { dir: '' }, approval: { mode: 'off' },
  browser: { port: PORT, token: TOKEN, timeoutMs: 3500 },
})
let ws
try {
  const service = host.ctx.browserCompanion
  assert.ok(service)
  assert.equal(service.isClientConnected(), false)
  assert.match(service.pairingCode, /^[A-Z0-9_-]{8}$/)
  assert.equal((await pair({code:'AAAAAAAA'})).status,401)
  const code = service.pairingCode
  const valid = await pair({code})
  assert.equal(valid.status,200)
  const data = await valid.json()
  assert.equal(data.token,TOKEN)
  assert.equal((await pair({code})).status,401,'pairing code single-use')
  assert.equal((await pair({token:TOKEN})).status,200,'saved secret reconnect remains supported')
  console.log('PASS short-lived one-use pairing and persistent local token')

  assert.equal(await rejected('bad-credential',EXTENSION_ORIGIN),true)
  assert.equal(await rejected(TOKEN,'https://example.com'),true)
  console.log('PASS WS rejects wrong credentials and forged website origins')

  ws = createSocket(TOKEN)
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)})
  assert.equal(service.isClientConnected(),true)
  const seen=[]
  ws.on('message',async raw=>{
    const frame = JSON.parse(raw.toString())
    if(frame.type !== 'command')return
    seen.push(frame.data)
    await fetch(BASE+'/api/browser-companion/response',{
      method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+TOKEN},
      body:JSON.stringify({id:frame.data.id,ok:true,result:{ok:true,title:'Real command delivered to WS'}})
    })
  })
  const returned=await service.executeOnBrowser('browser_dom_snapshot',{compact:true})
  assert.equal(returned.title,'Real command delivered to WS')
  assert.equal(seen.length,1)
  assert.equal(seen[0].tool,'browser_dom_snapshot')
  const state=await fetch(BASE+'/api/browser-companion/state',{headers:{authorization:'Bearer '+TOKEN}})
  const info=await state.json()
  assert.equal(info.connected,true)
  assert.equal(info.clientCount,1)
  console.log('PASS actual browser tool dispatch and HTTP result through background WebSocket')

  ws.close()
  await new Promise(resolve=>ws.once('close',resolve))
  await new Promise(resolve=>setTimeout(resolve,80))
  assert.equal(service.isClientConnected(),false)
  console.log('PASS disconnected state updates when background socket closes')
} finally {
  ws?.terminate()
  await host.dispose()
}
