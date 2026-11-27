import { app } from 'electron'

/** System dialogs run outside the renderer and follow the desktop app's macOS language. */
export function nativeDisplayCopy(zh: string, en: string, values?: unknown[]): string {
  let text = en
  try {
    if (/^zh(?:[-_]|$)/i.test(app.getLocale())) text = zh
  } catch { /* An early or headless native window can use the English fallback. */ }
  return values ? text.replace(/\{(\d+)\}/g, (part, i: string) => (
    Object.hasOwn(values, i) ? String(values[Number(i)]) : part
  )) : text
}
