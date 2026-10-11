#!/usr/bin/env node
// Chrome native messaging host for Switchboard Browser Companion.
// Chrome starts this process only for the extension IDs listed in the host manifest's
// allowed_origins, and only for the extension that calls sendNativeMessage. It answers one
// request with the companion token that `sbx` wrote on this computer, so the extension can
// pair without a typed code. Nothing else is read or returned.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOKEN_FILE = path.join(os.homedir(), '.switchboard', 'browser-companion-token');
const BRIDGE_URL = 'http://127.0.0.1:7778';
const TOKEN_PATTERN = /^[a-f0-9]{48}$/;

function reply(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]), () => process.exit(0));
}

function answer(request) {
  if (request?.type !== 'get-companion-token') return reply({ ok: false, error: 'Unknown request.' });
  let token = '';
  try {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch (_) {
    return reply({ ok: false, error: 'Start sbx on this computer once to create the companion token.' });
  }
  if (!TOKEN_PATTERN.test(token)) return reply({ ok: false, error: 'Companion token file is invalid.' });
  return reply({ ok: true, token, url: BRIDGE_URL });
}

// Chrome frames each message as a 4-byte little-endian length followed by UTF-8 JSON.
let buffered = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  buffered = Buffer.concat([buffered, chunk]);
  if (buffered.length < 4) return;
  const length = buffered.readUInt32LE(0);
  if (buffered.length < 4 + length) return;
  let request;
  try {
    request = JSON.parse(buffered.subarray(4, 4 + length).toString('utf8'));
  } catch (_) {
    return reply({ ok: false, error: 'Malformed request.' });
  }
  answer(request);
});
process.stdin.on('error', () => process.exit(1));

module.exports = { answer, TOKEN_PATTERN };
