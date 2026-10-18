// Native messaging pairing: the host returns only the companion token from the CLI's
// token file, and the extension pairs with it without a typed code.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHmac, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

const TOKEN = 'a'.repeat(48);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-native-'));
fs.mkdirSync(path.join(home, '.switchboard'), { recursive: true });
fs.writeFileSync(path.join(home, '.switchboard', 'browser-companion-token'), TOKEN + '\n');

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function ask(request, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['browser-extension/native/switchboard-native-host.cjs'], {
      env: { ...process.env, USERPROFILE: home, HOME: home, ...env },
    });
    let out = Buffer.alloc(0);
    child.stdout.on('data', c => { out = Buffer.concat([out, c]); });
    child.on('error', reject);
    child.on('exit', () => {
      const length = out.readUInt32LE(0);
      resolve(JSON.parse(out.subarray(4, 4 + length).toString('utf8')));
    });
    child.stdin.end(frame(request));
  });
}

// 1. Host answers with the companion token and the local bridge URL only.
{
  const reply = await ask({ type: 'get-companion-token' });
  assert.equal(reply.ok, true);
  assert.equal(reply.token, TOKEN);
  assert.equal(reply.url, 'http://127.0.0.1:7778');
  assert.deepEqual(Object.keys(reply).sort(), ['ok', 'token', 'url'], 'no other fields are returned');
  console.log('PASS native host returns the companion token and bridge URL only');
}

// 2. Unknown requests are refused.
{
  const reply = await ask({ type: 'read-anything' });
  assert.equal(reply.ok, false);
  assert.equal(reply.token, undefined);
  console.log('PASS native host refuses unknown requests');
}

// 3. A missing or malformed token file yields an error, never a token.
{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-native-empty-'));
  const reply = await ask({ type: 'get-companion-token' }, { USERPROFILE: empty, HOME: empty });
  assert.equal(reply.ok, false);
  assert.equal(reply.token, undefined);
  console.log('PASS native host reports a missing token file without a token');
}

// 4. The extension pairs with the returned token and stores it, with no typed code.
{
  const local = {};
  const requests = [];
  const chrome = {
    storage: { local: {
      async get(keys) { return Object.fromEntries([].concat(keys).map(k => [k, local[k]])); },
      async set(values) { Object.assign(local, values); }
    } },
    runtime: {
      sendNativeMessage: async (name, message) => { requests.push([name, message.type]); return { ok: true, token: TOKEN, url: 'http://127.0.0.1:7778' }; }
    }
  };
  const fetched = [];
  const serverNonce = 's'.repeat(24);
  const ctx = vm.createContext({
    chrome,
    URL,
    console,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    btoa,
    atob,
    setTimeout,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      fetched.push({ url, body });
      if (url.endsWith('/pair/challenge')) {
        const serverProof = createHmac('sha256', TOKEN)
          .update(`switchboard-pair-server|token|${body.clientNonce}|${serverNonce}`)
          .digest('base64url');
        return { ok: true, status: 200, json: async () => ({ ok: true, method: 'token', serverNonce, serverProof }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, mode: 'auto' }) };
    }
  });
  const source = readFileSync('browser-extension/background.js', 'utf8');
  const start = source.indexOf('function base64url');
  const end = source.indexOf('async function ensureBridgeSocket()');
  // Load only the helpers this test needs; the rest of the worker needs live Chrome APIs.
  vm.runInContext(source.slice(start, end)
    + '\nlet serverMode = "auto";'
    + '\nfunction normalizeActionMode(value) { return value === "manual" ? "manual" : value === "skip" ? "skip" : "auto"; }'
    + '\nfunction validBridgeUrl(input) { return new URL(String(input || "http://127.0.0.1:7778")).origin; }'
    + '\nthis.pairViaNativeHost = pairViaNativeHost;', ctx);
  await vm.runInContext('pairViaNativeHost()', ctx);
  assert.deepEqual(requests, [['com.botconnector.switchboard', 'get-companion-token']]);
  assert.equal(fetched[0].url, 'http://127.0.0.1:7778/api/browser-companion/pair/challenge');
  assert.equal(fetched[0].body.method, 'token');
  assert.equal(fetched[1].url, 'http://127.0.0.1:7778/api/browser-companion/pair');
  assert.equal(fetched[1].body.method, 'token');
  assert.match(fetched[1].body.clientProof, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(local.companionToken, TOKEN);
  assert.equal(local.bridgeConnected, true);
  assert.equal(local.permissionMode, 'auto');
  console.log('PASS extension pairs through the native host with mutual challenge-response');
}

fs.rmSync(home, { recursive: true, force: true });
console.log('=== Browser native pairing contract PASSED ===');
