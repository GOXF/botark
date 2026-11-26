import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Cookie, CookiesSetDetails } from 'electron'
import { ANTIGRAVITY_CHANNELS, type AntigravityAuthStatus } from '@shared/ipc'
import { isGoogleFirefoxCompatMode } from '../googleOAuthUaGuard'
import { parseAntigravityCredentials } from './antigravityCredentials'
import { getAntigravityAuthUser, probeAntigravitySession } from './antigravityClient'
import { registerAntigravityIpc } from './antigravityIpc'
import { closeAntigravityLoginWindow, openAntigravityLoginWindow } from './antigravityLogin'

const { fromPartition, handle, send, openExternal, onNewWindow } = vi.hoisted(() => ({
  fromPartition: vi.fn(),
  handle: vi.fn(),
  send: vi.fn(),
  openExternal: vi.fn(async () => undefined),
  onNewWindow: vi.fn()
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class TestWebContents extends EventEmitter {
    private url = ''
    private ua = ''
    windowOpenHandler?: (event: { url: string }) => void
    loadURL = async (url: string) => { this.url = url }
    getURL = () => this.url
    getUserAgent = () => this.ua
    setUserAgent = vi.fn((ua: string) => { this.ua = ua })
    executeJavaScript = vi.fn(async (_script: string) => 'This browser or app may not be secure')
    setWindowOpenHandler = (handler: (event: { url: string }) => void) => {
      this.windowOpenHandler = handler
    }
    isDestroyed = () => false
  }
  class TestBrowserWindow extends EventEmitter {
    private destroyed = false
    webContents = new TestWebContents()
    constructor() {
      super()
      onNewWindow(this)
    }
    static getAllWindows = () => [{ isDestroyed: () => false, webContents: { send } }]
    isDestroyed = () => this.destroyed
    loadURL = (url: string) => this.webContents.loadURL(url)
    destroy = () => {
      this.destroyed = true
      this.emit('closed')
    }
  }
  return {
    session: { fromPartition },
    ipcMain: { handle },
    BrowserWindow: TestBrowserWindow,
    shell: { openExternal }
  }
})
vi.mock('../appIcon', () => ({ getAppWindowIcon: () => undefined }))
vi.mock('../muse/accountProxy', () => ({ applyProxyToPartition: async () => undefined }))
vi.mock('../webContentsViewManager', () => ({ partitionForAccount: (id: string) => 'partition-' + id }))

describe('Antigravity credential input', () => {
  it('imports raw Cookie headers and key-value JSON without truncating equals signs', () => {
    for (const input of [
      'Cookie: SAPISID=fixture==; __Secure-1PAPISID=fixture-1p; SID=fixture-sid',
      JSON.stringify({ SAPISID: 'fixture==', '__Secure-1PAPISID': 'fixture-1p', SID: 'fixture-sid' }),
      JSON.stringify({ cookieHeader: 'SAPISID=fixture==; __Secure-1PAPISID=fixture-1p; SID=fixture-sid' })
    ]) {
      expect(parseAntigravityCredentials(input).cookies).toMatchObject([
        { name: 'SAPISID', value: 'fixture==', domain: '.google.com', secure: true, httpOnly: true },
        { name: '__Secure-1PAPISID', value: 'fixture-1p', domain: '.google.com', secure: true },
        { name: 'SID', value: 'fixture-sid', domain: '.google.com' }
      ])
    }
  })

  it('imports Bash cURL header and cookie flags and uses the request account index', () => {
    const input = [
      "curl 'https://antigravity.google.com/?authuser=1' \\",
      "  -H 'Cookie: SAPISID=fixture==; SID=fixture-sid' \\",
      "  --cookie='__Secure-3PAPISID=fixture-3p' \\",
      "  -H 'X-Goog-AuthUser: 2' \\",
      "  --data-raw '-b' 'IGNORED=fake-data'"
    ].join('\n')
    expect(parseAntigravityCredentials(input)).toMatchObject({
      authUser: '2',
      cookies: [
        { name: 'SAPISID', value: 'fixture==' },
        { name: 'SID', value: 'fixture-sid' },
        { name: '__Secure-3PAPISID', value: 'fixture-3p' }
      ]
    })

    const ansiCQuoted = "curl --url 'https://antigravity.google.com/u/1/' -b $'SAPISID=unsafe\\u0021fixture\\'s'"
    expect(parseAntigravityCredentials(ansiCQuoted)).toMatchObject({
      authUser: '1',
      cookies: [{ name: 'SAPISID', value: "unsafe!fixture's" }]
    })
  })

  it('parses Chrome and Edge Windows cmd exports, including CRLF and escaped characters', () => {
    const input = [
      'curl.exe --url ^"https://antigravity.google.com/^?entry=app^&authuser=1^" ^',
      '  -H ^"X-Goog-AuthUser: 3^" ^',
      '  -b ^"SAPISID=abc^&def%^^ghi; __Secure-3PAPISID=hello^^there; SID=fixture-sid^" ^',
      '  -H ^"Cookie: NID=second^"'
    ].join('\r\n')
    expect(parseAntigravityCredentials(input)).toMatchObject({
      authUser: '3',
      cookies: [
        { name: 'SAPISID', value: 'abc&def%^ghi' },
        { name: '__Secure-3PAPISID', value: 'hello^there' },
        { name: 'SID', value: 'fixture-sid' },
        { name: 'NID', value: 'second' }
      ]
    })
  })

  it('uses valid Cookie-Editor metadata and drops unrelated or expired cookies', () => {
    const input = JSON.stringify([
      { name: 'SAPISID', value: 'fixture', domain: '.google.com', path: '/', secure: false, httpOnly: false, expirationDate: 2000 },
      { name: '__Secure-1PAPISID', value: 'fixture-1p', domain: 'aicode.clients6.google.com', secure: false, sameSite: 'no_restriction', session: true },
      { name: '__Host-fixture', value: 'fixture-host', domain: 'antigravity.google.com', secure: false, path: '/wrong' },
      { name: 'NID', value: 'expired', domain: '.google.com', expirationDate: 1000 },
      { name: 'SID', value: 'unrelated', domain: 'example.com' },
      { name: 'SID', value: 'lookalike', domain: 'antigravity.google.com.example.com' }
    ])
    expect(parseAntigravityCredentials(input, 1000).cookies).toMatchObject([
      { name: 'SAPISID', url: 'https://google.com/', domain: '.google.com', path: '/', expirationDate: 2000, secure: false, httpOnly: false },
      { name: '__Secure-1PAPISID', url: 'https://aicode.clients6.google.com/', domain: undefined, secure: true, expirationDate: undefined, sameSite: 'no_restriction' },
      { name: '__Host-fixture', url: 'https://antigravity.google.com/', domain: undefined, secure: true, path: '/' }
    ])
  })

  it.each([
    'NID=fixture; SID=fixture',
    'SAPISID=',
    'Cookie: SAPISID=first\r\nX-Header: injected',
    '[{"name":"SAPISID","value":"fixture","domain":"google.com.example.org"}]',
    'curl https://antigravity.google.com/ --cookie /some/local/file'
  ])('requires a valid signing cookie from supported input (%s)', (input) => {
    expect(() => parseAntigravityCredentials(input)).toThrow('SAPISID')
  })

  it('rejects unrelated cURL destinations and malformed JSON', () => {
    expect(() => parseAntigravityCredentials("curl 'https://example.com/' -b 'SAPISID=fixture'")).toThrow('Google 请求')
    expect(() => parseAntigravityCredentials('{"SAPISID":"fixture"')).toThrow('JSON')
  })
})

function makeSession(initial: Cookie[]) {
  let jar = [...initial]
  const cookies = {
    get: vi.fn(async ({ url }: { url?: string }) => {
      if (!url) return [...jar]
      const { hostname, pathname } = new URL(url)
      return jar.filter((cookie) => {
        const domain = cookie.domain?.replace(/^\./, '')
        return (hostname === domain || (!cookie.hostOnly && hostname.endsWith('.' + domain))) &&
          pathname.startsWith(cookie.path || '/')
      })
    }),
    set: vi.fn(async (details: CookiesSetDetails) => {
      const domain = details.domain ?? new URL(details.url).hostname
      const path = details.path ?? '/'
      jar = jar.filter((cookie) => cookie.name !== details.name || cookie.domain !== domain || cookie.path !== path)
      if (details.expirationDate === undefined || details.expirationDate > Date.now() / 1000) {
        jar.push({
          name: details.name ?? '',
          value: details.value ?? '',
          domain,
          hostOnly: details.domain === undefined,
          path,
          secure: details.secure ?? false,
          httpOnly: details.httpOnly ?? false,
          sameSite: details.sameSite ?? 'lax',
          expirationDate: details.expirationDate
        })
      }
    }),
    on: vi.fn(),
    off: vi.fn(),
    remove: vi.fn(async (_url: string, name: string) => {
      jar = jar.filter((cookie) => cookie.name !== name)
    }),
    flushStore: vi.fn(async () => undefined)
  }
  return {
    cookies,
    fetch: vi.fn<(_url: string, _options: RequestInit) => Promise<Response>>(),
    getUserAgent: () => 'Chrome/147.0.0.0',
    clearStorageData: vi.fn(async () => { jar = [] })
  }
}

const oldCookie: Cookie = {
  name: 'SAPISID',
  value: 'previous-session',
  domain: '.google.com',
  hostOnly: false,
  path: '/',
  secure: true,
  httpOnly: false,
  sameSite: 'no_restriction',
  expirationDate: 2_000_000_000
}
const nonGoogleCookie: Cookie = {
  name: 'other',
  value: 'unrelated',
  domain: 'example.com',
  hostOnly: true,
  path: '/',
  sameSite: 'lax'
}

describe('Antigravity credential import IPC', () => {
  let handler: (event: unknown, request: unknown) => Promise<AntigravityAuthStatus>
  const invoke = (rawInput: unknown, accountId = 'import') => handler({}, { accountId, rawInput })

  beforeAll(() => {
    registerAntigravityIpc()
    handler = handle.mock.calls.find(([channel]) => channel === ANTIGRAVITY_CHANNELS.importCredentials)?.[1]
  })

  beforeEach(() => {
    send.mockClear()
    openExternal.mockClear()
    onNewWindow.mockClear()
    fromPartition.mockReset()
  })

  it('verifies the imported session in the selected partition, then broadcasts sign-in', async () => {
    const ses = makeSession([oldCookie, nonGoogleCookie])
    fromPartition.mockReturnValue(ses)
    ses.fetch.mockImplementationOnce(async (_url, request) => {
      expect(new Headers(request.headers).get('X-Goog-AuthUser')).toBe('2')
      expect(request.credentials).toBe('include')
      expect(await ses.cookies.get({ url: 'https://aicode.clients6.google.com' })).toMatchObject([
        { name: 'SAPISID', value: 'new-session' },
        { name: 'SID', value: 'new-sid' }
      ])
      expect(send).not.toHaveBeenCalled()
      return Response.json(['person@example.com', ['pro', 'Google AI Pro']])
    })

    await expect(invoke("curl 'https://antigravity.google.com/?authuser=2' -b 'SAPISID=new-session; SID=new-sid'")).resolves.toMatchObject({
      accountId: 'import', signedIn: true, handle: 'person@example.com', displayName: 'person',
      planDisplayName: 'Google AI Pro', sessionCookieNames: ['SAPISID', 'SID']
    })
    expect(fromPartition.mock.calls.every(([partition]) => partition === 'partition-import')).toBe(true)
    expect(ses.cookies.flushStore).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledExactlyOnceWith(ANTIGRAVITY_CHANNELS.event, {
      type: 'login', accountId: 'import', signedIn: true, handle: 'person@example.com',
      displayName: 'person', planDisplayName: 'Google AI Pro'
    })
  })

  it('rolls back old cookies and the verified account index when Google rejects the staged session', async () => {
    const previousSid = { ...oldCookie, name: 'SID', value: 'old-sid', domain: 'antigravity.google.com', hostOnly: true, path: '/settings' }
    const ses = makeSession([oldCookie, previousSid, nonGoogleCookie])
    fromPartition.mockReturnValue(ses)
    ses.fetch.mockResolvedValueOnce(Response.json(['old@example.com']))
    await expect(probeAntigravitySession('import', '4')).resolves.toMatchObject({ signedIn: true })
    ses.fetch.mockImplementation(async () => {
      expect(await ses.cookies.get({ url: 'https://antigravity.google.com/settings' })).toMatchObject([
        { name: 'SAPISID', value: 'wrong-session' },
        { name: '__Host-new', value: 'new-host-cookie' }
      ])
      return Response.json([16, 'Unauthenticated'], { status: 401 })
    })

    const status = await invoke('SAPISID=wrong-session; __Host-new=new-host-cookie')

    expect(status).toMatchObject({ signedIn: false, error: expect.stringContaining('HTTP 401') })
    expect(await ses.cookies.get({})).toEqual(expect.arrayContaining([oldCookie, previousSid, nonGoogleCookie]))
    expect(await ses.cookies.get({})).toHaveLength(4)
    await expect(getAntigravityAuthUser('import')).resolves.toBe('4')
    expect(ses.cookies.flushStore).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalled()
  })

  it('rolls back a partial cookie write before attempting verification', async () => {
    const ses = makeSession([oldCookie])
    fromPartition.mockReturnValue(ses)
    const write = ses.cookies.set.getMockImplementation()!
    ses.cookies.set.mockImplementation(async (cookie) => {
      if (cookie.name === 'SID') throw new Error('fixture write failure')
      await write(cookie)
    })

    await expect(invoke('SAPISID=staged; SID=failed-write')).resolves.toMatchObject({
      signedIn: false, error: expect.stringContaining('无法写入')
    })
    expect(await ses.cookies.get({})).toEqual([oldCookie])
    expect(ses.fetch).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('rolls back the verified account index and cookies if they cannot be flushed', async () => {
    const ses = makeSession([oldCookie])
    fromPartition.mockReturnValue(ses)
    ses.fetch.mockResolvedValueOnce(Response.json(['person@example.com']))
    ses.cookies.flushStore.mockRejectedValueOnce(new Error('fixture disk failure'))

    await expect(invoke('SAPISID=uncommitted')).resolves.toMatchObject({ signedIn: false })
    expect(await ses.cookies.get({})).toEqual([oldCookie])
    await expect(getAntigravityAuthUser('import')).resolves.toBeUndefined()
    expect(send).not.toHaveBeenCalled()
  })

  it('validates before writing and returns a helpful error', async () => {
    const ses = makeSession([oldCookie])
    fromPartition.mockReturnValue(ses)
    await expect(invoke('SID=not-enough')).resolves.toMatchObject({
      signedIn: false, error: expect.stringContaining('SAPISID')
    })
    await expect(invoke(42)).rejects.toThrow(TypeError)
    expect(ses.cookies.set).not.toHaveBeenCalled()
    expect(ses.fetch).not.toHaveBeenCalled()
  })

  it('hands off to the external browser once on Google block, supports manual reopen and compat retry, and settles after import', async () => {
    const ses = makeSession([])
    fromPartition.mockReturnValue(ses)
    await openAntigravityLoginWindow('import')
    const win = onNewWindow.mock.lastCall?.[0]
    const wc = win.webContents
    try {
      await wc.loadURL('https://accounts.google.com/v3/signin/rejected')
      wc.emit('did-finish-load')
      await vi.waitFor(() => expect(wc.executeJavaScript).toHaveBeenCalledWith(
        expect.stringContaining('Copy as cURL'),
        true
      ))
      expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://antigravity.google.com/')
      wc.windowOpenHandler({ url: 'botark-external://open' })
      expect(openExternal).toHaveBeenCalledTimes(2)
      expect(openExternal).toHaveBeenLastCalledWith('https://antigravity.google.com/')
      wc.windowOpenHandler({ url: 'botark-action://retry-firefox-ua' })
      expect(wc.setUserAgent).toHaveBeenLastCalledWith(expect.stringContaining('Firefox/'))
      expect(isGoogleFirefoxCompatMode(ses as never)).toBe(true)
      await vi.waitFor(() => expect(ses.cookies.remove).toHaveBeenCalledWith('https://accounts.google.com/', '__Host-GAPS'))

      ses.fetch.mockResolvedValueOnce(Response.json(['person@example.com']))
      await expect(invoke('SAPISID=new-session')).resolves.toMatchObject({ signedIn: true })

      expect(win.isDestroyed()).toBe(true)
      expect(isGoogleFirefoxCompatMode(ses as never)).toBe(false)
      expect(ses.cookies.off).toHaveBeenCalledWith('changed', expect.any(Function))
      expect(send).toHaveBeenCalledOnce()
    } finally {
      closeAntigravityLoginWindow('import')
    }
  })
})
