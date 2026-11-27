import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const html = readFileSync(join(__dirname, '../../index.html'), 'utf8')
const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? ''
const directive = (name: string) =>
  csp.split(';').map((d) => d.trim().split(/\s+/)).find(([key]) => key === name)?.slice(1) ?? []

it('lets previews load blob: and data: media and blob: frames (PDF)', () => {
  expect(directive('img-src')).toEqual(expect.arrayContaining(["'self'", 'data:', 'blob:']))
  expect(directive('media-src')).toEqual(expect.arrayContaining(["'self'", 'data:', 'blob:']))
  expect(directive('frame-src')).toEqual(expect.arrayContaining(["'self'", 'blob:']))
  expect(directive('script-src')).toEqual(["'self'"])
})
