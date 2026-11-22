import { describe, expect, it, vi } from 'vitest'

const NATIVE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) BotArk/0.12.0 Chrome/142.0.7444.59 Electron/45.2.1 Safari/537.36'

vi.mock('electron', () => ({
  app: { userAgentFallback: NATIVE, getPath: () => '/tmp' },
  session: { fromPartition: () => ({}) }
}))
vi.mock('../webContentsViewManager', () => ({
  partitionForAccount: (id: string) => `persist:bothub-account-${id}`
}))

const {
  cleanChromeUserAgent,
  harkLoginUserAgentFor,
  harkNativeUserAgent,
  isGoogleAuthUrl
} = await import('./harkUserAgent')
const { harkClientHeaders, HARK_USER_AGENT } = await import('./harkClient')

describe('Hark login keeps one native UA for Turnstile', () => {
  it('uses Electron native UA unedited', () => {
    expect(harkNativeUserAgent()).toBe(NATIVE)
  })

  it('never rewrites the UA on hark.com or Cloudflare challenge frames', () => {
    for (const url of [
      'https://app.hark.com/login',
      'https://auth.hark.com/api/auth/sign-in/email',
      'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/x'
    ]) {
      expect(isGoogleAuthUrl(url)).toBe(false)
      expect(harkLoginUserAgentFor(url, NATIVE)).toBe(NATIVE)
    }
  })

  it('only Google OAuth gets the cleaned Chrome UA', () => {
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x'
    expect(isGoogleAuthUrl(url)).toBe(true)
    const ua = harkLoginUserAgentFor(url, NATIVE)
    expect(ua).toBe(cleanChromeUserAgent(NATIVE))
    expect(ua).not.toMatch(/Electron\/|BotArk\//)
    expect(ua).toContain('Chrome/142.0.7444.59')
    expect(isGoogleAuthUrl('https://google.com.evil.example/x')).toBe(false)
  })
})

describe('Hark REST headers match the login window', () => {
  it('sends the same UA as the page and no forged client hints', () => {
    const h = harkClientHeaders()
    expect(h['User-Agent']).toBe(NATIVE)
    expect(h['User-Agent']).not.toBe(HARK_USER_AGENT)
    expect(Object.keys(h).some((k) => /^sec-ch-ua/i.test(k))).toBe(false)
    expect(h['X-Hark-Timezone']).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })
})
