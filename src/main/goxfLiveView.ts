import { session } from 'electron'

/**
 * GOXF 2026-11-26: Hark shows its remote browser through /api/liveview/view?t=… (a token-authenticated canvas page).
 * It sends X-Frame-Options: SAMEORIGIN, so the chat's iframe would stay blank; drop the frame headers for that page only.
 */
export function allowHarkLiveViewFrames(): void {
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['https://app.hark.com/api/liveview/view*'] }, (details, callback) => {
    const headers = { ...(details.responseHeaders ?? {}) }
    for (const name of Object.keys(headers)) {
      if (/^x-frame-options$/i.test(name)) delete headers[name]
      else if (/^content-security-policy$/i.test(name)) {
        headers[name] = headers[name]!.map((v) => v.replace(/frame-ancestors[^;]*;?/gi, ''))
      }
    }
    callback({ responseHeaders: headers })
  })
}
