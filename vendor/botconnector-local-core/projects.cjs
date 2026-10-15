// Recent-projects list for /project. Friendly folder name in the UI; full
// path stays available on demand. Stored under the same userData root as
// settings/sessions — no separate config location.
'use strict';
const fs = require('fs');
const path = require('path');
const { userDataDir } = require('./state.cjs');

function file() { return path.join(userDataDir(), 'projects.json'); }
const MAX = 10;

function load() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return []; }
}

function touch(dir) {
  const abs = path.resolve(dir);
  let list = load().filter((p) => p.path !== abs);
  list.unshift({ path: abs, name: path.basename(abs) || abs, lastUsed: Date.now() });
  list = list.slice(0, MAX);
  try { fs.mkdirSync(userDataDir(), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(list, null, 2)); } catch {}
  return list;
}

module.exports = { load, touch, file };
