import { describe, expect, it, vi } from 'vitest'
import { createSettingsRequestQueue, settingsMenuTemplate } from './settingsMenu'

describe('macOS Settings command', () => {
  it('adds Settings and Command+, without dropping the platform menu roles', () => {
    const open = vi.fn()
    const template = settingsMenuTemplate('BotArk', open)
    const submenu = template[0]?.submenu
    if (!Array.isArray(submenu)) throw new Error('Missing app menu')
    const item = submenu.find((entry) => entry.label === 'Settings…')
    expect(template[0]?.label).toBe('BotArk')
    expect(item?.accelerator).toBe('Command+,')
    expect(item?.click).toBe(open)
    expect(template.map((menu) => menu.role)).toContain('editMenu')
    expect(template.map((menu) => menu.role)).toContain('windowMenu')
  })

  it('provides the Chinese label for a Chinese macOS locale', () => {
    const submenu = settingsMenuTemplate('BotArk', vi.fn(), 'zh-CN')[0]?.submenu
    expect(submenu).toEqual(expect.arrayContaining([expect.objectContaining({ label: '设置…' })]))
  })

  it('opens once after the new or reloaded renderer is ready', () => {
    const send = vi.fn()
    const queue = createSettingsRequestQueue(send)
    queue.request()
    queue.request()
    expect(send).not.toHaveBeenCalled()
    queue.rendererReady()
    queue.rendererReady()
    expect(send).toHaveBeenCalledTimes(1)
    queue.request()
    expect(send).toHaveBeenCalledTimes(2)
    queue.rendererUnavailable()
    queue.request()
    expect(send).toHaveBeenCalledTimes(2)
    queue.rendererReady()
    expect(send).toHaveBeenCalledTimes(3)
  })
})
