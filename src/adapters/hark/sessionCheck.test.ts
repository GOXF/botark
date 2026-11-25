import { describe, expect, it } from 'vitest'
import { harkSessionLine } from './sessionCheck'

const at = new Date(2026, 10, 25, 19, 21).getTime()
const exp = new Date(2026, 11, 25, 19, 20).getTime()

describe('harkSessionLine', () => {
  it('shows the expiry and fades to grey after 10 minutes', () => {
    expect(harkSessionLine({ result: 'ok', at, expiresAt: exp }, at)).toEqual({
      tone: 'ok', text: '会话有效至 12月25日 19:20 · 19:21 刷新'
    })
    expect(harkSessionLine({ result: 'ok', at }, at + 11 * 60_000)?.tone).toBe('muted')
  })
  it('words expiry and background failures', () => {
    expect(harkSessionLine({ result: 'expired', at }, at)?.text).toBe('会话已失效，请重新登录 · 19:21')
    expect(harkSessionLine({ result: 'failed', at, message: '连接超时', background: true }, at)?.text)
      .toBe('后台刷新失败 19:21 · 连接超时，稍后自动重试')
  })
})
