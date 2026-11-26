import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildChromeClientHints,
  buildGoogleFirefoxCompatUa,
  buildGoogleOAuthMainWorldPatchScript,
  buildGoogleOAuthPreloadScriptSource,
  cleanChromeUserAgentForGoogle,
  GOOGLE_OAUTH_PRELOAD_ID,
  GOOGLE_OAUTH_URL_PATTERNS,
  installGoogleOAuthHeaderGuard,
  isGoogleAuthHostUrl,
  isGoogleBlockedOrPasskeyText,
  sanitizeGoogleRequestHeaders,
  setGoogleFirefoxCompatMode
} from './googleOAuthUaGuard'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botark-oauth-guard-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('googleOAuthUaGuard', () => {
  it('strips Electron and BotArk tokens from User-Agent and Sec-CH-UA headers across OS platforms', () => {
    const rawWin =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) BotArk/0.12.1 Chrome/147.0.7103.49 Electron/45.2.1 Safari/537.36'
    expect(cleanChromeUserAgentForGoogle(rawWin, '147.0.7103.49', 'win32')).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7103.49 Safari/537.36'
    )

    const sanitizedWin = sanitizeGoogleRequestHeaders(
      {
        'User-Agent': rawWin,
        'sec-ch-ua': '"Not.A/Brand";v="99", "Electron";v="45", "Chromium";v="147"',
        'sec-ch-ua-full-version-list': '"Electron";v="45.2.1", "Chromium";v="147.0.7103.49"',
        'sec-ch-ua-platform': '"Windows"',
        'X-Custom-Header': 'keep-me'
      },
      '147.0.7103.49',
      'darwin'
    )
    expect(sanitizedWin['User-Agent']).not.toContain('Electron')
    expect(sanitizedWin['User-Agent']).not.toContain('BotArk')
    expect(sanitizedWin['sec-ch-ua']).toBe(
      '"Chromium";v="147", "Google Chrome";v="147", "Not-A.Brand";v="99"'
    )
    expect(sanitizedWin['sec-ch-ua-full-version-list']).toBe(
      '"Chromium";v="147.0.7103.49", "Google Chrome";v="147.0.7103.49", "Not-A.Brand";v="99.0.0.0"'
    )
    // Inferred from Windows UA even if fallback platform was darwin
    expect(sanitizedWin['sec-ch-ua-platform']).toBe('"Windows"')
    expect(sanitizedWin['X-Custom-Header']).toBe('keep-me')

    const sanitizedMac = sanitizeGoogleRequestHeaders(
      {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/147.0.0.0 Electron/45.2.1 Safari/537.36'
      },
      '147.0.0.0',
      'win32'
    )
    expect(sanitizedMac['Sec-CH-UA-Platform']).toBe('"macOS"')

    const sanitizedLinux = sanitizeGoogleRequestHeaders({}, '147.0.0.0', 'linux')
    expect(sanitizedLinux['User-Agent']).toContain('X11; Linux x86_64')
    expect(sanitizedLinux['Sec-CH-UA-Platform']).toBe('"Linux"')
  })

  it('uses platform-appropriate fallback UA when Chrome/ is absent', () => {
    expect(cleanChromeUserAgentForGoogle('CustomUA/1.0', '145.0.0.0', 'win32')).toContain(
      'Windows NT 10.0; Win64; x64'
    )
    expect(cleanChromeUserAgentForGoogle('CustomUA/1.0', '145.0.0.0', 'darwin')).toContain(
      'Macintosh; Intel Mac OS X 10_15_7'
    )
    expect(cleanChromeUserAgentForGoogle('CustomUA/1.0', '145.0.0.0', 'linux')).toContain(
      'X11; Linux x86_64'
    )
    expect(buildChromeClientHints('145.1.2.3', 'win32').uaDataPlatform).toBe('Windows')
  })

  it('covers all 6+ Google OAuth domains and installs headers + preload idempotently', () => {
    expect(GOOGLE_OAUTH_URL_PATTERNS).toEqual([
      '*://*.google.com/*',
      '*://google.com/*',
      '*://*.youtube.com/*',
      '*://youtube.com/*',
      '*://*.gstatic.com/*',
      '*://*.googleapis.com/*',
      '*://*.googleusercontent.com/*'
    ])

    const dir = makeTempDir()
    const registeredScripts: Array<{ id?: string; filePath: string; matches?: string[]; type: string }> = []
    const onBeforeSendHeaders = vi.fn()
    const registerPreloadScript = vi.fn((script) => {
      registeredScripts.push(script)
      return script.id ?? 'id'
    })

    const ses = {
      getStoragePath: () => join(dir, 'Partitions', 'bothub-account-acc_1'),
      webRequest: { onBeforeSendHeaders },
      registerPreloadScript,
      getPreloadScripts: () => registeredScripts
    } as unknown as Parameters<typeof installGoogleOAuthHeaderGuard>[0]

    installGoogleOAuthHeaderGuard(ses, { chromeVersion: '147.0.0.0', platform: 'win32' })
    installGoogleOAuthHeaderGuard(ses, { chromeVersion: '147.0.0.0', platform: 'win32' })

    expect(onBeforeSendHeaders).toHaveBeenCalledTimes(1)
    expect(onBeforeSendHeaders.mock.calls[0]?.[0]).toEqual({
      urls: [...GOOGLE_OAUTH_URL_PATTERNS]
    })
    expect(registerPreloadScript).toHaveBeenCalledTimes(1)
    expect(registeredScripts[0]).toEqual({
      id: GOOGLE_OAUTH_PRELOAD_ID,
      type: 'frame',
      filePath: expect.any(String)
    })
    expect('matches' in registeredScripts[0]!).toBe(false)
    expect('matchOriginAsFallback' in registeredScripts[0]!).toBe(false)
    const diskPreload = readFileSync(registeredScripts[0]!.filePath, 'utf8')
    expect(diskPreload).toContain('webFrame.executeJavaScript')
    expect(buildGoogleOAuthPreloadScriptSource('147.0.0.0', 'win32')).toBe(diskPreload)
  })

  it('strips Sec-CH-UA headers and uses Firefox UA when Firefox compat mode is enabled', () => {
    const firefoxHeaders = sanitizeGoogleRequestHeaders(
      {
        'User-Agent': 'Mozilla/5.0 Chrome/147.0.0.0 Electron/45.2.1 Safari/537.36',
        'Sec-CH-UA': '"Chromium";v="147", "Electron";v="45"',
        'Sec-CH-UA-Platform': '"Windows"',
        'X-Custom': 'preserved'
      },
      '147.0.0.0',
      'win32',
      { firefoxCompat: true }
    )
    expect(firefoxHeaders['User-Agent']).toBe(buildGoogleFirefoxCompatUa('win32'))
    expect(firefoxHeaders['Sec-CH-UA']).toBeUndefined()
    expect(firefoxHeaders['Sec-CH-UA-Platform']).toBeUndefined()
    expect(firefoxHeaders['X-Custom']).toBe('preserved')

    type RequestDetails = { url: string; requestHeaders: Record<string, string> }
    let capturedCb: ((details: RequestDetails, cb: (r: { requestHeaders: Record<string, string> }) => void) => void) | undefined
    const mockSes = {
      webRequest: {
        onBeforeSendHeaders: (_filter: unknown, cb: typeof capturedCb) => {
          capturedCb = cb
        }
      }
    } as unknown as Parameters<typeof installGoogleOAuthHeaderGuard>[0]
    installGoogleOAuthHeaderGuard(mockSes, { chromeVersion: '147.0.0.0', platform: 'win32' })
    setGoogleFirefoxCompatMode(mockSes, true)

    const requestHeaders = {
      'User-Agent': 'Chrome/147 Electron/45',
      'sec-ch-ua': '"Electron";v="45"',
      'sec-ch-ua-mobile': '?0'
    }
    const sendTo = (url: string) => {
      let headers: Record<string, string> = {}
      capturedCb?.({ url, requestHeaders }, (result) => {
        headers = result.requestHeaders
      })
      return headers
    }
    const signInUrl = 'https://accounts.google.com/v3/signin/identifier'
    const signInHeaders = sendTo(signInUrl)
    expect(signInHeaders['User-Agent']).toBe(buildGoogleFirefoxCompatUa('win32'))
    expect(signInHeaders['sec-ch-ua']).toBeUndefined()
    expect(signInHeaders['sec-ch-ua-mobile']).toBeUndefined()

    for (const url of [
      'https://accounts.youtube.com/signin',
      'https://myaccount.google.com/',
      'https://gds.google.com/web/chip',
      'https://consent.google.com/',
      'https://www.google.com/ServiceLogin'
    ]) {
      expect(isGoogleAuthHostUrl(url)).toBe(true)
      expect(sendTo(url)['User-Agent']).toBe(buildGoogleFirefoxCompatUa('win32'))
    }

    for (const url of [
      'https://aicode.clients6.google.com/$rpc/google.gca.aicode.v1alpha.JetskiRemoteAgentProxyService/GetUserProfile',
      'https://antigravity.google.com/',
      'https://ssl.gstatic.com/accounts/static/main.js'
    ]) {
      expect(isGoogleAuthHostUrl(url)).toBe(false)
      expect(sendTo(url)).toMatchObject({
        'User-Agent': 'Chrome/147',
        'Sec-CH-UA-Platform': '"Windows"'
      })
    }
    expect(isGoogleAuthHostUrl(signInUrl)).toBe(true)
    expect(isGoogleAuthHostUrl('https://cue.im/login')).toBe(false)
    expect(isGoogleAuthHostUrl('https://accounts.google.com.example.net/')).toBe(false)

    setGoogleFirefoxCompatMode(mockSes, false)
    expect(sendTo(signInUrl)['User-Agent']).toBe('Chrome/147')
  })

  it('gracefully handles mock sessions without registerPreloadScript or nullish input', () => {
    expect(() => installGoogleOAuthHeaderGuard(null)).not.toThrow()
    expect(() => installGoogleOAuthHeaderGuard(undefined)).not.toThrow()
    const onBeforeSendHeaders = vi.fn()
    const minimalSes = { webRequest: { onBeforeSendHeaders } } as unknown as Parameters<
      typeof installGoogleOAuthHeaderGuard
    >[0]
    expect(() => installGoogleOAuthHeaderGuard(minimalSes)).not.toThrow()
    expect(onBeforeSendHeaders).toHaveBeenCalledTimes(1)
  })

  it('patches navigator.userAgent, userAgentData, and webdriver ONLY on Google origins (no-op on Turnstile)', async () => {
    const patchScript = buildGoogleOAuthMainWorldPatchScript('147.0.7103.49', 'win32')

    const runInOrigin = (hostname: string, userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 BotArk/0.12.1 Chrome/147.0.7103.49 Electron/45.2.1 Safari/537.36') => {
      class MockNavigatorUAData {
        brands = [{ brand: 'Electron', version: '45' }]
        mobile = false
        platform = 'Windows'
        async getHighEntropyValues() {
          return {
            architecture: 'x86',
            brands: [{ brand: 'Electron', version: '45' }],
            fullVersionList: [{ brand: 'Electron', version: '45.2.1' }],
            uaFullVersion: '45.2.1'
          }
        }
      }
      class MockNavigator {}
      Object.defineProperties(MockNavigator.prototype, {
        userAgent: {
          configurable: true,
          get: () => userAgent
        },
        appVersion: {
          configurable: true,
          get: () =>
            '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 BotArk/0.12.1 Chrome/147.0.7103.49 Electron/45.2.1 Safari/537.36'
        },
        webdriver: { configurable: true, get: () => true },
        userAgentData: { configurable: true, get: () => new MockNavigatorUAData() }
      })
      const navigator = new MockNavigator()
      const context = {
        Navigator: MockNavigator,
        navigator,
        location: { hostname, protocol: 'https:' },
        Object,
        Symbol,
        Promise,
        Array
      }
      vm.runInNewContext(patchScript, context)
      return { navigator, MockNavigatorUAData }
    }

    // Google OAuth origin: patched
    const googleEnv = runInOrigin('accounts.google.com')
    const gNav = googleEnv.navigator as unknown as {
      userAgent: string
      appVersion: string
      webdriver: boolean
      userAgentData: {
        brands: Array<{ brand: string; version: string }>
        platform: string
        mobile: boolean
        getHighEntropyValues: (hints: string[]) => Promise<Record<string, unknown>>
      }
    }
    expect(gNav.userAgent).not.toContain('Electron')
    expect(gNav.userAgent).not.toContain('BotArk')
    expect(gNav.appVersion).not.toContain('Electron')
    expect(gNav.webdriver).toBe(false)
    expect(gNav.userAgentData instanceof googleEnv.MockNavigatorUAData).toBe(true)
    expect(gNav.userAgentData.brands).toEqual([
      { brand: 'Chromium', version: '147' },
      { brand: 'Google Chrome', version: '147' },
      { brand: 'Not-A.Brand', version: '99' }
    ])
    expect(gNav.userAgentData.platform).toBe('Windows')
    const entropy = await gNav.userAgentData.getHighEntropyValues(['fullVersionList', 'uaFullVersion'])
    expect(entropy.uaFullVersion).toBe('147.0.7103.49')
    expect(entropy.fullVersionList).toEqual([
      { brand: 'Chromium', version: '147.0.7103.49' },
      { brand: 'Google Chrome', version: '147.0.7103.49' },
      { brand: 'Not-A.Brand', version: '99.0.0.0' }
    ])

    // Cloudflare Turnstile / non-Google origin: completely untouched
    const cfEnv = runInOrigin('challenges.cloudflare.com')
    const cNav = cfEnv.navigator as unknown as {
      userAgent: string
      webdriver: boolean
      userAgentData: { brands: Array<{ brand: string; version: string }> }
    }
    expect(cNav.userAgent).toContain('Electron/45.2.1')
    expect(cNav.webdriver).toBe(true)
    expect(cNav.userAgentData.brands[0]?.brand).toBe('Electron')

    const firefoxUa = buildGoogleFirefoxCompatUa('win32')
    expect(runInOrigin('accounts.google.com', firefoxUa).navigator).toMatchObject({
      userAgent: firefoxUa,
      userAgentData: undefined,
      vendor: '',
      productSub: '20100101',
      buildID: '20181001000000',
      oscpu: 'Windows NT 10.0; Win64; x64'
    })
    expect(runInOrigin('antigravity.google.com', firefoxUa).navigator).toMatchObject({
      userAgent: expect.stringContaining('Chrome/147.0.7103.49'),
      userAgentData: expect.objectContaining({ platform: 'Windows' })
    })
  })

  it('hardens full desktop browser fingerprint (window.chrome, plugins, high-entropy hints, native toString, iframe realms)', async () => {
    const patchScript = buildGoogleOAuthMainWorldPatchScript('147.0.7103.49', 'win32', 'x64')

    // 1. High-entropy HTTP Client Hints match JS userAgentData 1:1
    const sanitized = sanitizeGoogleRequestHeaders(
      {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0.7103.49 Electron/45.2.1 Safari/537.36',
        'sec-ch-ua': '"Electron";v="45"',
        'sec-ch-ua-full-version': '"45.2.1"',
        'sec-ch-ua-platform': '"Windows"',
        'sec-ch-ua-platform-version': '"0.0.0"',
        'sec-ch-ua-arch': '"x86"',
        'sec-ch-ua-bitness': '"64"',
        'sec-ch-ua-model': '"Electron"',
        'sec-ch-ua-wow64': '?1',
        'sec-ch-ua-form-factors': '"Unknown"'
      },
      '147.0.7103.49',
      'win32',
      { arch: 'x64' }
    )
    expect(sanitized['Sec-CH-UA-Mobile']).toBe('?0')
    expect(sanitized['sec-ch-ua-full-version']).toBe('"147.0.7103.49"')
    expect(sanitized['sec-ch-ua-platform-version']).toMatch(/^"(?:10|15)\.0\.0"$/)
    expect(sanitized['sec-ch-ua-arch']).toBe('"x86"')
    expect(sanitized['sec-ch-ua-bitness']).toBe('"64"')
    expect(sanitized['sec-ch-ua-model']).toBe('""')
    expect(sanitized['sec-ch-ua-wow64']).toBe('?0')
    expect(sanitized['sec-ch-ua-form-factors']).toBe('"Desktop"')

    // 2. Full main-world realm + synchronous child about:blank iframe patching
    const makeRealm = (hostname: string, protocol: string, referrer = '') => {
      class MockPlugin {}
      class MockMimeType {}
      class MockPluginArray { length = 0 }
      class MockMimeTypeArray { length = 0 }
      class MockNavigatorUAData {
        brands = [{ brand: 'Electron', version: '45' }]
        mobile = false
        platform = 'Windows'
      }
      class MockNavigator {}
      Object.defineProperties(MockNavigator.prototype, {
        userAgent: {
          configurable: true,
          get: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0.7103.49 Electron/45.2.1 Safari/537.36'
        },
        appVersion: {
          configurable: true,
          get: () => '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0.7103.49 Electron/45.2.1 Safari/537.36'
        },
        vendor: { configurable: true, get: () => 'Google Inc.' },
        webdriver: { configurable: true, get: () => true },
        plugins: { configurable: true, get: () => new MockPluginArray() },
        mimeTypes: { configurable: true, get: () => new MockMimeTypeArray() },
        pdfViewerEnabled: { configurable: true, get: () => false },
        userAgentData: { configurable: true, get: () => new MockNavigatorUAData() }
      })
      const nav = new MockNavigator()
      const realm: Record<string, unknown> = {
        Navigator: MockNavigator,
        navigator: nav,
        Plugin: MockPlugin,
        MimeType: MockMimeType,
        PluginArray: MockPluginArray,
        MimeTypeArray: MockMimeTypeArray,
        location: { hostname, protocol, pathname: '/v3/signin/identifier' },
        document: { referrer },
        performance: { timeOrigin: 1_700_000_000_000, now: () => 42.5 },
        innerWidth: 1080,
        innerHeight: 780,
        outerWidth: 0,
        outerHeight: 0,
        Object,
        Symbol,
        Promise,
        Array,
        WeakMap,
        Date,
        Math
      }
      realm.window = realm
      return { realm, MockNavigator, MockPluginArray, MockMimeTypeArray, MockNavigatorUAData }
    }

    const parent = makeRealm('accounts.google.com', 'https:')
    const child = makeRealm('', 'about:', 'https://accounts.google.com/v3/signin/identifier')

    class MockHTMLIFrameElement {}
    Object.defineProperty(MockHTMLIFrameElement.prototype, 'contentWindow', {
      configurable: true,
      enumerable: true,
      get() { return child.realm }
    })
    parent.realm.HTMLIFrameElement = MockHTMLIFrameElement

    const vmCtx = vm.createContext(parent.realm)
    vm.runInContext(patchScript, vmCtx)

    // Verify authentic window.chrome (app + csi + loadTimes + runtime)
    const chromeObj = parent.realm.chrome as {
      app: { isInstalled: boolean; getIsInstalled: () => boolean; runningState: () => string }
      csi: () => { startE: number; tran: number }
      loadTimes: () => { npnNegotiatedProtocol: string; wasFetchedViaSpdy: boolean }
      runtime: { PlatformOs: { WIN: string }; id: undefined }
    }
    expect(chromeObj).toBeDefined()
    expect(chromeObj.app.isInstalled).toBe(false)
    expect(chromeObj.app.getIsInstalled()).toBe(false)
    expect(chromeObj.app.runningState()).toBe('cannot_run')
    expect(chromeObj.csi()).toMatchObject({ startE: 1_700_000_000_000, tran: 15 })
    expect(chromeObj.loadTimes()).toMatchObject({ npnNegotiatedProtocol: 'h2', wasFetchedViaSpdy: true })
    expect(chromeObj.runtime.PlatformOs.WIN).toBe('win')
    expect(chromeObj.runtime.id).toBeUndefined()

    // Verify 5 Chrome PDF plugins + 2 MIME types + pdfViewerEnabled
    const nav = parent.realm.navigator as {
      plugins: { length: number; item: (i: number) => { name: string } | null }
      mimeTypes: { length: number; namedItem: (k: string) => { type: string } | null }
      pdfViewerEnabled: boolean
      userAgentData: { getHighEntropyValues: (h: string[]) => Promise<Record<string, unknown>> }
    }
    expect(nav.plugins instanceof parent.MockPluginArray).toBe(true)
    expect(nav.plugins.length).toBe(5)
    expect(nav.plugins.item(0)?.name).toBe('PDF Viewer')
    expect(nav.mimeTypes instanceof parent.MockMimeTypeArray).toBe(true)
    expect(nav.mimeTypes.length).toBe(2)
    expect(nav.mimeTypes.namedItem('application/pdf')?.type).toBe('application/pdf')
    expect(nav.pdfViewerEnabled).toBe(true)

    // Verify non-zero desktop outer dimensions
    expect(parent.realm.outerWidth).toBe(1080)
    expect(parent.realm.outerHeight).toBe(865)

    // Verify Function.prototype.toString returns native signatures
    const fnToString = vm.runInContext('Function.prototype.toString', vmCtx) as () => string
    const uaDataGetter = Object.getOwnPropertyDescriptor(parent.MockNavigator.prototype, 'userAgentData')?.get
    expect(fnToString.call(uaDataGetter)).toBe('function get userAgentData() { [native code] }')
    expect(fnToString.call(chromeObj.csi)).toBe('function csi() { [native code] }')
    expect(fnToString.call(fnToString)).toBe('function toString() { [native code] }')

    // Verify full high-entropy values
    const highEntropy = await nav.userAgentData.getHighEntropyValues([
      'architecture',
      'bitness',
      'model',
      'platformVersion',
      'wow64',
      'formFactors',
      'fullVersionList',
      'uaFullVersion'
    ])
    expect(highEntropy).toMatchObject({
      architecture: 'x86',
      bitness: '64',
      model: '',
      wow64: false,
      formFactors: ['Desktop'],
      uaFullVersion: '147.0.7103.49'
    })
    expect(String(highEntropy.platformVersion)).toMatch(/^(?:10|15)\.0\.0$/)

    // Verify BotGuard hidden about:blank iframe gets synchronously patched on contentWindow access
    const iframe = new MockHTMLIFrameElement() as unknown as { contentWindow: typeof child.realm }
    const childWin = iframe.contentWindow
    const childNav = childWin.navigator as {
      userAgent: string
      webdriver: boolean
      pdfViewerEnabled: boolean
      plugins: { length: number }
      userAgentData: { brands: Array<{ brand: string; version: string }> }
    }
    expect(childNav.userAgent).not.toContain('Electron')
    expect(childNav.webdriver).toBe(false)
    expect(childNav.pdfViewerEnabled).toBe(true)
    expect(childNav.plugins.length).toBe(5)
    expect(childNav.userAgentData.brands.some((b) => b.brand === 'Google Chrome')).toBe(true)
    expect((childWin.chrome as { app?: { isInstalled: boolean } })?.app?.isInstalled).toBe(false)
  })

  it('detects Google blocked or passkey pages strictly on Google/YouTube auth hosts', () => {
    expect(
      isGoogleBlockedOrPasskeyText(
        '此浏览器或应用可能不安全。请尝试使用其他浏览器。',
        'https://accounts.google.com/v3/signin/rejected'
      )
    ).toBe(true)
    expect(
      isGoogleBlockedOrPasskeyText(
        'This browser or app may not be secure',
        'https://accounts.google.com/signin/v2'
      )
    ).toBe(true)
    expect(
      isGoogleBlockedOrPasskeyText(
        'Use your passkey to confirm it is really you',
        'https://accounts.youtube.com/signin'
      )
    ).toBe(true)
    expect(
      isGoogleBlockedOrPasskeyText(
        '请使用通行密钥或安全密钥验证',
        'https://accounts.google.com/v3/signin/challenge'
      )
    ).toBe(true)
    expect(
      isGoogleBlockedOrPasskeyText(
        'Couldn’t sign you in',
        'https://accounts.google.com/v3/signin'
      )
    ).toBe(true)
    // Never false-positive on non-Google sites
    expect(
      isGoogleBlockedOrPasskeyText(
        'Use your passkey to sign in',
        'https://chatgpt.com/auth/login'
      )
    ).toBe(false)
  })
})
