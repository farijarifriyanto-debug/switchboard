// Permission gate. Plan mode: read-only. Act mode: mutating ops need approval
// unless the user explicitly enabled a looser policy via /permissions.
'use strict';

const READ_OPS = new Set([
  'read', 'list', 'search', 'analyze', 'explain', 'propose',
  'direct', 'review', // plain chat and read-only code review: no mutations
  'list_directory', 'read_file', 'search_files', // Phase-1B/1 real read tools
]);

function classify(op) { return READ_OPS.has(op) ? 'read' : 'mutating'; }

// Returns { allowed: bool, needsApproval: bool, reason }
function gate({ mode, approval, op }) {
  const kind = classify(op);
  if (mode === 'Plan' && kind === 'mutating')
    return { allowed: false, needsApproval: false, reason: 'Plan mode is read-only. Toggle to Act (Tab) to propose changes.' };
  if (kind === 'read')
    return { allowed: approval === 'full-auto' ? true : true, needsApproval: false, reason: 'read' };
  // Act + mutating
  if (approval === 'full-auto') return { allowed: true, needsApproval: false, reason: 'full-auto (explicit opt-in)' };
  return { allowed: false, needsApproval: true, reason: 'mutating op requires approval' };
}

module.exports = { gate, classify, READ_OPS };
