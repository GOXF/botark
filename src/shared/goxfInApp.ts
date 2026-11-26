/** GOXF fork: web pages opened from chat show in a BotArk window first; its menu can move them to the system browser. */
export const GOXF_INAPP_CHANNELS = {
  open: 'goxf:inapp:open'
} as const

export interface InAppOpenRequest {
  url: string
  /** Open with this account's cookies (e.g. a Hark connect flow that comes back to app.hark.com). */
  accountId?: string
  /** The flow is finished once the page reaches a URL starting with this; the window closes itself. */
  doneUrlPrefix?: string
  /** Force the system browser. */
  external?: boolean
}

/** done: reached doneUrlPrefix. closed: the user closed it. external: handed to the system browser. */
export interface InAppOpenResult {
  result: 'done' | 'closed' | 'external'
  url?: string
}

export interface GoxfInAppBridge {
  open(req: InAppOpenRequest): Promise<InAppOpenResult>
}

/** True when `url` is at or under `prefix` (same origin, path starts with the prefix path). */
export function reachedDoneUrl(url: string, prefix: string): boolean {
  try {
    const u = new URL(url)
    const p = new URL(prefix)
    return u.origin === p.origin && u.pathname.replace(/\/+$/, '').startsWith(p.pathname.replace(/\/+$/, ''))
  } catch {
    return false
  }
}
