// Friendly readiness check for the Native Agent TUI — built entirely from
// canonical Core: real hardware detection (nvidia-smi), real runtime status
// and installed-binary verification, real settings store. No probe here
// invents information Core can't actually verify (GPU shows "unknown" when
// no known accelerator is confirmed, never a guess).
'use strict';
const fs = require('fs');
const dns = require('dns');
const path = require('path');
const { detectHardware } = require('./runtime/hardware.cjs');
const { RuntimeManager } = require('./runtime/runtime-manager.cjs');
const { readOwnership, statePath, pidAlive } = require('./runtime/ownership.cjs');
const local = require('./agent/local.cjs');

function checkInternet(timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    const t = setTimeout(() => finish(false), timeoutMs);
    dns.lookup('huggingface.co', (err) => { clearTimeout(t); finish(!err); });
  });
}

function checkProjectAccess(cwd) {
  try { fs.accessSync(cwd, fs.constants.R_OK); return true; } catch { return false; }
}

const ACCEL_BACKENDS = new Set(['vulkan', 'cuda12', 'cuda13', 'rocm']);

// Two independent, verified sources — never a guess:
//  1. hw.nvidia (nvidia-smi) — has a real device name/VRAM/driver.
//  2. the ACTIVE runtime's backend, from the ownership record — confirms
//     acceleration is engaged (the process was launched with that backend)
//     even on hardware detectHardware() can't name (e.g. AMD iGPU/Vulkan).
function gpuLabel(hw, activeBackend) {
  const gpus = hw.nvidia || [];
  if (gpus.length) { const g = gpus[0]; return { name: g.name, memoryGb: g.memoryGb, driver: g.driver, verified: 'device' }; }
  if (activeBackend && ACCEL_BACKENDS.has(activeBackend)) return { name: null, backend: activeBackend, verified: 'active-backend' };
  return null; // no verified accelerator — never guessed
}

// "Running" is checked CROSS-PROCESS: ownership.cjs's lock file is shared by
// the Desktop app, the CLI, and this TUI, so this correctly reports a
// runtime started by any of them — not just one this process happens to own.
async function check(s) {
  const cwd = s.workspace || process.cwd();
  const userDataDir = require('./state.cjs').userDataDir();
  const runtimes = new RuntimeManager({ baseDir: path.join(userDataDir, 'runtimes', 'llama.cpp') });
  const [hw, internet, managedInstalled, owner] = await Promise.all([
    detectHardware(),
    checkInternet(),
    runtimes.installed(),
    readOwnership(statePath()),
  ]);
  const ownerAlive = owner && pidAlive(owner.childPid != null ? owner.childPid : owner.ownerPid);
  const endpoint = ownerAlive && owner.port ? `http://127.0.0.1:${owner.port}/v1` : local.DEFAULT_ENDPOINT;
  const probe = await local.discoverLocalModel({ endpoint, timeoutMs: 1500 });
  const gpu = gpuLabel(hw, ownerAlive ? owner.backend : null);
  return {
    running: probe.ok,
    model: probe.ok ? probe.friendly : null,
    modelId: probe.ok ? probe.id : (ownerAlive ? owner.modelPath : null),
    nCtx: probe.ok ? probe.nCtx : null,
    port: ownerAlive ? owner.port : null,
    endpoint,
    ownerType: ownerAlive ? owner.ownerType : null,
    backend: (ownerAlive && owner.backend) || s.runtime.backend,
    gpu,
    managedInstalled: managedInstalled.installed,
    managedBinary: managedInstalled.binary,
    internet,
    project: checkProjectAccess(cwd),
    projectPath: cwd,
    node: process.version,
    platform: process.platform,
    cpu: hw.cpu,
    ramGb: hw.ramGb,
    reason: probe.ok ? null : probe.reason,
  };
}

function summaryLines(r) {
  const line = (ok, label) => `${ok ? '✓' : '✗'} ${label}`;
  const L = [];
  L.push(r.running && r.project ? 'BotConnector is ready' : 'BotConnector needs attention');
  L.push('');
  L.push(line(r.running, r.running ? 'Local runtime' : 'Local runtime is stopped'));
  if (r.running && r.model) L.push(line(true, r.model));
  if (!r.running) L.push(line(r.managedInstalled, r.managedInstalled ? 'Managed runtime installed' : 'No managed runtime installed'));
  L.push(line(!!r.gpu, r.gpu ? (r.gpu.name ? `${r.gpu.name} acceleration` : `GPU acceleration active (${r.gpu.backend})`) : 'GPU acceleration (not confirmed — see /details)'));
  L.push(line(r.internet, 'Internet'));
  L.push(line(r.project, 'Project access'));
  return L;
}

function detailLines(r) {
  return [
    `runtime       : ${r.running ? `running on ${r.endpoint}` : 'stopped'}`,
    `owner         : ${r.ownerType || '—'}`,
    `backend       : ${r.backend}`,
    `model id      : ${r.modelId || '—'}`,
    `n_ctx         : ${r.nCtx || '—'}`,
    `managed binary: ${r.managedBinary || '—'}`,
    r.reason ? `runtime error : ${r.reason}` : null,
    `gpu           : ${r.gpu ? (r.gpu.name ? `${r.gpu.name} (${r.gpu.memoryGb}GB, driver ${r.gpu.driver})` : `not named by hardware probe — confirmed active via ${r.gpu.backend} backend`) : 'none verified'}`,
    `cpu           : ${r.cpu}`,
    `ram           : ${r.ramGb}GB`,
    `node          : ${r.node}`,
    `platform      : ${r.platform}`,
    `project path  : ${r.projectPath}`,
  ].filter((l) => l != null);
}

module.exports = { check, summaryLines, detailLines };
