#!/usr/bin/env node
/**
 * dsh-flowkiln selftest - synthetic end-to-end run, no DSH required.
 * Ports the 33 checks from codex-flowkiln/scripts/wfminer.py selftest.
 * Usage: node bin/selftest.js    (exit 0 = all pass)
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { redact } from '../lib/redact.js'
import { mine, tokenize, keywords } from '../lib/miner.js'
import {
  appendPrompt, readPrompts, readCandidates, writeCandidates,
  readDismissed,
} from '../lib/store.js'
import { dismiss, renderList, filterDismissed } from '../lib/review.js'
import { promote, sanitizeName, renderSkill } from '../lib/skill.js'

const checks = []
function check(label, ok) {
  checks.push([label, Boolean(ok)])
}

const synthetic = [
  'rewrite the changelog for release v2 and push the tag',
  'rewrite the changelog for release v3 and push the tag',
  'please rewrite the changelog for release v4 and push the tag',
  'rewrite the changelog for release v5 and push the tag',
  'fix the flaky test in CI then run the full build suite',
  'fix the flaky test in CI then run the full build suite again',
  'fix that flaky CI test and run the full build suite',
  'fix the flaky test in CI then run the full build suite',
  'one-off: what is the weather in Tokyo right now',
]

const td = mkdtempSync(join(tmpdir(), 'dfk-selftest-'))
process.env.DFK_DATA_DIR = td
process.env.DFK_SKILLS_DIR = join(td, 'skills')

try {
  // ---- collect (same record shape the DSH hook writes) ----
  synthetic.forEach((text, i) => {
    appendPrompt({
      ts: new Date(Date.UTC(2026, 10, 19, 0, i)).toISOString(),
      event: 'agent/pre-step',
      session_id: `test-${i}`,
      cwd: td,
      tool: '',
      text,
    })
  })
  const records = readPrompts()
  check('collect wrote all records', records.length === synthetic.length)
  check('redaction keeps clean text', records[records.length - 1].text.includes('weather'))

  appendPrompt({
    ts: new Date().toISOString(),
    event: 'agent/pre-step',
    session_id: 'secrets',
    cwd: td,
    tool: '',
    text: redact('use key sk-abcdefghijklmnopqrstuvwxyz and ghp_abcdefghijklmnopqrstuvwxyz'),
  })
  const last = readPrompts().slice(-1)[0].text
  check('redacts openai key', !last.includes('sk-abcdefghijklmnopqrstuvwxyz'))
  check('redacts github pat', !last.includes('ghp_abcdefghijklmnopqrstuvwxyz'))

  // ---- mine ----
  const all = readPrompts()
  const candidates = mine(all, { threshold: 0.70, minCount: 3 })
  check('found at least one cluster', candidates.length >= 1)
  check('candidate has count', candidates.length > 0 && candidates[0].count >= 3)
  check('candidate has skeleton', candidates.length > 0 && candidates[0].skeleton_terms.length > 0)
  writeCandidates(candidates)

  // ---- promote dry-run / apply ----
  const dest = join(td, 'out', 'skills')
  const preview = promote(candidates, null, false, dest)
  check('dry-run writes nothing', preview.every((r) => !r.applied))
  check('dry-run reports target', preview.length > 0 && preview[0].target.endsWith('SKILL.md'))

  const applied = promote(candidates.slice(0, 1), null, true, dest)
  check('apply writes file', applied.length > 0 && applied[0].applied)
  const written = applied[0].target
  check('file exists', existsSync(written))
  if (existsSync(written)) {
    const content = readFileSync(written, 'utf-8')
    const dirName = written.split(/[\\/]/).slice(-2, -1)[0]
    check('frontmatter name matches dir', content.includes(`name: ${dirName}`))
    check('has description', content.includes('description:'))
    check('has TODO markers', content.includes('[TODO:'))
  }
  const again = promote(candidates.slice(0, 1), null, true, dest)
  check('no overwrite on re-apply', again[0].reason.startsWith('skipped'))

  // ---- determinism ----
  const second = mine(all, { threshold: 0.70, minCount: 3 })
  check('deterministic mining',
    JSON.stringify(second.map((c) => c.id)) === JSON.stringify(candidates.map((c) => c.id)))

  // ---- review loop ----
  check('render_list names every id',
    candidates.length > 0 && candidates.every((c) => renderList(candidates).includes(c.id)))
  const target = candidates[0].id
  const result = dismiss(target, 'user said no')
  check('dismiss reports removal', result.dismissed === target)
  check('dismiss shrinks the list', result.remaining === candidates.length - 1)
  const left = readCandidates()
  check('dismissed id gone from list', left.every((c) => c.id !== target))
  const entries = readDismissed()
  check('dismiss records fingerprint',
    entries.length > 0 &&
    entries[entries.length - 1].id === target &&
    entries[entries.length - 1].fingerprint_terms.length > 0)
  const filtered = filterDismissed(candidates, entries)
  check('filter drops dismissed cluster', filtered.skipped === 1)
  check('filter keeps the rest', filtered.kept.length === candidates.length - 1)
  const resurrected = filterDismissed(
    mine(all, { threshold: 0.70, minCount: 3 }), readDismissed())
  check('dismissed cluster stays gone',
    resurrected.skipped === 1 && resurrected.kept.every((c) => c.id !== target))

  // ---- kernel extras (zh / sanitize / template) ----
  const zh = [
    '把今天的 GitHub trending 抓下来按格式发微信',
    '抓取今日 github trending 按日报格式推送微信',
    'github trending 日报 抓取并推送到微信',
  ]
  const zhCands = mine(zh.map((text, i) => ({ text, tool: '', ts: `t${i}` })), {})
  check('zh short prompts cluster', zhCands.length === 1 && zhCands[0].count === 3)
  check('sanitize kebab-case', sanitizeName('wf-Hello World_1') === 'wf-hello-world-1')
  check('renderSkill has frontmatter', renderSkill(candidates[0]).body.startsWith('---\nname:'))
  const toks = tokenize('fix the flaky test in CI')
  check('tokenize keeps latin words', toks.includes('flaky'))
  const kw = keywords('抓取 GitHub trending 推送微信')
  check('keywords finds latin + cjk', kw.has('github') && kw.has('trending'))
} finally {
  delete process.env.DFK_DATA_DIR
  delete process.env.DFK_SKILLS_DIR
  rmSync(td, { recursive: true, force: true })
}

const passed = checks.filter(([, ok]) => ok).length
for (const [label, ok] of checks) {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`)
}
console.log(`\n${passed}/${checks.length} checks passed`)
process.exit(passed === checks.length ? 0 : 1)
