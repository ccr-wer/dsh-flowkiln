/**
 * dsh-tools-diag — one-shot diagnostic: dump the tools registry view.
 * Answers: are flowkiln tools visible in ctx.tools.definitions()?
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-tools-diag'
export const inject = ['tools']

export function apply(ctx) {
  const out = []
  const dump = (phase) => {
    const rec = { phase, ts: new Date().toISOString() }
    try {
      rec.getFlowkiln = typeof ctx.tools.get('flowkiln_mine')
      rec.getWebsearch = typeof ctx.tools.get('web_search')
      rec.getPwsh = typeof ctx.tools.get('pwsh')
    } catch (e) { rec.getErr = String(e) }
    try {
      const defs = ctx.tools.definitions()
      rec.defCount = defs.length
      rec.defNames = defs.map((d) => d.name).sort()
    } catch (e) { rec.defsErr = String(e) }
    try {
      const view = ctx.tools.view()
      rec.visibleCount = view.visible ? view.visible.size : 'n/a'
      rec.visibleNames = view.visible ? [...view.visible.keys()].sort() : []
      rec.knownNames = view.knownNames ? [...view.knownNames].sort() : []
    } catch (e) { rec.viewErr = String(e) }
    out.push(rec)
    try {
      const dir = join(homedir(), '.dsh', 'flowkiln')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'tools-diag.json'), JSON.stringify(out, null, 2), 'utf-8')
    } catch { /* best-effort */ }
  }

  dump('apply')
  try {
    // agent/pre-step is a waterfall: must call next() or the whole chain
    // short-circuits (official docs; the 'kind' crash was exactly this).
    ctx.on('agent/pre-step', async (payload, next) => {
      const downstream = typeof next === 'function' ? await next() : undefined
      if (!out.some((r) => r.phase === 'pre-step')) dump('pre-step')
      return downstream
    })
  } catch (e) {
    out.push({ phase: 'hook-err', err: String(e) })
  }
}
