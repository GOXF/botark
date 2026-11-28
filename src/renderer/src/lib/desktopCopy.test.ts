import { afterEach, describe, expect, it } from 'vitest'
import { usePrefsStore } from '@/store/prefsStore'
import { desktopCopy, desktopNotice } from './desktopCopy'

afterEach(() => usePrefsStore.getState().setLocale('en'))

describe('desktop localization', () => {
  it('switches known labels without changing the original Chinese', () => {
    usePrefsStore.getState().setLocale('en')
    expect(desktopCopy('默认浏览器授权', 'Sign in with your browser')).toBe('Sign in with your browser')
    usePrefsStore.getState().setLocale('zh')
    expect(desktopCopy('默认浏览器授权', 'Sign in with your browser')).toBe('默认浏览器授权')
  })
  it('keeps dynamic values and their punctuation unchanged', () => {
    usePrefsStore.getState().setLocale('en')
    expect(desktopCopy('打开 {0}', 'Open {0}', ['文件 & notes'])).toBe('Open 文件 & notes')
    expect(desktopNotice('这个任意文本应保持不变')).toBe('这个任意文本应保持不变')
  })
  it('translates known diagnostics only when English is selected', () => {
    const original = '已送达，但没有收到回复'
    usePrefsStore.getState().setLocale('en')
    expect(desktopNotice(original)).toBe('Delivered, but no reply received')
    usePrefsStore.getState().setLocale('zh')
    expect(desktopNotice(original)).toBe(original)
  })
  it('translates room limits and delivery notices without changing member names', () => {
    usePrefsStore.getState().setLocale('en')
    expect(desktopNotice('已达 1 轮上限，待回复：@成员 A')).toBe('Round limit reached (1). Still awaiting: @成员 A')
    expect(desktopNotice('成员 A 本轮未送达。')).toBe('The message wasn’t delivered to 成员 A.')
    expect(desktopNotice('目录：项目 A')).toBe('目录：项目 A')
    const unknown = "Error invoking remote method 'bothub:grok:rpc': Error: 自定义错误"
    expect(desktopNotice(unknown)).toBe(unknown)
    expect(desktopNotice("Error invoking remote method 'bothub:grok:rpc': Error: 已送达，但没有收到回复")).toBe('Delivered, but no reply received')
  })
  it('localizes native IPC validation failures without losing the server name', () => {
    usePrefsStore.getState().setLocale('en')
    const raw = "Error invoking remote method 'botark:workspace': Error: 无效的 MCP 服务 URL（Example）：url 必须为字符串"
    expect(desktopNotice(raw)).toBe('Invalid URL for MCP server “Example”: the URL must be a string.')
    expect(desktopNotice("Error invoking remote method 'botark:workspace': Error: 非内置消息")).toBe(
      "Error invoking remote method 'botark:workspace': Error: 非内置消息"
    )
  })

})
