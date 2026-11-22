import { HARK_ORIGIN } from './harkClient'

/**
 * Where an embedded Hark web view should go once its account partition gained
 * a valid session. A view still on the login / auth / Cloudflare challenge
 * page (or anywhere off app.hark.com) is sent to the app home; a view already
 * inside the app just reloads (`undefined`).
 */
export function harkWebViewUrlAfterSignIn(currentUrl: string): string | undefined {
  let url: URL
  try {
    url = new URL(currentUrl)
  } catch {
    return HARK_ORIGIN
  }
  if (url.origin !== HARK_ORIGIN) return HARK_ORIGIN
  if (/^\/(?:login|sign-?in|sign-?up|auth)(?:[/?#]|$)/i.test(url.pathname)) return HARK_ORIGIN
  if (url.pathname.startsWith('/cdn-cgi/')) return HARK_ORIGIN
  return undefined
}
