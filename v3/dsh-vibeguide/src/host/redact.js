// Best-effort masking of obvious secrets before text goes to a model. Not a guarantee.
const PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"']{6,}/gi,
]

export function redact(text) {
  if (typeof text !== 'string') return text
  let out = text
  for (const p of PATTERNS) out = out.replace(p, (m) => m.startsWith('-----') ? '[已隐藏的密钥]' : m.replace(/[^:=\s"']{6,}$/, '[已隐藏]'))
  return out
}
