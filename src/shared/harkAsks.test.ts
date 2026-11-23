import { expect, it } from 'vitest'
import { askKind, pendingHarkAsks } from './harkAsks'
import { downloadFileName, downloadPercent, formatDownloadSize } from './goxfDownload'

it('classifies Hark asks', () => {
  expect(askKind('code_form', 'Enter the verification code')).toBe('code')
  expect(askKind('', '输入你的 GitHub 验证码')).toBe('code')
  expect(askKind('login_form', 'Sign in to GitHub')).toBe('credential')
  expect(askKind('', 'Approve the purchase?')).toBe('confirm')
})

it('keeps only pending asks', () => {
  const out = pendingHarkAsks([
    { id: 'a', status: 'pending', prompt: 'Enter the verification code' },
    { id: 'b', status: 'answered', prompt: 'x' }
  ])
  expect(out.map((a) => [a.id, a.kind])).toEqual([['a', 'code']])
})

it('formats download progress', () => {
  expect(formatDownloadSize(61_000_000, 155_635_299)).toBe('58.2 MB / 148 MB')
  expect(downloadPercent(50, 200)).toBe(25)
  expect(downloadPercent(5, 0)).toBeNull()
  expect(downloadFileName('https://x.com/a/BotArk%20v1.zip?y=1')).toBe('BotArk v1.zip')
  expect(downloadFileName('https://x.com/', '../a:b.zip')).toBe('_a_b.zip')
})
