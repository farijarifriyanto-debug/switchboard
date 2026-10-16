/**
 * Read-only hardware-based suggestions from the pinned ORIGINAL BotConnector
 * Local Core. No second model manager, network catalog, downloads or runtime
 * starts. The Core's hardware probe, curated registry and fit policy remain
 * authoritative; Switchboard only presents task-specific selections.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { bundledBotConnectorCore } from './botconnector-core-location.js'

const coreRoot = bundledBotConnectorCore()
const requireCore = createRequire(import.meta.url)
type Hardware = {
  platform: string; arch: string; cpu: string; logicalCores: number
  ramGb: number; freeRamGb: number
  nvidia: Array<{ name: string; memoryGb: number }>
}
type CoreModel = {
  id: string; name: string; category: string; runtime: string
  recommended_quant?: string; download_size_gb: number
  min_ram_gb: number; recommended_ram_gb: number
}
type Fit = { level: 'great' | 'ok' | 'warn' | 'no'; label: string; reason: string }
const firstRun = requireCore(path.join(coreRoot, 'tui/first-run.cjs')) as {
  recommend(): Promise<{hardware: Hardware; recommendation: {model: CoreModel} | null}>
  catalog(): CoreModel[]
}
const { assess } = requireCore(path.join(coreRoot, 'runtime/recommend.cjs')) as {
  assess(model: CoreModel, hardware: Hardware): Fit
}

export type LocalModelSuggestion = {
  role: 'starter' | 'browser' | 'coding' | 'vision'
  id: string; name: string; category: string
  quant: string; downloadGb: number
  fit: Fit['level']; fitLabel: string
  memory: 'fits-now' | 'free-ram-first'
  estimatedRamGb: number
  cpuHint: string
  note: string
}

export function recommendForHardware(hardware: Hardware, starterId?: string) {
  // Use canonical Core requirements and fit levels. Reserve operating-system
  // headroom and estimate GGUF weight + KV cache; this is NOT a benchmark.
  const available = Math.max(0, hardware.freeRamGb - 2)
  const catalog = firstRun.catalog().filter(model => model.runtime === 'llama.cpp')
  const suitable = catalog.map(model => {
    const fit = assess(model, hardware)
    const estimatedRamGb = Math.round((model.download_size_gb * 1.35 + 0.8) * 10) / 10
    return { model, fit, estimatedRamGb, memory: estimatedRamGb <= available ? 'fits-now' as const : 'free-ram-first' as const }
  }).filter(item => item.fit.level !== 'no')
  const byId = (id: string) => suitable.find(x => x.model.id === id)
  const pick = (filter: (model: CoreModel) => boolean) =>
    suitable.filter(x => filter(x.model))
      .sort((a, b) => Number(a.memory !== 'fits-now') - Number(b.memory !== 'fits-now')
        || a.model.download_size_gb - b.model.download_size_gb)[0]
  const preferred = starterId ? byId(starterId) : undefined
  const rows: Array<{role: LocalModelSuggestion['role']; item: typeof suitable[number] | undefined; note: string}> = [
    { role: 'starter', item: preferred ?? pick(m => m.category === 'General'),
      note: 'Pilihan ringan dari rekomendasi perangkat BotConnector Local Core.' },
    { role: 'browser', item: byId('qwen3-4b'),
      note: 'Qwen3 4B sudah diuji tool calling via Ollama lokal. Tool calling GGUF/llama.cpp harus diuji setelah model dipasang.' },
    { role: 'coding', item: pick(m => /Coding/.test(m.category)),
      note: 'Kandidat coding berdasarkan katalog dan kebutuhan RAM; performa CPU belum dibenchmark.' },
    { role: 'vision', item: pick(m => /Multimodal/.test(m.category)),
      note: 'Vision membutuhkan projector GGUF dan runtime kompatibel; belum diverifikasi untuk model ini.' },
  ]
  return {
    source: 'Pinned BotConnector Local Core hardware and model catalog',
    hardware: {
      cpu: hardware.cpu.trim(), logicalCores: hardware.logicalCores,
      ramGb: hardware.ramGb, freeRamGb: hardware.freeRamGb,
      nvidia: hardware.nvidia.map(x => ({name:x.name,memoryGb:x.memoryGb})),
    },
    notes: ['Perkiraan RAM mencakup overhead dan cadangan OS 2 GB; bukan jaminan kecepatan atau kompatibilitas.',
      'GPU NVIDIA dideteksi oleh Core; GPU AMD terintegrasi tidak dihitung sebagai VRAM dedicated. Vulkan perlu diuji terpisah.',
      'Unduhan model dan aktivasi runtime hanya melalui BotConnector Local Core setelah persetujuan pengguna.'],
    recommendations: rows.filter(r => r.item).map(r => {
      const {model,fit,memory,estimatedRamGb} = r.item!
      const threads = Math.max(1, hardware.logicalCores || 1)
      const cpuHint = hardware.nvidia.length
        ? 'GPU NVIDIA tersedia; uji offload/runtime'
        : model.download_size_gb <= (threads >= 8 ? 3.5 : 2.5)
          ? 'Beban CPU relatif ringan (perkiraan)'
          : model.download_size_gb <= (threads >= 12 ? 6 : 3.5)
            ? 'Beban CPU sedang; latensi tergantung runtime'
            : 'Beban CPU berat; performa perlu diuji'
      return {
        role: r.role, id: model.id, name: model.name,
        category: model.category, quant: model.recommended_quant || 'Q4_K_M',
        downloadGb: model.download_size_gb, fit: fit.level,
        fitLabel: fit.label, memory, estimatedRamGb, cpuHint, note: r.note,
      } satisfies LocalModelSuggestion
    }),
  }
}

export async function recommendBotConnectorLocal() {
  const { hardware, recommendation } = await firstRun.recommend()
  return recommendForHardware(hardware, recommendation?.model.id)
}
