/** Best-effort data minimization, not a claim of comprehensive secret detection. */
export function redact(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[已过滤私钥]')
    .replace(/\b(?:sk|pk|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{16,}\b/g, '[已过滤凭证]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [已过滤凭证]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1[已过滤凭证]');
}
