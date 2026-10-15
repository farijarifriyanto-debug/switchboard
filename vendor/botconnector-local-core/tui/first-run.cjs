// Real, complete first-run composition, entirely from canonical Core:
//   hardware detection -> catalog recommendation -> user approval ->
//   download (resumable, SHA256-verified) -> runtime resolve/install ->
//   backend choose -> runtime start (respecting the shared ownership lock)
// No step here invents its own download/runtime logic — every step calls
// the same modules the Electron Desktop app and existing CLI already use.
'use strict';
const fs = require('fs');
const path = require('path');
const { detectHardware } = require('../runtime/hardware.cjs');
const { assess } = require('../runtime/recommend.cjs');
const hf = require('../runtime/hf.cjs');
const { DownloadManager } = require('../runtime/downloads.cjs');
const { RuntimeManager } = require('../runtime/runtime-manager.cjs');
const llama = require('../runtime/llama.cjs');
const { claimOwnership, setChild, statePath, readOwnership, pidAlive } = require('../runtime/ownership.cjs');

function catalog() {
  // require() (not fs.readFileSync) so bundlers (esbuild, for the SEA CLI
  // build) statically inline this JSON into the single-file bundle instead
  // of needing a real file tree relative to the running executable.
  return (require('../registry/models.json').models || []);
}

// Ranks the curated local catalog against REAL detected hardware using
// Core's own recommend.assess() — never a heuristic invented here.
async function recommend() {
  const hw = await detectHardware();
  const rank = { great: 0, ok: 1, warn: 2 };
  const scored = catalog()
    .filter((m) => m.runtime === 'llama.cpp')
    .map((m) => ({ model: m, fit: assess(m, hw) }))
    .filter((x) => x.fit.level !== 'no')
    .sort((a, b) => (rank[a.fit.level] ?? 9) - (rank[b.fit.level] ?? 9) || a.model.download_size_gb - b.model.download_size_gb);
  return { hardware: hw, recommendation: scored[0] || null, alternatives: scored.slice(1, 4) };
}

// Resolves a catalog entry (which points at a base-weights homepage, not a
// GGUF repo) to an actual downloadable GGUF file group — the same live HF
// search + modelDetails path `botconnector models search` / `get` already
// use, so this reuses tested Core, not a hardcoded URL.
async function resolveDownloadable(catalogEntry, hardware) {
  const results = await hf.searchModels({ query: catalogEntry.name, limit: 15, hardware });
  const wantCoding = catalogEntry.category === 'Coding';
  const scored = results
    .filter((r) => (r.files === undefined ? true : true)) // search results don't carry files; details fetched below
    .map((r) => ({ r, score: (r.downloads || 0) + (r.likes || 0) * 10 + (wantCoding && r.capabilities.coding ? 1e9 : 0) }))
    .sort((a, b) => b.score - a.score);
  if (!scored.length) throw new Error(`No downloadable GGUF repo found on Hugging Face for "${catalogEntry.name}"`);
  const top = scored[0].r;
  const details = await hf.modelDetails({ id: top.id, hardware });
  if (!details.files.length) throw new Error(`"${top.id}" has no GGUF files`);
  const group = details.files.find((g) => g.quant?.toUpperCase() === String(catalogEntry.recommended_quant || '').toUpperCase()) || details.files[0];
  return { repoId: top.id, group, details };
}

// Downloads via canonical DownloadManager — resumable, SHA256-verified,
// same manifest.json format runtime/installed.cjs already reads.
function makeDownloader({ store, emit }) {
  return new DownloadManager({ getModelsDir: () => store.get('modelsDir'), getToken: () => '', emit });
}

async function ensureRuntimeInstalled({ userDataDir, backend = 'auto', emit }) {
  const runtimes = new RuntimeManager({ baseDir: path.join(userDataDir, 'runtimes', 'llama.cpp'), emit });
  const installed = await runtimes.installed();
  if (installed.installed) return { ...installed, alreadyInstalled: true };
  const result = await runtimes.install({ backend });
  return { ...result, alreadyInstalled: false };
}

// Starts the runtime, claiming the SAME shared ownership lock the Desktop
// app and CLI use. Refuses if another interface already owns it (never
// steals ownership) — surfaces that as an error for the caller to show.
async function startRuntime({ binary, modelPath, projector = null, backend, context = 8192, port = 11435 }) {
  const owner = await readOwnership(statePath());
  if (owner && pidAlive(owner.childPid != null ? owner.childPid : owner.ownerPid) && owner.ownerType !== 'cli-tui') {
    throw new Error(`Runtime is already owned by ${owner.ownerType} (pid ${owner.ownerPid}) — stop it there first, or use its running model.`);
  }
  await claimOwnership({ file: statePath(), ownerType: 'cli-tui', port, modelPath, backend, auth: false });
  try {
    const started = llama.startLlama({ binary, modelPath, projector, port, gpuLayers: backend === 'cpu' ? 0 : 999, context });
    await setChild(statePath(), started.pid);
    return started;
  } catch (error) {
    const { releaseOwnership } = require('../runtime/ownership.cjs');
    await releaseOwnership(statePath());
    throw error;
  }
}

module.exports = { catalog, recommend, resolveDownloadable, makeDownloader, ensureRuntimeInstalled, startRuntime };
