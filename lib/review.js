/**
 * Review loop: the human decides. list -> user says keep/dismiss -> act.
 * A dismissed cluster is fingerprinted so the same workflow does not come back.
 */
import { readCandidates, readDismissed, writeCandidates, writeDismissed } from './store.js'

/**
 * A cluster is dismissed if its skeleton terms largely overlap a rejection.
 * Fuzzy on purpose: the same workflow may pick up one extra term next time,
 * so we require >=75% of the smaller term set to match.
 */
export function isDismissed(terms, dismissed) {
  const cur = new Set((terms || []).filter(Boolean))
  for (const entry of dismissed) {
    const seen = new Set(entry.fingerprint_terms || [])
    if (!seen.size) continue
    let overlap = 0
    for (const w of cur) if (seen.has(w)) overlap++
    const need = Math.max(1, Math.floor(0.75 * Math.min(cur.size, seen.size)))
    if (overlap >= need) return true
  }
  return false
}

export function filterDismissed(candidates, dismissed) {
  const kept = []
  let skipped = 0
  for (const c of candidates) {
    if (isDismissed(c.skeleton_terms || [], dismissed)) skipped++
    else kept.push(c)
  }
  return { kept, skipped }
}

/** Remove one candidate and remember the rejection (fingerprint keeps it gone). */
export function dismiss(wanted, reason = '') {
  const candidates = readCandidates()
  const hit = candidates.find((c) => c.id === wanted)
  if (!hit) {
    return { error: `candidate not found: ${wanted}` }
  }
  const kept = candidates.filter((c) => c.id !== wanted)
  writeCandidates(kept)

  const entries = readDismissed()
  entries.push({
    id: hit.id,
    fingerprint_terms: hit.skeleton_terms || [],
    count: hit.count || 0,
    reason: reason || '',
    ts: new Date().toISOString(),
  })
  writeDismissed(entries)
  return {
    dismissed: hit.id,
    count: hit.count || 0,
    reason: reason || '(none)',
    remaining: kept.length,
    note: 'removed from the list; fingerprinted so it will not come back',
  }
}

/** Human-readable review list. Meant to be pasted into the chat verbatim. */
export function renderList(candidates) {
  if (!candidates || candidates.length === 0) {
    return 'No candidates awaiting review.'
  }
  const lines = [`${candidates.length} candidate(s) awaiting review:`, '']
  candidates.forEach((c, i) => {
    const terms = (c.skeleton_terms || []).slice(0, 6).join(', ') || '(none)'
    const slots = (c.slots || []).join(', ') || 'none detected'
    const sample = (c.samples || ['(no sample)'])[0]
    lines.push(`[${i + 1}] id=${c.id}  count=${c.count}`)
    lines.push(`    terms: ${terms}`)
    lines.push(`    slots: ${slots}`)
    lines.push(`    sample: ${sample}`)
    lines.push('')
  })
  lines.push('Keep some? Promote those. Say no to any other -> dismiss it.')
  return lines.join('\n')
}
