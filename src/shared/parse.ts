/**
 * Canonical runtime type-narrowing helpers for untrusted JSON/RPC payloads.
 * Shared across main, adapters, and renderer to avoid duplicated local helpers.
 */

export function asObj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

export function trimStr(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
