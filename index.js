/**
 * dsh-flowkiln — mine repeated DSH prompts into reviewable SKILL.md drafts.
 *
 * Pipeline (four stages, the last one needs a human):
 *   collect  : agent/pre-step hook -> redacted prompts.jsonl   (automatic, 0 token)
 *   mine     : TF-IDF + shared-keyword clustering -> candidates (offline, 0 token)
 *   review   : flowkiln_list -> the candidate list goes into the chat
 *   act      : user says keep -> flowkiln_promote (mounts SKILL.md)
 *              user says no  -> flowkiln_dismiss (fingerprinted, never comes back)
 *
 * The clustering is deterministic and model-free. An LLM call is available
 * (promote with refine:true) only to polish a candidate name/description,
 * one short call per candidate, off by default.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { redact } from './lib/redact.js'
import { mine } from './lib/miner.js'
import {
  appendPrompt, readPrompts, readCandidates, writeCandidates, readDismissed, dataDir,
} from './lib/store.js'
import { dismiss, renderList, filterDismissed } from './lib/review.js'
import { promote, renderSkill, sanitizeName, skillsRoot } from './lib/skill.js'

export const name = 'dsh-flowkiln'
export const inject = ['tools', 'llm']

const VERSION = '0.1.0-dsh'

function extractUserTexts(payload) {
  const msgs = Array.isArray(payload?.messages) ? payload.messages : []
  const texts = []
  for (const m of msgs) {
    if (m?.role !== 'user') continue
    const blocks = Array.isArray(m.content) ? m.content : []
    const text = blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim()
    if (text) texts.push(text)
  }
  return texts
}

export function apply(ctx) {
  const disposers = []
  const bootLog = { ts: new Date().toISOString(), inject, registers: [], events: [] }

  // DSH requires output { schema, render }; render returns content blocks.
  const jsonOutput = () => ({
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  })
  const textOutput = (pick) => ({
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: String(pick(value)) }],
  })

  function markBoot() {
    try {
      mkdirSync(dataDir(), { recursive: true })
      writeFileSync(join(dataDir(), 'boot.json'), JSON.stringify(bootLog, null, 2), 'utf-8')
    } catch { /* marker is best-effort */ }
  }

  // ---- Stage 1: automatic collection (0 token, redacted, append-only) ----
  const triedPhases = new Set()
  const retryTools = (phase) => {
    if (triedPhases.has(phase)) return
    triedPhases.add(phase)
    registerAll(phase)
  }
  // session/created registration was tried and CRASHES session init
  // (Cannot read properties of undefined (reading 'kind')) - do not hook it.
  try {
    // agent/pre-step is a WATERFALL: the listener receives (payload, next) and
    // MUST call next(), or it does not "add a hook" - it REPLACES the whole
    // chain with nothing (official docs). The earlier plain listener
    // short-circuited the pipeline and the run died with
    // "Cannot read properties of undefined (reading 'kind')".
    const off = ctx.on('agent/pre-step', async (payload, next) => {
      // Let the chain proceed FIRST (docs: write the next() call before
      // anything else), so our own failures can never block the agent.
      const downstream = typeof next === 'function' ? await next() : undefined
      try {
        // apply()-time registration is silently dropped on some profiles (the
        // registry is empty then); retry once when the service is live.
        retryTools('pre-step')
        const texts = extractUserTexts(payload)
        // Only the newest user turn, so multi-turn context is not double-counted.
        const text = texts.slice(-1)[0]
        if (text) {
          appendPrompt({
            ts: new Date().toISOString(),
            event: 'agent/pre-step',
            session_id: String(payload?.session?.id || payload?.sessionId || ''),
            cwd: String(payload?.cwd || ''),
            tool: '',
            text: redact(text).slice(0, 4000),
          })
        }
      } catch (e) {
        ctx.logger?.warn?.('dsh-flowkiln: collect failed: ' + String(e))
      }
      // ALWAYS hand the chain its result back; a bare return (undefined)
      // would short-circuit the waterfall again.
      return downstream
    })
    if (typeof off === 'function') disposers.push(off)
  } catch (e) {
    ctx.logger?.warn?.('dsh-flowkiln: hook registration failed: ' + String(e))
  }

  // ---- Stage 2+3+4: review tools (the model calls these on the user's behalf) ----
  // Registration timing matters: some profiles expose ctx.tools only after the
  // agent is up, so we register at apply() AND retry once at the first
  // agent/pre-step (the same pattern the scout verified for ctx.skills).
  const toolDefs = []

  const registerAll = (phase) => {
    for (const def of toolDefs) {
      try {
        const ret = ctx.tools.register(def)
        // Probe: is the tool visible immediately after register returns?
        let seen = 'n/a'
        try { seen = typeof ctx.tools.get(def.name) } catch (e) { seen = 'get-err:' + String(e) }
        bootLog.registers.push({ tool: def.name, phase, ok: true, disposer: typeof ret, seenRightAfter: seen })
        if (typeof ret === 'function') disposers.push(ret)
      } catch (e) {
        const msg = String(e)
        // "already registered" means an earlier phase landed; that is success.
        const ok = msg.includes('already registered')
        bootLog.registers.push({ tool: def.name, phase, ok, error: ok ? 'already registered' : msg })
        if (!ok) ctx.logger?.warn?.('dsh-flowkiln: tool ' + def.name + ' failed at ' + phase + ': ' + msg)
      }
    }
    markBoot()
  }

  toolDefs.push({
    name: 'flowkiln_mine',
    description:
      'Cluster the locally recorded prompts into workflow skill candidates. ' +
      'Offline, deterministic, zero model calls. Run this first, then flowkiln_list ' +
      'to show the candidates to the user. Does not create any skill by itself.',
    // Raw register() takes a JSON Schema OBJECT ROOT, not the defineTool
    // property table - a bare table goes out on the wire with no `type` at
    // the root (official troubleshooting: "Invalid schema for function").
    parameters: { type: 'object', properties: {} },
    output: jsonOutput(),
    execute: () => {
      const records = readPrompts()
      const raw = mine(records, {})
      const { kept, skipped } = filterDismissed(raw, readDismissed())
      writeCandidates(kept)
      return {
        prompts: records.length,
        candidates: kept.length,
        skipped_dismissed: skipped,
        ids: kept.map((c) => c.id),
        next: 'Call flowkiln_list and show the result to the user for review.',
      }
    },
  })

  toolDefs.push({
    name: 'flowkiln_list',
    description:
      'Return the candidate review list formatted for the chat. Paste this to the user ' +
      'verbatim and ask them, item by item, which to promote and which to dismiss. ' +
      'Never call flowkiln_promote or flowkiln_dismiss before the user answers. ' +
      'Silence is not consent.',
    parameters: { type: 'object', properties: {} },
    output: textOutput((v) => v.list),
    execute: () => {
      const candidates = readCandidates()
      return {
        list: renderList(candidates),
        count: candidates.length,
        ids: candidates.map((c) => c.id),
      }
    },
  })

  toolDefs.push({
    name: 'flowkiln_promote',
    description:
      'Mount one approved candidate as a SKILL.md under the DSH skills directory ' +
      '(~/.dsh/skills/<name>/SKILL.md) so the model can use it. ' +
      'ONLY call this after the user explicitly agreed to promote this candidate. ' +
      'Never overwrites an existing skill. Default is a dry-run preview; pass ' +
      'apply:true to actually write, and only after the user confirmed.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Candidate id from flowkiln_list.',
        },
        apply: {
          type: 'boolean',
          description: 'false (default) = dry-run preview only; true = actually write the SKILL.md.',
        },
        refine: {
          type: 'boolean',
          description:
            'If true, spend one short LLM call to polish the skill name and description. ' +
            'Default false (fully deterministic). Ask the user before enabling.',
        },
      },
      required: ['id'],
    },
    output: jsonOutput(),
    execute: async (args) => {
      const candidates = readCandidates()
      const wanted = args?.id
      const hit = candidates.find((c) => c.id === wanted)
      if (!hit) return { error: `candidate not found: ${wanted}` }

      let candidate = hit
      if (args?.refine) {
        try {
          const polished = await refineCandidate(ctx, hit)
          if (polished) candidate = { ...hit, ...polished }
        } catch (e) {
          ctx.logger?.warn?.('dsh-flowkiln: refine failed, using raw candidate: ' + String(e))
        }
      }

      const results = promote([candidate], candidate.id, Boolean(args?.apply))
      return {
        ...results[0],
        skill_root: skillsRoot(),
        note: results[0]?.applied
          ? 'SKILL.md written. Review it before relying on it; edit the [TODO] steps.'
          : 'Dry-run only. Re-run with apply:true to write.',
      }
    },
  })

  toolDefs.push({
    name: 'flowkiln_dismiss',
    description:
      'Drop one candidate because the user rejected it. Records a fingerprint so the ' +
      'same workflow will NOT resurface on future mining runs. ' +
      'ONLY call this after the user explicitly said no to this candidate.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Candidate id to remove.',
        },
        reason: {
          type: 'string',
          description: 'Short reason the user gave (optional).',
        },
      },
      required: ['id'],
    },
    output: jsonOutput(),
    execute: (args) => {
      const result = dismiss(String(args?.id || ''), String(args?.reason || ''))
      return result
    },
  })

  registerAll('apply')

  const dispose = () => {
    bootLog.disposed = new Date().toISOString()
    markBoot()
    for (const fn of disposers) {
      try {
        fn()
      } catch {
        /* unregister must not throw */
      }
    }
  }
  // NOTE: ctx.effect(fn) CALLS fn immediately as setup; only its RETURN value
  // is the cleanup. Passing `dispose` directly would tear everything down at
  // once (tools + hooks vanish right after apply) - wrap it in a thunk.
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
  return dispose
}

/**
 * One short LLM call to polish a candidate's name and description.
 * Optional and off by default; clustering stays deterministic either way.
 */
async function refineCandidate(ctx, candidate) {
  const terms = (candidate.skeleton_terms || []).slice(0, 6).join(', ')
  const samples = (candidate.samples || []).slice(0, 2).map((s) => '- ' + s).join('\n')
  const prompt =
    'You name reusable agent skills. Given the repeated-task evidence below, ' +
    'reply with ONLY two lines:\n' +
    'NAME: <kebab-case-name-max-40-chars>\n' +
    'DESC: <one sentence, max 120 chars>\n\n' +
    'Evidence terms: ' + terms + '\n' +
    'Observed prompts:\n' + samples

  let text = ''
  const stream = ctx.llm.stream({
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens: 80,
  })
  for await (const chunk of stream) {
    const parts = Array.isArray(chunk?.content) ? chunk.content : []
    for (const p of parts) {
      if (p && p.type === 'text' && typeof p.text === 'string') text += p.text
    }
    if (chunk?.type === 'text' && typeof chunk.text === 'string') text += chunk.text
  }

  const nameMatch = text.match(/NAME:\s*([a-z0-9-]{2,64})/i)
  const descMatch = text.match(/DESC:\s*(.+)/i)
  const out = {}
  if (nameMatch) out.skill_name = sanitizeName(nameMatch[1])
  if (descMatch) out.skill_description = descMatch[1].trim().slice(0, 200)
  return out.skill_name ? out : null
}
