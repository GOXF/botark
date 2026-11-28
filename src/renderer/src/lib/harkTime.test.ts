import { expect, it } from 'vitest'
import { parseHarkTime, pickTime } from './harkTime'

it('reads Hark display times by their (UTC+08:00) offset, not CST as US Central', () => {
  expect(parseHarkTime('Sat 2026-11-28 6:57 PM CST (UTC+08:00)')?.toISOString()).toBe('2026-11-28T10:57:00.000Z')
  expect(parseHarkTime('Fri 2026-12-11 12:05 AM CST (UTC+08:00)')?.toISOString()).toBe('2026-12-10T16:05:00.000Z')
  expect(parseHarkTime('Fri 2026-12-11 12:30 PM CST (UTC+08:00)')?.toISOString()).toBe('2026-12-11T04:30:00.000Z')
})

it('still reads ISO strings and epoch seconds or milliseconds', () => {
  expect(parseHarkTime('2026-12-11T10:56:55Z')?.toISOString()).toBe('2026-12-11T10:56:55.000Z')
  expect(parseHarkTime(1796459438)?.getTime()).toBe(1796459438000)
  expect(parseHarkTime(1796459438000)?.getTime()).toBe(1796459438000)
  expect(parseHarkTime('soon')).toBeNull()
  expect(pickTime([null, { a: '', b: 'Sat 2026-11-28 6:57 PM CST (UTC+08:00)' }], ['a', 'b'])?.getUTCHours()).toBe(10)
})
