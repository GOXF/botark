import { app } from 'electron'

import { isDisplayLocale, type DisplayLocale } from '@shared/displayLocale'

let rendererLocale: DisplayLocale | undefined

/** A valid, changed preference returns true so the app can refresh its existing menu. */
export function setNativeDisplayLocale(value: unknown): boolean {
  if (!isDisplayLocale(value) || value === rendererLocale) return false
  rendererLocale = value
  return true
}

export function getNativeDisplayLocale(): DisplayLocale {
  if (rendererLocale) return rendererLocale
  try {
    return /^zh(?:[-_]|$)/i.test(app.getLocale()) ? 'zh' : 'en'
  } catch { return 'en' }
}

/** Native UI follows the in-app preference once the primary renderer has loaded it. */
export function nativeDisplayCopy(zh: string, en: string, values?: unknown[]): string {
  const text = getNativeDisplayLocale() === 'zh' ? zh : en
  return values ? text.replace(/\{(\d+)\}/g, (part, i: string) => (
    Object.hasOwn(values, i) ? String(values[Number(i)]) : part
  )) : text
}
