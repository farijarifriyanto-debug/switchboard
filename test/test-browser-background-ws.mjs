import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { createHost } from '../dist/index.js'
import { pairV2 } from './helpers/pair-client.mjs'

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
  assert.match(service.pairingCode, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/)
  assert.equal((await pair({code:'AAAAAAAA'})).status,401)
  const code = service.pairingCode
  const data = await pairV2(BASE, code, 'code', EXTENSION_ORIGIN)
  assert.equal(data.token, TOKEN, 'code pairing returns the token only inside the authenticated encryption envelope')
  assert.equal(data.webOrigin, undefined, 'no console origin advertised when no web console runs')
  await assert.rejects(pairV2(BASE, code, 'code', EXTENSION_ORIGIN), /HTTP 401|rejected|expired/, 'pairing code is single-use')
  const reconnect = await pairV2(BASE, TOKEN, 'token', EXTENSION_ORIGIN)
  assert.equal(reconnect.token, undefined, 'saved token reconnect does not echo the secret')
  assert.equal(reconnect.ok, true, 'saved token reconnect remains supported')
  console.log('PASS short-lived one-use pairing and persistent local token')

  assert.equal(await rejected('bad-credential',EXTENSION_ORIGIN),true)
  assert.equal(await rejected(TOKEN,'https://example.com'),true)
  console.log('PASS WS rejects wrong credentials and forged website origins')

  ws = createSocket(TOKEN)
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)})
  assert.equal(service.isClientConnected(),true)
  assert.equal(service.connectedExtensionOrigin, EXTENSION_ORIGIN, 'Only a fully authenticated socket identifies its extension origin')
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

  const original=ws
  const displaced=new Promise(resolve=>original.once('close',code=>resolve(code)))
  const replacement=createSocket(TOKEN)
  await new Promise((resolve,reject)=>{replacement.once('open',resolve);replacement.once('error',reject)})
  assert.equal(await displaced,4001,'older WS client is explicitly displaced; no reconnect fight')
  ws=replacement
  ws.on('message',async raw=>{
    const frame=JSON.parse(raw.toString())
    if(frame.type!=='command')return
    await fetch(BASE+'/api/browser-companion/response',{
      method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+TOKEN},
      body:JSON.stringify({id:frame.data.id,ok:true,result:{ok:true,title:'Second browser client'}}),
    })
  })
  const second=await service.executeOnBrowser('browser_dom_snapshot',{})
  assert.equal(second.title,'Second browser client')
  console.log('PASS two paired browsers do not receive duplicate commands; latest session wins')
  ws.close()
  await new Promise(resolve=>ws.once('close',resolve))
  await new Promise(resolve=>setTimeout(resolve,80))
  assert.equal(service.isClientConnected(),false)
  assert.equal(service.connectedExtensionOrigin, null, 'Disconnected extension identity must be cleared')
  console.log('PASS disconnected state updates when background socket closes')
} finally {
  ws?.terminate()
  await host.dispose()
}
