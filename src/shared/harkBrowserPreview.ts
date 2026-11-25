export interface HarkBrowserPreview {
  label: string
  status: string
  screenshotKey?: string
  screenshotUrl?: string
}

export const HARK_PREVIEW_MAX_BYTES = 8 * 1024 * 1024
export const HARK_PREVIEW_TIMEOUT_MS = 12_000

/** A browser run counts as live until its status says it ended (Hark uses running / in_progress / pending / waiting_for_input…). */
export const HARK_BROWSER_ENDED = /complete|done|success|finish|fail|error|cancel|abort|timeout|stop|ended|closed|expired/i
export const harkBrowserLive = (status: string): boolean => !HARK_BROWSER_ENDED.test(status)

interface Panel {
  /** Derived from the dispatching tool call: its status is the call's, not the browser run's. */
  fromToolCall?: boolean
  kind: string
  status: string
  title?: string
  url?: string
  liveViewUrl?: string
  screenshotKey?: string
  screenshotUrl?: string
}

export function currentHarkBrowser(panels: Panel[]): HarkBrowserPreview | null {
  const browsers = panels.filter((p) => p.screenshotKey || p.screenshotUrl || p.liveViewUrl || /browser|computer/i.test(p.kind))
  // Hark's own browser panels first; tool-call stand-ins only when it has none.
  const own = browsers.filter((p) => !p.fromToolCall)
  const pool = own.length ? own : browsers
  const panel = pool.findLast((p) => harkBrowserLive(p.status)) ?? pool.at(-1)
  if (!panel) return null
  return {
    label: panel.url || panel.title || panel.kind, status: panel.status,
    ...harkScreenshotReference(panel.screenshotKey, panel.screenshotUrl)
  }
}

export function harkScreenshotReference(key?: string, directUrl?: string): Pick<HarkBrowserPreview, 'screenshotKey' | 'screenshotUrl'> {
  const cleanKey = key?.trim()
  const screenshotKey = cleanKey && !/^(?:[a-z][a-z0-9+.-]*:|[/\\])/i.test(cleanKey) ? cleanKey : undefined
  let screenshotUrl: string | undefined
  if (!screenshotKey && directUrl && URL.canParse(directUrl, 'https://app.hark.com')) {
    const url = new URL(directUrl, 'https://app.hark.com')
    if (url.protocol === 'https:' && !url.username && !url.password &&
      (url.hostname === 'hark.com' || url.hostname.endsWith('.hark.com'))) screenshotUrl = url.href
  }
  return { screenshotKey, screenshotUrl }
}
