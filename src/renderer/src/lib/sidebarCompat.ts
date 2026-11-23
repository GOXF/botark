/**
 * Shared compatibility & graceful-degradation helpers for right-sidebar inspector panels.
 *
 * Upstream platforms (Muse, Grok, Hark, Dot, Hermes, Antigravity) frequently rotate,
 * gate, or retire secondary sidebar endpoints (404 / 405 / 409 / 410 / 501 / unimplemented /
 * unknown_method / rotated Next.js Server Actions). Sidebar panels should degrade quietly
 * to an unavailable/empty state instead of spamming raw HTTP/JSON error walls.
 */

export function isOnlineAccountStatus(status: string | undefined): boolean {
  return status === 'online' || status === 'busy' || status === 'attention'
}

export function isIncompatibleApiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : String(err ?? '')
  if (!msg) return false
  return /\b(404|405|409|410|501)\b|not[\s_-]?found|unimplemented|unsupported|unknown[\s_-]?method|method[\s_-]?not[\s_-]?allowed|action[\s_-]?not[\s_-]?found|no[\s_-]?such[\s_-]?method|route[\s_-]?not[\s_-]?found|invalid_params|missing field|cannot\s+(?:get|post|put|patch|delete)\b|retired|deprecated|unavailable|not signed in|sign in to .* first|not ready|ipc unavailable|invalid json/i.test(
    msg
  )
}

/**
 * Returns `undefined` for retired/incompatible/offline sidebar API errors (so the section
 * can quietly show its empty/unavailable state), or a concise single-line message for real errors.
 */
export function cleanSidebarError(err: unknown): string | undefined {
  if (isIncompatibleApiError(err)) return undefined
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : String(err ?? '')
  const trimmed = raw.replace(/\s+/g, ' ').trim()
  if (!trimmed) return undefined
  return trimmed.length > 140 ? `${trimmed.slice(0, 140)}…` : trimmed
}
