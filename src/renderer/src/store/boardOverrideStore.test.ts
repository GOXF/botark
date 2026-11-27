import { beforeEach, describe, expect, it } from 'vitest'
import { effectiveColumn, sanitizeOverrides } from '@/lib/boardStatus'
import { useBoardOverrides } from './boardOverrideStore'

describe('effectiveColumn', () => {
  it('uses the derived column without an override', () => {
    expect(effectiveColumn('run', undefined)).toBe('run')
    expect(effectiveColumn('idle', undefined)).toBe('idle')
  })
  it('a manual column beats the derived one, whatever it is', () => {
    expect(effectiveColumn('wait', 'done')).toBe('done')
    expect(effectiveColumn('done', 'fail')).toBe('fail')
    expect(effectiveColumn('idle', 'run')).toBe('run')
  })
  it('ignores junk and 空闲 as an override', () => {
    expect(effectiveColumn('wait', 'idle')).toBe('wait')
    expect(effectiveColumn('wait', 'bogus')).toBe('wait')
    expect(effectiveColumn('wait', 3)).toBe('wait')
  })
})

describe('sanitizeOverrides', () => {
  it('keeps only well-formed entries', () => {
    expect(sanitizeOverrides({ 'a:1': 'done', 'b:x': 'idle', 'r:y': 'nope', '': 'run', 'p:2': 'fail' })).toEqual({ 'a:1': 'done', 'p:2': 'fail' })
    expect(sanitizeOverrides(null)).toEqual({})
    expect(sanitizeOverrides(['done'])).toEqual({})
  })
})

describe('useBoardOverrides', () => {
  beforeEach(() => useBoardOverrides.setState({ overrides: {} }))
  it('sets, replaces and clears an override', () => {
    const { setOverride, clearOverride } = useBoardOverrides.getState()
    setOverride('p|acc|c:t1', 'done')
    expect(useBoardOverrides.getState().overrides).toEqual({ 'p|acc|c:t1': 'done' })
    setOverride('p|acc|c:t1', 'fail')
    setOverride('b:bot', 'wait')
    expect(useBoardOverrides.getState().overrides).toEqual({ 'p|acc|c:t1': 'fail', 'b:bot': 'wait' })
    clearOverride('p|acc|c:t1')
    expect(useBoardOverrides.getState().overrides).toEqual({ 'b:bot': 'wait' })
  })
  it('stays put with time — no expiry', () => {
    useBoardOverrides.getState().setOverride('x', 'done')
    const before = useBoardOverrides.getState()
    useBoardOverrides.getState().clearOverride('missing')
    expect(useBoardOverrides.getState()).toBe(before)
    expect(effectiveColumn('wait', useBoardOverrides.getState().overrides.x)).toBe('done')
  })
})
