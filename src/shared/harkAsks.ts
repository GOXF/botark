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
  /** Set when the ask wants one key / token (saved to the Hark vault as an api_key, then its id handed to the tool). */
  secret?: { scope: string; label: string }
  /** Hark's own line under the title (where to find the value). */
  hint?: string
  /** secure_screen one-time code: saved to the vault like a login (type one_time_code), then its id handed over. */
  codeSecret?: { scope: string }
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
  if (/password|passkey|login|sign[-_ ]?in|credential|card|payment|secret|api[-_ ]?key|token|vault|登录|密码|卡号|密钥|令牌|口令/i.test(s)) return 'credential'
  return 'confirm'
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

/** Hark's secure_screen asks (2026-11-26) carry the form in request.screen: components + secret {scope, type}. */
function screenOf(a: RawAsk): { secret: Record<string, unknown>; inputs: string[]; site: string } {
  const req = obj(a.raw?.['request'] ?? a.raw?.['userInputRequest'] ?? a.raw)
  const screen = obj(req['screen'])
  const comps = Array.isArray(screen['components']) ? (screen['components'] as unknown[]).map(obj) : []
  const inputs = comps.filter((c) => /input/i.test(str(c['type']))).map((c) => str(c['id'])).filter((n) => /^[\w.-]{1,40}$/.test(n))
  return { secret: obj(screen['secret']), inputs, site: str(req['site']) }
}

/** A sign-in ask Hark's web app answers with a login secret: type login, scope = the site, fields username + password. */
export function loginSpec(a: RawAsk, kind: HarkAskKind): HarkAskView['login'] {
  if (kind !== 'credential') return undefined
  const sc = screenOf(a)
  if (str(sc.secret['type'])) {
    if (str(sc.secret['type']) !== 'login') return undefined
    const scope = str(sc.secret['scope']) || sc.site || a.domain || ''
    if (!scope) return undefined
    return { scope, label: str(sc.secret['site_name']) || 'Login', fields: sc.inputs.length ? sc.inputs : ['username', 'password'] }
  }
  const raw = a.raw ?? {}
  const req = ((raw['request'] ?? raw['userInputRequest'] ?? raw) || {}) as Record<string, unknown>
  const type = `${str(req['secretType'])} ${str(req['type'])} ${str(req['kind'])} ${a.displayHint ?? ''}`.toLowerCase()
  if (/card|payment|api[-_ ]?key|token|cvv|cvc/.test(type)) return undefined
  if (/card|卡号|payment|api[-_ ]?key|密钥|token|令牌|口令/i.test(a.prompt ?? '')) return undefined
  const scope = str(req['scope']) || str(req['secretScope']) || a.domain || ''
  if (!scope) return undefined
  const rawFields = Array.isArray(req['fields']) ? (req['fields'] as unknown[]) : []
  const names = rawFields.map((f) => (typeof f === 'string' ? f : str((f as Record<string, unknown>)?.['name'])))
    .filter((n) => /^[\w.-]{1,40}$/.test(n))
  const fields = names.length ? names : ['username', 'password']
  return { scope, label: str(req['label']) || 'Login', fields }
}

/** A key or token ask: one hidden field. A card stays on the web form. */
export function secretSpec(a: RawAsk, kind: HarkAskKind): HarkAskView['secret'] {
  if (kind !== 'credential' || str(screenOf(a).secret['type'])) return undefined
  const req = ((a.raw?.['request'] ?? a.raw?.['userInputRequest'] ?? a.raw) || {}) as Record<string, unknown>
  const s = `${str(req['secretType'])} ${str(req['type'])} ${a.displayHint ?? ''} ${a.prompt ?? ''}`
  if (/card|payment|卡号|cvv|cvc/i.test(s) || !/api[-_ ]?key|token|secret|密钥|令牌|口令/i.test(s)) return undefined
  return { scope: str(req['scope']) || str(req['secretScope']) || a.domain || '', label: str(req['label']) || a.prompt || 'API key' }
}

function askHint(a: RawAsk): string | undefined {
  const req = ((a.raw?.['request'] ?? a.raw?.['userInputRequest'] ?? a.raw) || {}) as Record<string, unknown>
  const screen = obj(req['screen'])
  const comps = Array.isArray(screen['components']) ? (screen['components'] as unknown[]).map(obj) : []
  const text = comps.find((c) => str(c['type']) === 'instructions')
  const h = str(req['description']) || (text ? str(text['text']) : '') || str(req['instructions']) || str(req['helpText']) || str(req['body'])
  return h && h !== a.prompt ? h.slice(0, 300) : undefined
}

export function pendingHarkAsks(asks: RawAsk[] | undefined): HarkAskView[] {
  return (asks ?? []).filter((a) => !DONE.test(a.status)).map((a) => {
    const sc = screenOf(a)
    const secretType = str(sc.secret['type'])
    const kind: HarkAskKind = secretType === 'one_time_code' ? 'code' : secretType ? 'credential' : askKind(a.displayHint, a.prompt)
    return {
      id: a.id,
      dispatchId: a.dispatchId,
      requestId: a.requestId,
      kind,
      prompt: (a.prompt || a.displayHint || 'Hark 需要你确认').slice(0, 200),
      domain: a.domain || sc.site || undefined,
      login: loginSpec(a, kind),
      secret: secretSpec(a, kind),
      hint: askHint(a),
      codeSecret: secretType === 'one_time_code' ? { scope: str(sc.secret['scope']) || sc.site || a.domain || '' } : undefined
    }
  })
}
