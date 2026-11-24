import { describe, expect, it } from 'vitest'
import { comparableText, splitLeadingQuote } from './quoteText'

describe('splitLeadingQuote', () => {
  it('splits quote and body', () => {
    expect(splitLeadingQuote('> a\n> b\n\n要，这种也算')).toEqual({ quote: 'a\nb', body: '要，这种也算' })
  })
  it('leaves plain text and quote-only text alone', () => {
    expect(splitLeadingQuote('hi')).toEqual({ body: 'hi' })
    expect(splitLeadingQuote('> only')).toEqual({ body: '> only' })
  })
  it('compares local and server copies', () => {
    expect(comparableText('> q\n\nyes ')).toBe(comparableText('yes'))
  })
})
