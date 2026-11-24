import { describe, expect, it } from 'vitest'
import { reorderTitles } from './Section'

describe('reorderTitles', () => {
  it('moves a section before or after the target', () => {
    expect(reorderTitles(['a', 'b', 'c'], [], 'c', 'a', false)).toEqual(['c', 'a', 'b'])
    expect(reorderTitles(['a', 'b', 'c'], [], 'a', 'b', true)).toEqual(['b', 'a', 'c'])
  })
  it('keeps saved titles that are not shown for this bot', () => {
    expect(reorderTitles(['a', 'b'], ['x', 'a', 'b'], 'b', 'a', false)).toEqual(['b', 'a', 'x'])
  })
  it('ignores an unknown target', () => {
    expect(reorderTitles(['a'], ['a'], 'a', 'z', false)).toEqual(['a'])
  })
})
