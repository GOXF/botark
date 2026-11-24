/** GOXF: Hark's pending user-input requests ("asks": a code, a sign-in, a card, an approval) for the native chat. */
export type HarkAskKind = 'code' | 'credential' | 'confirm'

export interface HarkAskView {
  id: string
  dispatchId?: string
  requestId?: string
  kind: HarkAskKind
  prompt: string
  domain?: string
  /** Set when the ask is a site sign-in BotArk can fill natively (POST /secrets, then tool-response {secretId}). */
  login?: { scope: string; label: string; fields: string[] }
}

interface RawAsk {
  id: string
  dispatchId?: string
  requestId?: string
  displayHint?: string
  prompt?: string
  domain?: string
  status: string
  raw?: Record<string, unknown>
}

const DONE = /^(answered|resolved|completed|done|cancel+ed|expired|closed|submitted|dismissed|failed)$/i

export function askKind(hint = '', prompt = ''): HarkAskKind {
  const s = `${hint} ${prompt}`
  if (/\b(otp|2fa|mfa|totp|one[-_ ]?time|verification[-_ ]?code|code)\b|验证码|動態碼|两步验证/i.test(s)) return 'code'
  if (/password|passkey|login|sign[-_ ]?in|credential|card|payment|secret|api[-_ ]?key|token|vault|登录|密码|卡号|密钥/i.test(s)) return 'credential'
  return 'confirm'
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** A sign-in ask Hark's web app answers with a login secret: type login, scope = the site, fields username + password. */
export function loginSpec(a: RawAsk, kind: HarkAskKind): HarkAskView['login'] {
  if (kind !== 'credential') return undefined
  const raw = a.raw ?? {}
  const req = ((raw['request'] ?? raw['userInputRequest'] ?? raw) || {}) as Record<string, unknown>
  const type = `${str(req['secretType'])} ${str(req['type'])} ${str(req['kind'])} ${a.displayHint ?? ''}`.toLowerCase()
  if (/card|payment|api[-_ ]?key|token|cvv|cvc/.test(type)) return undefined
  if (/card|卡号|payment|api[-_ ]?key|密钥|token/i.test(a.prompt ?? '')) return undefined
  const scope = str(req['scope']) || str(req['secretScope']) || a.domain || ''
  if (!scope) return undefined
  const rawFields = Array.isArray(req['fields']) ? (req['fields'] as unknown[]) : []
  const names = rawFields.map((f) => (typeof f === 'string' ? f : str((f as Record<string, unknown>)?.['name'])))
    .filter((n) => /^[\w.-]{1,40}$/.test(n))
  const fields = names.length ? names : ['username', 'password']
  return { scope, label: str(req['label']) || 'Login', fields }
}

export function pendingHarkAsks(asks: RawAsk[] | undefined): HarkAskView[] {
  return (asks ?? []).filter((a) => !DONE.test(a.status)).map((a) => {
    const kind = askKind(a.displayHint, a.prompt)
    return {
      id: a.id,
      dispatchId: a.dispatchId,
      requestId: a.requestId,
      kind,
      prompt: (a.prompt || a.displayHint || 'Hark 需要你确认').slice(0, 200),
      domain: a.domain,
      login: loginSpec(a, kind)
    }
  })
}
