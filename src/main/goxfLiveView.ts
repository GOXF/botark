import { app, session } from 'electron'
import { partitionForAccount } from './webContentsViewManager'

const LIVE_VIEW = /^https:\/\/app\.hark\.com\/api\/liveview\/view\?t=[\w-]+$/

/**
 * GOXF 2026-11-26: Hark shows its remote browser through /api/liveview/view?t=… (a token page whose relay only
 * streams to a viewer signed in to Hark). The chat shows it in a <webview partition="hark-live:<accountId>">:
 * only that page may attach, it gets the Hark account's real partition (so its sign-in cookie goes along),
 * and it runs with no preload, no node and a sandbox. Anything else is refused.
 */
export function allowHarkLiveViewFrames(): void {
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (event, prefs, params) => {
      const src = String(params.src ?? '')
      const part = String(prefs.partition ?? params.partition ?? '')
      const accountId = part.startsWith('hark-live:') ? part.slice('hark-live:'.length) : ''
      if (!LIVE_VIEW.test(src) || !accountId) {
        event.preventDefault()
        return
      }
      delete prefs.preload
      prefs.nodeIntegration = false
      prefs.nodeIntegrationInSubFrames = false
      prefs.contextIsolation = true
      prefs.sandbox = true
      prefs.partition = partitionForAccount(accountId)
    })
    // A live view never navigates away or opens windows.
    if (contents.getType() === 'webview') {
      contents.on('will-navigate', (event, url) => { if (!LIVE_VIEW.test(url)) event.preventDefault() })
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    }
  })
  // Kept for any plain frame of the page (older builds): drop its frame headers.
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
