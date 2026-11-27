import type { MenuItemConstructorOptions } from 'electron'

/** Keep the standard macOS editing and window commands alongside Settings. */
export function settingsMenuTemplate(
  appName: string,
  openSettings: () => void,
  locale = 'en'
): MenuItemConstructorOptions[] {
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: /^zh(?:[-_]|$)/i.test(locale) ? '设置…' : 'Settings…',
          accelerator: 'Command+,',
          click: openSettings
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help' }
  ]
}

/** Coalesce invocations until React has installed its Settings listener. */
export function createSettingsRequestQueue(send: () => void) {
  let ready = false
  let pending = false
  return {
    request() {
      if (ready) send()
      else pending = true
    },
    rendererReady() {
      ready = true
      if (!pending) return
      pending = false
      send()
    },
    rendererUnavailable() {
      ready = false
    }
  }
}
