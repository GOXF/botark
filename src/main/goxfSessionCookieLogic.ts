/**
 * GOXF fork only: pure helpers for goxfSessionCookies.ts (kept Electron-free for tests).
 */
import { basename } from 'node:path'

/** Shape of Electron's Cookie that we keep (session cookies have no expirationDate). */
export interface SavedCookie {
  name: string
  value: string
  domain?: string
  hostOnly?: boolean
  path?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  session?: boolean
}

/** Account partitions only (persist:bothub-account-<id>); login/preview partitions are skipped. */
export function accountPartitionName(storagePath: string | null | undefined): string | null {
  if (!storagePath) return null
  const name = basename(storagePath)
  return /^bothub-account-[\w-]+$/.test(name) ? name : null
}

/** Cookies Electron will not write to disk on its own. */
export function sessionOnly(cookies: SavedCookie[]): SavedCookie[] {
  return cookies.filter((c) => c.session === true && c.name && c.domain)
}

/** Arguments for session.cookies.set() that recreate the cookie as a session cookie. */
export interface SetDetails {
  url: string
  name: string
  value: string
  domain?: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite?: SavedCookie['sameSite']
}

export function toSetDetails(c: SavedCookie): SetDetails {
  const host = (c.domain ?? '').replace(/^\./, '')
  const path = c.path || '/'
  return {
    url: `${c.secure ? 'https' : 'http'}://${host}${path}`,
    name: c.name,
    value: c.value,
    // Host-only cookies must not get a domain, or they would widen to subdomains.
    ...(c.hostOnly ? {} : { domain: c.domain }),
    path,
    secure: c.secure ?? false,
    httpOnly: c.httpOnly ?? false,
    ...(c.sameSite ? { sameSite: c.sameSite } : {})
  }
}
