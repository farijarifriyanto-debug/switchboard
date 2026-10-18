import { createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'

function proof(secret, side, method, clientNonce, serverNonce) {
  return createHmac('sha256', secret)
    .update(`switchboard-pair-${side}|${method}|${clientNonce}|${serverNonce}`)
    .digest('base64url')
}

/**
 * Test client for the v2 mutual pairing protocol. `code` pairing decrypts the
 * returned token; `token` pairing returns no token in the body.
 */
export async function pairV2(base, secret, method = 'token', origin = 'chrome-extension://' + 'a'.repeat(32)) {
  const clientNonce = randomBytes(18).toString('base64url')
  const challengeResponse = await fetch(base + '/api/browser-companion/pair/challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ method, clientNonce }),
  })
  if (!challengeResponse.ok) throw new Error(`challenge HTTP ${challengeResponse.status}: ${await challengeResponse.text()}`)
  const challenge = await challengeResponse.json()
  if (challenge.method !== method || proof(secret, 'server', method, clientNonce, challenge.serverNonce) !== challenge.serverProof) {
    throw new Error('server proof mismatch')
  }
  const response = await fetch(base + '/api/browser-companion/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({
      method,
      clientNonce,
      serverNonce: challenge.serverNonce,
      clientProof: proof(secret, 'client', method, clientNonce, challenge.serverNonce),
    }),
  })
  if (!response.ok) throw new Error(`pair HTTP ${response.status}: ${await response.text()}`)
  const data = await response.json()
  if (method === 'code') {
    const key = createHash('sha256')
      .update(`switchboard-pair-token|${method}|${secret}|${clientNonce}|${challenge.serverNonce}`)
      .digest()
    const sealed = Buffer.from(data.tokenCipher, 'base64url')
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(data.tokenIv, 'base64url'))
    decipher.setAuthTag(sealed.subarray(-16))
    data.token = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]).toString('utf8')
  }
  return data
}
