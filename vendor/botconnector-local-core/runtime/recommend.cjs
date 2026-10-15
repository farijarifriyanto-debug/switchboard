function assess(model, hw) {
  if (model.kind === 'cloud') return {level:'cloud', label:'Cloud only', reason:'Model flagship dijalankan melalui cloud.'};
  const maxVram = Math.max(0, ...(hw.nvidia || []).map(g => g.memoryGb || 0));
  if (hw.ramGb < model.min_ram_gb) return {level:'no', label:'Tidak disarankan', reason:`Butuh minimal ${model.min_ram_gb} GB RAM.`};
  if (maxVram >= model.recommended_vram_gb && hw.ramGb >= model.recommended_ram_gb) return {level:'great', label:'Sangat cocok', reason:'Full/mostly GPU target tersedia.'};
  if (hw.ramGb >= model.recommended_ram_gb) return {level:'ok', label:'Bisa dijalankan', reason:'Gunakan CPU/RAM + partial GPU offload.'};
  return {level:'warn', label:'Bisa, lebih lambat', reason:'RAM cukup tetapi headroom terbatas.'};
}
module.exports = { assess };
