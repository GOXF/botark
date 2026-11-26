import { describe, expect, it } from 'vitest'
import { pendingHarkAsks } from './harkAsks'
import { currentHarkBrowser, harkLiveViewUrl } from './harkBrowserPreview'

const ask = (request: Record<string, unknown>) => ({ id: 'a1', dispatchId: 'tu_1', requestId: String(request['requestId']), displayHint: 'secure_screen', prompt: String(request['prompt']), status: 'waiting_for_input', raw: { request } })

describe('Hark secure_screen asks (2026-11-26)', () => {
  it('reads a login form from request.screen', () => {
    const [v] = pendingHarkAsks([ask({
      requestId: 'uir_1', prompt: '16688 商户后台登录', displayHint: 'secure_screen', site: '16688.com.cn',
      screen: { components: [{ type: 'instructions', text: 'Enter your 16688 credentials' }, { id: 'username', type: 'text_input' }, { id: 'password', type: 'text_input', secret: true }],
        secret: { scope: '16688.com.cn', site_name: '16688', type: 'login' } }
    })])
    expect(v!.kind).toBe('credential')
    expect(v!.login).toEqual({ scope: '16688.com.cn', label: '16688', fields: ['username', 'password'] })
    expect(v!.secret).toBeUndefined()
    expect(v!.hint).toBe('Enter your 16688 credentials')
  })

  it('reads a one-time code form', () => {
    const [v] = pendingHarkAsks([ask({
      requestId: 'uir_2', prompt: '邮箱验证码', site: '16688.com.cn',
      screen: { components: [{ id: 'code', type: 'code_input' }], secret: { scope: 'www.16688.com.cn', type: 'one_time_code' } }
    })])
    expect(v!.kind).toBe('code')
    expect(v!.codeSecret).toEqual({ scope: 'www.16688.com.cn' })
    expect(v!.login).toBeUndefined()
  })
})

describe('Hark live view', () => {
  it('keeps only app.hark.com liveview pages, made absolute', () => {
    expect(harkLiveViewUrl('/api/liveview/view?t=abc')).toBe('https://app.hark.com/api/liveview/view?t=abc')
    expect(harkLiveViewUrl('https://evil.com/api/liveview/view?t=abc')).toBeUndefined()
    expect(harkLiveViewUrl('/api/files/x')).toBeUndefined()
    expect(currentHarkBrowser([{ kind: 'browser', status: 'running', liveViewUrl: '/api/liveview/view?t=abc' }])?.liveViewUrl)
      .toBe('https://app.hark.com/api/liveview/view?t=abc')
  })
})

describe('stale Hark asks', () => {
  it('keeps only the newest ask of a dispatch and drops asks with no request left', () => {
    const ask = (id: string, at: number, prompt?: string) => ({
      id, dispatchId: 'tu_1', requestId: id, status: 'waiting_for_input', prompt,
      raw: { at, request: prompt ? { prompt, askedAt: at } : undefined }
    })
    const out = pendingHarkAsks([
      ask('a', 1, 'Enter the verification code'),
      ask('b', 3, 'Enter the verification code'),
      { id: 'c', requestId: 'c', status: 'waiting_for_input', raw: {} }
    ])
    expect(out.map((a) => a.id)).toEqual(['b'])
  })
})
