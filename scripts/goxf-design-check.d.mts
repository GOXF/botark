export interface DesignHit {
  file: string
  line: number
  token: string
  variants: string[]
  important: boolean
  base: string
  status: 'ok' | 'offscale'
}
export interface DesignViolation extends DesignHit {
  reason: string
}
export const MAPPING: Record<string, Record<string, string>>
export const OVERLAY_TOKENS: Record<string, string>
export function classify(base: string): 'ok' | 'offscale' | null
export function splitToken(raw: string): { variants: string[]; important: boolean; base: string }
export function escapeClass(cls: string): string
export function ruleFor(token: string): { css: string; depth: number } | null
export function coveredTokens(cssPath?: string): Set<string>
export function generateCss(hits?: DesignHit[]): string
export function runCheck(opts?: { rootDir?: string; cssPath?: string }): { hits: DesignHit[]; violations: DesignViolation[] }
