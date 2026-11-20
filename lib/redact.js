/**
 * Secret redaction - never persist secrets even from a trusted local hook.
 * Mirrors codex-flowkiln/scripts/wfminer.py SECRET_RULES exactly.
 */

export const SECRET_RULES = [
  [/sk-[A-Za-z0-9_-]{16,}/g, '<redacted:openai-key>'],
  [/ghp_[A-Za-z0-9]{20,}/g, '<redacted:github-pat>'],
  [/\bbearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer <redacted>'],
  [/\b(api[-_]?key|secret|token)\s*[:=]\s*\S+/gi, '$1=<redacted>'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<redacted:email>'],
]

export function redact(text) {
  let out = String(text ?? '')
  for (const [pattern, replacement] of SECRET_RULES) {
    out = out.replace(pattern, replacement)
  }
  return out
}
