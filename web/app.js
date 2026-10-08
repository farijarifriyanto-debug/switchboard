/* Switchboard console - talks to the /api surface served by the web-ui plugin.
   UI conventions follow the adapted MIT reference design system (see app.css header). */
'use strict'

const $ = (id) => document.getElementById(id)

const ui = {
  status: $('status'),
  activityStatus: $('activity-status'),
  modelPicker: $('model-picker'),
  modelMini: $('model-mini'),
  presetMini: $('preset-mini'),
  rail: $('rail'),
  sessions: $('sessions'),
  sessionsCount: $('sessions-count'),
  refresh: $('btn-refresh'),
  tools: $('tools'),
  plugins: $('plugins'),
  pluginMsg: $('plugin-msg'),
  audit: $('audit'),
  traceEvents: $('trace-events'),
  traceRefresh: $('btn-trace-refresh'),
  modelCapabilities: $('model-capabilities'),
  metricsBox: $('metrics-box'),
  scrollBody: $('scroll-body'),
  timeline: $('timeline'),
  hero: $('hero'),
  heroWs: $('hero-ws'),
  heroWsLabel: $('hero-ws-label'),
  heroWsForm: $('hero-ws-form'),
  heroWsInput: $('hero-ws-input'),
  heroSub: $('hero-sub'),
  composerHost: $('composer-card-host'),
  seat: $('composer-seat'),
  composer: $('composer'),
  prompt: $('prompt'),
  mentions: $('mentions'),
  commands: $('commands'),
  toolsWarning: $('tools-warning'),
  send: $('send'),
  stop: $('stop'),
  sessionId: $('session-id'),
  wsRoot: $('ws-root'),
  wsRecents: $('ws-recents'),
  files: $('files'),
  editor: $('editor'),
  editorName: $('editor-name'),
  editorCode: $('editor-code'),
  editorFoot: $('editor-foot'),
  approval: $('approval'),
  approvalTool: $('approval-tool'),
  approvalArgs: $('approval-args'),
  approvalDiff: $('approval-diff'),
  approvalHint: $('approval-hint'),
  approvalMode: $('approval-mode'),
  approvalYes: $('approval-yes'),
  approvalSession: $('approval-session'),
  approvalNo: $('approval-no'),
  projectName: $('header-project'),
  workspaceName: $('ws-project-name'),
  changedFiles: $('changed-files'),
  fileSearch: $('file-search'),
  pluginSearch: $('plugin-search'),
  runtimeServices: $('runtime-services'),
  modelInfo: $('model-info'),
  details: $('session-details'),
  detailsButton: $('btn-details'),
  attachmentInput: $('attachment-input'),
  attachmentList: $('attachment-list'),
}

const state = {
  sessionId: null,
  selectedSession: null,
  sessions: [],
  model: null,
  running: false,
  controller: null,
  pinned: true,
  models: [],
  lastPromptTokens: 0,
  workspace: null,
  filesDir: '.',
  filesCache: null,
  editorPath: null,
  attachedImages: [],
  textAttachments: [],
  changedFiles: new Set(),
  pluginCapabilities: [],
  activeTurnModel: null,
}

// ------------------------------------------------------------------ helpers

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const clock = (at) => new Date(at).toTimeString().slice(0, 8)
const shortPath = (p) => String(p || '').replace(/^[A-Za-z]:[\\/]/, '').slice(-46)
const folderName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'workspace'

function updateSessionLabel(session = state.selectedSession) {
  state.selectedSession = session || null
  const project = session?.projectRoot && session.projectRoot !== state.workspace?.root ? folderName(session.projectRoot) : state.workspace?.name || 'Project'
  ui.projectName.textContent = project
  ui.sessionId.textContent = session?.title || 'New chat'
  ui.sessionId.title = session?.id ? 'Run details are in the menu' : ''
  if (session?.id) {
    try { localStorage.setItem('sb-active-session', session.id) } catch { /* private mode */ }
    history.replaceState(null, '', `?session=${encodeURIComponent(session.id)}`)
  } else {
    try { localStorage.removeItem('sb-active-session') } catch { /* private mode */ }
    history.replaceState(null, '', location.pathname)
  }
  if (ui.details) {
    ui.details.innerHTML = session ? `<span>Run ${esc(session.id)}</span><span>Project path ${esc(session.projectRoot || state.workspace?.root || '')}</span><span>Model ${esc(session.model || state.model || 'default')}</span>` : '<span>Unsaved run</span>'
  }
}

function statusText(status) {
  return ({ working: 'Working', waiting_approval: 'Needs approval', idle: 'Ready', failed: 'Failed', completed: 'Completed', cancelled: 'Stopped' })[status] || 'Ready'
}

function relativeTime(at) {
  const seconds = Math.max(0, Math.floor((Date.now() - Number(at || 0)) / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

function atBottom() {
  const el = ui.scrollBody
  return el.scrollHeight - el.scrollTop - el.clientHeight < 48
}

function scrollDown(force) {
  if (force || (state.pinned && atBottom())) ui.scrollBody.scrollTop = ui.scrollBody.scrollHeight
}

function setStatus(kind, text) {
  const normalized = ['working', 'waiting_approval', 'idle', 'failed', 'completed', 'cancelled', 'limited', 'active', 'error'].includes(kind) ? kind : 'idle'
  ui.status.className = `status-pill ${normalized}`
  ui.status.textContent = text || statusText(normalized)
}

function setActivity(text = '') {
  ui.activityStatus.textContent = text
  ui.activityStatus.hidden = !text
}

/** Docks the composer card into the hero (welcome) or the bottom seat. */
function dockComposer() {
  const host = ui.hero.hidden ? ui.seat.querySelector('.composer-stack') : ui.composerHost
  if (ui.composer.parentElement !== host) host.appendChild(ui.composer)
  ui.composer.hidden = false
}

// ------------------------------------------------------------ markdown-lite+

/** Inline layer: code, bold, links. Input must already be escaped. */
function inline(md) {
  return md
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
}

function linesToHtml(lines) {
  let html = ''
  let list = null // 'ul' | 'ol'
  const closeList = () => {
    if (list) { html += `</${list}>`; list = null }
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) { closeList(); continue }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      const level = Math.min(heading[1].length + 1, 4) // h2..h4 inside entries
      html += `<h${level}>${inline(esc(heading[2]))}</h${level}>`
      continue
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul' }
      html += `<li>${inline(esc(bullet[1]))}</li>`
      continue
    }
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (numbered) {
      if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol' }
      html += `<li>${inline(esc(numbered[1]))}</li>`
      continue
    }
    closeList()
    html += `<p>${inline(esc(line))}</p>`
  }
  closeList()
  return html
}

const LANG_ALIASES = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', sh: 'bash', py: 'python' }

/** Tiny highlighter for the common languages in this repo. Best effort. */
function highlight(code, lang) {
  const L = LANG_ALIASES[lang] || lang
  let out = esc(code)
  if (L === 'json') {
    return out
      .replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="hl-key">$1</span>$2')
      .replace(/:\s*(&quot;(?:[^&]|&(?!quot;))*&quot;)/g, ': <span class="hl-str">$1</span>')
      .replace(/\b(true|false|null)\b/g, '<span class="hl-kw">$1</span>')
      .replace(/\b(-?\d[\d._eE+-]*)\b/g, '<span class="hl-num">$1</span>')
  }
  const kw = {
    javascript: 'const let var function return if else for while class new import from export default async await try catch throw typeof this extends of in do switch case break continue yield delete instanceof void true false null undefined',
    typescript: 'const let var function return if else for while class new import from export default async await try catch throw typeof this extends of in do switch case break continue yield delete instanceof void true false null undefined interface type enum implements readonly public private protected static declare namespace as satisfies',
    bash: 'if then else fi for while do done case esac function echo exit return set export source local cd ls rm cp mv mkdir cat grep sed awk curl git npm node python',
    python: 'def class return if elif else for while import from as with try except finally raise lambda yield pass break continue global nonlocal assert del in is not and or None True False async await',
  }[L]
  if (kw) {
    out = out.replace(new RegExp(`\\b(${kw.split(' ').join('|')})\\b`, 'g'), '<span class="hl-kw">$1</span>')
  }
  out = out.replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;|'(?:[^'\\]|\\.)*?'|`(?:[^`\\]|\\.)*?`)/g, '<span class="hl-str">$1</span>')
  out = out.replace(/(^|\n)((?:\s*)\/\/[^\n]*|(?:\s*)#[^\n]*)/g, '$1<span class="hl-com">$2</span>')
  out = out.replace(/\b(-?\d[\d._]*)\b/g, '<span class="hl-num">$1</span>')
  return out
}

/** Markdown-lite: fenced code (highlighted), headings, lists, paragraphs. */
function rich(text) {
  const blocks = String(text).split(/```/)
  let out = ''
  blocks.forEach((block, i) => {
    if (i % 2 === 1) {
      const nl = block.indexOf('\n')
      const lang = (nl >= 0 ? block.slice(0, nl) : '').trim().toLowerCase()
      const body = nl >= 0 ? block.slice(nl + 1) : block
      out += `<pre data-lang="${esc(lang)}"><code>${highlight(body.replace(/\n$/, ''), lang)}</code></pre>`
      return
    }
    out += linesToHtml(block.split(/\r?\n/))
  })
  return out || '<p></p>'
}

const LANG_OF = {
  json: 'json', ts: 'typescript', tsx: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  css: 'css', html: 'html', md: 'markdown', py: 'python', sh: 'bash', yml: 'yaml', yaml: 'yaml',
}

// ------------------------------------------------------------ file preview

async function previewFile(rel) {
  const res = await fetch('/api/tools/read_file', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args: { path: rel } }),
  })
  const body = await res.json().catch(() => ({}))
  const text = String(body.result ?? body.error ?? 'unreadable')
  state.editorPath = rel
  ui.editor.hidden = false
  ui.editorName.textContent = rel
  const ext = (rel.split('.').pop() || '').toLowerCase()
  const lang = LANG_OF[ext] || ''
  if (text.startsWith('Error:')) {
    ui.editorCode.className = 'mono editor-error'
    ui.editorCode.textContent = text
    ui.editorFoot.textContent = ''
    return
  }
  ui.editorCode.className = 'mono'
  ui.editorCode.innerHTML = lang ? highlight(text, lang) : esc(text)
  const lines = text.split('\n').length
  ui.editorFoot.textContent = `${lines} lines · ${text.length} chars${text.includes('...[truncated') ? ' · truncated' : ''}`
  wireLineNumbers()
}

function wireLineNumbers() {
  if (ui.editorCode.dataset.lines !== '1') {
    ui.editorCode.dataset.lines = '1'
    const g = document.createElement('span')
    g.className = 'ln-gutter'
    const update = () => {
      const n = ui.editorCode.textContent.split('\n').length
      g.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n')
    }
    const obs = new MutationObserver(update)
    obs.observe(ui.editorCode, { childList: true, characterData: true, subtree: true })
    ui.editorCode.prepend(g)
    update()
  }
}

function closeEditor() {
  ui.editor.hidden = true
  state.editorPath = null
}

$('editor-close').addEventListener('click', closeEditor)

// ----------------------------------------------------------------- timeline

function entry(kind, label) {
  ui.hero.hidden = true
  dockComposer()
  const li = document.createElement('li')
  li.className = `entry ${kind}`
  li.innerHTML =
    `<div class="head"><span class="kind">${esc(label)}</span><span class="time">${clock(Date.now())}</span></div><div class="body"></div>`
  ui.timeline.appendChild(li)
  scrollDown()
  return li
}

function clearTimeline() {
  ui.timeline.innerHTML = ''
  ui.hero.hidden = false
  dockComposer()
}

/** One-argument summary line for a tool call (tool-row convention). */
function toolTitle(name) {
  return ({ read_file: 'Read', write_file: 'Edit', list_dir: 'Browse', search_files: 'Search', run_command: 'Run', web_fetch: 'Open web page', web_search: 'Search the web' })[name] || 'Tool'
}

function toolSummary(name, args) {
  const a = args && typeof args === 'object' ? args : {}
  const pick = (key) => String(a[key] ?? '')
  const value = name === 'read_file' || name === 'write_file' ? pick('path')
    : name === 'list_dir' ? pick('path') || '.'
    : name === 'search_files' ? pick('pattern')
    : name === 'run_command' ? pick('command') || pick('cmd')
    : name === 'web_fetch' ? pick('url')
    : name === 'web_search' ? pick('query')
    : ''
  return value ? shortPath(value) : 'Working with project'
}

function ioSection(label, text, isError) {
  return (
    `<div class="io-section"><span class="io-label">${esc(label)}</span><pre class="io-text"${isError ? ' data-error="1"' : ''}>${esc(text)}</pre></div>`
  )
}

function ioCardSection(label, text, isError) {
  const section = document.createElement('div')
  section.className = 'io-section'
  section.innerHTML = `<span class="io-label">${esc(label)}</span><pre class="io-text"${isError ? ' data-error="1"' : ''}></pre>`
  section.querySelector('pre').textContent = text
  section.hidden = false
  return section
}

/** Compact activity row; arguments and output stay behind an explicit Details disclosure. */
function toolCard(name, args) {
  const li = entry('tool', 'tool')
  const body = li.querySelector('.body')
  const row = document.createElement('div')
  row.className = 't-row'
  row.innerHTML = `<span class="t-lead" aria-hidden="true">${name === 'run_command' ? '›' : name === 'write_file' ? '✎' : '⌕'}</span><span class="t-title">${esc(toolTitle(name))}</span><span class="t-summary">${esc(toolSummary(name, args))}</span><span class="t-dur"></span><span class="t-dot" title="Working"></span>`
  const details = document.createElement('details')
  details.className = 'activity-details'
  details.innerHTML = '<summary>Details</summary><div class="io-card"></div>'
  const card = details.querySelector('.io-card')
  card.appendChild(ioCardSection('Arguments', JSON.stringify(args, null, 2), false))
  body.append(row, details)
  const dot = row.querySelector('.t-dot')
  const isWrite = name === 'write_file'

  function appendDiff(beforeText, afterText) {
    const before = String(beforeText || '')
    const after = String(afterText || '')
    const bLines = before.split('\n'), aLines = after.split('\n')
    let start = 0, endB = bLines.length, endA = aLines.length
    while (start < endB && start < endA && bLines[start] === aLines[start]) start++
    while (endB > start && endA > start && bLines[endB - 1] === aLines[endA - 1]) { endB--; endA-- }
    const rows = []
    for (let i = start; i < endB; i++) rows.push(`<div class="diff-line del"><span class="sign">−</span>${esc(bLines[i])}</div>`)
    for (let i = start; i < endA; i++) rows.push(`<div class="diff-line add"><span class="sign">+</span>${esc(aLines[i])}</div>`)
    const diff = document.createElement('div')
    diff.className = 'diff-card'
    diff.innerHTML = `<strong>${esc(args?.path || 'Changed file')}</strong>${rows.slice(0, 80).join('') || '<div class="muted">File created</div>'}`
    card.appendChild(diff)
  }

  return {
    li,
    done(resultText, durationMs, fileChange) {
      const fail = String(resultText ?? '').startsWith('Error:')
      dot.className = `t-dot ${fail ? 'failed' : 'ok'}`
      dot.title = fail ? 'Failed' : 'Completed'
      row.querySelector('.t-dur').textContent = durationMs != null ? (name === 'run_command' ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`) : ''
      const out = String(resultText ?? '')
      const compact = out.split(/\r?\n/).slice(0, 2).join(' · ').slice(0, 160)
      row.querySelector('.t-summary').textContent = name === 'run_command' ? `${toolSummary(name, args)}${/^exit /i.test(out) ? ` · ${out.split(/\r?\n/)[0]}` : ''}` : (fail ? compact || 'Action failed' : toolSummary(name, args))
      card.appendChild(ioCardSection('Result', out.length > 8000 ? `${out.slice(0, 8000)}…[truncated]` : out || '(no output)', fail))
      if (isWrite && !fail && fileChange) appendDiff(fileChange.before, fileChange.content)
      scrollDown()
    },
    fileChanged(change) {
      if (isWrite) appendDiff(change.before, change.content)
    },
  }
}

function renderTranscript(session) {
  clearTimeline()
  state.changedFiles.clear()
  ui.changedFiles.innerHTML = '<li class="muted pad">Changes appear here</li>'
  const toolCards = new Map()
  for (const message of session.messages || []) {
    if (message.role === 'system') continue
    if (message.role === 'user' && String(message.content || '').startsWith('[Summary of the earlier conversation]')) {
      const item = entry('notice', 'Earlier conversation')
      item.querySelector('.body').innerHTML = `<details><summary>Earlier messages were summarized to save context</summary>${rich(String(message.content).replace('[Summary of the earlier conversation]', '').trim())}</details>`
    } else if (message.role === 'user') {
      const item = entry('user', 'you')
      item.querySelector('.body').innerHTML = rich(message.content)
      for (const image of message.attachments || []) item.querySelector('.body').insertAdjacentHTML('beforeend', `<span class="attachment-chip">Image · ${esc(image.name)}</span>`)
    } else if (message.role === 'assistant') {
      if (message.content) entry('assistant', 'Switchboard').querySelector('.body').innerHTML = rich(message.content)
      for (const call of message.tool_calls || []) toolCards.set(call.id, { name: call.function.name, args: safeJson(call.function.arguments), card: toolCard(call.function.name, safeJson(call.function.arguments)) })
    } else if (message.role === 'tool') {
      const activity = toolCards.get(message.tool_call_id)
      if (activity) {
        const result = String(message.content || '')
        activity.card.done(result, null)
        if (activity.name === 'write_file' && !result.startsWith('Error:')) markFileChanged(activity.args.path)
      }
    }
  }
  scrollDown(true)
  ui.hero.hidden = (session.messages || []).some((m) => m.role !== 'system')
  dockComposer()
}

function safeJson(raw) {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return { _raw: raw }
  }
}

async function openSession(id) {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`)
    if (!res.ok) return
    const session = await res.json()
    state.sessionId = session.id
    state.selectedSession = session
    state.model = session.model ? encodeModelOption(session.provider, session.model) : state.model
    renderModelPicker(state.models, state.model)
    renderModelCapabilities()
    state.preset = session.preset || ''
    renderPresetPicker()
    updateSessionLabel(session)
    setStatus(session.status || 'idle', statusText(session.status || 'idle'))
    renderTranscript(session)
    void loadTrace(session.id)
  } catch {
    /* keep current view */
  }
}

// ------------------------------------------------------------- workbench panes

function renderSessions(sessions) {
  state.sessions = sessions
  ui.sessions.innerHTML = ''
  ui.sessionsCount.textContent = sessions.length || ''
  if (!sessions.length) {
    ui.sessions.innerHTML = '<li class="muted pad">Your chats will appear here.</li>'
    return
  }
  for (const s of sessions.slice(0, 80)) {
    const li = document.createElement('li')
    li.title = s.id
    const project = s.projectRoot ? folderName(s.projectRoot) : 'workspace'
    const status = s.status || 'idle'
    li.className = [status, s.id === state.sessionId ? 'current' : ''].filter(Boolean).join(' ')
    const short = ({ working: 'run', waiting_approval: 'req', idle: 'idle', failed: 'fail', completed: 'ok', cancelled: 'halt' })[status] || 'idle'
    li.innerHTML = `<div class="session-row"><span class="session-state ${esc(status)}" title="${esc(statusText(status))}">${esc(short)}</span><div class="title">${esc(s.title || 'Untitled run')}</div><button class="del" type="button" title="Delete run" aria-label="Delete run">×</button></div><div class="session-meta"><span>${esc(project)}</span><span>${relativeTime(s.updatedAt)}</span></div><div class="session-model">${esc(s.model || state.model || 'Default model')} · ${esc(statusText(status))}</div>`
    li.addEventListener('click', (event) => {
      if (event.target.closest('.del')) return
      void openSession(s.id)
    })
    li.querySelector('.del').addEventListener('click', async () => {
      await fetch(`/api/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' })
      if (state.sessionId === s.id) newRun()
      void loadState().catch(() => {})
    })
    ui.sessions.appendChild(li)
  }
}

function renderModelCapabilities() {
  const picked = parseModelOption(ui.modelPicker.value || state.model || '')
  const model =
    state.models.find((item) => item.id === picked.model && (item.provider || 'default') === picked.provider) ||
    state.models.find((item) => item.id === picked.model)
  if (!model) {
    ui.modelCapabilities.textContent = 'Model capabilities unavailable.'
    ui.modelInfo.hidden = true
    if (ui.toolsWarning) ui.toolsWarning.hidden = true
    return
  }
  const yesNo = (value) => value === true ? 'yes' : value === false ? 'no' : 'unknown'
  const caps = [`Tools ${yesNo(model.tools)}`, `Vision ${yesNo(model.vision)}`, `Reasoning ${yesNo(model.reasoning)}`]
  if (model.context) caps.push(`Context ${Number(model.context).toLocaleString()} tokens`)
  const route = [model.provider, model.route].filter(Boolean).join(' · ')
  const noTools = model.tools === false
  ui.modelCapabilities.textContent = `${model.id} · ${caps.join(' · ')}`
  const infoCaps = caps.filter((c) => !c.startsWith('Context '))
  const gauge = typeof formatContextGauge === 'function' ? formatContextGauge(state.lastPromptTokens, model.context) : ''
  const hot = gauge && state.lastPromptTokens / Number(model.context) >= 0.9 ? ' hot' : ''
  ui.modelInfo.innerHTML = `<strong>${esc(model.id)}</strong><span>${esc(route || model.access || 'BotConnector route')}</span><span>${infoCaps.map(esc).join(' · ')}</span>${gauge ? `<span class="ctx-gauge${hot} mono">${esc(gauge)}</span>` : ''}${noTools ? '<strong class="warning-text">This model cannot use project tools — project tasks will be refused.</strong>' : ''}`
  // MCP status segment (web/badge.js) — appended as text after the innerHTML
  // above; server names/states never pass through HTML parsing.
  const mcpSeg = typeof mcpSummary === 'function' ? mcpSummary(state.mcp) : null
  if (mcpSeg) {
    const seg = document.createElement('span')
    seg.className = `mcp-seg mono mcp-seg--${mcpSeg.tone}`
    seg.textContent = mcpSeg.text
    ui.modelInfo.appendChild(seg)
  }
  ui.modelInfo.classList.toggle('model-warning', noTools)
  ui.modelInfo.hidden = false
  if (ui.toolsWarning) ui.toolsWarning.hidden = !noTools
}

async function loadTrace(sessionId = state.selectedSession?.id || state.sessionId) {
  const target = sessionId || state.selectedSession?.id
  if (!target) {
    ui.traceEvents.innerHTML = '<li class="muted pad">no session selected</li>'
    return
  }
  try {
    const res = await fetch(`/api/trace?session=${encodeURIComponent(target)}&limit=200`)
    if (!res.ok) return
    const data = await res.json()
    const entries = Array.isArray(data.entries) ? data.entries : []
    if (!entries.length) {
      ui.traceEvents.innerHTML = '<li class="muted pad">no trace entries yet</li>'
      return
    }
    ui.traceEvents.innerHTML = entries
      .map((event) => {
        const cls = event.level === 'error' ? 'trace-error' : event.level === 'warn' ? 'trace-warn' : 'trace-info'
        const kv = []
        const add = (key, value) => {
          if (value !== undefined && value !== null && value !== '') kv.push(`<div class="trace-kv"><span>${esc(key)}</span><span>${esc(String(value))}</span></div>`)
        }
        add('model', event.model)
        add('ttft', event.ttftMs != null ? `${event.ttftMs} ms` : null)
        add('total', event.totalMs != null ? `${event.totalMs} ms` : null)
        add('speed', event.tokensPerSec != null ? `${Number(event.tokensPerSec).toFixed(1)} tok/s` : null)
        add('prompt tok', event.promptTokens)
        add('output tok', event.completionTokens)
        add('cached tok', event.cachedTokens)
        add('duration', event.durationMs != null ? `${event.durationMs} ms` : null)
        add('tool', event.name)
        add('attempt', event.attempt != null ? `${event.attempt}/${event.max ?? ''}` : null)
        add('detail', event.detail)
        const detail = kv.length ? `<div class="trace-detail">${kv.join('')}</div>` : ''
        return `<li class="${cls}"><details class="trace-item"><summary title="${esc(event.detail || '')}"><span class="trace-kind mono">${esc(event.kind || 'event')}</span><span class="trace-summary">${esc(event.summary || '—')}</span><span class="trace-time mono">${clock(event.at)}</span></summary>${detail}</details></li>`
      })
      .join('')
  } catch {
    /* trace is optional */
  }
}

ui.traceRefresh?.addEventListener('click', () => {
  void loadTrace()
})

function renderModelPicker(models, current) {
  const pickers = [ui.modelPicker, ui.modelMini].filter(Boolean)
  for (const picker of pickers) {
    picker.innerHTML = ''
    if (!models.length) {
      const opt = document.createElement('option')
      opt.textContent = current || 'no models'
      picker.appendChild(opt)
      picker.disabled = true
      continue
    }
    picker.disabled = false
    for (const m of models) {
      const opt = document.createElement('option')
      opt.value = encodeModelOption(m.provider, m.id)
      const caps = [m.tools === true ? 'tools' : null, m.vision === true ? 'vision' : null, m.reasoning === true ? 'reasoning' : null].filter(Boolean)
      opt.textContent = caps.length ? `${m.id} · ${caps.join(' · ')}` : m.id
      opt.title = [m.providerName || m.provider, m.route, m.access ? `access ${m.access}` : null, m.context ? `${Number(m.context).toLocaleString()} token context` : null].filter(Boolean).join(' · ')
      opt.selected = opt.value === current || m.id === current
      picker.appendChild(opt)
    }
  }
}

function renderPluginCapabilities() {
  const query = (ui.pluginSearch?.value || '').trim().toLowerCase()
  const displayName = (name) => ({ 'tools-fs': 'Project files', 'tools-shell': 'Terminal', 'tools-web': 'Web access', 'agent-loop': 'Agent workflow' })[name] || String(name || 'Capability').replace(/^plugins?[-/]/, '').replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
  const capabilities = state.pluginCapabilities.filter((plugin) => !query || `${plugin.name} ${(plugin.tools || []).map((tool) => `${tool.name} ${tool.description}`).join(' ')}`.toLowerCase().includes(query))
  ui.plugins.innerHTML = capabilities.map((plugin) => `<li class="capability-item"><div class="capability-top"><strong>${esc(displayName(plugin.name))}</strong><span class="enabled-state">${plugin.enabled === false ? 'Disabled' : 'Enabled'}</span></div><p>${esc((plugin.tools || []).map((tool) => tool.description).filter(Boolean).join(' ') || 'Provides an agent capability.')}</p><div class="capability-foot">Version ${esc(plugin.version || 'built-in')} · ${esc(plugin.health || 'ready')} · ${(plugin.tools || []).length} tools</div></li>`).join('') || '<li class="muted pad">No matching capabilities</li>'
}

ui.pluginSearch?.addEventListener('input', renderPluginCapabilities)

// ------------------------------------------------------------------- state

/** Agent presets (roadmap stage 2): the selector in the composer. '' = plain agent. */
async function loadPresets() {
  if (!ui.presetMini) return
  try {
    const res = await fetch('/api/presets')
    if (!res.ok) return
    state.presets = (await res.json()).presets || []
  } catch {
    return
  }
  renderPresetPicker()
}

function renderPresetPicker() {
  if (!ui.presetMini) return
  const current = state.selectedSession?.preset ?? state.preset ?? ''
  ui.presetMini.innerHTML = (state.presets || [])
    .map((p) => {
      const value = p.id === 'default' ? '' : p.id
      const tools = p.tools?.allow ? ` · ${p.tools.allow.length} tools` : ''
      return `<option value="${esc(value)}" title="${esc(p.description || '')}"${value === current ? ' selected' : ''}>${esc(p.name)}${esc(tools)}</option>`
    })
    .join('')
  ui.presetMini.value = current
}

async function setPreset(value) {
  state.preset = value
  if (state.selectedSession) state.selectedSession.preset = value || undefined
  if (!state.sessionId) return
  await fetch(`/api/sessions/${encodeURIComponent(state.sessionId)}/preset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preset: value || null }),
  }).catch(() => {})
}

async function loadState() {
  const res = await fetch('/api/state')
  if (!res.ok) throw new Error(`state ${res.status}`)
  const data = await res.json()

  state.models = data.models || []
  state.mcp = data.mcp
  state.model = state.selectedSession?.model ? encodeModelOption(state.selectedSession.provider, state.selectedSession.model) : data.model

  showConnectionNotice(state.models.length ? '' : 'The model list is unavailable. Check your provider settings, then check the connection again. Your configured model may still work.')

  renderModelPicker(state.models, state.model)
  renderModelCapabilities()
  void loadPresets()

  ui.tools.innerHTML = (data.tools || [])
    .map((t) => `<li title="${esc(t.description || '')}"><span class="tool-name">${esc(t.name)}</span> <span class="muted">${esc(t.plugin || '')}</span></li>`)
    .join('')
  ui.runtimeServices.innerHTML = (data.runtimeServices || data.plugins || []).map((service) => `<li><span class="tool-name">${esc(service)}</span></li>`).join('') || '<li class="muted pad">No runtime services</li>'
  state.pluginCapabilities = data.capabilities || []
  renderPluginCapabilities()

  if (data.workspace) {
    setWorkspace(data.workspace)
  }

  if (data.approval) {
    renderAudit(data.approval.recent || [])
    if (!state.running) renderApprovalGate(data.approval.pending || [], data.approval.mode)
  }

  renderSessions(data.sessions || [])

  const summary = Object.entries(data.metrics || {})
  ui.metricsBox.innerHTML = summary.length
    ? summary
        .map(
          ([model, s]) =>
            `<div>${esc(model)}<span class="muted"> · ${s.calls}× · ttft ${s.ttftP50}ms · ${s.tpsP50} tok/s</span></div>`,
        )
        .join('')
    : '<span class="muted">no samples yet</span>'

  return data
}

function setWorkspace(workspace) {
  state.workspace = workspace
  const name = workspace.name || folderName(workspace.root)
  ui.workspaceName.textContent = name
  ui.projectName.textContent = name
  ui.wsRoot.textContent = shortPath(workspace.root)
  ui.wsRoot.title = workspace.root
  ui.heroWsLabel.textContent = name
  ui.heroWs.title = `Project path: ${workspace.root}`
  if (ui.heroSub) ui.heroSub.textContent = 'Explore your workspace, ask a question, or start something new.'
  ui.wsRecents.innerHTML = (workspace.recents || [])
    .map((r) => `<li class="mono ws-recent" title="${esc(r)}">${esc(folderName(r))}</li>`)
    .join('')
  if (state.selectedSession) updateSessionLabel(state.selectedSession)
}

function markFileChanged(filePath) {
  if (!filePath) return
  state.changedFiles.add(String(filePath))
  ui.changedFiles.innerHTML = [...state.changedFiles].map((file) => `<li class="changed-file" data-path="${esc(file)}" title="${esc(file)}"><span aria-hidden="true">✎</span> ${esc(file)}</li>`).join('')
  ui.changedFiles.querySelectorAll('.changed-file').forEach((item) => item.addEventListener('click', () => void previewFile(item.dataset.path)))
}

function renderAudit(recent) {
  ui.audit.innerHTML =
    recent
      .map(
        (r) =>
          `<li><span class="decision ${esc(r.decision)}">${esc(r.decision)}</span> <span class="tool-name">${esc(r.tool)}</span> <span class="muted">${clock(r.at)}</span></li>`,
      )
      .join('') || '<li class="muted pad">no decisions yet</li>'
}

// -------------------------------------------------------------- approval gate

let approvalItem = null

/** Shows a before/after diff when the gate is about to write a file. */
function renderDiff(argsText) {
  const box = ui.approvalDiff
  let args
  try {
    args = JSON.parse(argsText)
  } catch {
    box.hidden = true
    return
  }
  if (args.path === undefined || args.content === undefined) {
    box.hidden = true
    return
  }
  void fetch('/api/tools/read_file', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args: { path: args.path } }),
  })
    .then((res) => res.json())
    .then((body) => {
      const before = String(body.result ?? '').startsWith('Error:') ? '' : String(body.result)
      const after = String(args.content ?? '')
      const rows = []
      const bLines = before.split('\n')
      const aLines = after.split('\n')
      // naive line diff: longest-common-prefix/suffix trim, middle marked
      let start = 0
      while (start < bLines.length && start < aLines.length && bLines[start] === aLines[start]) start += 1
      let endB = bLines.length
      let endA = aLines.length
      while (endB > start && endA > start && bLines[endB - 1] === aLines[endA - 1]) {
        endB -= 1
        endA -= 1
      }
      const ctx = 2
      if (start > ctx) rows.push({ t: 'h', s: `@ ${start - ctx} lines unchanged` })
      for (let i = Math.max(0, start - ctx); i < start; i++) rows.push({ t: ' ', s: bLines[i] })
      for (let i = start; i < endB; i++) rows.push({ t: '-', s: bLines[i] })
      for (let i = start; i < endA; i++) rows.push({ t: '+', s: aLines[i] })
      for (let i = endB; i < Math.min(endB + ctx, bLines.length); i++) rows.push({ t: ' ', s: bLines[i] })
      box.hidden = !rows.length
      box.innerHTML =
        `<div class="diff-file mono">${esc(args.path)}</div>` +
        rows
          .map((r) =>
            r.t === 'h' ? `<div class="diff-hunk">${esc(r.s)}</div>` : `<div class="diff-line ${r.t === '+' ? 'add' : r.t === '-' ? 'del' : 'ctx'}"><span class="sign">${esc(r.t === '+' ? '+' : r.t === '-' ? '-' : ' ')}</span>${esc(r.s)}</div>`,
          )
          .join('')
    })
    .catch(() => {
      box.hidden = true
    })
}

function renderApprovalGate(pending, mode) {
  const previousId = approvalItem?.id
  approvalItem = pending[0] || null
  const box = ui.approval
  if (!approvalItem) {
    box.hidden = true
    ui.approvalDiff.hidden = true
    ui.approvalMode.hidden = !mode
    ui.approvalMode.textContent = mode ? `mode ${mode}` : ''
    return
  }
  box.hidden = false
  ui.approvalTool.textContent = `${toolTitle(approvalItem.tool)} · ${toolSummary(approvalItem.tool, approvalItem.args)}`
  const argsText = JSON.stringify(approvalItem.args, null, 2)
  const args = approvalItem.args && typeof approvalItem.args === 'object' ? approvalItem.args : {}
  const humanRequest = approvalItem.tool === 'run_command' ? `Command: ${args.command || args.cmd || '(command)'}`
    : approvalItem.tool === 'write_file' ? `Write file: ${args.path || '(file)'}\n${String(args.content || '').slice(0, 500)}`
    : `${toolTitle(approvalItem.tool)} ${toolSummary(approvalItem.tool, args)}`
  ui.approvalArgs.textContent = humanRequest
  renderDiff(argsText)
  ui.approvalHint.textContent = `${mode === 'all' ? 'Every action requires approval' : 'This action is covered by the active approval policy'} · rejected if unanswered`
  ui.approvalMode.hidden = !mode
  ui.approvalMode.textContent = mode ? `mode ${mode}` : ''
  if (previousId !== approvalItem.id) ui.approvalYes.focus()
}

async function submitApproval(decision) {
  if (!approvalItem) return
  await fetch(`/api/approvals/${encodeURIComponent(approvalItem.id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision }),
  })
  renderApprovalGate([], 'off')
  void loadState().catch(() => {})
}

ui.approvalYes.addEventListener('click', () => {
  void submitApproval('approved')
})

ui.approvalSession.addEventListener('click', () => {
  void submitApproval('approved_session')
})

ui.approvalNo.addEventListener('click', () => {
  void submitApproval('rejected')
})

/** While a run is streaming, poll for pending approvals so the card shows up. */
function watchApprovals() {
  if (!state.running) return
  fetch('/api/approvals')
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (state.running && data) renderApprovalGate(data.pending || [], data.mode)
    })
    .catch(() => {})
}

// ------------------------------------------------------------------ workspace

async function useWorkspace(root) {
  const res = await fetch('/api/workspace', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    ui.pluginMsg.className = 'plugin-msg error'
    ui.pluginMsg.textContent = body.error || `workspace ${res.status}`
    return
  }
  setWorkspace(body)
  wsInput().value = ''
  ui.heroWsInput.value = ''
  ui.heroWsForm.hidden = true
  state.filesDir = '.'
  state.filesCache = null
  await loadFiles('.')
  void loadState().catch(() => {})
}

/** Late-bound: the sidebar input exists only after DOM ready. */
const wsInput = () => $('ws-input')

$('ws-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const value = wsInput().value.trim()
  if (value) void useWorkspace(value)
})

ui.heroWsForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const value = ui.heroWsInput.value.trim()
  if (value) void useWorkspace(value)
})

ui.heroWs.addEventListener('click', () => {
  ui.heroWsForm.hidden = !ui.heroWsForm.hidden
  if (!ui.heroWsForm.hidden) {
    ui.heroWsInput.value = state.workspace?.root || ''
    ui.heroWsInput.focus()
  }
})

ui.wsRecents.addEventListener('click', (event) => {
  const li = event.target.closest('.ws-recent')
  if (li) void useWorkspace(li.title)
})

async function loadFiles(dir) {
  const res = await fetch(`/api/files/${dir.split('/').map(encodeURIComponent).join('/')}`)
  if (!res.ok) {
    ui.files.innerHTML = `<li class="muted pad">cannot list ${esc(dir || '.')}</li>`
    return
  }
  const body = await res.json()
  state.filesDir = body.dir || '.'
  state.filesCache = null
  ui.files.innerHTML = body.files
    .map(
      (f) =>
        `<li class="file ${f.type}" data-name="${esc(f.name)}" data-type="${esc(f.type)}" title="${esc(f.name)}"><span class="file-icon">${f.type === 'dir' ? '▸' : '·'}</span> ${esc(f.name)}</li>`,
    )
    .join('') || '<li class="muted pad">(empty)</li>'
}

ui.files.addEventListener('click', (event) => {
  const li = event.target.closest('.file')
  if (!li) return
  const name = li.dataset.name
  if (li.dataset.type === 'dir') {
    void loadFiles(state.filesDir === '.' ? name : `${state.filesDir}/${name}`)
    return
  }
  const rel = state.filesDir === '.' ? name : `${state.filesDir}/${name}`
  void previewFile(rel)
})

$('btn-files-up').addEventListener('click', () => {
  if (state.filesDir === '.') return
  void loadFiles(state.filesDir.split('/').slice(0, -1).join('/') || '.')
})

// ------------------------------------------------------------------- plugins

$('plugin-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const src = $('plugin-input').value.trim()
  if (!src) return
  ui.pluginMsg.className = 'plugin-msg'
  ui.pluginMsg.textContent = 'loading…'
  const res = await fetch('/api/plugins', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    ui.pluginMsg.className = 'plugin-msg error'
    ui.pluginMsg.textContent = body.error || `load failed (${res.status})`
    return
  }
  ui.pluginMsg.className = 'plugin-msg ok'
  ui.pluginMsg.textContent = 'loaded'
  $('plugin-input').value = ''
  void loadState().catch(() => {})
})

// ------------------------------------------------------------------ rail tabs

function activateTab(name) {
  document.querySelectorAll('.rail-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name))
  for (const pane of document.querySelectorAll('.rail-pane')) pane.hidden = pane.id !== `pane-${name}`
}

document.querySelectorAll('.rail-tabs .tab').forEach((tab) => {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab))
})

function toggleRail() {
  if (matchMedia('(max-width: 760px)').matches) {
    document.body.classList.remove('rail-collapsed')
    document.body.classList.toggle('mobile-rail-open')
  } else document.body.classList.toggle('rail-collapsed')
}
$('btn-rail').addEventListener('click', toggleRail)
$('btn-rail-reveal').addEventListener('click', () => {
  if (matchMedia('(max-width: 760px)').matches) toggleRail()
  else document.body.classList.remove('rail-collapsed')
})
document.querySelector('.stage').addEventListener('click', (event) => {
  if (!event.target.closest('#btn-rail-reveal')) document.body.classList.remove('mobile-rail-open')
})

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') {
    event.preventDefault()
    toggleRail()
    return
  }
  if (event.key === 'Escape') {
    document.body.classList.remove('mobile-rail-open')
    if (!ui.editor.hidden) return closeEditor()
    if (state.running) return state.controller?.abort()
  }
})

// drag-resize the rail from its right edge (200..520, dblclick resets)

{
  const EDGE = 5
  let drag = null
  ui.scrollBody.addEventListener('pointerdown', (event) => {
    if (document.body.classList.contains('rail-collapsed')) return
    const rect = ui.rail.getBoundingClientRect()
    if (Math.abs(event.clientX - rect.right) > EDGE) return
    drag = { startX: event.clientX, width: rect.width }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const ghost = document.createElement('div')
    ghost.id = 'rail-drag-ghost'
    ghost.style.cssText =
      'position:fixed;top:0;bottom:0;left:' + rect.width + 'px;width:2px;z-index:99;background:var(--sb-alias-state-business-primary);pointer-events:none;'
    document.body.appendChild(ghost)
    event.preventDefault()
  })
  window.addEventListener('pointermove', (event) => {
    if (!drag) return
    const w = Math.min(520, Math.max(200, event.clientX))
    drag.width = w
    const ghost = document.getElementById('rail-drag-ghost')
    if (ghost) ghost.style.left = `${w}px`
  })
  window.addEventListener('pointerup', () => {
    if (!drag) return
    ui.rail.style.width = `${drag.width}px`
    drag = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    document.getElementById('rail-drag-ghost')?.remove()
  })
  ui.rail.addEventListener('dblclick', () => {
    ui.rail.style.width = ''
  })
}

// ----------------------------------------------------------------------- ci
// Local workflow runner panel. Boots only when the server reports ci.enabled;
// self-contained so loadState/activateTab stay untouched.

const ciState = { workflows: [], runs: [], total: 0, limit: 20, offset: 0, wf: '', status: '', timer: null, openRun: null, expect: null, detailHtml: '', detailSeq: 0 }

const CI_BADGE = { success: 'completed', failed: 'failed', running: 'working', cancelled: 'cancelled', 'setup-failed': 'failed', skipped: 'idle', pending: 'idle' }

function ciPill(status) {
  return `<span class="status-pill ${CI_BADGE[status] ?? 'idle'}">${esc(status)}</span>`
}

function ciQuery() {
  const params = new URLSearchParams({ limit: ciState.limit, offset: ciState.offset })
  if (ciState.wf) params.set('workflow', ciState.wf)
  if (ciState.status) params.set('status', ciState.status)
  return params.toString()
}

function ciTrigger(trigger) {
  return `<span class="ci-trigger" title="trigger: ${esc(trigger)}">${esc(trigger)}</span>`
}

function ciDuration(run) {
  if (!run.endedAt) return ''
  const ms = Date.parse(run.endedAt) - Date.parse(run.startedAt)
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

async function ciJson(pathname, options) {
  const res = await fetch(pathname, options)
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
  return res.json()
}

async function ciLoad() {
  const [workflows, page] = await Promise.all([
    ciJson('/api/ci/workflows'),
    ciJson(`/api/ci/runs?${ciQuery()}`),
  ])
  ciState.workflows = workflows
  ciState.runs = page.runs
  ciState.total = page.total
  ciState.offset = page.offset
  ciRender()
  // the re-render replaced the detail box with the cached markup — refresh it
  if (ciState.openRun && ciState.detailHtml && ciState.runs.some((r) => r.id === ciState.openRun)) {
    await ciRenderDetail(ciState.openRun)
  }
}

function ciRender() {
  $('ci-count').textContent = String(ciState.runs.filter((r) => r.status === 'running').length || '')
  $('ci-workflows').innerHTML = ciState.workflows.length
    ? ciState.workflows
        .map(
          (wf) => `<li class="ci-row" data-id="${esc(wf.id)}">
        <span class="ci-name">${esc(wf.name)}</span>
        <span class="muted mono">${esc(wf.jobs.join(' → ') || wf.error || '')}</span>
        <button class="icon-btn ghost-btn ci-run" type="button" title="Run ${esc(wf.name)}" aria-label="Run ${esc(wf.name)}" ${wf.error ? 'disabled' : ''}>▶</button>
      </li>`,
        )
        .join('')
    : '<li class="muted pad">No workflows in .switchboard/workflows/</li>'
  const wfSel = $('ci-filter-wf')
  const wfKey = ciState.workflows.map((w) => w.id).join(',')
  if (wfSel.dataset.key !== wfKey) {
    wfSel.innerHTML =
      '<option value="">All workflows</option>' +
      ciState.workflows.map((wf) => `<option value="${esc(wf.id)}">${esc(wf.name)}</option>`).join('')
    wfSel.dataset.key = wfKey
  }
  wfSel.value = ciState.wf
  ciState.wf = wfSel.value // self-heal if the filtered workflow disappeared
  $('ci-filter-status').value = ciState.status

  $('ci-runs').innerHTML = ciState.runs.length
    ? ciState.runs
        .map(
          (run) => `<li class="ci-run-item" data-id="${esc(run.id)}">
        <button class="ci-run-head" type="button" aria-expanded="${ciState.openRun === run.id}">
          ${ciPill(run.status)}${ciTrigger(run.trigger)}<span class="ci-name">${esc(run.name)}</span><span class="muted mono">${esc(ciDuration(run))}</span>
        </button>
        ${ciState.openRun === run.id ? `<div class="ci-detail${ciState.detailHtml ? ' pad' : ' muted pad'}">${ciState.detailHtml || 'loading…'}</div>` : ''}
      </li>`,
        )
        .join('')
    : ciState.wf || ciState.status
      ? '<li class="muted pad">No runs match the filters</li>'
      : '<li class="muted pad">No runs yet</li>'

  const first = ciState.total ? ciState.offset + 1 : 0
  const last = Math.min(ciState.offset + ciState.limit, ciState.total)
  $('ci-page-info').textContent = ciState.total ? `${first}–${last} / ${ciState.total}` : '0'
  $('ci-prev').disabled = ciState.offset <= 0
  $('ci-next').disabled = ciState.offset + ciState.limit >= ciState.total
}

async function ciRenderDetail(id) {
  const seq = ++ciState.detailSeq
  let html
  try {
    const run = await ciJson(`/api/ci/runs/${id}`)
    if (seq !== ciState.detailSeq || ciState.openRun !== id) return
    html =
      `<div class="ci-detail-actions"><button class="ci-download" type="button" data-id="${esc(run.id)}">Unduh log</button></div>` +
      (run.jobs
        .map(
          (job) => `<div class="ci-job"><strong>${esc(job.name)}</strong> ${ciPill(job.status)}
        ${job.steps
          .map(
            (step) => `<div class="ci-step">${ciPill(step.status)} <span class="mono">${esc(step.name)}</span>
            ${step.log ? `<pre class="ci-log">${esc(step.log)}</pre>` : ''}</div>`,
          )
          .join('')}</div>`,
        )
        .join('') || `<div class="pad">${esc(run.error ?? 'no jobs')}</div>`)
  } catch (error) {
    if (seq !== ciState.detailSeq || ciState.openRun !== id) return
    html = `<div class="pad">${esc(String(error))}</div>`
  }
  ciState.detailHtml = html
  const box = document.querySelector(`.ci-run-item[data-id="${id}"] .ci-detail`)
  if (!box) return
  box.classList.remove('muted')
  box.innerHTML = html
}

async function ciShowRun(id) {
  const closing = ciState.openRun === id
  ciState.detailSeq += 1 // latest wins — drop any in-flight fetch
  ciState.openRun = closing ? null : id
  ciState.detailHtml = ''
  ciRender()
  if (closing) return
  await ciRenderDetail(id)
}

function ciPoll() {
  clearInterval(ciState.timer)
  ciState.timer = null
  const tick = async () => {
    try {
      await ciLoad()
      // the server persists a started run only after the workflow re-resolves,
      // so keep polling until the id from the 202 response shows up
      if (ciState.expect && ciState.runs.some((r) => r.id === ciState.expect)) ciState.expect = null
      if (!ciState.expect && !ciState.runs.some((r) => r.status === 'running')) {
        clearInterval(ciState.timer)
        ciState.timer = null
      }
    } catch {
      /* transient fetch error — keep or stop on next tick */
    }
  }
  ciState.timer = setInterval(tick, 2000)
  void tick()
}

async function ciStart(workflow) {
  const started = await ciJson('/api/ci/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflow }),
  })
  ciState.expect = started.id
  ciState.offset = 0
  ciPoll()
}

async function ciDownload(id) {
  const run = await ciJson(`/api/ci/runs/${id}`)
  const text = run.jobs
    .map(
      (job) =>
        `# ${job.name} (${job.status})\n` +
        job.steps.map((step) => `## ${step.name} (${step.status})\n${step.log ?? ''}`).join('\n'),
    )
    .join('\n')
  const blob = new Blob([text], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${id}.txt`
  a.click()
  URL.revokeObjectURL(url)
}

async function initCi() {
  let boot = null
  try {
    boot = await (await fetch('/api/state')).json()
  } catch {
    return
  }
  if (!boot?.ci?.enabled) return
  document.querySelector('.rail-tabs .tab[data-tab="ci"]')?.removeAttribute('hidden')
  $('btn-ci-refresh').addEventListener('click', () => ciLoad().catch(() => {}))
  $('ci-workflows').addEventListener('click', (event) => {
    const btn = event.target.closest('.ci-run')
    if (!btn) return
    void ciStart(btn.closest('.ci-row').dataset.id).catch((error) => {
      btn.title = String(error)
    })
  })
  $('ci-runs').addEventListener('click', (event) => {
    const dl = event.target.closest('.ci-download')
    if (dl) {
      void ciDownload(dl.dataset.id).catch(() => {})
      return
    }
    const head = event.target.closest('.ci-run-head')
    if (!head) return
    void ciShowRun(head.closest('.ci-run-item').dataset.id)
  })
  $('ci-filter-wf').addEventListener('change', (event) => {
    ciState.wf = event.target.value
    ciState.offset = 0
    void ciLoad().catch(() => {})
  })
  $('ci-filter-status').addEventListener('change', (event) => {
    ciState.status = event.target.value
    ciState.offset = 0
    void ciLoad().catch(() => {})
  })
  $('ci-prev').addEventListener('click', () => {
    ciState.offset = Math.max(0, ciState.offset - ciState.limit)
    void ciLoad().catch(() => {})
  })
  $('ci-next').addEventListener('click', () => {
    ciState.offset += ciState.limit
    void ciLoad().catch(() => {})
  })
  await ciLoad().catch(() => {})
  if (ciState.runs.some((r) => r.status === 'running')) ciPoll()
}
void initCi()

// -------------------------------------------------------------------- theme

/* A bright welcome surface for Bico; respect the user's saved preference. */
const THEME_KEY = 'sb-theme'
function applyTheme(theme) {
  const dark = theme !== 'light'
  document.body.toggleAttribute('data-theme', dark)
  $('btn-theme').setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme')
  $('btn-theme').title = dark ? 'Switch to light theme' : 'Switch to dark theme'
  try {
    localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light')
  } catch {
    /* private mode */
  }
}
$('btn-theme').addEventListener('click', () =>
  applyTheme(document.body.hasAttribute('data-theme') ? 'light' : 'dark'),
)
try {
  applyTheme(localStorage.getItem(THEME_KEY) || 'light')
} catch {
  applyTheme('light')
}

// -------------------------------------------------------------------- chat

/** Metric chips appended under a sealed assistant entry (detail lives in Trace). */
function metricChips(m) {
  if (!m) return
  const chips = [
    `ttft ${m.ttftMs}ms`,
    `${m.tokensPerSec || '—'} tok/s`,
    `${m.usage?.completionTokens ?? '?'} out`,
    m.usage?.cachedTokens ? `${m.usage.cachedTokens} cached` : null,
  ].filter(Boolean)
  const div = document.createElement('div')
  div.className = 'chips'
  div.innerHTML = chips.map((c) => `<span class="chip mono">${esc(c)}</span>`).join('')
  ui.timeline.lastElementChild?.appendChild(div)
  scrollDown()
}

/** Collapsible live entry: reasoning renders closed ("Thought…"), text grows. */
function liveEntry(kind, label) {
  const li = entry(kind, label)
  li.classList.add('live')
  const body = li.querySelector('.body')
  let textNode
  if (kind === 'reasoning') {
    const details = document.createElement('details')
    details.className = 'reasoning-box'
    details.open = false
    details.innerHTML = '<summary>Thought for a while</summary><div class="reasoning-text"></div>'
    body.appendChild(details)
    textNode = details.querySelector('.reasoning-text')
  } else {
    body.innerHTML = '<span class="cursor"></span>'
    textNode = body
  }
  let text = ''
  return {
    push(chunk) {
      text += chunk
      if (kind === 'reasoning') textNode.textContent = text
      else body.innerHTML = rich(text) + '<span class="cursor"></span>'
      scrollDown()
    },
    seal(extraHtml) {
      li.classList.remove('live')
      if (kind === 'reasoning') textNode.textContent = text || '—'
      else body.innerHTML = text ? rich(text) : '<p class="muted">—</p>'
      if (extraHtml) li.insertAdjacentHTML('beforeend', extraHtml)
      scrollDown()
    },
  }
}

// ------------------------------------------------------------ composer @/ commands

/** Shows the file mention dropdown under the composer. */
async function updateMentions(fragment, explicit) {
  const atEnd = /(?:^|\s)@([\w./-]*)$/.exec(fragment)
  if (!explicit && !atEnd) {
    ui.mentions.hidden = true
    return
  }
  const query = (atEnd ? atEnd[1] : '').toLowerCase()
  if (!state.filesCache || state.filesCache.dir !== state.filesDir) {
    const res = await fetch(`/api/files/${state.filesDir.split('/').map(encodeURIComponent).join('/')}`).catch(() => null)
    state.filesCache = res && res.ok ? await res.json() : { files: [] }
  }
  const hits = (state.filesCache?.files || []).filter((f) => f.name.toLowerCase().includes(query)).slice(0, 6)
  if (!hits.length) {
    ui.mentions.hidden = true
    return
  }
  ui.mentions.innerHTML = hits
    .map((f) => `<li data-name="${esc(f.name)}" data-type="${esc(f.type)}"><span class="file-icon">${f.type === 'dir' ? '▸' : '·'}</span> ${esc(f.name)}</li>`)
    .join('')
  ui.mentions.hidden = false
}

ui.mentions.addEventListener('mousedown', (event) => {
  const li = event.target.closest('li')
  if (!li) return
  event.preventDefault()
  ui.prompt.value = ui.prompt.value.replace(/@([\w./-]*)$/, `@${li.dataset.name}${li.dataset.type === 'dir' ? '/' : ' '}`)
  ui.mentions.hidden = true
  ui.prompt.focus()
})

/** `/` commands (composer shortcuts, not model calls). */
const COMMANDS = {
  '/new': () => newRun(),
  '/sessions': () => {
    activateTab('sessions')
    void loadState().catch(() => {})
  },
  '/workspace': () => activateTab('workspace'),
  '/plugins': () => activateTab('plugins'),
  '/trace': () => activateTab('trace'),
  '/metrics': () => {
    activateTab('trace')
    void loadState().catch(() => {})
  },
}

const COMMAND_HELP = {
  '/new': 'Start a new session',
  '/sessions': 'Browse past sessions',
  '/workspace': 'Project files and search',
  '/plugins': 'Installed plugins',
  '/trace': 'Run trace and approvals',
  '/metrics': 'Model latency metrics',
}

/** Command palette: shown while the input is exactly `/…`. */
function updateCommands() {
  if (!ui.commands) return
  const match = /^\/([\w-]*)$/.exec(ui.prompt.value)
  if (!match) {
    ui.commands.hidden = true
    return
  }
  const query = match[1].toLowerCase()
  const hits = Object.keys(COMMANDS).filter((cmd) => cmd.slice(1).startsWith(query))
  if (!hits.length) {
    ui.commands.hidden = true
    return
  }
  ui.commands.innerHTML = hits
    .map((cmd) => `<li data-cmd="${esc(cmd)}"><span class="cmd-name">${esc(cmd)}</span><span class="cmd-desc">${esc(COMMAND_HELP[cmd] || '')}</span></li>`)
    .join('')
  ui.commands.hidden = false
}

ui.commands?.addEventListener('mousedown', (event) => {
  const li = event.target.closest('li')
  if (!li) return
  event.preventDefault()
  ui.prompt.value = li.dataset.cmd
  ui.commands.hidden = true
  ui.prompt.focus()
})

/** `/compact [focus]` in the composer: fold old history into a summary. */
async function compactSession(focus) {
  if (!state.sessionId) {
    entry('notice', 'Compact').querySelector('.body').textContent = 'Nothing to compact yet: start a conversation first.'
    return
  }
  const res = await fetch(`/api/sessions/${encodeURIComponent(state.sessionId)}/compact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ focus: focus || undefined }),
  }).catch(() => null)
  const data = res ? await res.json().catch(() => ({})) : {}
  if (res?.ok) await openSession(state.sessionId)
  const note = entry('notice', 'Compact')
  note.querySelector('.body').textContent = res?.ok ? `Summarized ${data.summarized} message(s): about ${data.before} → ${data.after} tokens.` : `Not compacted: ${data.error || 'the request failed'}.`
}

async function send(prompt) {
  if (/^\/compact(\s|$)/.test(String(prompt).trim())) return void (await compactSession(String(prompt).trim().slice(8).trim()))
  if (state.running) return
  state.running = true
  state.activeTurnModel = ui.modelPicker.value || state.model
  state.pinned = atBottom()
  ui.send.disabled = true
  ui.stop.hidden = false
  setStatus('working', 'Working')
  setActivity('Starting')
  ui.mentions.hidden = true
  if (ui.commands) ui.commands.hidden = true

  const images = state.attachedImages.slice()
  const augmentedPrompt = state.textAttachments.length ? `${prompt}\n\nAttached files:\n${state.textAttachments.map((file) => `--- ${file.name} ---\n${file.text}`).join('\n\n')}` : prompt
  const userEntry = entry('user', 'you')
  userEntry.querySelector('.body').innerHTML = rich(prompt)
  for (const file of [...state.textAttachments, ...images]) userEntry.querySelector('.body').insertAdjacentHTML('beforeend', `<span class="attachment-chip">${file.type?.startsWith('image/') || file.mimeType ? 'Image' : 'File'} · ${esc(file.name)}</span>`)
  state.textAttachments = []
  state.attachedImages = []
  renderAttachmentList()

  state.controller = new AbortController()
  try {
    if (!state.sessionId) {
      const sessionPick = parseModelOption(state.activeTurnModel)
      const created = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'New task', model: sessionPick.model || null, provider: sessionPick.provider, preset: state.preset || undefined }) })
      if (!created.ok) throw new Error(`Could not create session (${created.status})`)
      const session = await created.json()
      state.sessionId = session.id
      state.selectedSession = session
      updateSessionLabel(session)
    }
  } catch (error) {
    entry('error', 'session failed').querySelector('.body').textContent = error.message || String(error)
    finish('failed', 'Failed')
    return
  }

  const chatPick = parseModelOption(state.activeTurnModel)
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: augmentedPrompt, sessionId: state.sessionId, model: chatPick.model || null, provider: chatPick.provider, preset: state.preset || undefined, attachments: images }),
    signal: state.controller.signal,
  }).catch((error) => ({ ok: false, status: 0, error }))

  if (!res.ok || !res.body) {
    if (state.controller?.signal.aborted || res.error?.name === 'AbortError') {
      entry('notice', 'Stopped').querySelector('.body').textContent = 'Response stopped. You can send another message when you are ready.'
      finish('cancelled', 'Stopped')
      return
    }
    const errorBody = res.status ? await res.json().catch(() => ({})) : {}
    const detail = errorBody.error || (res.status ? `Request failed (${res.status})` : (res.error?.message || 'network error'))
    entry('error', 'request failed').querySelector('.body').textContent = detail
    finish('failed', 'Failed')
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let live = null
  let reasoning = null
  let lastMetrics = null
  let sawCancelled = false
  let sawError = false
  let stopReason
  const toolNodes = new Map()
  const callStarts = new Map()

  const seal = () => {
    if (live) live.seal()
    if (reasoning) reasoning.seal()
    live = reasoning = null
  }

  const approvalTimer = setInterval(watchApprovals, 1200)

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let split
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const typeLine = /^event: (.+)$/m.exec(frame)
        const dataLine = /^data: (.+)$/m.exec(frame)
        if (!typeLine || !dataLine) continue
        const type = typeLine[1]
        let event
        try {
          event = JSON.parse(dataLine[1])
        } catch {
          continue
        }

        switch (type) {
          case 'session':
            state.sessionId = event.sessionId
            if (state.selectedSession) state.selectedSession.model = state.activeTurnModel
            updateSessionLabel(state.selectedSession || { id: event.sessionId, title: 'New task', model: state.activeTurnModel, projectRoot: state.workspace?.root })
            void loadState().catch(() => {})
            break
          case 'turn_started':
            setStatus('working', 'Working')
            setActivity('Analyzing task')
            break
          case 'step':
            setActivity('Working through the next step')
            break
          case 'delta':
            if (reasoning) reasoning.seal()
            reasoning = null
            setActivity('Writing response')
            if (!live) live = liveEntry('assistant', 'Switchboard')
            live.push(event.text)
            break
          case 'reasoning':
            // Reasoning is private. Only expose a safe activity label.
            setActivity('Analyzing')
            break
          case 'tool_call': {
            seal()
            callStarts.set(event.id, Date.now())
            setActivity(event.name === 'read_file' || event.name === 'list_dir' ? 'Reading files' : event.name === 'run_command' ? 'Running command' : event.name === 'write_file' ? 'Editing files' : event.name === 'search_files' ? 'Searching project' : 'Using a tool')
            const card = toolCard(event.name, event.args)
            toolNodes.set(event.id, card)
            break
          }
          case 'tool_result': {
            const card = toolNodes.get(event.id)
            const dur = callStarts.get(event.id)
            if (card) card.done(event.result, dur != null ? Date.now() - dur : null)
            else {
              const li = entry('tool-result', toolTitle(event.name))
              li.querySelector('.body').innerHTML = toolBody(event.result)
            }
            setActivity(String(event.result || '').startsWith('Error:') ? 'Checking the result' : 'Working')
            scrollDown()
            break
          }
          case 'file_changed': {
            markFileChanged(event.path)
            const match = [...toolNodes.values()].find((item) => item.li.querySelector('.t-summary')?.textContent.includes(shortPath(event.path)))
            match?.fileChanged(event)
            void loadFiles(state.filesDir)
            setActivity('Checking file changes')
            break
          }
          case 'approval_needed': {
            seal()
            setStatus('waiting_approval', 'Waiting approval')
            setActivity('')
            const waiting = entry('notice', 'waiting approval')
            waiting.querySelector('.body').textContent = `Waiting for approval: ${toolTitle(event.name)} · ${toolSummary(event.name, event.args)}`
            break
          }
          case 'cancelled':
            sawCancelled = true
            break
          case 'metrics':
            lastMetrics = event.metrics
            if (event.metrics?.usage?.promptTokens != null) {
              state.lastPromptTokens = event.metrics.usage.promptTokens
              renderModelCapabilities()
            }
            break
          case 'notice':
            seal()
            entry('notice', 'notice').querySelector('.body').textContent = event.notice
            break
          case 'error':
            sawError = true
            seal()
            entry('error', 'Could not finish').querySelector('.body').textContent = `${event.error}\nCheck your provider settings or choose another model, then try again.`
            break
          case 'final': {
            stopReason = event.stopReason
            seal()
            const last = ui.timeline.lastElementChild
            if (lastMetrics && last && last.classList.contains('assistant')) metricChips(lastMetrics)
            // stopReason badge (web/badge.js): only the values the agent actually
            // yields render; missing/unknown stays badge-free. Text carries the
            // meaning; the tone class is a secondary cue. Assigned as text.
            const badge = typeof stopBadge === 'function' ? stopBadge(event.stopReason) : null
            if (badge && last && last.classList.contains('assistant')) {
              const chip = document.createElement('span')
              chip.className = `stop-badge stop-badge--${badge.tone}`
              chip.textContent = badge.text
              const head = last.querySelector('.head') || last
              head.appendChild(chip)
            }
            break
          }
          default:
            break
        }
      }
    }
    seal()
    const outcome = runOutcome({ cancelled: sawCancelled, error: sawError, stopReason })
    if (!sawCancelled && !sawError && stopReason === 'step_limit') {
      entry('notice', 'Step limit reached').querySelector('.body').textContent = 'The agent reached its step limit before finishing. Ask it to continue, or split the task into smaller steps.'
    } else if (!sawCancelled && !sawError && stopReason !== 'answer') {
      entry('error', 'Response interrupted').querySelector('.body').textContent = 'The connection ended before the agent finished. Check your connection, then try again.'
    }
    finish(outcome.kind, outcome.label)
  } catch (error) {
    seal()
    if (error?.name !== 'AbortError') {
      entry('error', 'stream failed').querySelector('.body').textContent = String(error?.message || error)
      finish('failed', 'Failed')
    } else {
      entry('notice', 'cancelled').querySelector('.body').textContent = 'Run stopped. You can continue with another task.'
      finish('cancelled', 'Stopped')
    }
  } finally {
    clearInterval(approvalTimer)
    await loadState().catch(() => {})
  }
}

function toolBody(text) {
  const t = String(text ?? '')
  return t.length > 1200
    ? `<details><summary>${esc(t.slice(0, 160))}…</summary><pre><code>${esc(t)}</code></pre></details>`
    : `<div class="tool-result">${esc(t)}</div>`
}

function finish(kind, label) {
  state.running = false
  ui.send.disabled = false
  ui.stop.hidden = true
  state.controller = null
  setActivity('')
  setStatus(kind, label)
  ui.prompt.focus()
  void loadState().catch(() => {})
  void loadTrace()
}

async function newRun() {
  if (state.running) return
  try {
    const runPick = parseModelOption(ui.modelPicker.value || state.model || '')
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'New task', model: runPick.model || null, provider: runPick.provider }),
    })
    if (!response.ok) throw new Error(`session ${response.status}`)
    const session = await response.json()
    state.sessionId = session.id
    state.selectedSession = session
    state.model = session.model ? encodeModelOption(session.provider, session.model) : state.model
    updateSessionLabel(session)
    state.changedFiles.clear()
    ui.changedFiles.innerHTML = '<li class="muted pad">Changes appear here</li>'
    clearTimeline()
    setStatus('idle', 'Idle')
    activateTab('sessions')
    void loadState().catch(() => {})
    ui.prompt.focus()
  } catch (error) {
    entry('error', 'session failed').querySelector('.body').textContent = error.message || String(error)
  }
}

function renderAttachmentList() {
  const files = [...state.textAttachments, ...state.attachedImages]
  ui.attachmentList.innerHTML = files.map((file, index) => `<button type="button" class="attachment-chip remove-attachment" data-index="${index}" title="Remove ${esc(file.name)}">${esc(file.name)} ×</button>`).join('')
}

async function addAttachments(fileList) {
  for (const file of fileList) {
    if (file.type.startsWith('image/')) {
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
        entry('error', 'attachment').querySelector('.body').textContent = `${file.name}: choose PNG, JPEG, GIF or WebP under 5 MB.`
        continue
      }
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })
      state.attachedImages.push({ name: file.name, mimeType: file.type, dataUrl })
    } else {
      if (file.size > 512 * 1024) {
        entry('error', 'attachment').querySelector('.body').textContent = `${file.name}: text attachments must be under 512 KB.`
        continue
      }
      state.textAttachments.push({ name: file.name, text: await file.text() })
    }
  }
  renderAttachmentList()
}

// ------------------------------------------------------------------- events

ui.composer.addEventListener('submit', (event) => {
  event.preventDefault()
  if (ui.commands) ui.commands.hidden = true
  ui.mentions.hidden = true
  const prompt = ui.prompt.value.trim()
  if ((!prompt && !state.textAttachments.length && !state.attachedImages.length) || state.running) return
  if (prompt.startsWith('/') && COMMANDS[prompt]) {
    ui.prompt.value = ''
    COMMANDS[prompt]()
    return
  }
  ui.prompt.value = ''
  ui.prompt.style.height = 'auto'
  void send(prompt)
})

ui.prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    if (!ui.mentions.hidden) {
      const first = ui.mentions.querySelector('li')
      if (first) {
        ui.prompt.value = ui.prompt.value.replace(/@([\w./-]*)$/, `@${first.dataset.name}${first.dataset.type === 'dir' ? '/' : ' '}`)
        ui.mentions.hidden = true
        return
      }
    }
    if (ui.commands && !ui.commands.hidden) {
      const first = ui.commands.querySelector('li')
      if (first) {
        ui.prompt.value = first.dataset.cmd
        ui.commands.hidden = true
        return
      }
    }
    ui.composer.requestSubmit()
  }
  if (event.key === 'Escape') {
    ui.mentions.hidden = true
    if (ui.commands) ui.commands.hidden = true
  }
})

ui.prompt.addEventListener('input', () => {
  ui.prompt.style.height = 'auto'
  ui.prompt.style.height = `${Math.min(180, ui.prompt.scrollHeight)}px`
  void updateMentions(ui.prompt.value, false)
  updateCommands()
})

ui.stop.addEventListener('click', () => state.controller?.abort())

/** Keeps the header and composer model selectors in sync and refreshes warnings. */
function setModel(id) {
  if (!id) return
  state.model = id
  if (ui.modelPicker && ui.modelPicker.value !== id) ui.modelPicker.value = id
  if (ui.modelMini && ui.modelMini.value !== id) ui.modelMini.value = id
  renderModelCapabilities()
}

ui.modelPicker.addEventListener('change', () => setModel(ui.modelPicker.value))
ui.modelMini?.addEventListener('change', () => setModel(ui.modelMini.value))
ui.presetMini?.addEventListener('change', () => void setPreset(ui.presetMini.value))

$('btn-new').addEventListener('click', () => void newRun())
$('btn-new-session').addEventListener('click', () => void newRun())
ui.refresh.addEventListener('click', () => void loadState().catch(() => {}))
ui.detailsButton.addEventListener('click', () => {
  ui.details.hidden = !ui.details.hidden
  ui.detailsButton.setAttribute('aria-expanded', String(!ui.details.hidden))
  document.querySelector('.conv-header').classList.toggle('show-details', !ui.details.hidden)
})
$('attach-files').addEventListener('click', () => ui.attachmentInput.click())
ui.attachmentInput.addEventListener('change', () => { void addAttachments([...ui.attachmentInput.files]); ui.attachmentInput.value = '' })
ui.attachmentList.addEventListener('click', (event) => {
  const button = event.target.closest('.remove-attachment')
  if (!button) return
  const index = Number(button.dataset.index)
  if (index < state.textAttachments.length) state.textAttachments.splice(index, 1)
  else state.attachedImages.splice(index - state.textAttachments.length, 1)
  renderAttachmentList()
})
ui.fileSearch.addEventListener('input', () => {
  const query = ui.fileSearch.value.trim().toLowerCase()
  ui.files.querySelectorAll('.file').forEach((file) => { file.hidden = !file.dataset.name.toLowerCase().includes(query) })
})

ui.scrollBody.addEventListener('scroll', () => {
  state.pinned = atBottom()
})

document.querySelectorAll('.hero-suggest .suggest').forEach((btn) => {
  btn.addEventListener('click', () => {
    ui.prompt.value = btn.dataset.prompt || btn.textContent
    ui.prompt.focus()
    ui.prompt.dispatchEvent(new Event('input'))
  })
})

/** Session to reopen after a refresh: URL first, then the last active one. */
function wantedSession(sessions) {
  const fromUrl = new URLSearchParams(location.search).get('session')
  if (fromUrl && sessions.some((s) => s.id === fromUrl)) return fromUrl
  try {
    const remembered = localStorage.getItem('sb-active-session')
    if (remembered && sessions.some((s) => s.id === remembered)) return remembered
  } catch {
    /* private mode */
  }
  return null
}

// --------------------------------------------------------------- settings
// Spec §9 panel controller: dialog markup lives in index.html, helpers in
// settings.js. Delegated events only — every action re-renders fresh HTML so
// listeners can never go stale. Copy is English; errors always carry the
// server hint so the user knows how to recover.

const settingsUi = {
  data: null,
  loadError: '',
  tab: 'general',
  editing: null, // { mode, entry, models, apiKeyDraft, discovery, issues, formError, fetching, saving }
  catalog: null, // { id, models } — open model catalog draft
  query: '',
  pendingDelete: null,
  deleteSessions: null, // authoritative list from a 409 payload
  forceNext: false,
  lastDeleted: null,
}

async function settingsJson(pathname, options = {}) {
  const res = await fetch(pathname, options)
  let payload = null
  try {
    payload = await res.json()
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const error = new Error((payload && (payload.hint || payload.error)) || `Settings request failed (${res.status}). Reload the dialog and try again.`)
    error.status = res.status
    error.payload = payload
    throw error
  }
  return payload
}

function settingsRequest(pathname, method, body) {
  // The guard (spec §6) requires application/json on EVERY non-GET, even the
  // body-less DELETEs — so the header rides along regardless of payload.
  const mutating = (method || 'GET').toUpperCase() !== 'GET'
  return settingsJson(pathname, {
    method,
    ...(mutating ? { headers: { 'content-type': 'application/json' } } : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

let settingsToastTimer = null
function settingsToast(message, action) {
  const box = $('settings-toast')
  if (!box) return
  box.innerHTML = `<span class="toast-msg">${esc(message)}</span>${action ? `<button class="toast-action" type="button" data-action="${esc(action.action)}">${esc(action.label)}</button>` : ''}`
  box.hidden = false
  clearTimeout(settingsToastTimer)
  settingsToastTimer = setTimeout(() => {
    box.hidden = true
  }, action ? 15000 : 5000)
}

async function refreshSettings() {
  await loadSettings().catch(() => {})
  await loadState().catch(() => {})
}

async function openSettings(tab) {
  if (tab) settingsUi.tab = tab
  const dialog = $('settings-dialog')
  renderSettingsTabs()
  if (dialog && !dialog.open) dialog.showModal()
  await loadSettings()
}

async function loadSettings() {
  try {
    settingsUi.data = await settingsJson('/api/settings')
    settingsUi.loadError = ''
  } catch (error) {
    settingsUi.data = null
    settingsUi.loadError = error.message
  }
  renderSettingsPanel()
}

function renderSettingsTabs() {
  document.querySelectorAll('.settings-tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.settingsTab === settingsUi.tab)
  })
  document.querySelectorAll('.settings-panel').forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== settingsUi.tab
  })
}

function renderSettingsPanel() {
  const panel = document.querySelector(`.settings-panel[data-settings-panel="${settingsUi.tab}"]`)
  if (!panel) return
  if (!settingsUi.data) {
    panel.innerHTML = `<div class="settings-section"><h3>Unavailable</h3><p class="settings-empty">${esc(settingsUi.loadError || 'Settings could not be loaded. Close the dialog and open it again.')}</p></div>`
    return
  }
  if (settingsUi.tab === 'general') renderGeneralPanel(panel, settingsUi.data)
  else if (settingsUi.tab === 'models') renderModelsPanel(panel, settingsUi.data)
  else if (settingsUi.tab === 'plugins') renderPluginsPanel(panel, settingsUi.data)
  else renderAgentPanel(panel, settingsUi.data)
}

function renderGeneralPanel(panel, data) {
  const general = data.general || {}
  const storage = general.storage || {}
  const modes = (data.supported && data.supported.approvalModes) || ['off', 'risky', 'all']
  panel.innerHTML = `
    <div class="settings-section">
      <h3>Operator</h3>
      <div class="settings-field">
        <label for="gen-approval">Approval mode</label>
        <select id="gen-approval" data-action="save-approval">
          ${modes.map((mode) => `<option value="${esc(mode)}" ${mode === general.approvalMode ? 'selected' : ''}>${esc(mode)}</option>`).join('')}
        </select>
        <span class="field-hint">When Switchboard must ask before a tool runs: off (never), risky (destructive commands), all (every tool).</span>
      </div>
      <div class="settings-status-row"><span>Language</span><span class="status-value">English</span></div>
      <div class="settings-status-row"><span>Account</span><span class="status-value">Not available — local console</span></div>
    </div>
    <div class="settings-section">
      <h3>Storage</h3>
      <dl class="settings-kv">
        <dt>Settings directory</dt><dd class="mono">${esc(storage.settingsDir || '')}</dd>
        <dt>Providers file</dt><dd class="mono">${esc(storage.providersFile || '')}</dd>
        <dt>Credentials file</dt><dd class="mono">${esc(storage.credentialsFile || '')}</dd>
        <dt>Session directory</dt><dd class="mono">${esc(storage.sessionDir || 'in memory')}</dd>
      </dl>
    </div>
    <div class="settings-section">
      <h3>API key precedence</h3>
      <ol class="plugin-settings-list">${(general.keyPrecedence || []).map((line) => `<li><span>${esc(line)}</span></li>`).join('')}</ol>
      <p class="settings-note">Keys are never shown in the browser — Switchboard only reports where the active key comes from.</p>
    </div>
    <div class="settings-section">
      <h3>Connection</h3>
      <div class="settings-status-row"><span>Default endpoint</span><span class="status-value mono">${esc(general.endpoint || '')}</span></div>
      <div class="settings-status-row"><span>Wire protocols</span><span class="status-value mono">${esc(((data.supported && data.supported.protocols) || []).join(', '))}</span></div>
    </div>`
}

/** Unique provider ids present in the union catalog (plus `default`). */
function catalogProviderIds(models) {
  const ids = []
  for (const model of models) {
    const id = model.provider || 'default'
    if (!ids.includes(id)) ids.push(id)
  }
  if (!ids.includes('default')) ids.push('default')
  return ids
}

function renderModelsPanel(panel, data) {
  const providers = data.providers || []
  const fallback = data.default || { provider: 'default', model: '' }
  const models = state.models || []
  const providerIds = catalogProviderIds(models)
  const providerLabel = (id) => {
    const entry = providers.find((p) => p.id === id)
    return entry ? entry.displayName : id === 'default' ? 'default (config)' : id
  }
  const modelsFor = (provider) => models.filter((model) => (model.provider || 'default') === provider)
  const modelOptions = (provider, selected) =>
    modelsFor(provider)
      .map((model) => `<option value="${esc(model.id)}" ${model.id === selected ? 'selected' : ''}>${esc(model.id)}</option>`)
      .join('')
  panel.innerHTML = `
    <div class="settings-section">
      <h3>Default model</h3>
      <p class="section-note">Used for new runs when the session has no model of its own.</p>
      <div class="default-row">
        <div class="settings-field"><label for="def-provider">Provider</label><select id="def-provider" data-action="def-provider-change">${providerIds
          .map((id) => `<option value="${esc(id)}" ${id === fallback.provider ? 'selected' : ''}>${esc(providerLabel(id))}</option>`)
          .join('')}</select></div>
        <div class="settings-field"><label for="def-model">Model</label><select id="def-model">${
          modelsFor(fallback.provider).length
            ? modelOptions(fallback.provider, fallback.model)
            : `<option value="${esc(fallback.model || '')}" selected>${esc(fallback.model || '— add a model first —')}</option>`
        }</select></div>
        <button class="settings-btn primary" type="button" data-action="save-default">Save default</button>
      </div>
    </div>
    <div class="settings-section">
      <div class="provider-card-top"><h3>Providers</h3><div class="provider-card-actions"><button type="button" class="settings-btn small primary" data-action="add-provider">+ Add provider</button></div></div>
      <p class="section-note">API keys stay on this computer (write-only file). The default provider comes from switchboard.config.jsonc.</p>
      ${settingsUi.editing ? providerFormHtml() : ''}
      <ul class="provider-cards">${providers.map(providerCardHtml).join('')}</ul>
      ${providers.length ? '' : '<p class="settings-empty">No providers yet.</p>'}
    </div>`
}

function providerFormHtml() {
  const editing = settingsUi.editing
  const entry = editing.entry
  const creating = editing.mode === 'create'
  const fieldError = (field) => {
    const hit = (editing.issues || []).find((issue) => issue.field === field)
    return hit ? `<span class="field-error">${esc(hit.message)}</span>` : ''
  }
  const serverError = editing.formError ? `<div class="form-errors">${esc(editing.formError)}</div>` : ''
  const candidates = editing.discovery || []
  return `
    <div class="provider-form" id="provider-form">
      <h4>${creating ? 'Add provider' : `Edit ${esc(entry.displayName || entry.id)}`}</h4>
      ${serverError}
      <div class="settings-grid-2">
        <div class="settings-field"><label for="pf-name">Display name</label>
          <input id="pf-name" type="text" data-field="displayName" value="${esc(entry.displayName || '')}" placeholder="My provider" maxlength="80">
          ${fieldError('displayName')}</div>
        <div class="settings-field"><label for="pf-id">Provider id ${creating ? '(optional)' : ''}</label>
          <input id="pf-id" type="text" data-field="id" value="${esc(entry.id || '')}" placeholder="auto from name" ${creating ? '' : 'disabled'}>
          <span class="field-hint">${creating ? 'Lowercase letters, digits, hyphens — immutable after creation.' : 'Id is immutable — create a new provider to change it.'}</span>
          ${fieldError('id')}</div>
        <div class="settings-field"><label for="pf-url">Base URL</label>
          <input id="pf-url" type="text" data-field="baseURL" value="${esc(entry.baseURL || '')}" placeholder="https://api.example.com/v1">
          ${fieldError('baseURL')}</div>
        <div class="settings-field"><label for="pf-protocol">Protocol</label>
          <select id="pf-protocol" data-field="protocol">${PROTOCOL_OPTIONS.map(
            (protocol) => `<option value="${esc(protocol)}" ${protocol === entry.protocol ? 'selected' : ''}>${esc(protocol)}</option>`,
          ).join('')}</select>
          ${fieldError('protocol')}</div>
        <div class="settings-field"><label for="pf-env">Key environment variable</label>
          <input id="pf-env" type="text" data-field="apiKeyEnv" value="${esc(entry.apiKeyEnv || '')}" placeholder="MY_PROVIDER_KEY">
          <span class="field-hint">Only the variable name is stored, never its value.</span>
          ${fieldError('apiKeyEnv')}</div>
        <div class="settings-field"><label for="pf-key">API key ${editing.mode === 'edit' ? '(leave blank to keep the stored key)' : ''}</label>
          <input id="pf-key" type="password" data-field="_apiKey" value="" placeholder="${editing.mode === 'edit' ? '••••••••' : 'sk-…'}" autocomplete="new-password">
          <span class="field-hint">Sent once when you save, then write-only in the local credential file.</span></div>
      </div>
      <div class="settings-actions">
        <button type="button" class="settings-btn primary" data-action="save-provider" ${editing.saving ? 'disabled' : ''}>${editing.saving ? 'Saving…' : 'Save provider'}</button>
        <button type="button" class="settings-btn ghost" data-action="cancel-provider">Cancel</button>
        <button type="button" class="settings-btn ghost" data-action="fetch-models" ${editing.fetching ? 'disabled' : ''}>${editing.fetching ? 'Fetching…' : 'Fetch models'}</button>
        <span class="field-hint">Fetch probes the Base URL without saving — the key travels with this request only.</span>
      </div>
      ${
        candidates.length
          ? `<ul class="discovery-results">${candidates
              .map(
                (candidate, index) => `<li class="${candidate.status}">
                <input type="checkbox" data-action="candidate-check" data-index="${index}" ${candidate.status === 'new' && candidate.checked !== false ? 'checked' : ''} ${candidate.status === 'dup' ? 'disabled' : ''} aria-label="Add ${esc(candidate.id)}">
                <code>${esc(candidate.id)}</code>
                ${candidate.context ? `<span class="candidate-status">${Number(candidate.context).toLocaleString()} ctx</span>` : ''}
                <span class="candidate-status">${candidate.status === 'dup' ? 'already in catalog' : 'new'}</span>
              </li>`,
              )
              .join('')}</ul>
            <div class="settings-actions"><button type="button" class="settings-btn ghost" data-action="add-candidates">Add selected to catalog</button></div>`
          : ''
      }
    </div>`
}

function providerCardHtml(entry) {
  const credential = entry.credential || {}
  const isDefault = entry.source === 'config' || entry.id === 'default'
  const open = Boolean(settingsUi.catalog && settingsUi.catalog.id === entry.id)
  const pending = settingsUi.pendingDelete === entry.id
  const clientSessions = (state.sessions || []).filter((session) => session.provider === entry.id)
  const sessionList = settingsUi.deleteSessions || clientSessions
  const recovery = pending
    ? deleteRecoveryCopy(entry, sessionList, (settingsUi.data && settingsUi.data.default) || null)
    : null
  return `
    <li class="provider-card" data-provider="${esc(entry.id)}">
      <div class="provider-card-top">
        <strong>${esc(entry.displayName)}</strong>
        <span class="protocol-badge">${esc(entry.protocol)}</span>
        <span class="credential-chip ${credential.configured ? 'ok' : 'missing'}" title="Key source">${esc(credentialSourceLabel(credential))}</span>
        <span class="model-count">${Number(entry.modelCount || 0)} models</span>
        <span class="provider-url" title="${esc(entry.baseURL)}">${esc(entry.baseURL)}</span>
        <div class="provider-card-actions">
          ${
            isDefault
              ? '<span class="model-count">Live endpoint catalog</span>'
              : `<button type="button" class="settings-btn small ghost" data-action="toggle-catalog" data-id="${esc(entry.id)}">${open ? 'Hide models' : `Models (${Number(entry.modelCount || 0)})`}</button>
                 <button type="button" class="settings-btn small ghost" data-action="edit-provider" data-id="${esc(entry.id)}">Edit</button>
                 <button type="button" class="settings-btn small danger" data-action="delete-provider" data-id="${esc(entry.id)}">Delete</button>`
          }
        </div>
      </div>
      <div class="model-add-row" style="border-top:0;padding-top:6px;margin-top:8px">
        <input type="password" class="pc-key" placeholder="API key (write-only)" autocomplete="new-password" aria-label="API key for ${esc(entry.displayName)}">
        <button type="button" class="settings-btn small primary" data-action="save-credential" data-id="${esc(entry.id)}">Save key</button>
        ${credential.source === 'local' ? `<button type="button" class="settings-btn small ghost" data-action="clear-credential" data-id="${esc(entry.id)}">Clear key</button>` : ''}
        ${credential.source === 'env' ? '<span class="candidate-status">Environment variable wins while it is set.</span>' : ''}
        ${isDefault && !credential.configured ? '<span class="candidate-status">Falls back to config/legacy key.</span>' : ''}
      </div>
      ${
        recovery
          ? `<div class="delete-recovery">
              <h4>${esc(recovery.title)}</h4>
              <p>${esc(recovery.body)}</p>
              <div class="settings-actions">
                <button type="button" class="settings-btn danger" data-action="confirm-delete" data-id="${esc(entry.id)}">${esc(recovery.confirm)}</button>
                <button type="button" class="settings-btn ghost" data-action="cancel-delete">Cancel</button>
              </div>
            </div>`
          : ''
      }
      ${open ? catalogHtml(entry) : ''}
    </li>`
}

function catalogHtml(entry) {
  const catalog = settingsUi.catalog || { id: entry.id, models: [] }
  const query = settingsUi.query.trim().toLowerCase()
  const visible = (model) => !query || String(model.id).toLowerCase().includes(query) || String(model.displayName || '').toLowerCase().includes(query)
  const cap = (model, key) => Boolean(model.inputs && model.inputs[key] === true)
  return `
    <div class="catalog" data-catalog="${esc(entry.id)}">
      <div class="model-toolbar">
        <input type="search" class="pm-search" data-action="filter-models" data-id="${esc(entry.id)}" value="${esc(settingsUi.query)}" placeholder="Search ${catalog.models.length} models" aria-label="Search models">
        <span class="model-count">${catalog.models.filter(visible).length} / ${catalog.models.length} shown</span>
      </div>
      <ul class="model-rows">${catalog.models
        .map(
          (model, index) => `<li class="model-row" data-model-id="${esc(model.id)}" ${visible(model) ? '' : 'hidden'}>
          <span class="model-id" title="${esc(model.id)}">${esc(model.id)}</span>
          <span class="model-meta">${esc(model.displayName || '')}${model.context ? ` · ${Number(model.context).toLocaleString()} ctx` : ''}${model.maxOutput ? ` · ${model.maxOutput} out` : ''}${model.manual ? ' · manual' : ''}</span>
          <span class="cap-toggles">
            <label><input type="checkbox" data-action="toggle-cap" data-index="${index}" data-cap="tools" ${cap(model, 'tools') ? 'checked' : ''}> tools</label>
            <label><input type="checkbox" data-action="toggle-cap" data-index="${index}" data-cap="vision" ${cap(model, 'vision') ? 'checked' : ''}> vision</label>
            <label><input type="checkbox" data-action="toggle-cap" data-index="${index}" data-cap="reasoning" ${cap(model, 'reasoning') ? 'checked' : ''}> reasoning</label>
          </span>
          <button type="button" class="settings-btn small danger remove-model" data-action="remove-model" data-index="${index}" data-id="${esc(entry.id)}">Remove</button>
        </li>`,
        )
        .join('')}</ul>
      <div class="model-add-row">
        <input type="text" class="pm-new-id" placeholder="model id (exact)" aria-label="New model id">
        <input type="text" class="pm-new-name" placeholder="display name" aria-label="New model display name">
        <input type="number" class="pm-new-context" placeholder="context" min="1" aria-label="New model context">
        <input type="number" class="pm-new-output" placeholder="max output" min="1" aria-label="New model max output">
        <button type="button" class="settings-btn small ghost" data-action="add-model" data-id="${esc(entry.id)}">Add model</button>
      </div>
      <div class="settings-actions">
        <button type="button" class="settings-btn primary" data-action="save-catalog" data-id="${esc(entry.id)}">Save catalog</button>
        <span class="field-hint">Nothing is written until you save.</span>
      </div>
    </div>`
}

function renderPluginsPanel(panel, data) {
  const capabilities = state.pluginCapabilities || []
  const mcp = data.mcp || {}
  const servers = mcp.servers
  panel.innerHTML = `
    <div class="settings-section">
      <h3>Capabilities</h3>
      <ul class="plugin-settings-list">${capabilities
        .map(
          (capability) => `<li><span>${esc(capability.name)}</span><span class="status-value">${(capability.tools || []).length} tools · ${esc(capability.health || 'ready')}</span></li>`,
        )
        .join('') || '<li>No capabilities loaded.</li>'}</ul>
      <p class="settings-note">Capabilities come from the plugins loaded by this console — enable or disable them in the repo config, then restart sbx web.</p>
    </div>
    <div class="settings-section">
      <h3>MCP servers</h3>
      ${
        mcp.configured === false
          ? '<p class="settings-empty">No MCP servers configured.</p>'
          : servers
            ? `<ul class="plugin-settings-list">${servers
                .map(
                  (server) => `<li><span>${esc(server.name)}</span><span class="status-value">${esc(server.state)}${server.attempts ? ` · ${server.attempts} attempts` : ''}</span></li>`,
                )
                .join('') || '<li>No MCP servers configured.</li>'}</ul>`
            : '<p class="settings-empty">MCP status is unavailable right now.</p>'
      }
      <p class="settings-note">Servers are declared under mcp.servers in switchboard.config.jsonc — restart sbx web after editing. This tab is read-only.</p>
    </div>`
}

function renderAgentPanel(panel, data) {
  const agent = data.agent || {}
  panel.innerHTML = `
    <div class="settings-section">
      <h3>Agent</h3>
      <dl class="settings-kv">
        <dt>Max steps per run</dt><dd>${esc(String(agent.maxSteps ?? 8))}</dd>
        <dt>Temperature</dt><dd>${agent.temperature !== undefined ? esc(String(agent.temperature)) : 'default'}</dd>
        <dt>Max prompt tokens</dt><dd>${esc(String(agent.maxPromptTokens ?? 96000))}</dd>
        <dt>Keep recent messages</dt><dd>${esc(String(agent.keepRecent ?? 4))}</dd>
        <dt>System prompt</dt><dd>${esc(agent.systemSource || 'default')}</dd>
      </dl>
      <p class="settings-note">These values come from the agent block in switchboard.config.jsonc — edit the file and restart sbx web to change them. This tab is read-only for now.</p>
    </div>
    <div class="settings-section">
      <h3>Run approval</h3>
      <div class="settings-status-row"><span>Current mode</span><span class="status-value">${esc((data.general && data.general.approvalMode) || 'risky')}</span></div>
      <p class="settings-note">Change approval mode under Settings → General.</p>
    </div>`
}

function readProviderForm() {
  const editing = settingsUi.editing
  if (!editing) return null
  const entry = editing.entry
  return {
    displayName: typeof entry.displayName === 'string' ? entry.displayName.trim() : '',
    id: typeof entry.id === 'string' ? entry.id.trim() : '',
    baseURL: typeof entry.baseURL === 'string' ? entry.baseURL.trim() : '',
    protocol: entry.protocol,
    apiKeyEnv: typeof entry.apiKeyEnv === 'string' ? entry.apiKeyEnv.trim() : '',
  }
}

function startProviderEdit(mode, entry) {
  settingsUi.editing = {
    mode,
    entry: entry ? { ...entry } : { id: '', displayName: '', baseURL: '', protocol: PROTOCOL_OPTIONS[0], apiKeyEnv: '' },
    models: entry && entry.__models ? [...entry.__models] : [],
    apiKeyDraft: '',
    discovery: [],
    issues: [],
    formError: '',
    fetching: false,
    saving: false,
  }
}

async function handleSettingsAction(action, element, event) {
  const editing = settingsUi.editing
  try {
    if (action === 'add-provider') {
      startProviderEdit('create', null)
      renderSettingsPanel()
      document.getElementById('pf-name')?.focus()
      return
    }
    if (action === 'cancel-provider') {
      settingsUi.editing = null
      renderSettingsPanel()
      return
    }
    if (action === 'edit-provider') {
      const id = element.dataset.id
      const provider = (settingsUi.data.providers || []).find((entry) => entry.id === id)
      if (!provider) return
      const models = await settingsJson(`/api/settings/providers/${encodeURIComponent(id)}/models`)
      startProviderEdit('edit', { ...provider, __models: models.models || [] })
      settingsUi.editing.models = models.models || []
      delete settingsUi.editing.entry.__models
      renderSettingsPanel()
      document.getElementById('pf-name')?.focus()
      return
    }
    if (action === 'save-provider' && editing) {
      const form = readProviderForm()
      const issues = validateProviderForm(form)
      if (issues.length) {
        editing.issues = issues
        editing.formError = ''
        renderSettingsPanel()
        return
      }
      editing.issues = []
      editing.formError = ''
      editing.saving = true
      renderSettingsPanel()
      const wasMode = editing.mode
      const providerId = editing.entry.id
      try {
        let saved
        if (wasMode === 'create') {
          saved = await settingsRequest('/api/settings/providers', 'POST', {
            displayName: form.displayName,
            ...(form.id ? { id: form.id } : {}),
            baseURL: form.baseURL,
            protocol: form.protocol,
            ...(form.apiKeyEnv ? { apiKeyEnv: form.apiKeyEnv } : {}),
            ...(editing.models.length ? { models: editing.models } : {}),
          })
          if (editing.apiKeyDraft) await settingsRequest(`/api/settings/providers/${encodeURIComponent(saved.id)}/credential`, 'PUT', { apiKey: editing.apiKeyDraft })
        } else {
          saved = await settingsRequest(`/api/settings/providers/${encodeURIComponent(providerId)}`, 'PUT', {
            displayName: form.displayName,
            baseURL: form.baseURL,
            protocol: form.protocol,
            apiKeyEnv: form.apiKeyEnv,
          })
          await settingsRequest(`/api/settings/providers/${encodeURIComponent(providerId)}/models`, 'PUT', { models: editing.models })
          if (editing.apiKeyDraft) await settingsRequest(`/api/settings/providers/${encodeURIComponent(providerId)}/credential`, 'PUT', { apiKey: editing.apiKeyDraft })
        }
        settingsUi.editing = null
        await refreshSettings()
        settingsToast(`Provider "${saved.displayName}" saved.`)
      } catch (error) {
        editing.saving = false
        editing.formError = error.message
        renderSettingsPanel()
      }
      return
    }
    if (action === 'fetch-models' && editing) {
      const form = readProviderForm()
      const probeIssues = validateProviderForm({ displayName: 'draft', baseURL: form.baseURL, protocol: form.protocol })
      if (probeIssues.length) {
        editing.issues = probeIssues
        renderSettingsPanel()
        return
      }
      editing.fetching = true
      editing.formError = ''
      renderSettingsPanel()
      try {
        const result = await settingsRequest('/api/settings/discover', 'POST', {
          baseURL: form.baseURL,
          protocol: form.protocol,
          ...(editing.apiKeyDraft ? { apiKey: editing.apiKeyDraft } : {}),
        })
        const existing = editing.models.map((model) => model.id)
        editing.discovery = diffDiscovery(existing, result.models || []).map((candidate) => ({ ...candidate, checked: candidate.status === 'new' }))
        if (!editing.discovery.length) editing.formError = 'The endpoint returned no models. Add one by hand below after saving.'
      } catch (error) {
        editing.formError = error.message
      } finally {
        editing.fetching = false
        renderSettingsPanel()
      }
      return
    }
    if (action === 'add-candidates' && editing) {
      const picked = editing.discovery.filter((candidate) => candidate.status === 'new' && candidate.checked !== false)
      for (const candidate of picked) {
        if (!editing.models.some((model) => model.id === candidate.id)) {
          editing.models.push({
            id: candidate.id,
            ...(candidate.displayName ? { displayName: candidate.displayName } : {}),
            ...(candidate.context ? { context: candidate.context } : {}),
            ...(candidate.maxOutput ? { maxOutput: candidate.maxOutput } : {}),
            ...(candidate.inputs ? { inputs: candidate.inputs } : {}),
          })
        }
      }
      editing.discovery = []
      renderSettingsPanel()
      settingsToast(`${picked.length} model${picked.length === 1 ? '' : 's'} staged — save the provider to keep them.`)
      return
    }
    if (action === 'toggle-catalog') {
      const id = element.dataset.id
      if (settingsUi.catalog && settingsUi.catalog.id === id) {
        settingsUi.catalog = null
        settingsUi.query = ''
      } else {
        const models = await settingsJson(`/api/settings/providers/${encodeURIComponent(id)}/models`)
        settingsUi.catalog = { id, models: models.models || [] }
        settingsUi.query = ''
      }
      renderSettingsPanel()
      return
    }
    if (action === 'add-model') {
      const id = element.dataset.id
      const card = document.querySelector(`.provider-card[data-provider="${id}"]`)
      const catalog = settingsUi.catalog
      if (!card || !catalog || catalog.id !== id) return
      const modelId = card.querySelector('.pm-new-id')?.value.trim() || ''
      if (!modelId) {
        settingsToast('Model id is required — enter the exact id the endpoint expects.')
        return
      }
      if (catalog.models.some((model) => model.id === modelId)) {
        settingsToast(`Model "${modelId}" is already in the catalog.`)
        return
      }
      const displayName = card.querySelector('.pm-new-name')?.value.trim() || ''
      const context = Number(card.querySelector('.pm-new-context')?.value) || undefined
      const maxOutput = Number(card.querySelector('.pm-new-output')?.value) || undefined
      catalog.models.push({
        id: modelId,
        ...(displayName ? { displayName } : {}),
        ...(context ? { context } : {}),
        ...(maxOutput ? { maxOutput } : {}),
        manual: true,
      })
      renderSettingsPanel()
      document.querySelector(`.provider-card[data-provider="${id}"] .pm-new-id`)?.focus()
      return
    }
    if (action === 'remove-model') {
      const catalog = settingsUi.catalog
      if (!catalog) return
      catalog.models.splice(Number(element.dataset.index), 1)
      renderSettingsPanel()
      return
    }
    if (action === 'save-catalog') {
      const id = element.dataset.id
      const catalog = settingsUi.catalog
      if (!catalog || catalog.id !== id) return
      const result = await settingsRequest(`/api/settings/providers/${encodeURIComponent(id)}/models`, 'PUT', { models: catalog.models })
      catalog.models = result.models || catalog.models
      const provider = (settingsUi.data.providers || []).find((entry) => entry.id === id)
      if (provider) provider.modelCount = catalog.models.length
      await refreshSettings()
      settingsToast(`Catalog saved — ${catalog.models.length} model${catalog.models.length === 1 ? '' : 's'}.`)
      return
    }
    if (action === 'save-credential') {
      const id = element.dataset.id
      const card = element.closest('.provider-card')
      const value = card?.querySelector('.pc-key')?.value || ''
      if (!value) {
        settingsToast('Enter an API key first — existing keys are never shown back.')
        return
      }
      await settingsRequest(`/api/settings/providers/${encodeURIComponent(id)}/credential`, 'PUT', { apiKey: value })
      await refreshSettings()
      settingsToast('API key stored in the local credential file (write-only).')
      return
    }
    if (action === 'clear-credential') {
      const id = element.dataset.id
      await settingsRequest(`/api/settings/providers/${encodeURIComponent(id)}/credential`, 'DELETE')
      await refreshSettings()
      settingsToast('Stored API key cleared. The env variable (if set) still applies.')
      return
    }
    if (action === 'delete-provider') {
      settingsUi.pendingDelete = element.dataset.id
      settingsUi.deleteSessions = null
      settingsUi.forceNext = false
      renderSettingsPanel()
      document.querySelector('.delete-recovery .settings-btn.danger')?.focus()
      return
    }
    if (action === 'cancel-delete') {
      settingsUi.pendingDelete = null
      settingsUi.deleteSessions = null
      settingsUi.forceNext = false
      renderSettingsPanel()
      return
    }
    if (action === 'confirm-delete') {
      const id = element.dataset.id
      const force = settingsUi.forceNext || Boolean(settingsUi.deleteSessions) || (state.sessions || []).some((session) => session.provider === id)
      try {
        const result = await settingsRequest(`/api/settings/providers/${encodeURIComponent(id)}${force ? '?force=1' : ''}`, 'DELETE')
        settingsUi.lastDeleted = result.deleted
        settingsUi.pendingDelete = null
        settingsUi.deleteSessions = null
        settingsUi.forceNext = false
        await refreshSettings()
        settingsToast(
          `Provider "${result.deleted.displayName}" deleted.${result.detachedSessions ? ` ${result.detachedSessions} session${result.detachedSessions === 1 ? '' : 's'} detached to ${result.fallback.provider}.` : ''}`,
          { label: 'Undo', action: 'undo-delete' },
        )
      } catch (error) {
        if (error.status === 409 && error.payload && error.payload.inUse) {
          settingsUi.deleteSessions = error.payload.inUse.sessions || []
          settingsUi.forceNext = true
          renderSettingsPanel()
          settingsToast('This provider is in use — confirm again to detach those sessions.')
          return
        }
        settingsUi.pendingDelete = null
        renderSettingsPanel()
        settingsToast(error.message)
      }
      return
    }
    if (action === 'undo-delete') {
      const deleted = settingsUi.lastDeleted
      if (!deleted) return
      await settingsRequest('/api/settings/providers', 'POST', {
        id: deleted.id,
        displayName: deleted.displayName,
        baseURL: deleted.baseURL,
        protocol: deleted.protocol,
        ...(deleted.headers ? { headers: deleted.headers } : {}),
        ...(deleted.apiKeyEnv ? { apiKeyEnv: deleted.apiKeyEnv } : {}),
        ...(Array.isArray(deleted.models) ? { models: deleted.models } : {}),
      })
      settingsUi.lastDeleted = null
      await refreshSettings()
      settingsToast(`Provider "${deleted.displayName}" restored.`)
      return
    }
    if (action === 'save-default') {
      const provider = document.getElementById('def-provider')?.value || 'default'
      const model = document.getElementById('def-model')?.value || ''
      await settingsRequest('/api/settings/default', 'PUT', { provider, model })
      await refreshSettings()
      settingsToast(`Default set to ${provider} · ${model || 'live catalog default'}.`)
      return
    }
    if (action === 'save-approval') {
      const approvalMode = element.value
      await settingsRequest('/api/settings/general', 'PUT', { approvalMode })
      await loadState().catch(() => {})
      await loadSettings().catch(() => {})
      settingsToast(`Approval mode is now "${approvalMode}".`)
      return
    }
    if (action === 'def-provider-change') {
      const provider = element.value
      const modelSelect = document.getElementById('def-model')
      const currentDefault = (settingsUi.data && settingsUi.data.default) || {}
      const options = (state.models || []).filter((model) => (model.provider || 'default') === provider)
      if (modelSelect) {
        modelSelect.innerHTML = options
          .map((model) => `<option value="${esc(model.id)}" ${model.id === currentDefault.model && provider === currentDefault.provider ? 'selected' : ''}>${esc(model.id)}</option>`)
          .join('')
        if (!options.length) {
          const keep = provider === currentDefault.provider && currentDefault.model
          modelSelect.innerHTML = `<option value="${esc(keep ? currentDefault.model : '')}" selected>${esc(keep ? currentDefault.model : '— add a model first —')}</option>`
        }
      }
      return
    }
  } catch (error) {
    settingsToast(error.message || 'Settings update failed. Try again.')
  }
}

$('btn-settings')?.addEventListener('click', () => void openSettings())

$('settings-dialog')?.addEventListener('click', (event) => {
  const tabButton = event.target.closest('.settings-tab')
  if (tabButton) {
    settingsUi.tab = tabButton.dataset.settingsTab
    renderSettingsTabs()
    renderSettingsPanel()
    return
  }
  const button = event.target.closest('[data-action]')
  if (!button || button.tagName !== 'BUTTON' || !$('settings-dialog').contains(button)) return
  void handleSettingsAction(button.dataset.action, button, event)
})

$('settings-dialog')?.addEventListener('change', (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  if (target.matches('[data-field]') && settingsUi.editing) {
    const field = target.dataset.field
    if (field === '_apiKey') settingsUi.editing.apiKeyDraft = target.value
    else settingsUi.editing.entry[field] = target.value
    return
  }
  const control = target.closest('[data-action]')
  if (!control || control.tagName === 'BUTTON' || !$('settings-dialog').contains(control)) return
  const action = control.dataset.action
  if (action === 'candidate-check' && settingsUi.editing) {
    const candidate = settingsUi.editing.discovery[Number(control.dataset.index)]
    if (candidate) candidate.checked = control.checked
    return
  }
  if (action === 'toggle-cap' && settingsUi.catalog) {
    const model = settingsUi.catalog.models[Number(control.dataset.index)]
    if (model) {
      model.inputs = { ...(model.inputs || {}), [control.dataset.cap]: control.checked }
    }
    return
  }
  void handleSettingsAction(action, control, event)
})

$('settings-dialog')?.addEventListener('input', (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  if (target.matches('[data-field]') && settingsUi.editing) {
    const field = target.dataset.field
    if (field === '_apiKey') settingsUi.editing.apiKeyDraft = target.value
    else settingsUi.editing.entry[field] = target.value
    return
  }
  if (!target.matches('[data-action="filter-models"]')) return
  settingsUi.query = target.value
  const query = settingsUi.query.trim().toLowerCase()
  const card = target.closest('[data-catalog]') || document.querySelector('[data-catalog]')
  if (!card) return
  let shown = 0
  card.querySelectorAll('.model-row').forEach((row) => {
    const match = !query || String(row.dataset.modelId || '').toLowerCase().includes(query) || row.textContent.toLowerCase().includes(query)
    row.hidden = !match
    if (match) shown += 1
  })
  const count = card.querySelector('.model-toolbar .model-count')
  const total = settingsUi.catalog ? settingsUi.catalog.models.length : shown
  if (count) count.textContent = `${shown} / ${total} shown`
})

// Guide contains instructions only: keys are never collected in the browser.
const setupGuide = $('getting-started')
dockComposer()
$('btn-guide').addEventListener('click', () => setupGuide.showModal())
$('btn-setup').addEventListener('click', () => setupGuide.showModal())
function showConnectionNotice(message) {
  $('connection-message').textContent = message
  $('connection-notice').hidden = !message
}
async function reconnect() {
  const button = $('btn-reconnect')
  button.disabled = true
  button.textContent = 'Checking…'
  try {
    await loadState()
    setStatus('idle', 'Ready')
  } catch {
    showConnectionNotice('Cannot connect to Switchboard. Make sure sbx web is running, then check the connection again.')
    setStatus('error', 'Disconnected')
  } finally {
    button.disabled = false
    button.textContent = 'Check connection'
  }
}
$('btn-reconnect').addEventListener('click', reconnect)

loadState()
  .then(async (data) => {
    setStatus('idle', 'Ready')
    void loadFiles('.')
    const resume = wantedSession(data.sessions || [])
    if (resume) await openSession(resume)
    ui.prompt.focus()
  })
  .catch(() => {
    setStatus('error', 'Disconnected')
    showConnectionNotice('Cannot connect to Switchboard. Make sure sbx web is running, then check the connection again.')
  })
