#!/usr/bin/env node
// Registers the Switchboard native messaging host for one unpacked extension ID.
// Usage: node browser-extension/native/install-native-host.mjs <extension-id>
// Writes the host manifest under ~/.switchboard/native and points Chrome and Edge at it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOST_NAME = 'com.botconnector.switchboard';
const extensionId = String(process.argv[2] || '');
if (!/^[a-p]{32}$/.test(extensionId)) {
  console.error('Usage: node install-native-host.mjs <32-character extension ID>');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const hostScript = path.join(here, 'switchboard-native-host.cjs');
const dir = path.join(os.homedir(), '.switchboard', 'native');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const wrapper = path.join(dir, 'switchboard-native-host.cmd');
fs.writeFileSync(wrapper, `@echo off\r\nnode "${hostScript}" %*\r\n`);

const manifest = {
  name: HOST_NAME,
  description: 'Switchboard Browser Companion native host',
  path: wrapper,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${extensionId}/`],
};
const manifestPath = path.join(dir, `${HOST_NAME}.json`);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

if (process.platform !== 'win32') {
  console.log('Manifest written to', manifestPath);
  console.log('On macOS/Linux copy it into the browser NativeMessagingHosts folder for Chrome or Edge.');
  process.exit(0);
}

for (const root of ['HKCU\\Software\\Google\\Chrome', 'HKCU\\Software\\Microsoft\\Edge']) {
  execFileSync('reg', ['add', `${root}\\NativeMessagingHosts\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'ignore' });
}
console.log('Native host registered for Chrome and Edge:', manifestPath);
console.log('Reload the extension once, then start sbx on this computer.');
