import { usePrefsStore } from '@/store/prefsStore'
import { desktopNotices } from './desktopNotices'

/** Localize legacy BotArk-owned text. Never translate user chat or provider pages. */
export function desktopCopy(zh: string, en: string, values?: unknown[]): string {
  const text = usePrefsStore.getState().locale === 'zh' ? zh : en
  return values ? text.replace(/\{(\d+)\}/g, (part, i: string) => (
    Object.hasOwn(values, i) ? String(values[Number(i)]) : part
  )) : text
}


const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Subscribe copy-rendering components without remounting the chat or losing drafts. */
export function useDesktopLocale(): void {
  usePrefsStore((state) => state.locale)
}

const numericSlot = /\{(\d+)\}/g
const noticePatterns = Object.entries(desktopNotices).flatMap(([zh, en]) => {
  const slots = [...zh.matchAll(numericSlot)].map((match) => Number(match[1]))
  const parts = zh.split(/\{\d+\}/g)
  const literal = parts.join('')
  // Judge the whole diagnostic, not just its prefix: e.g. «已达 {0} 轮上限…».
  // Keep generic labels like «目录：{0}» out of free-form error matching.
  if (!slots.length || literal.trim().length < 5 || !/\p{Script=Han}/u.test(literal)) return []
  return [{ fixedLength: literal.length, regex: new RegExp('^'+parts.map(escapeRe).join('([\\s\\S]*?)')+'$'), slots, en }]
}).sort((a, b) => b.fixedLength - a.fixedLength)

/** At a diagnostic display boundary, localize only known app copy, never arbitrary text. */
export function desktopNotice(value: string): string
export function desktopNotice(value: string | undefined): string | undefined
export function desktopNotice(value: string | null | undefined): string | null | undefined
export function desktopNotice(value: string | null | undefined): string | null | undefined {
  if (!value || usePrefsStore.getState().locale === 'zh' || !/\p{Script=Han}/u.test(value)) return value
  const diagnostic = value.replace(/^Error invoking remote method ['"](?:botark|bothub):[^'"]+['"]:\s*(?:Error:\s*)?/, '')
  const exact = Object.hasOwn(desktopNotices, diagnostic) ? desktopNotices[diagnostic] : undefined
  if (exact) return exact
  if (diagnostic.length > 1800) return value
  for (const { regex, slots, en } of noticePatterns) {
    const matched = regex.exec(diagnostic)
    if (!matched) continue
    const args: string[] = []
    slots.forEach((slot, i) => { args[slot] = matched[i + 1] ?? '' })
    return en.replace(numericSlot, (part, i: string) => args[Number(i)] ?? part)
  }
  return value
}
