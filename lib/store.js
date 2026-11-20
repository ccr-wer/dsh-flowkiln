/**
 * Persistence: prompts.jsonl (append-only) + candidates.json + dismissed.json.
 * Data root defaults to ~/.dsh/flowkiln; override with DFK_DATA_DIR (testing).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function dataDir() {
  const override = process.env.DFK_DATA_DIR
  if (override) return override
  return join(homedir(), '.dsh', 'flowkiln')
}

export function promptsPath() {
  return join(dataDir(), 'prompts.jsonl')
}

export function candidatesPath() {
  return join(dataDir(), 'candidates.json')
}

export function dismissedPath() {
  return join(dataDir(), 'dismissed.json')
}

function ensureDir(filePath) {
  mkdirSync(join(filePath, '..'), { recursive: true })
}

export function appendPrompt(record) {
  const target = promptsPath()
  ensureDir(target)
  appendFileSync(target, JSON.stringify(record) + '\n', 'utf-8')
}

export function readPrompts() {
  const path = promptsPath()
  if (!existsSync(path)) return []
  const out = []
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // tolerate a torn append
    }
  }
  return out
}

export function readCandidates() {
  const path = candidatesPath()
  if (!existsSync(path)) return []
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

export function writeCandidates(candidates) {
  const path = candidatesPath()
  ensureDir(path)
  writeFileSync(path, JSON.stringify(candidates, null, 2), 'utf-8')
  return path
}

export function readDismissed() {
  const path = dismissedPath()
  if (!existsSync(path)) return []
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

export function writeDismissed(entries) {
  const path = dismissedPath()
  ensureDir(path)
  writeFileSync(path, JSON.stringify(entries, null, 2), 'utf-8')
  return path
}
