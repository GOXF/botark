import { describe, expect, it } from 'vitest'
import { asArray, asObj, bool, num, str, trimStr } from './parse'

describe('shared/parse helpers', () => {
  it('narrows plain objects and rejects null, arrays, and primitives', () => {
    expect(asObj({ a: 1 })).toEqual({ a: 1 })
    expect(asObj(null)).toBeNull()
    expect(asObj(undefined)).toBeNull()
    expect(asObj([1, 2])).toBeNull()
    expect(asObj('x')).toBeNull()
  })

  it('converts strings, numbers, booleans, and arrays safely', () => {
    expect(str('hi')).toBe('hi')
    expect(str(42)).toBe('42')
    expect(str(null)).toBe('')
    expect(str(undefined)).toBe('')
    expect(trimStr('  abc  ')).toBe('abc')
    expect(trimStr(123)).toBe('')
    expect(num(3.5)).toBe(3.5)
    expect(num(' 42 ')).toBe(42)
    expect(num(Number.NaN)).toBeUndefined()
    expect(num('nope')).toBeUndefined()
    expect(bool(true)).toBe(true)
    expect(bool('true')).toBeUndefined()
    expect(asArray([1])).toEqual([1])
    expect(asArray('x')).toEqual([])
  })
})
