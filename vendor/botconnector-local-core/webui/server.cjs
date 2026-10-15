// Local-only HTTP server for the Portable Web App delivery path. This is a
// second presentation-layer adapter over the SAME shared Core that
// desktop/main.cjs already wires up (runtime/*, agent/*) — an HTTP/browser
// transport instead of Electron's contextBridge/IPC transport. It duplicates
// no runtime logic: every capability here is a direct call into the existing
// runtime/*.cjs modules.
//
// Security posture (binds 127.0.0.1 only, caller must verify):
//  - never bind anything but 127.0.0.1
//  - no CORS headers are ever emitted (default browser same-origin policy
//    blocks a foreign page from reading any response body)
//  - every request is additionally checked server-side against Origin/Host
//    (defense in depth against non-browser clients and DNS rebinding)
//  - a random per-process session secret gates every /api/* route except the
//    /api/session bootstrap and /health; the browser page learns the secret
//    only via that bootstrap call, itself Origin/Host-gated
//  - cloud/HF/local-API credentials: this process has no Electron
//    safeStorage, so — exactly like the existing CLI (bin/botconnector.mjs,
//    "cloud set-key") — nothing is ever persisted as plaintext or
//    pseudo-encrypted here. Keys/tokens entered through this server live in
//    memory for the current process only; persistent encrypted storage
//    remains the Desktop app's job. This is a disclosed scope difference,
//    not a silent regression.
'use strict';
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { pickFolder, pickFile } = require('./dialogs.cjs');
const { isSafeExternal, providerName, plainObject } = require('../desktop/security.cjs');
const agentLoop = require('../agent/loop.cjs');
const agentLocal = require('../agent/local.cjs');
const { createWorkspace } = require('../agent/tools.cjs');
const agentMutate = require('../agent/mutate.cjs');
const agentShell = require('../agent/shell.cjs');

const { detectHardware } = require('../runtime/hardware.cjs');
const llama = require('../runtime/llama.cjs');
const hf = require('../runtime/hf.cjs');
const { DownloadManager } = require('../runtime/downloads.cjs');
const { RuntimeManager } = require('../runtime/runtime-manager.cjs');
const { Store } = require('../runtime/store.cjs');
const { scanInstalled } = require('../runtime/installed.cjs');
const { TOOL_DEFINITIONS, executeAllowedTool } = require('../runtime/tools.cjs');
const { claimOwnership, releaseOwnership, setChild, statePath } = require('../runtime/ownership.cjs');
const { McpClient } = require('../runtime/mcp.cjs');
const { CredentialManager } = require('../runtime/credentials.cjs');
const { NebiusProvider } = require('../runtime/cloud/nebius.cjs');
const { TogetherProvider } = require('../runtime/cloud/together.cjs');
const { ModelCatalog } = require('../runtime/cloud/catalog.cjs');
const { RoutingTable } = require('../runtime/cloud/routing.cjs');
const { HealthBoard } = require('../runtime/cloud/health.cjs');
const { UsageLedger } = require('../runtime/cloud/usage.cjs');
const { PricingRegistry } = require('../runtime/cloud/pricing.cjs');
const { UnitEngine } = require('../runtime/cloud/units.cjs');
const { BudgetGuard } = require('../runtime/cloud/budget.cjs');
const { CloudRouter } = require('../runtime/cloud/router.cjs');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };

function startUiServer({ userDataDir, webRoot, getAsset, preferredPort = 32100, log = () => {}, onQuit = () => {} } = {}) {
  if (!userDataDir) throw new Error('userDataDir is required');
  fs.mkdirSync(userDataDir, { recursive: true }); // fresh install / first run: nothing has created this yet
  const secret = crypto.randomBytes(24).toString('hex');
  const store = new Store(userDataDir);
  store.load();
  const ownershipFile = statePath(userDataDir);
  const downloads = new DownloadManager({ getModelsDir: () => store.get('modelsDir'), getToken: () => getToken(), emit: (channel, payload) => broadcast(channel, payload) });
  const runtimes = new RuntimeManager({ baseDir: path.join(userDataDir, 'runtimes', 'llama.cpp'), emit: (channel, payload) => broadcast(channel, payload) });

  // ---------- in-memory-only secrets (no Electron safeStorage here) ----------
  let sessionHfToken = process.env.HF_TOKEN || '';
  let sessionApiToken = '';
  let sessionApiAuthEnabled = false;
  const sessionCloudKeys = { nebius: '', together: '' };
  function getToken() { return sessionHfToken; }
  function bearerForRt() { return sessionApiAuthEnabled && sessionApiToken ? `Bearer ${sessionApiToken}` : 'Bearer local'; }
  function publicSettings() {
    const d = store.public();
    delete d.hfToken; delete d.hfTokenEncrypted; delete d.apiTokenEncrypted;
    return { ...d, hfTokenConfigured: Boolean(sessionHfToken), apiAuthEnabled: sessionApiAuthEnabled, apiTokenConfigured: Boolean(sessionApiToken), credentialStorage: 'session-only (no Electron safeStorage in the portable web server — persistent encrypted storage remains the Desktop app)' };
  }

  // ---------- cloud (session-only key overrides, same contract as the CLI) ----------
  let cloud = null;
  function initCloud() {
    const cloudDir = path.join(userDataDir, 'cloud');
    const credentials = new CredentialManager({ store, env: process.env });
    const keyFor = (p) => sessionCloudKeys[p] || (credentials.source(p).source !== 'missing' ? credentials.source(p).key : null);
    const adapters = {
      nebius: new NebiusProvider({ getKey: () => keyFor('nebius') }),
      together: new TogetherProvider({ getKey: () => keyFor('together') }),
    };
    const catalog = new ModelCatalog({ adapters, cachedir: cloudDir });
    const routing = new RoutingTable({ dir: cloudDir });
    const health = new HealthBoard({ dir: cloudDir }); health.restore().catch(() => {});
    const ledger = new UsageLedger({ dir: cloudDir });
    const pricing = new PricingRegistry({ dir: cloudDir });
    const units = new UnitEngine({});
    const budget = new BudgetGuard({ dir: cloudDir });
    const router = new CloudRouter({ adapters, catalog, routing, health, ledger, pricing, units, budget });
    cloud = { credentials, adapters, catalog, routing, health, ledger, pricing, units, budget, router, dir: cloudDir };
    return cloud;
  }
  function cloudPublic() {
    const base = cloud.credentials.public();
    for (const p of ['nebius', 'together']) if (sessionCloudKeys[p]) base[p] = { ...base[p], configured: true, source: 'session' };
    return { configured: true, credentials: base, health: cloud.health.all(['nebius', 'together']), catalog: cloud.catalog.counts(), units: cloud.units.public(), budget: cloud.budget.public(), commercialLaunchApproved: false };
  }
  initCloud();

  // ---------- MCP ----------
  const mcpClients = new Map(), mcpStatuses = new Map();
  function normalizeMcpConfig(input = {}) {
    const id = String(input.id || '').trim(), name = String(input.name || '').trim();
    const transport = String(input.transport || 'stdio').toLowerCase(), command = String(input.command || '').trim();
    if (id && !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('MCP id is invalid');
    if (!name || name.length > 120) throw new Error('MCP server name is required');
    if (transport !== 'stdio') throw new Error('Only stdio MCP transport is enabled in this beta');
    if (!command || command.includes('\u0000')) throw new Error('MCP executable/command is required');
    const args = Array.isArray(input.args) ? input.args.map(String).slice(0, 64) : [];
    if (args.some(v => v.includes('\u0000') || v.length > 4096)) throw new Error('MCP argument is invalid');
    const envRefs = Array.isArray(input.envRefs) ? input.envRefs.map(String).filter(v => /^[A-Z_][A-Z0-9_]*$/i.test(v)).slice(0, 32) : [];
    const allowedTools = [...new Set((Array.isArray(input.allowedTools) ? input.allowedTools : []).map(String).filter(Boolean).slice(0, 128))];
    const toolPermissions = {}; for (const [tool, mode] of Object.entries(input.toolPermissions && typeof input.toolPermissions === 'object' ? input.toolPermissions : {})) { if (tool && ['ask', 'allow', 'deny'].includes(String(mode).toLowerCase())) toolPermissions[String(tool)] = String(mode).toLowerCase(); }
    return { id: id || crypto.randomUUID(), name, transport, command, args, envRefs, enabled: input.enabled !== false, timeoutMs: Math.min(30000, Math.max(250, Number(input.timeoutMs || 5000))), allowedTools, toolPermissions, permissionMode: ['ask', 'allow', 'deny'].includes(String(input.permissionMode || 'ask').toLowerCase()) ? String(input.permissionMode || 'ask').toLowerCase() : 'ask', notes: String(input.notes || '').slice(0, 500), provenance: String(input.provenance || '').slice(0, 240) };
  }
  function mcpStatusFor(config) { return mcpStatuses.get(config.id) || { state: config.enabled ? 'configured' : 'disabled', tools: [], error: null }; }
  function mcpPublic(config) { const status = mcpStatusFor(config); return { ...config, status: status.state, tools: status.tools || [], error: status.error || null }; }
  function storedMcp() { const rows = store.get('mcpServers'); return Array.isArray(rows) ? rows : []; }
  async function stopMcp(id) { const client = mcpClients.get(id); if (client) { await client.stop().catch(() => {}); mcpClients.delete(id); } }
  async function testMcp(config) {
    if (!config.enabled) { mcpStatuses.set(config.id, { state: 'disabled', tools: [], error: null }); return mcpPublic(config); }
    await stopMcp(config.id);
    const client = new McpClient(config); mcpClients.set(config.id, client);
    mcpStatuses.set(config.id, { state: 'connecting', tools: [], error: null });
    try { const tools = await client.listTools(); mcpStatuses.set(config.id, { state: 'connected', tools: tools.map(t => t.name), error: null }); return mcpPublic(config); }
    catch (error) { await stopMcp(config.id); mcpStatuses.set(config.id, { state: 'error', tools: [], error: String(error.message || error) }); return mcpPublic(config); }
  }

  // ---------- runtime ----------
  function runtimeConfig(input = {}) {
    if (!plainObject(input)) throw new Error('Runtime configuration must be an object');
    for (const key of ['binary', 'modelPath', 'projector', 'apiKey']) if (input[key] != null && (typeof input[key] !== 'string' || input[key].length > 4096 || input[key].includes('\u0000'))) throw new Error(`Runtime ${key} is invalid`);
    const port = Number(input.port || 11435), context = Number(input.context || 8192), gpuLayers = Number(input.gpuLayers ?? 999), backend = String(input.backend || 'auto').toLowerCase();
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Runtime port is invalid');
    if (!Number.isInteger(context) || context < 256 || context > 262144 || !Number.isInteger(gpuLayers) || gpuLayers < -1 || gpuLayers > 10000) throw new Error('Runtime limits are invalid');
    if (!['auto', 'cpu', 'vulkan', 'cuda12', 'cuda13', 'rocm', 'hip'].includes(backend)) throw new Error('Runtime backend is invalid');
    return { ...input, port, context, gpuLayers, backend };
  }
  async function startOwnedRuntime(cfg) {
    if (llama.status().running) throw new Error('Local runtime already running in this process');
    const port = Number(cfg.port || 11435);
    try { const h = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) }); if (h.ok) throw new Error(`Port ${port} already serves a runtime`); } catch (e) { if (e.message.includes('already serves')) throw e; }
    await claimOwnership({ file: ownershipFile, ownerType: 'cli', port, modelPath: cfg.modelPath, backend: cfg.backend || store.get('runtimeBackend') || 'auto', auth: Boolean(cfg.apiKey) });
    try { const started = llama.startLlama(cfg); await setChild(ownershipFile, started.pid); return started; }
    catch (error) { await releaseOwnership(ownershipFile); throw error; }
  }

  // ---------- SSE broadcast (download/runtime-install progress) ----------
  const sseClients = new Set();
  function broadcast(type, payload) { const line = `data: ${JSON.stringify({ type, payload })}\n\n`; for (const res of sseClients) { try { res.write(line); } catch {} } }

  // ---------- minimal browser Agent workflow (Section 5) ----------
  // One user message -> one tool intent -> proposal -> approve/reject ->
  // apply -> plain result. Deliberately NOT the full TUI experience (no
  // multi-tool bounded task loop, no session-resume-across-restart, no rich
  // tool-call timeline) — this reuses the exact same Core primitives
  // (agent/loop.cjs, agent/mutate.cjs, agent/shell.cjs) the TUI already
  // uses, just composed for a two-request HTTP flow instead of the TUI's
  // in-process approval promise. A pending proposal/command is held here in
  // memory only, keyed by a short-lived taskId — never written to disk.
  const pendingAgentTasks = new Map();
  function prunePendingTasks() { const now = Date.now(); for (const [id, t] of pendingAgentTasks) if (t.expiresAt < now) pendingAgentTasks.delete(id); }

  // ---------- HTTP plumbing ----------
  function readJson(req) {
    return new Promise((resolve, reject) => {
      let body = ''; let size = 0;
      req.on('data', c => { size += c.length; if (size > 25 * 1024 * 1024) { reject(new Error('Request body too large')); req.destroy(); return; } body += c; });
      req.on('end', () => { if (!body) return resolve({}); try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON body')); } });
      req.on('error', reject);
    });
  }
  function send(res, status, body, headers = {}) {
    const buf = Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body);
    const defaultType = typeof body === 'string' ? 'text/plain; charset=utf-8' : Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json; charset=utf-8';
    res.writeHead(status, { 'Content-Type': defaultType, 'Content-Length': Buffer.byteLength(buf), ...headers });
    res.end(buf);
  }
  function sendJson(res, status, obj) { send(res, status, JSON.stringify(obj)); }

  let boundPort = null;
  function allowedOrigin(value) {
    if (!value) return true; // browsers omit Origin on plain top-level navigations/GETs; Host is still checked below
    try { const u = new URL(value); return (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && Number(u.port || 80) === boundPort; } catch { return false; }
  }
  function allowedHost(value) {
    if (!value) return false;
    const h = String(value).split(',')[0].trim();
    return h === `127.0.0.1:${boundPort}` || h === `localhost:${boundPort}`;
  }

  async function handleApi(req, res, url) {
    const p = url.pathname;
    // bootstrap: no session secret required yet, but still Origin/Host gated
    if (p === '/api/session' && req.method === 'GET') return sendJson(res, 200, { secret });
    const given = req.headers['x-botconnector-session'] || url.searchParams.get('s');
    if (given !== secret) return sendJson(res, 403, { error: 'Missing or invalid session credential' });

    try {
      // ---- quit ----
      if (p === '/api/quit' && req.method === 'POST') {
        sendJson(res, 200, { ok: true, message: 'BotConnector is stopping.' });
        setImmediate(async () => {
          try {
            if (llama.status().running) { llama.stopLlama(); await releaseOwnership(ownershipFile); }
          } catch (e) { log(`[quit] runtime stop error: ${e.message || e}`); }
          for (const client of mcpClients.values()) { try { await client.stop(); } catch {} }
          mcpClients.clear();
          for (const c of sseClients) { try { c.end(); } catch {} }
          let quitCalled = false;
          const finishQuit = () => { if (quitCalled) return; quitCalled = true; onQuit(); };
          server.close(finishQuit);
          // Belt-and-braces: if something (a lingering socket) keeps close()
          // from firing its callback, still exit — a hung "quit" would be
          // worse than a slightly-abrupt one after cleanup already ran.
          setTimeout(finishQuit, 3000).unref();
        });
        return;
      }
      // ---- overview / settings ----
      if (p === '/api/overview' && req.method === 'GET') {
        const hardware = await detectHardware();
        return sendJson(res, 200, { hardware, runtime: llama.status(), preferredLanguages: [], settings: publicSettings(), mcp: storedMcp().map(mcpPublic), managedRuntime: await runtimes.installed(), installed: await scanInstalled(store.get('modelsDir')), downloads: downloads.list() });
      }
      if (p === '/api/settings' && req.method === 'GET') return sendJson(res, 200, publicSettings());
      if (p === '/api/settings' && req.method === 'POST') {
        const input = await readJson(req); if (!plainObject(input)) throw new Error('Settings payload must be an object');
        const allowed = ['runtimeBackend', 'language']; for (const k of allowed) if (k in input) await store.set(k, String(input[k]).slice(0, 64));
        if ('apiAuthEnabled' in input) sessionApiAuthEnabled = Boolean(input.apiAuthEnabled);
        if ('firstRunCompleted' in input) await store.set('firstRunCompleted', Boolean(input.firstRunCompleted));
        if ('firstRunMode' in input) await store.set('firstRunMode', String(input.firstRunMode || '').slice(0, 32));
        return sendJson(res, 200, publicSettings());
      }
      if (p === '/api/settings/hf-token' && req.method === 'POST') { const { token } = await readJson(req); sessionHfToken = String(token || '').trim().slice(0, 4096); return sendJson(res, 200, { configured: Boolean(sessionHfToken) }); }
      if (p === '/api/settings/api-token' && req.method === 'POST') { sessionApiToken = 'bc-local-' + crypto.randomBytes(24).toString('hex'); return sendJson(res, 200, { token: sessionApiToken, warning: 'Shown once. Copy it now; this server never displays it again. Session-only — lost on restart.' }); }
      if (p === '/api/settings/api-token' && req.method === 'DELETE') { sessionApiToken = ''; sessionApiAuthEnabled = false; return sendJson(res, 200, publicSettings()); }
      if (p === '/api/settings/models-dir' && req.method === 'POST') {
        const dir = await pickFolder('Choose model storage directory');
        if (!dir) return sendJson(res, 200, null);
        await store.set('modelsDir', dir); return sendJson(res, 200, { modelsDir: dir, installed: await scanInstalled(dir) });
      }
      if (p === '/api/open-external' && req.method === 'POST') { const { url: u } = await readJson(req); if (!isSafeExternal(u)) throw new Error('External URL is not allowed'); return sendJson(res, 200, { ok: true, url: u }); }

      // ---- mcp ----
      if (p === '/api/mcp' && req.method === 'GET') return sendJson(res, 200, storedMcp().map(mcpPublic));
      if (p === '/api/mcp' && req.method === 'POST') {
        const input = await readJson(req); const config = normalizeMcpConfig(input || {});
        const rows = storedMcp(), index = rows.findIndex(row => row.id === config.id), previous = mcpStatusFor(config);
        if (index >= 0) { await stopMcp(config.id); rows[index] = config; } else rows.push(config);
        await store.set('mcpServers', rows); if (previous.state === 'connected') mcpStatuses.set(config.id, previous); else mcpStatuses.delete(config.id);
        return sendJson(res, 200, mcpPublic(config));
      }
      const mcpIdMatch = p.match(/^\/api\/mcp\/([^/]+)$/);
      if (mcpIdMatch && req.method === 'DELETE') {
        const id = decodeURIComponent(mcpIdMatch[1]); const rows = storedMcp().filter(row => row.id !== id);
        if (rows.length === storedMcp().length) return sendJson(res, 200, { ok: false });
        await stopMcp(id); mcpStatuses.delete(id); await store.set('mcpServers', rows); return sendJson(res, 200, { ok: true });
      }
      const mcpTestMatch = p.match(/^\/api\/mcp\/([^/]+)\/test$/);
      if (mcpTestMatch && req.method === 'POST') { const config = storedMcp().find(r => r.id === decodeURIComponent(mcpTestMatch[1])); if (!config) throw new Error('MCP server is not configured'); return sendJson(res, 200, await testMcp(config)); }
      const mcpInvokeMatch = p.match(/^\/api\/mcp\/([^/]+)\/invoke$/);
      if (mcpInvokeMatch && req.method === 'POST') {
        const { tool, args } = await readJson(req); const config = storedMcp().find(r => r.id === decodeURIComponent(mcpInvokeMatch[1])); if (!config) throw new Error('MCP server is not configured');
        if (!config.enabled) throw new Error('MCP server is disabled');
        const toolName = String(tool || ''), permission = String(config.toolPermissions?.[toolName] || config.permissionMode || 'ask').toLowerCase();
        if (permission !== 'allow') throw new Error(permission === 'deny' ? `MCP tool denied: ${toolName}` : `MCP tool approval required: ${toolName}`);
        if (!config.allowedTools.includes(toolName)) throw new Error(`MCP tool is not allowlisted: ${toolName}`);
        let client = mcpClients.get(config.id); if (!client) { client = new McpClient(config); mcpClients.set(config.id, client); }
        const result = await client.callTool(toolName, args || {}); return sendJson(res, 200, { ...result, provenance: config.provenance || config.name });
      }

      // ---- models / downloads ----
      if (p === '/api/models/search' && req.method === 'POST') { const input = await readJson(req); if (!plainObject(input)) throw new Error('Model search payload must be an object'); const hardware = await detectHardware(); return sendJson(res, 200, await hf.searchModels({ ...input, hardware, token: getToken() })); }
      if (p === '/api/models/details' && req.method === 'POST') { const { id } = await readJson(req); if (typeof id !== 'string' || !id || id.length > 300) throw new Error('Model id is invalid'); const hardware = await detectHardware(); return sendJson(res, 200, await hf.modelDetails({ id, hardware, token: getToken() })); }
      if (p === '/api/models/installed' && req.method === 'GET') return sendJson(res, 200, await scanInstalled(store.get('modelsDir')));
      if (p === '/api/models/reveal' && req.method === 'POST') {
        const { path: fp } = await readJson(req); if (typeof fp !== 'string' || !fp) return sendJson(res, 200, false);
        const { execFile } = require('node:child_process');
        if (process.platform === 'win32') execFile('explorer.exe', ['/select,', fp], () => {});
        else execFile('xdg-open', [path.dirname(fp)], () => {}); // no Linux equivalent of "select this exact file" without knowing the desktop's file manager; open the containing folder instead
        return sendJson(res, 200, true);
      }
      if (p === '/api/models/delete' && req.method === 'POST') {
        const { dir } = await readJson(req); const root = path.resolve(store.get('modelsDir')); const target = path.resolve(String(dir || ''));
        if (!target.startsWith(root + path.sep)) throw new Error('Refusing to delete outside model directory');
        if (llama.status().running && path.resolve(llama.status().modelPath || '').startsWith(target + path.sep)) throw new Error('Stop the runtime before deleting this model');
        await fsp.rm(target, { recursive: true, force: true }); return sendJson(res, 200, await scanInstalled(root));
      }
      if (p === '/api/models/download' && req.method === 'POST') { const payload = await readJson(req); if (!plainObject(payload)) throw new Error('Download payload must be an object'); return sendJson(res, 200, downloads.start(payload)); }
      if (p === '/api/downloads' && req.method === 'GET') return sendJson(res, 200, downloads.list());
      const dlMatch = p.match(/^\/api\/downloads\/([^/]+)\/(pause|resume|cancel)$/);
      if (dlMatch && req.method === 'POST') { const [, id, action] = dlMatch; return sendJson(res, 200, { ok: downloads[action](decodeURIComponent(id)) }); }

      // ---- native pickers ----
      if (p === '/api/dialog/folder' && req.method === 'POST') { const { title } = await readJson(req); return sendJson(res, 200, await pickFolder(title)); }
      if (p === '/api/dialog/file' && req.method === 'POST') { const { title, filterName, extensions } = await readJson(req); return sendJson(res, 200, await pickFile(title, filterName, extensions)); }

      // ---- runtime ----
      if (p === '/api/runtime/latest' && req.method === 'GET') return sendJson(res, 200, await runtimes.latest());
      if (p === '/api/runtime/resolve' && req.method === 'POST') { const cfg = await readJson(req); return sendJson(res, 200, await runtimes.resolveBackend(plainObject(cfg) ? String(cfg.backend || 'vulkan') : 'vulkan')); }
      if (p === '/api/runtime/verify' && req.method === 'GET') return sendJson(res, 200, await runtimes.verifyInstalled());
      if (p === '/api/runtime/managed-status' && req.method === 'GET') return sendJson(res, 200, await runtimes.installed());
      if (p === '/api/runtime/install' && req.method === 'POST') { const cfg = await readJson(req); if (!plainObject(cfg)) throw new Error('Runtime configuration must be an object'); return sendJson(res, 200, await runtimes.install({ backend: String(cfg.backend || 'vulkan') })); }
      if (p === '/api/runtime/start' && req.method === 'POST') { const cfg = await readJson(req); return sendJson(res, 200, await startOwnedRuntime(runtimeConfig(cfg))); }
      if (p === '/api/runtime/start-installed' && req.method === 'POST') {
        let cfg = await readJson(req); cfg = runtimeConfig(cfg || {}); const managed = await runtimes.installed(); const binary = cfg.binary || managed.binary;
        if (!binary) throw new Error('No llama.cpp runtime installed. Install a managed runtime first.');
        const backend = cfg.backend || store.get('runtimeBackend') || 'auto'; const gpuLayers = backend === 'cpu' ? 0 : 999;
        const apiKey = sessionApiAuthEnabled ? (sessionApiToken || null) : null;
        if (sessionApiAuthEnabled && !apiKey) throw new Error('API authentication is enabled but no token exists. Generate one in Settings first.');
        return sendJson(res, 200, await startOwnedRuntime({ binary, modelPath: cfg.modelPath, projector: cfg.projector || null, port: Number(cfg.port || 11435), gpuLayers, context: Number(cfg.context || 8192), embedding: Boolean(cfg.embedding), jinja: true, apiKey, backend }));
      }
      if (p === '/api/runtime/stop' && req.method === 'POST') { const stopped = llama.stopLlama(); if (stopped) await releaseOwnership(ownershipFile); return sendJson(res, 200, { stopped }); }
      if (p === '/api/runtime/status' && req.method === 'GET') return sendJson(res, 200, llama.status());
      if (p === '/api/runtime/logs' && req.method === 'GET') return sendJson(res, 200, llama.logs());

      // ---- chat ----
      if (p === '/api/chat/complete' && req.method === 'POST') {
        const messages = await readJson(req); const rt = llama.status(); if (!rt.running) throw new Error('Local runtime is not running');
        const r = await fetch(`http://127.0.0.1:${rt.port || 11435}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: bearerForRt() }, body: JSON.stringify({ model: 'local-model', messages, temperature: .7, stream: false }) });
        const data = await r.json().catch(() => ({})); if (!r.ok) throw new Error(data?.error?.message || `Runtime returned ${r.status}`);
        const msg = data?.choices?.[0]?.message || {}; return sendJson(res, 200, { content: msg.content || '', reasoning: msg.reasoning_content || null, usage: data?.usage || null });
      }
      if (p === '/api/chat/pick-image' && req.method === 'POST') {
        const fp = await pickFile('Choose an image', 'Images', ['png', 'jpg', 'jpeg', 'webp', 'gif']); if (!fp) return sendJson(res, 200, null);
        const b = await fsp.readFile(fp); const ext = path.extname(fp).slice(1).toLowerCase().replace('jpg', 'jpeg');
        return sendJson(res, 200, { name: path.basename(fp), dataUrl: `data:image/${ext};base64,${b.toString('base64')}` });
      }
      if (p === '/api/chat/stream' && req.method === 'POST') return handleChatStream(req, res, await readJson(req));

      // ---- agent (minimal browser workflow) ----
      if (p === '/api/agent/task' && req.method === 'POST') {
        const { prompt, workspace } = await readJson(req);
        if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('A task/prompt is required');
        if (typeof workspace !== 'string' || !workspace.trim()) throw new Error('A workspace folder is required');

        const intents = agentLoop.detectIntents(prompt);
        const primary = intents[0] || null;
        if (primary && primary.kind === 'command') {
          const ws = createWorkspace(workspace);
          const analysis = agentShell.analyzeCommand(primary.args.display);
          prunePendingTasks();
          const taskId = crypto.randomBytes(12).toString('hex');
          pendingAgentTasks.set(taskId, { expiresAt: Date.now() + 10 * 60 * 1000, kind: 'command', ws, exe: primary.args.exe, args: primary.args.args, display: primary.args.display });
          return sendJson(res, 200, { status: 'needsApproval', taskId, op: 'run', kind: 'command', detail: `Command:\n${primary.args.display}\n\nWorking directory:\n${ws.root}${analysis.dangerous ? `\n\nWarning: dangerous pattern (${analysis.hits.join(', ')}) — this will NOT run without your approval.` : ''}` });
        }

        const resolvedEp = await agentLocal.resolveEndpoint();
        const found = await agentLocal.discoverLocalModel({ endpoint: resolvedEp.endpoint, timeoutMs: 5000 });
        if (!found.ok) throw new Error('Local runtime is not available. Start a local model first (Runtime tab), then try again.');
        const localCtx = { endpoint: found.endpoint, modelId: found.id, friendly: found.friendly };
        const model = { name: found.friendly, locality: 'Local', backend: resolvedEp.backend || 'auto', provider: 'llama.cpp', cost: '$0.00' };

        const r = await agentLoop.runTurn({ prompt, mode: 'Act', approval: 'ask', model, tools: [], cwd: workspace, workspace, localCtx, session: { approveAll: false }, history: [] });
        if (r.needsApproval && r.proposal) {
          const ws = createWorkspace(workspace);
          prunePendingTasks();
          const taskId = crypto.randomBytes(12).toString('hex');
          pendingAgentTasks.set(taskId, { expiresAt: Date.now() + 10 * 60 * 1000, kind: 'mutation', ws, proposal: r.proposal });
          const proposal = r.proposal;
          const detail = proposal.kind === 'edit' ? proposal.diffText
            : proposal.kind === 'create' ? `Create ${proposal.path} (${proposal.content.split('\n').length} lines):\n\n${proposal.content.slice(0, 3000)}${proposal.content.length > 3000 ? '\n… (truncated preview)' : ''}`
            : proposal.kind === 'delete' ? `Delete ${proposal.path} (${proposal.bytes} bytes)\n(Reversible: moved to workspace trash on apply.)`
            : `Rename ${proposal.path} → ${proposal.dest}`;
          return sendJson(res, 200, { status: 'needsApproval', taskId, op: r.op, kind: proposal.kind, detail });
        }
        return sendJson(res, 200, { status: 'done', answer: r.answer, op: r.op, blocked: Boolean(r.blocked), failed: Boolean(r.failed) });
      }
      if (p === '/api/agent/apply' && req.method === 'POST') {
        const { taskId, approved } = await readJson(req);
        const pending = pendingAgentTasks.get(String(taskId || ''));
        if (!pending) throw new Error('This proposal has expired or was already handled. Ask again.');
        pendingAgentTasks.delete(String(taskId));
        if (!approved) return sendJson(res, 200, { status: 'done', answer: 'Rejected — nothing changed.' });

        if (pending.kind === 'mutation') {
          const { proposal, ws } = pending;
          let applied;
          try {
            if (proposal.kind === 'edit') applied = agentMutate.applyEdit(ws, proposal);
            else if (proposal.kind === 'create') applied = agentMutate.applyCreate(ws, proposal);
            else if (proposal.kind === 'delete') applied = agentMutate.applyDelete(ws, proposal);
            else applied = agentMutate.applyRename(ws, proposal);
          } catch (e) { applied = { ok: false, error: `apply failed: ${e.message}` }; }
          if (!applied.ok) return sendJson(res, 200, { status: 'done', answer: `Apply failed: ${applied.error}`, failed: true });
          return sendJson(res, 200, { status: 'done', answer: `Applied ${proposal.kind} to ${proposal.path}.`, toolResult: applied });
        }
        const { ws, exe, args, display } = pending;
        const result = await agentShell.run({ ws, exe, args, cwdRel: '.', timeoutMs: 120000 });
        if (result.cancelled) return sendJson(res, 200, { status: 'done', answer: '(command cancelled)' });
        if (!result.ok) return sendJson(res, 200, { status: 'done', answer: `Command failed to start: ${result.error}`, failed: true });
        return sendJson(res, 200, { status: 'done', answer: `Ran: ${display}\nExit code: ${result.exitCode}${result.stdout ? `\n\n${String(result.stdout).slice(0, 3000)}` : ''}${result.stderr ? `\n\n[stderr]\n${String(result.stderr).slice(0, 1500)}` : ''}`, toolResult: result });
      }

      // ---- cloud ----
      if (p === '/api/cloud/status' && req.method === 'GET') return sendJson(res, 200, { ...cloudPublic(), routing: (await cloud.routing.load()).rules });
      if (p === '/api/cloud/key' && req.method === 'POST') {
        const { provider, key } = await readJson(req); const pr = providerName(provider); const value = String(key || '');
        if (!value || value.length > 4096) throw new Error('Cloud credential is invalid');
        sessionCloudKeys[pr] = value;
        const h = await cloud.adapters[pr].health(); cloud.health.record(pr, { ok: h.ok, status: h.status || 0 });
        return sendJson(res, 200, { provider: pr, configured: true, source: 'session', health: h.ok ? 'reachable' : (h.reason || 'unknown') });
      }
      const cloudKeyMatch = p.match(/^\/api\/cloud\/key\/([^/]+)$/);
      if (cloudKeyMatch && req.method === 'DELETE') { const pr = providerName(decodeURIComponent(cloudKeyMatch[1])); sessionCloudKeys[pr] = ''; return sendJson(res, 200, await cloud.credentials.removeKey(pr)); }
      if (p === '/api/cloud/models' && req.method === 'POST') {
        let { refresh = false, provider = null } = await readJson(req); if (provider != null) provider = providerName(provider);
        if (refresh) { const r = await cloud.catalog.refresh(provider || null); return sendJson(res, 200, { models: r.models, refresh: r.results }); }
        return sendJson(res, 200, cloud.catalog.list({ provider: provider || null }));
      }
      if (p === '/api/cloud/usage' && req.method === 'GET') return sendJson(res, 200, { summary: await cloud.ledger.summary(), recent: await cloud.ledger.list({ limit: 20 }) });
      if (p === '/api/cloud/budget' && req.method === 'POST') { const partial = await readJson(req); if (!plainObject(partial)) throw new Error('Budget payload must be an object'); await cloud.budget.set(partial); return sendJson(res, 200, cloud.budget.public()); }
      if (p === '/api/cloud/chat' && req.method === 'POST') {
        const { model, messages, options = {} } = await readJson(req);
        if (!model) return sendJson(res, 200, { ok: false, error: 'model required' });
        if (!Array.isArray(messages) || messages.length > 128 || !plainObject(options)) return sendJson(res, 200, { ok: false, error: 'invalid cloud chat payload', code: 'INVALID_ARGUMENT' });
        if (String(model).startsWith('local/')) return sendJson(res, 200, { ok: false, error: 'local models use the local runtime path' });
        try {
          const out = await cloud.router.chat({ modelId: model, messages, temperature: Number(options.temperature ?? .7), tools: options.tools === false ? null : undefined, sessionSpentUsd: 0, todaySpentUsd: 0, request: { max_tokens: options.max_tokens || 1024 } });
          const m = (out.choices && out.choices[0] && out.choices[0].message) || {};
          return sendJson(res, 200, { ok: true, content: m.content || '', reasoning: m.reasoning_content || null, usage: out._meta.usage, meta: { providerUsed: out._meta.providerUsed, failover: out._meta.failover, retryCount: out._meta.retryCount, cost: out._meta.cost, cloudUnits: out._meta.cloudUnits, modelId: out._meta.modelId } });
        } catch (e) { return sendJson(res, 200, { ok: false, error: String(e.message || e), code: e.code || 'CLOUD_ERROR' }); }
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (e) {
      return sendJson(res, 400, { error: String(e.message || e) });
    }
  }

  async function handleChatStream(req, res, { requestId, messages, options = {} }) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const emit = (type, payload) => { try { res.write(`data: ${JSON.stringify({ type, requestId, ...payload })}\n\n`); } catch {} };
    const rt = llama.status();
    if (!rt.running) { emit('chat:error', { error: 'Local runtime is not running' }); return res.end(); }
    try {
      let working = Array.isArray(messages) ? messages.slice() : [];
      for (let round = 0; round < 2; round++) {
        const body = { model: 'local-model', messages: working, temperature: Number(options.temperature ?? .7), stream: true };
        if (round === 0 && options.tools !== false) { body.tools = TOOL_DEFINITIONS; body.tool_choice = 'auto'; }
        const r = await fetch(`http://127.0.0.1:${rt.port || 11435}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: bearerForRt() }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error(`Runtime returned ${r.status}`);
        const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '', toolCalls = [];
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true }); const lines = buf.split(/\r?\n/); buf = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data:')) continue; const raw = line.slice(5).trim(); if (!raw || raw === '[DONE]') continue;
            try {
              const j = JSON.parse(raw); const delta = j?.choices?.[0]?.delta || {};
              if (delta.content) emit('chat:delta', { delta: delta.content });
              if (delta.reasoning_content) emit('chat:reasoning', { delta: String(delta.reasoning_content) });
              if (Array.isArray(delta.tool_calls)) for (const tc of delta.tool_calls) {
                const idx = Number(tc.index || 0); const cur = toolCalls[idx] || (toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } });
                if (tc.id) cur.id = tc.id; if (tc.type) cur.type = tc.type; if (tc.function?.name) cur.function.name += tc.function.name; if (typeof tc.function?.arguments === 'string') cur.function.arguments += tc.function.arguments;
                emit('chat:toolcall', { toolCall: tc });
              }
            } catch {}
          }
        }
        if (round === 0 && toolCalls.length) {
          const results = toolCalls.map(call => ({ call, result: executeAllowedTool(call) }));
          for (const { call, result } of results) emit('chat:toolresult', { toolCallId: call.id || null, ...result });
          working = [...working, { role: 'assistant', content: null, tool_calls: toolCalls }, ...results.map(({ call, result }) => ({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result.ok ? result.result : { error: result.error }) }))];
          continue;
        }
        break;
      }
      emit('chat:done', {});
    } catch (e) { emit('chat:error', { error: String(e.message || e) }); }
    res.end();
  }

  async function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    if (rel.includes('..')) return send(res, 400, 'Bad path');
    rel = rel.replace(/^\/+/, '');
    if (getAsset) {
      const buf = getAsset(rel);
      if (buf) return send(res, 200, buf, { 'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream' });
      return send(res, 404, 'Not found');
    }
    const abs = path.join(webRoot, rel);
    if (!abs.startsWith(webRoot)) return send(res, 400, 'Bad path');
    try {
      const buf = await fsp.readFile(abs);
      return send(res, 200, buf, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    } catch { return send(res, 404, 'Not found'); }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${boundPort || preferredPort}`);
    if (!allowedHost(req.headers.host) || !allowedOrigin(req.headers.origin)) { return send(res, 403, 'Forbidden: unexpected Host/Origin'); }
    if (url.pathname === '/health') return sendJson(res, 200, { ok: true });
    if (url.pathname === '/api/events') {
      const given = url.searchParams.get('s');
      if (given !== secret) return sendJson(res, 403, { error: 'Missing or invalid session credential' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, url);
  });

  return new Promise((resolve, reject) => {
    // Each retry attempt gets its OWN error/listening listener pair, removed
    // the instant that attempt settles either way. Reusing server.listen()'s
    // callback form across retries on the same server instance stacks a new
    // 'listening' listener on every attempt without removing the failed
    // ones — when the port finally binds, ALL accumulated listeners fire,
    // and the FIRST one (registered for the first, FAILED port) wins the
    // promise race with its own stale port number. Confirmed live: this
    // resolved with the originally-requested port even though the server
    // was actually listening on a fallback port two higher.
    function tryListen(port, attemptsLeft) {
      function onError(err) {
        cleanup();
        if (err.code === 'EADDRINUSE' && attemptsLeft > 0) { tryListen(port + 1, attemptsLeft - 1); return; }
        reject(err);
      }
      function onListening() {
        cleanup();
        boundPort = port;
        log(`BotConnector UI server listening on http://127.0.0.1:${port}`);
        resolve({
          server, port, secret,
          close: () => new Promise(r => { for (const c of sseClients) try { c.end(); } catch {} server.close(() => r()); }),
        });
      }
      function cleanup() {
        server.removeListener('error', onError);
        server.removeListener('listening', onListening);
      }
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    }
    tryListen(preferredPort, 20);
  });
}

module.exports = { startUiServer };
