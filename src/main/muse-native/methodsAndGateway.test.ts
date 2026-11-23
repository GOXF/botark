import { describe, expect, it } from 'vitest'
import { extractRequiredMethodPath } from './gateway'
import { MUSE_METHODS } from './methods'

describe('Muse session.* method registry & path self-healing', () => {
  it('routes all session.* mutations and session.start to /api/session/*', () => {
    expect(MUSE_METHODS['session.start']).toEqual({ httpMethod: 'POST', path: '/api/session/start' })
    expect(MUSE_METHODS['session.archive']).toEqual({ httpMethod: 'POST', path: '/api/session/archive' })
    expect(MUSE_METHODS['session.unarchive']).toEqual({ httpMethod: 'POST', path: '/api/session/unarchive' })
    expect(MUSE_METHODS['session.pin']).toEqual({ httpMethod: 'POST', path: '/api/session/pin' })
    expect(MUSE_METHODS['session.unpin']).toEqual({ httpMethod: 'POST', path: '/api/session/unpin' })
    expect(MUSE_METHODS['session.rename']).toEqual({ httpMethod: 'POST', path: '/api/session/rename' })
    expect(MUSE_METHODS['session.delete']).toEqual({ httpMethod: 'POST', path: '/api/session/delete' })
  })

  it('extracts canonical daemon path from invalid_params method mismatch errors', () => {
    const body = JSON.stringify({
      ok: false,
      error: {
        code: 'invalid_params',
        message: '`method` must be `/api/session/start`'
      }
    })
    expect(extractRequiredMethodPath(body)).toBe('/api/session/start')
    expect(extractRequiredMethodPath('{"message":"`method` must be `//evil.com/x`"}')).toBeNull()
    expect(extractRequiredMethodPath('{"message":"`method` must be `/api/../etc`"}')).toBeNull()
    expect(extractRequiredMethodPath('unrelated error')).toBeNull()
  })
})
