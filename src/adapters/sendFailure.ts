import { AdapterError, type ConnectionStatus } from './types'

const AUTH_FAILURE_RE =
  /(?:^\s*|\bHTTP(?:\/\d(?:\.\d)?)?\s+)(?:401|403)\b|\b(?:unauthori[sz]ed|unauthenticated|forbidden|not signed in|sign in (?:first|again)|log ?in again|session (?:has )?expired|token (?:has )?expired|invalid[_ ]token|refresh token (?:is )?(?:invalid|expired))\b/i
const TRANSIENT_ERROR_CODES = new Set(['network', 'timeout', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'])

/**
 * Account status after a send failed. Only a sign-in problem should flip the
 * account to `error`: the composer treats `error` as disconnected, so a
 * timeout or a 5xx used to lock typing until the user pressed Connect.
 */
export function statusAfterSendFailure(error: unknown): ConnectionStatus {
  if (error instanceof AdapterError) {
    return error.code === 'not-connected' || error.code === 'unknown-account' ? 'error' : 'online'
  }
  if (error && typeof error === 'object') {
    const { code, status, statusCode, response } = error as {
      code?: string
      status?: number
      statusCode?: number
      response?: { status?: number; statusCode?: number }
    }
    if (code === 'not-connected' || code === 'unknown-account') return 'error'
    const httpStatus = response?.status ?? response?.statusCode ?? status ?? statusCode
    if (typeof httpStatus === 'number') {
      return httpStatus === 401 || httpStatus === 403 ? 'error' : 'online'
    }
    if (code && TRANSIENT_ERROR_CODES.has(code)) return 'online'
  }
  const detail = error instanceof Error ? error.message : String(error ?? '')
  return AUTH_FAILURE_RE.test(detail) ? 'error' : 'online'
}
