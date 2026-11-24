import { beforeEach, describe, expect, it, vi } from 'vitest'

const persistCueTokens = vi.fn(async (accountId: string, tokens: Record<string, unknown>, opts?: { shouldSave: () => boolean }) => ({
  accountId,
  handle: tokens['handle'],
  displayName: tokens['displayName'],
  accountSlot: tokens['accountSlot'],
  ...(opts?.shouldSave() === false ? { accountId: '' } : {})
}))
const openExternal = vi.fn(async (_url: string) => undefined)
const isDefaultProtocolClient = vi.fn(() => true)
const setAsDefaultProtocolClient = vi.fn(() => false)
const credentialRevision = Symbol()

vi.mock('electron', () => ({
  app: { isDefaultProtocolClient: () => isDefaultProtocolClient(), setAsDefaultProtocolClient: () => setAsDefaultProtocolClient() },
  shell: { openExternal: (url: string) => openExternal(url) }
}))
vi.mock('./cueAuth', () => ({
  decodeJwtClaims: () => ({ handle: 'me@example.com', displayName: 'me' }),
  getCueCredentialRevision: () => credentialRevision,
  persistCueTokens: (...args: Parameters<typeof persistCueTokens>) => persistCueTokens(...args)
}))

const mod = await import('./cueDesktopHandoff')

describe('Cue system-browser login hand-off', () => {
  beforeEach(() => {
    persistCueTokens.mockClear()
    openExternal.mockClear()
  })

  it("builds cue.im's desktop login URL with the cuedev scheme and nonce", () => {
    const url = new URL(mod.buildCueBrowserLoginUrl('abc123'))
    expect(url.origin + url.pathname).toBe('https://cue.im/login')
    expect(url.searchParams.get('from')).toBe('desktop')
    expect(url.searchParams.get('desktopAgents')).toBe('1')
    expect(url.searchParams.get('agentsScheme')).toBe('cuedev')
    expect(url.searchParams.get('nonce')).toBe('abc123')
    const redirect = new URL(url.searchParams.get('redirectUrl')!)
    expect(redirect.pathname).toBe('/login-success')
    expect(redirect.searchParams.get('nonce')).toBe('abc123')
  })

  const cb = (scheme: string, route: string, q: Record<string, string>) =>
    `${scheme}://${route}?${new URLSearchParams(q).toString()}`

  it('parses only well-formed desktop callbacks', () => {
    expect(mod.parseCueDesktopCallback(cb('cuedev', 'oauth/desktop-callback', { token: 'T.k', nonce: 'n1' }))).toEqual({
      token: 'T.k',
      nonce: 'n1'
    })
    expect(mod.parseCueDesktopCallback(cb('cue', 'oauth/desktop-callback', { token: 'T', nonce: 'n' }))).toBeNull()
    expect(mod.parseCueDesktopCallback(cb('cuedev', 'other', { token: 'T', nonce: 'n' }))).toBeNull()
    expect(mod.parseCueDesktopCallback(cb('cuedev', 'oauth/desktop-callback', { token: 'T' }))).toBeNull()
    expect(mod.findCueCallbackArg(['BotArk.exe', '--flag', 'cuedev://oauth/desktop-callback?x=1'])).toBe(
      'cuedev://oauth/desktop-callback?x=1'
    )
  })

  it('opens the browser and signs the right account in when the callback returns', async () => {
    const events: unknown[] = []
    mod.onCueHandoffSignedIn((ev) => events.push(ev))
    await mod.startCueBrowserLogin('acc_cue_1')
    expect(openExternal).toHaveBeenCalledTimes(1)
    const issued = new URL(String(openExternal.mock.calls[0]![0])).searchParams.get('nonce')!
    const callback = cb('cuedev', 'oauth/desktop-callback', { token: 'jwt.token.value', nonce: issued })
    expect(await mod.handleCueDesktopCallbackUrl(callback)).toBe(true)
    expect(persistCueTokens).toHaveBeenCalledWith(
      'acc_cue_1',
      expect.objectContaining({
        accessToken: 'jwt.token.value',
        cookies: [
          { name: 'cue_session_id', value: 'jwt.token.value', domain: '.cue.im', path: '/' },
          { name: 'session_id', value: 'jwt.token.value', domain: '.manus.im', path: '/' }
        ]
      }),
      expect.objectContaining({ shouldSave: expect.any(Function) })
    )
    expect(events).toEqual([expect.objectContaining({ accountId: 'acc_cue_1', signedIn: true, handle: 'me@example.com' })])
    // A nonce works once only.
    expect(await mod.handleCueDesktopCallbackUrl(callback)).toBe(false)
  })

  it('rejects callbacks with unknown or expired nonces', async () => {
    expect(await mod.handleCueDesktopCallbackUrl(cb('cuedev', 'oauth/desktop-callback', { token: 'T', nonce: 'nope' }))).toBe(false)
    const old = mod.issueCueLoginNonce('acc_old', 0)
    expect(mod.consumeCueLoginNonce(old, 31 * 60 * 1000)).toBeNull()
    expect(persistCueTokens).not.toHaveBeenCalled()
  })

  it('reports protocol registration failure before opening the browser and revokes failed launches', async () => {
    isDefaultProtocolClient.mockReturnValueOnce(false)
    await expect(mod.startCueBrowserLogin('launch-fixture')).rejects.toThrow('无法注册')
    expect(openExternal).not.toHaveBeenCalled()

    openExternal.mockRejectedValueOnce(new Error('Cannot launch browser'))
    await expect(mod.startCueBrowserLogin('launch-fixture')).rejects.toThrow('Cannot launch browser')
    const nonce = new URL(openExternal.mock.calls[0]![0]).searchParams.get('nonce')!
    expect(await mod.handleCueDesktopCallbackUrl(cb('cuedev', 'oauth/desktop-callback', { token: 'T', nonce }))).toBe(false)
    expect(persistCueTokens).not.toHaveBeenCalled()
  })

  it('rechecks that the claimed nonce is active before saving credentials', async () => {
    const nonce = mod.issueCueLoginNonce('cancel-fixture')
    let commit!: () => void
    persistCueTokens.mockImplementationOnce((accountId, _tokens, opts) => new Promise((resolve, reject) => {
      commit = () => {
        if (opts?.shouldSave()) resolve({ accountId, handle: undefined, displayName: undefined, accountSlot: undefined })
        else reject(new Error('Revoked'))
      }
    }))
    const result = mod.handleCueDesktopCallbackUrl(cb('cuedev', 'oauth/desktop-callback', { nonce, token: 'T' }))
    mod.revokeCueLoginNonce('cancel-fixture')
    commit()
    expect(await result).toBe(false)
  })
})
