/**
 * Protocol adapters for the settings provider registry (spec §5).
 *
 * Exactly three tested wire protocols:
 *   - `openai-chat`          POST {base}/chat/completions (today's OpenAI SSE shape)
 *   - `openai-responses`     POST {base}/responses         (OpenAI Responses stream)
 *   - `anthropic-messages`   POST {base}/v1/messages       (Anthropic SSE)
 *
 * Contract:
 *   buildRequest(profile, opts)      -> { url, headers, body }
 *   parseStream(res, profile)        -> AsyncGenerator<LLMEvent, ParseSummary>
 *   adapterError(providerId, status) -> Error with HTTP status + recovery hint
 *
 * `ProviderProfile` is a per-request snapshot (hot-apply, spec §7): retries and
 * the whole stream use the snapshot taken at request start, so a settings save
 * during the run cannot change endpoint or credentials mid-flight.
 */
import type { AgentMessage, LLMEvent, ToolCall, ToolDef, Usage } from '../types.js'
import type { Protocol } from '../services/providers.js'

export type AdapterName = Protocol

/** Snapshot of one provider taken at request start (spec §7). */
export interface ProviderProfile {
  id: string
  displayName?: string
  baseURL: string
  protocol: Protocol
  headers?: Record<string, string>
  /** Resolved secret — never persisted, never returned by any API. */
  apiKey?: string
  extraBody?: Record<string, unknown>
  contextCatalogUrl?: string
}

export interface AdapterRequestOpts {
  model: string
  messages: AgentMessage[]
  tools?: ToolDef[]
  temperature?: number
  maxTokens?: number
}

export interface AdapterRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** Final accumulated state handed back when the stream generator returns. */
export interface ParseSummary {
  content: string
  reasoning: string
  toolCalls: ToolCall[]
  finishReason?: string
  usage: Usage
}

export type { LLMEvent }

const ANTHROPIC_VERSION = '2023-06-01'

/**
 * Splits a streamed `content` string into answer text and inline reasoning.
 *
 * Some OpenAI-compatible models (gpt-oss, ling, ...) inline their chain of
 * thought as `<think>...</think>` / `<thinking>` / `<reasoning>` blocks inside
 * `content` instead of using a separate `reasoning_content` field. This keeps a
 * tail buffer so a tag straddling two SSE chunks is still detected.
 *
 * (Lives here so `services/llm.ts` and the adapters share one implementation
 * without an import cycle; `llm.ts` re-exports it for compatibility.)
 */
export class InlineReasoningSplitter {
  private readonly open: string[]
  private readonly close: string[]
  private readonly tail: number
  private inThink = false
  private hold = ''

  constructor(names: string[] = ['think', 'thinking', 'reasoning']) {
    this.open = names.map((name) => '<' + name + '>')
    this.close = names.map((name) => '</' + name + '>')
    this.tail = Math.max(...this.open.map((tag) => tag.length - 1))
  }

  push(chunk: string): Piece[] {
    return this.split(chunk, false)
  }

  /** Flushes buffered text (an unterminated think block stays reasoning). */
  flush(): Piece[] {
    return this.split('', true)
  }

  private split(chunk: string, final: boolean): Piece[] {
    const out: Piece[] = []
    this.hold += chunk
    for (;;) {
      const tags = this.inThink ? this.close : this.open
      let idx = -1
      let found = ''
      for (const tag of tags) {
        const at = this.hold.indexOf(tag)
        if (at >= 0 && (idx < 0 || at < idx)) {
          idx = at
          found = tag
        }
      }
      if (idx < 0) {
        const keep = final ? 0 : this.tail
        if (this.hold.length > keep) {
          const head = this.hold.slice(0, this.hold.length - keep)
          this.hold = this.hold.slice(this.hold.length - keep)
          if (head) out.push({ kind: this.inThink ? 'think' : 'text', text: head })
        }
        break
      }
      if (idx > 0) out.push({ kind: this.inThink ? 'think' : 'text', text: this.hold.slice(0, idx) })
      this.hold = this.hold.slice(idx + found.length)
      this.inThink = !this.inThink
    }
    return out
  }
}

export type Piece = { kind: 'text' | 'think'; text: string }

/**
 * Every adapter failure becomes an Error carrying the provider id, HTTP status
 * and a recovery hint naming where to fix it (spec §5 "Errors").
 */
export function adapterError(providerId: string, status: number, body = ''): Error {
  const detail = body.trim().replace(/\s+/g, ' ').slice(0, 300)
  const hint =
    status === 401 || status === 403
      ? 'Check the API key in Settings → Models, then retry.'
      : status === 404
        ? 'Check the Base URL in Settings → Models (the endpoint path was not found).'
        : status === 429
          ? 'Rate limited — wait a moment and retry, or pick another provider in Settings → Models.'
          : status >= 500 || status === 0
            ? 'The provider is unavailable — retry later or pick another provider in Settings → Models.'
            : 'Review the provider in Settings → Models, then retry.'
  const where = status ? `HTTP ${status}` : 'stream error'
  return new Error(`provider "${providerId}": ${where}${detail ? ` — ${detail}` : ''} ${hint}`)
}

/** Auth + protocol headers shared by requests and discovery GETs. */
export function authHeaders(profile: ProviderProfile): Record<string, string> {
  const headers: Record<string, string> = {}
  if (profile.protocol === 'anthropic-messages') {
    if (profile.apiKey) headers['x-api-key'] = profile.apiKey
    headers['anthropic-version'] = ANTHROPIC_VERSION
  } else if (profile.apiKey) {
    headers.authorization = `Bearer ${profile.apiKey}`
  }
  return headers
}

function stripTrailingSlash(base: string): string {
  return base.replace(/\/+$/, '')
}

/** Anthropic paths always live under `/v1` — never emit `/v1/v1/...`. */
function anthropicUrl(base: string, suffix: '/messages' | '/models'): string {
  return `${stripTrailingSlash(base).replace(/\/v1$/, '')}/v1${suffix}`
}

// ------------------------------------------------------------ conversions

function openAIChatMessages(messages: AgentMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role !== 'user' || !message.attachments?.length) return message
    return {
      role: message.role,
      content: [
        { type: 'text', text: message.content },
        ...message.attachments.map((attachment) => ({
          type: 'image_url',
          image_url: { url: attachment.dataUrl },
        })),
      ],
    }
  })
}

function responsesMessages(messages: AgentMessage[]): { instructions?: string; input: unknown[] } {
  const system: string[] = []
  const input: unknown[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content) system.push(message.content)
      continue
    }
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id ?? '', output: message.content })
      continue
    }
    if (message.role === 'assistant') {
      if (message.content) input.push({ role: 'assistant', content: [{ type: 'output_text', text: message.content }] })
      for (const call of message.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments })
      }
      continue
    }
    input.push({
      role: 'user',
      content: [
        { type: 'input_text', text: message.content },
        ...(message.attachments ?? []).map((attachment) => ({ type: 'input_image', image_url: attachment.dataUrl })),
      ],
    })
  }
  return { ...(system.length ? { instructions: system.join('\n\n') } : {}), input }
}

function parseDataUrl(dataUrl: string): { mediaType: string; data: string } {
  const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(dataUrl)
  if (!match) return { mediaType: 'application/octet-stream', data: dataUrl.replace(/^.*?,/, '') }
  return { mediaType: match[1] || 'application/octet-stream', data: match[2] }
}

function safeJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function anthropicMessages(messages: AgentMessage[]): { system?: string; messages: Array<{ role: 'user' | 'assistant'; content: unknown[] }> } {
  const system: string[] = []
  const out: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = []
  // Anthropic requires strict user/assistant alternation: consecutive messages
  // of one role are merged into a single message (spec §5).
  const push = (role: 'user' | 'assistant', block: unknown): void => {
    const last = out[out.length - 1]
    if (last && last.role === role) last.content.push(block)
    else out.push({ role, content: [block] })
  }
  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content) system.push(message.content)
      continue
    }
    if (message.role === 'tool') {
      push('user', { type: 'tool_result', tool_use_id: message.tool_call_id ?? '', content: message.content })
      continue
    }
    if (message.role === 'assistant') {
      if (message.content) push('assistant', { type: 'text', text: message.content })
      for (const call of message.tool_calls ?? []) {
        push('assistant', { type: 'tool_use', id: call.id, name: call.function.name, input: safeJsonObject(call.function.arguments) })
      }
      continue
    }
    if (message.content) push('user', { type: 'text', text: message.content })
    for (const attachment of message.attachments ?? []) {
      const { mediaType, data } = parseDataUrl(attachment.dataUrl)
      push('user', { type: 'image', source: { type: 'base64', media_type: mediaType, data } })
    }
  }
  return { ...(system.length ? { system: system.join('\n\n') } : {}), messages: out }
}

// ------------------------------------------------------------ buildRequest

/** Builds the wire request for one protocol (spec §5 shared contract). */
export function buildRequest(profile: ProviderProfile, opts: AdapterRequestOpts): AdapterRequest {
  const base = stripTrailingSlash(profile.baseURL)
  const common: Record<string, unknown> = {
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.tools && opts.tools.length ? { tools: opts.tools } : {}),
    ...(profile.extraBody || {}),
  }

  if (profile.protocol === 'openai-responses') {
    const { instructions, input } = responsesMessages(opts.messages)
    const body: Record<string, unknown> = {
      model: opts.model,
      stream: true,
      ...(instructions ? { instructions } : {}),
      input,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { max_output_tokens: opts.maxTokens } : {}),
      ...(opts.tools && opts.tools.length
        ? {
            tools: opts.tools.map((tool) => ({
              type: 'function',
              name: tool.function.name,
              description: tool.function.description,
              parameters: tool.function.parameters,
            })),
          }
        : {}),
      ...(profile.extraBody || {}),
    }
    return {
      url: `${base}/responses`,
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(profile.headers || {}), ...authHeaders(profile) },
      body,
    }
  }

  if (profile.protocol === 'anthropic-messages') {
    const { system, messages } = anthropicMessages(opts.messages)
    const body: Record<string, unknown> = {
      model: opts.model,
      stream: true,
      // Anthropic requires max_tokens; default keeps unset requests legal (spec §5).
      max_tokens: opts.maxTokens ?? 4096,
      ...(system ? { system } : {}),
      messages,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.tools && opts.tools.length
        ? {
            tools: opts.tools.map((tool) => ({
              name: tool.function.name,
              description: tool.function.description,
              input_schema: tool.function.parameters,
            })),
          }
        : {}),
      ...(profile.extraBody || {}),
    }
    return {
      url: anthropicUrl(base, '/messages'),
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(profile.headers || {}), ...authHeaders(profile) },
      body,
    }
  }

  // openai-chat — today's shape (llm.ts) behind the interface.
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: openAIChatMessages(opts.messages),
    stream: true,
    // Ask for the trailing usage frame; providers that ignore it are unaffected.
    stream_options: { include_usage: true },
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    ...(opts.tools && opts.tools.length ? { tool_choice: 'auto' } : {}),
    ...common,
  }
  return {
    url: `${base}/chat/completions`,
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(profile.headers || {}), ...authHeaders(profile) },
    body,
  }
}

// ------------------------------------------------------------ parseStream

/** Reads `data:` payloads from an SSE body (abort propagates to the caller). */
async function* ssePayloads(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const raw = buffer.slice(0, nl).replace(/\r$/, '')
      buffer = buffer.slice(nl + 1)
      if (!raw.startsWith('data:')) continue
      const payload = raw.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let json: unknown
      try {
        json = JSON.parse(payload)
      } catch {
        continue
      }
      yield json
    }
  }
  if (buffer.startsWith('data:')) {
    const payload = buffer.slice(5).trim()
    if (payload && payload !== '[DONE]') {
      try {
        yield JSON.parse(payload)
      } catch {
        /* trailing partial line — ignore */
      }
    }
  }
}

async function* parseOpenAIChat(body: ReadableStream<Uint8Array>, profile: ProviderProfile): AsyncGenerator<LLMEvent, ParseSummary> {
  let content = ''
  let reasoning = ''
  let finishReason: string | undefined
  let usage: Usage = {}
  const toolAcc = new Map<number, { id: string; name: string; args: string }>()
  const splitter = new InlineReasoningSplitter()

  for await (const json of ssePayloads(body)) {
    const frame = json as Record<string, any>
    if (frame.error) throw adapterError(profile.id, 0, String(frame.error.message ?? JSON.stringify(frame.error)))
    if (frame.usage) {
      usage = {
        promptTokens: frame.usage.prompt_tokens,
        completionTokens: frame.usage.completion_tokens,
        totalTokens: frame.usage.total_tokens,
        cachedTokens: frame.usage.prompt_tokens_details?.cached_tokens,
        cacheWriteTokens: frame.usage.prompt_tokens_details?.cache_write_tokens,
      }
    }
    const choice = frame.choices?.[0]
    if (!choice) continue
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = choice.delta ?? choice.message ?? {}
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      reasoning += delta.reasoning_content
      yield { type: 'reasoning', text: delta.reasoning_content }
    }
    if (typeof delta.content === 'string' && delta.content) {
      for (const piece of splitter.push(delta.content)) {
        if (piece.kind === 'text') {
          content += piece.text
          yield { type: 'delta', text: piece.text }
        } else {
          reasoning += piece.text
          yield { type: 'reasoning', text: piece.text }
        }
      }
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const index = tc.index ?? 0
        const entry = toolAcc.get(index) ?? { id: '', name: '', args: '' }
        if (tc.id) entry.id = tc.id
        if (tc.function?.name) entry.name = tc.function.name
        if (tc.function?.arguments) entry.args += tc.function.arguments
        toolAcc.set(index, entry)
      }
    }
  }

  for (const piece of splitter.flush()) {
    if (piece.kind === 'text') {
      content += piece.text
      yield { type: 'delta', text: piece.text }
    } else {
      reasoning += piece.text
      yield { type: 'reasoning', text: piece.text }
    }
  }

  const toolCalls: ToolCall[] = []
  for (const [, entry] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
    if (!entry.name) continue
    toolCalls.push({ id: entry.id || `call_${toolCalls.length}`, type: 'function', function: { name: entry.name, arguments: entry.args || '{}' } })
    yield { type: 'tool_call', call: toolCalls[toolCalls.length - 1] }
  }
  return { content, reasoning, toolCalls, finishReason, usage }
}

function responsesFinish(reason: string | undefined): string | undefined {
  if (!reason) return 'stop'
  if (reason.includes('max_output_tokens') || reason === 'length') return 'length'
  if (reason.includes('content_filter')) return 'content_filter'
  return reason
}

async function* parseResponses(body: ReadableStream<Uint8Array>, profile: ProviderProfile): AsyncGenerator<LLMEvent, ParseSummary> {
  let content = ''
  let reasoning = ''
  let finishReason: string | undefined
  let usage: Usage = {}
  const toolAcc = new Map<string, { id: string; name: string; args: string }>()

  for await (const json of ssePayloads(body)) {
    const frame = json as Record<string, any>
    const type = String(frame.type ?? '')
    if (type === 'error' || type === 'response.error' || frame.error) {
      const message = frame.error?.message ?? frame.message ?? JSON.stringify(frame.error ?? frame)
      throw adapterError(profile.id, 0, String(message))
    }
    if (type === 'response.output_text.delta' && typeof frame.delta === 'string') {
      content += frame.delta
      yield { type: 'delta', text: frame.delta }
    } else if ((type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') && typeof frame.delta === 'string') {
      reasoning += frame.delta
      yield { type: 'reasoning', text: frame.delta }
    } else if (type === 'response.output_item.added' && frame.item?.type === 'function_call') {
      const key = String(frame.item.id ?? frame.item.call_id ?? toolAcc.size)
      toolAcc.set(key, { id: String(frame.item.call_id ?? ''), name: String(frame.item.name ?? ''), args: '' })
    } else if (type === 'response.function_call_arguments.delta') {
      const key = String(frame.item_id ?? '')
      const entry = toolAcc.get(key)
      if (entry && typeof frame.delta === 'string') entry.args += frame.delta
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      const response = frame.response ?? {}
      if (response.usage) {
        usage = {
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
          totalTokens: response.usage.total_tokens,
          cachedTokens: response.usage.prompt_tokens_details?.cached_tokens,
        }
      }
      finishReason = responsesFinish(response.incomplete_details?.reason)
    } else if (type === 'response.failed') {
      const message = frame.response?.error?.message ?? 'response failed'
      throw adapterError(profile.id, 0, String(message))
    }
  }

  const toolCalls: ToolCall[] = []
  for (const [, entry] of toolAcc) {
    if (!entry.name) continue
    toolCalls.push({ id: entry.id || `call_${toolCalls.length}`, type: 'function', function: { name: entry.name, arguments: entry.args || '{}' } })
    yield { type: 'tool_call', call: toolCalls[toolCalls.length - 1] }
  }
  return { content, reasoning, toolCalls, finishReason, usage }
}

function anthropicFinish(stopReason: string | undefined): string | undefined {
  if (!stopReason) return undefined
  if (stopReason === 'tool_use') return 'tool_calls'
  if (stopReason === 'end_turn' || stopReason === 'stop_sequence') return 'stop'
  if (stopReason === 'max_tokens') return 'length'
  if (stopReason === 'refusal') return 'content_filter'
  return stopReason
}

async function* parseAnthropic(body: ReadableStream<Uint8Array>, profile: ProviderProfile): AsyncGenerator<LLMEvent, ParseSummary> {
  let content = ''
  let reasoning = ''
  let finishReason: string | undefined
  let usage: Usage = {}
  const toolAcc = new Map<number, { id: string; name: string; args: string }>()

  for await (const json of ssePayloads(body)) {
    const frame = json as Record<string, any>
    const type = String(frame.type ?? '')
    if (type === 'error' || frame.error) {
      const message = frame.error?.message ?? JSON.stringify(frame.error ?? frame)
      throw adapterError(profile.id, 0, String(message))
    }
    if (type === 'message_start') {
      const input = frame.message?.usage
      if (input) {
        // totalTokens stays unset: llm.usageReport() sums prompt+completion.
        usage = {
          ...usage,
          promptTokens: input.input_tokens,
          ...(input.cache_read_input_tokens ? { cachedTokens: input.cache_read_input_tokens } : {}),
          ...(input.cache_creation_input_tokens ? { cacheWriteTokens: input.cache_creation_input_tokens } : {}),
        }
      }
    } else if (type === 'content_block_start' && frame.content_block?.type === 'tool_use') {
      toolAcc.set(Number(frame.index), { id: String(frame.content_block.id ?? ''), name: String(frame.content_block.name ?? ''), args: '' })
    } else if (type === 'content_block_delta') {
      const delta = frame.delta ?? {}
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        content += delta.text
        yield { type: 'delta', text: delta.text }
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        reasoning += delta.thinking
        yield { type: 'reasoning', text: delta.thinking }
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const entry = toolAcc.get(Number(frame.index))
        if (entry) entry.args += delta.partial_json
      }
    } else if (type === 'message_delta') {
      if (frame.delta?.stop_reason) finishReason = anthropicFinish(frame.delta.stop_reason)
      if (frame.usage?.output_tokens !== undefined) usage = { ...usage, completionTokens: frame.usage.output_tokens }
    }
  }

  const toolCalls: ToolCall[] = []
  for (const [, entry] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
    if (!entry.name) continue
    toolCalls.push({ id: entry.id || `call_${toolCalls.length}`, type: 'function', function: { name: entry.name, arguments: entry.args || '{}' } })
    yield { type: 'tool_call', call: toolCalls[toolCalls.length - 1] }
  }
  return { content, reasoning, toolCalls, finishReason, usage }
}

/**
 * Streams one provider response as LLM events and returns the accumulated
 * summary (usage, finish reason, tool calls). HTTP failures become
 * `adapterError(...)` messages; abort mid-stream rejects like the fetch abort
 * path so the agent's cancellation handling stays identical for all protocols.
 */
export function parseStream(res: Response, profile: ProviderProfile): AsyncGenerator<LLMEvent, ParseSummary> {
  return (async function* () {
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw adapterError(profile.id, res.status, text)
    }
    if (!res.body) throw adapterError(profile.id, 0, 'response has no body')
    if (profile.protocol === 'openai-responses') return yield* parseResponses(res.body, profile)
    if (profile.protocol === 'anthropic-messages') return yield* parseAnthropic(res.body, profile)
    return yield* parseOpenAIChat(res.body, profile)
  })()
}
