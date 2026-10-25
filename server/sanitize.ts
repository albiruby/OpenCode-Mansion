/** Text sanitization for anything leaving the bridge (WS broadcast + console). */

const ANSI = /\u001b\[[0-9;]*m/g;
const CONTROL =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\ufeff]/g;

/**
 * Best-effort secret masking. Tool inputs frequently contain credentials
 * (`TOKEN=...`, `Authorization: Bearer ...`, provider keys), and this bridge is
 * read-only plumbing — it must never reshare them with dashboard clients.
 */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/(\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY)[A-Za-z0-9_]*\s*[:=]\s*["']?)([^\s"'`,;]+)/gi, '$1[REDACTED]'],
  [/(\bAuthorization\s*:\s*(?:Bearer|Basic)\s+)([^\s"',;]+)/gi, '$1[REDACTED]'],
  [/(\bBearer\s+)([A-Za-z0-9._~+/=-]{16,})/g, '$1[REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]'],
  [/\bghp_[A-Za-z0-9]{20,}\b/g, '[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/\bMLY\|[A-Za-z0-9|]{10,}\b/g, '[REDACTED]'],
  [/([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^@\s/]+)(@)/gi, '$1[REDACTED]$3'],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function clean(value: unknown, max = 500): string {
  const text =
    typeof value === 'string'
      ? value
      : value === undefined || value === null
        ? ''
        : JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
  return redactSecrets(text.replace(ANSI, '').replace(CONTROL, ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function errorText(err: unknown): string {
  if (!err || typeof err !== 'object') return clean(err, 300);
  const e = err as Record<string, unknown>;
  for (const key of ['message', 'reason', 'name', 'type', 'description']) {
    if (typeof e[key] === 'string' && e[key]) return clean(e[key], 300);
  }
  return clean(err, 300);
}
