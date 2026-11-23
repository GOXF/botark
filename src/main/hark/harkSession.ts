import {
  extractHandle,
  getAuthSession,
  getProfile,
  HarkApiError,
  preparedSessionForAccount,
  type HarkAuthSession
} from './harkClient'

export type HarkSessionProbe =
  | {
      session: NonNullable<HarkAuthSession>
      handle?: string
      displayName?: string
      userId?: string
    }
  | { signedIn: false }

/** GET /api/auth/get-session decides signed-in; /profile only supplies the display name. */
export async function probeHarkSession(
  accountId: string,
  options?: { reportConnectionErrors?: boolean }
): Promise<HarkSessionProbe> {
  let session: HarkAuthSession
  try {
    session = await getAuthSession(accountId)
  } catch (error) {
    if (options?.reportConnectionErrors && !(error instanceof HarkApiError && error.status === 401)) {
      throw new Error('无法验证 Hark 会话，请检查网络或代理后再刷新')
    }
    // Login polling treats failed probes as pending until the window closes.
    if (process.env['BOTHUB_HARK_DEBUG'] === '1') {
      console.warn('[hark] get-session probe failed')
    }
    return { signedIn: false }
  }
  if (!session || !(session.user || session.session)) return { signedIn: false }

  const profile = await getProfile(accountId, true).catch(() => null) as
    { email?: unknown; name?: unknown; nickname?: unknown } | null
  const handle = extractHandle(session)
  const nickname = typeof profile?.nickname === 'string' && profile.nickname.trim() ? profile.nickname : undefined
  const name = nickname ?? (typeof profile?.name === 'string' && profile.name.trim() ? profile.name : undefined)
  return { session, ...handle, ...(name ? { displayName: name } : {}) }
}

/** BOTHUB_HARK_DEBUG=1 only: what the account's partition holds at startup. Never logs cookie values. */
export async function logHarkSessionDebug(accountId: string): Promise<void> {
  const ses = await preparedSessionForAccount(accountId)
  const cookies = (await ses.cookies.get({})).filter((c) => /(^|\.)hark\.com$/i.test(c.domain ?? ''))
  const status = (p: Promise<unknown>) =>
    p.then((data) => (data == null ? '200 (null)' : '200'), (e: unknown) =>
      e instanceof HarkApiError ? String(e.status) : `error: ${e instanceof Error ? e.message : String(e)}`)
  const [getSession, profile] = await Promise.all([status(getAuthSession(accountId)), status(getProfile(accountId, true))])
  console.info(`[hark] startup ${accountId}: get-session=${getSession} profile=${profile} cookies=${JSON.stringify(
    cookies.map((c) => ({ name: c.name, domain: c.domain, session: c.session, expirationDate: c.expirationDate }))
  )}`)
}
