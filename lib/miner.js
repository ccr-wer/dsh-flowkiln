/**
 * Offline clustering kernel - ported 1:1 from codex-flowkiln/scripts/wfminer.py.
 *
 * Two independent similarity signals; either one linking two prompts is enough:
 *   1. TF-IDF cosine over normalized tokens (English / long prompts)
 *   2. Count of shared content keywords >= sharedKeywords (short Chinese prompts)
 *
 * Deterministic: same input -> same clusters -> same candidate names.
 * Zero model calls, zero network.
 */

const TOKEN_RE = /[a-z0-9_]+|[一-鿿]/g
const NOISE_RE = /(sk-[a-z0-9_-]+|ghp_[a-z0-9]+|https?:\/\/\S+|\b[0-9a-f]{8,}\b|[a-z]:[\\/][^\s]+|\/[^\s]+|\b\d+\b|\{[^}]*\})/gi

const STOPWORDS = new Set(
  'a an the and or to of in on for with is are please 把 和 与 在 给 这 那 我 你 他 的 了 并 然后 按 用'
    .split(/\s+/)
    .filter(Boolean)
)

const LATIN_RE = /[a-z][a-z0-9_+#.-]{2,}/g
const CJK_RUN_RE = /[一-鿿]{2,}/g

/** Normalize away paths/ids/numbers, keep stable signal tokens. */
export function tokenize(text) {
  const cleaned = String(text ?? '').toLowerCase().replace(NOISE_RE, ' ')
  const tokens = cleaned.match(TOKEN_RE) || []
  // CJK single chars are weak signal: also emit adjacent bigrams.
  const bigrams = []
  for (let i = 0; i + 1 < tokens.length; i++) {
    const a = tokens[i]
    const b = tokens[i + 1]
    if (a.length === 1 && b.length === 1 &&
        a >= '一' && a <= '鿿' && b >= '一' && b <= '鿿') {
      bigrams.push(a + b)
    }
  }
  return tokens.concat(bigrams)
}

/** Extract content-bearing terms: latin words + CJK 2/3-grams, minus stopwords. */
export function keywords(text) {
  const found = new Set()
  const lower = String(text ?? '').toLowerCase()
  for (const m of lower.matchAll(LATIN_RE)) found.add(m[0])
  for (const m of lower.matchAll(CJK_RUN_RE)) {
    const run = m[0]
    for (const n of [2, 3]) {
      for (let i = 0; i + n <= run.length; i++) found.add(run.slice(i, i + n))
    }
  }
  const out = new Set()
  for (const w of found) {
    if (!STOPWORDS.has(w) && w.length >= 2) out.add(w)
  }
  return out
}

function tfidfVectors(docs) {
  const df = new Map()
  for (const toks of docs) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1)
  }
  const n = Math.max(docs.length, 1)
  const vectors = []
  for (const toks of docs) {
    const tf = new Map()
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1)
    const vec = new Map()
    for (const [token, count] of tf) {
      const idf = Math.log((n + 1) / ((df.get(token) || 0) + 1)) + 1.0
      vec.set(token, (1.0 + Math.log(count)) * idf)
    }
    let norm = 0
    for (const v of vec.values()) norm += v * v
    norm = Math.sqrt(norm) || 1.0
    const unit = new Map()
    for (const [k, v] of vec) unit.set(k, v / norm)
    vectors.push(unit)
  }
  return vectors
}

function cosine(a, b) {
  let small = a
  let big = b
  if (small.size > big.size) {
    small = b
    big = a
  }
  let sum = 0
  for (const [k, v] of small) sum += v * (big.get(k) || 0)
  return sum
}

class UnionFind {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i)
  }
  find(x) {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]]
      x = this.parent[x]
    }
    return x
  }
  union(a, b) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent[rb] = ra
  }
}

/** Extract variable slots so a candidate is a workflow, not a transcript. */
export function slotsFrom(text) {
  const found = []
  const patterns = [
    [/[a-z]:[\\/][^\s]+/gi, 'path'],
    [/https?:\/\/\S+/g, 'url'],
    [/\b\d+\b/g, 'number'],
    [/[\w.-]+@[\w.-]+/g, 'email'],
  ]
  for (const [pattern, label] of patterns) {
    for (const _ of String(text ?? '').matchAll(pattern)) found.push(label)
  }
  return [...new Set(found)].sort()
}

/**
 * Cluster repeated prompts into skill candidates.
 * Defaults match the Codex engine: threshold 0.72, minCount 3, sharedKeywords 3.
 */
export function mine(records, opts = {}) {
  const threshold = opts.threshold ?? 0.72
  const minCount = opts.minCount ?? 3
  const sharedKeywords = opts.sharedKeywords ?? 3

  const texts = records.map((r) => r?.text || '')
  const docs = texts.map(tokenize)
  const kws = texts.map(keywords)
  const usable = []
  for (let i = 0; i < texts.length; i++) {
    if (docs[i].length >= 2 || kws[i].size >= 2) usable.push(i)
  }
  if (usable.length < minCount) return []

  const vecs = tfidfVectors(usable.map((i) => docs[i]))
  const uf = new UnionFind(usable.length)
  for (let ai = 0; ai < usable.length; ai++) {
    for (let bi = ai + 1; bi < usable.length; bi++) {
      const cos = cosine(vecs[ai], vecs[bi])
      let shared = 0
      for (const w of kws[usable[ai]]) if (kws[usable[bi]].has(w)) shared++
      if (cos >= threshold || shared >= sharedKeywords) uf.union(ai, bi)
    }
  }

  const groups = new Map()
  for (let idx = 0; idx < usable.length; idx++) {
    const root = uf.find(idx)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(usable[idx])
  }

  const candidates = []
  for (const members of groups.values()) {
    if (members.length < minCount) continue
    const samples = members.map((i) => texts[i])
    // Shared content keywords become the skeleton (readable in zh and en).
    const tf = new Map()
    for (const i of members) {
      for (const w of kws[i]) tf.set(w, (tf.get(w) || 0) + 1)
    }
    let top = [...tf.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([w]) => w)
      .filter((w) => w.length > 1)
      .slice(0, 8)
    if (!top.length) {
      const fallback = new Map()
      for (const i of members) {
        for (const w of docs[i]) fallback.set(w, (fallback.get(w) || 0) + 1)
      }
      top = [...fallback.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([w]) => w)
        .filter((w) => w.length > 1)
        .slice(0, 8)
    }
    const signatures = new Set()
    for (const i of members) signatures.add(records[i]?.tool || '')
    const slotSet = new Set()
    for (const t of samples) for (const s of slotsFrom(t)) slotSet.add(s)
    candidates.push({
      id: 'wf-' + top.slice(0, 3).join('_').replace(/\//g, '-').slice(0, 40),
      count: members.length,
      signatures: [...signatures].filter(Boolean).sort(),
      skeleton_terms: top,
      slots: [...slotSet].sort(),
      samples: samples.slice(0, 5),
      first_ts: records[members[0]]?.ts || '',
      last_ts: records[members[members.length - 1]]?.ts || '',
    })
  }
  candidates.sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1))
  return candidates
}
