import { expect, it } from 'vitest'
import { teamStatusBlock } from './adminContext'

it('teamStatusBlock: one line per teammate with status, working projects and latest line', () => {
  const now = 1_000_000_000
  const text = teamStatusBlock([
    { name: '千问', column: 'run', working: ['店铺 A 上新'], last: '在改主图', lastAt: now - 5 * 60_000 },
    { name: '悟天Muse', column: 'idle' }
  ], now)
  expect(text).toContain('- @千问: 进行中 · working on 「店铺 A 上新」 · latest: 在改主图 (5 min ago)')
  expect(text).toContain('- @悟天Muse: 空闲')
  expect(teamStatusBlock([])).toBe('')
})
