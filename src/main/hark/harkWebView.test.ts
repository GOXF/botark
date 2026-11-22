import { describe, expect, it } from 'vitest'
import { HARK_ORIGIN } from './harkClient'
import { harkWebViewUrlAfterSignIn } from './harkWebView'

describe('harkWebViewUrlAfterSignIn', () => {
  it.each([
    'https://app.hark.com/login',
    'https://app.hark.com/login?redirect=%2F',
    'https://app.hark.com/sign-in',
    'https://app.hark.com/auth/callback',
    'https://app.hark.com/cdn-cgi/challenge-platform/h/b',
    'https://auth.hark.com/',
    'https://accounts.google.com/o/oauth2',
    'about:blank',
    'data:text/html,placeholder',
    ''
  ])('sends a signed-out / off-app view home: %s', (url) => {
    expect(harkWebViewUrlAfterSignIn(url)).toBe(HARK_ORIGIN)
  })

  it.each(['https://app.hark.com/', 'https://app.hark.com/projects/abc', 'https://app.hark.com/loginx'])(
    'just reloads a view already inside the app: %s',
    (url) => {
      expect(harkWebViewUrlAfterSignIn(url)).toBeUndefined()
    }
  )
})
