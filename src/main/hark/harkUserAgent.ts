/**
 * One User-Agent for everything Hark sees from an account partition.
 *
 * Cloudflare Turnstile (email login on app.hark.com) fails with "Verifying…"
 * → "Complete the verification and try again." when the UA string is
 * hand-edited (e.g. `Electron/…` / `BotArk/…` stripped) while the engine's own
 * fingerprint (navigator.userAgentData, workers on `app.userAgentFallback`)
 * still describes stock Electron, or when the UA changes during the session
 * (cf cookies are bound to the UA that earned them). See
 * github.com/akriaueno/electron-turnstile-repro and
 * developers.cloudflare.com/turnstile ("Consistent User Agent throughout the session").
 *
 * So: Hark pages, Cloudflare challenge frames and our own REST calls all use
 * Electron's native UA. Only Google's OAuth pages (which reject UAs naming
 * Electron with `disallowed_useragent`) get the cleaned Chrome UA.
 */

import { app } from 'electron'

/** Last-resort UA when Electron's native fallback is unavailable (unit tests). */
export const HARK_FALLBACK_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'

/** Electron's own, unedited UA: what the engine's Client Hints and workers report. */
export function harkNativeUserAgent(): string {
  try {
    const ua = app?.userAgentFallback
    if (typeof ua === 'string' && ua.trim()) return ua
  } catch {
    /* electron mock without `app` */
  }
  return HARK_FALLBACK_USER_AGENT
}

/** Strip `Electron/…` and the app token; for Google OAuth pages only. */
export function cleanChromeUserAgent(rawUa: string): string {
  return rawUa
    .replace(/\s+Electron\/[\d.]+/gi, '')
    .replace(/\s+(?:BotArk|BotHub)\/[\d.a-z-]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const GOOGLE_AUTH_HOST = /^(?:accounts\.google\.com|accounts\.youtube\.com|(?:[\w-]+\.)*google\.com)$/i

/** Google sign-in hosts that need the cleaned UA (never hark.com / cloudflare.com). */
export function isGoogleAuthUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    return GOOGLE_AUTH_HOST.test(u.hostname)
  } catch {
    return false
  }
}

/** UA the Hark login window should present for a navigation to `url`. */
export function harkLoginUserAgentFor(url: string, nativeUa: string): string {
  return isGoogleAuthUrl(url) ? cleanChromeUserAgent(nativeUa) : nativeUa
}
