import { describe, expect, it } from 'vitest'
import { statusAfterSendFailure } from './sendFailure'
import { AdapterError } from './types'

describe('statusAfterSendFailure', () => {
  it('keeps the account usable for transient failures', () => {
    expect(statusAfterSendFailure(new Error('fetch failed'))).toBe('online')
    expect(statusAfterSendFailure(new Error('HTTP 502 Bad Gateway'))).toBe('online')
    expect(statusAfterSendFailure(new AdapterError('timeout', 'timed out'))).toBe('online')
    expect(statusAfterSendFailure(new AdapterError('network', 'socket hang up on HTTP 403'))).toBe('online')
    expect(statusAfterSendFailure(Object.assign(new Error('socket reset during HTTP 403'), { code: 'ECONNRESET' }))).toBe('online')
    expect(statusAfterSendFailure(new Error('Timed out contacting 127.0.0.1:401'))).toBe('online')
    expect(statusAfterSendFailure(Object.assign(new Error('Upstream returned HTTP 401'), { status: 502 }))).toBe('online')
  })

  it('flags sign-in problems', () => {
    expect(statusAfterSendFailure(new Error('HTTP 401'))).toBe('error')
    expect(statusAfterSendFailure(new Error('Unauthorized'))).toBe('error')
    expect(statusAfterSendFailure(new Error('session expired, sign in again'))).toBe('error')
    expect(statusAfterSendFailure(new AdapterError('not-connected', 'x'))).toBe('error')
    expect(statusAfterSendFailure({ response: { status: 403 } })).toBe('error')
  })
})
