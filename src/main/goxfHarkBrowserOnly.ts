import type { WebContents } from 'electron'

/** Marker BotArk adds to a Hark page URL when only its remote browser should show. */
export const HARK_BROWSER_ONLY_HASH = 'botark-browser'

/**
 * GOXF 2026-11-26: show only Hark's remote browser out of Hark's own page. Hark's page holds the live view
 * (/api/liveview/view iframe, with the handshake and sign-in it needs); this pins that iframe over the whole view
 * and covers the rest. Without a live view it shows Hark's newest browser screenshot. Selectors are inferred.
 */
const SCRIPT = `(() => {
  if (window.__botarkBrowserOnly) return
  window.__botarkBrowserOnly = 1
  const st = document.createElement('style')
  st.textContent = 'html,body{overflow:hidden!important}'
  document.documentElement.appendChild(st)
  const cover = document.createElement('div')
  cover.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:#0b0f14;color:#9aa3ad;display:flex;align-items:center;justify-content:center;font:13px system-ui,sans-serif'
  cover.textContent = '等待 Hark 浏览器画面…'
  document.body.appendChild(cover)
  let img = null
  const PIN = 'position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;z-index:2147483647!important;border:0!important;visibility:visible!important;opacity:1!important;transform:none!important;background:#000'
  const tick = () => {
    const frames = Array.from(document.querySelectorAll('iframe')).filter((f) => /\\/api\\/liveview\\/view/.test(f.src))
    const f = frames[frames.length - 1]
    for (const e of Array.from(document.querySelectorAll('[data-botark-pin]'))) {
      if (e !== f) { e.style.cssText = e.dataset.botarkOld || ''; e.removeAttribute('data-botark-pin') }
    }
    if (f) {
      if (!f.hasAttribute('data-botark-pin')) { f.dataset.botarkOld = f.style.cssText; f.setAttribute('data-botark-pin', '1') }
      if (f.style.cssText !== PIN) f.style.cssText = PIN
      return
    }
    const shots = Array.from(document.querySelectorAll('img')).filter((i) => /screenshot|artifact|step_\\d+/.test(i.currentSrc || i.src))
    const s = shots[shots.length - 1]
    if (s) {
      if (!img) { img = document.createElement('img'); img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain' }
      if (img.src !== (s.currentSrc || s.src)) img.src = s.currentSrc || s.src
      if (img.parentNode !== cover) { cover.textContent = ''; cover.appendChild(img) }
    } else if (!cover.firstChild || cover.firstChild.nodeType === 3) {
      cover.textContent = '等待 Hark 浏览器画面…（浏览器没在运行时这里显示最新截图）'
    }
  }
  setInterval(tick, 700)
  tick()
})()`

export function installHarkBrowserOnly(contents: WebContents): void {
  let on = false
  contents.on('did-navigate', (_e, url) => {
    on = /^https:\/\/app\.hark\.com\//.test(url) && url.includes(`#${HARK_BROWSER_ONLY_HASH}`)
  })
  const inject = () => { void contents.executeJavaScript(SCRIPT, true).catch(() => undefined) }
  contents.on('dom-ready', () => { if (on) inject() })
  // Same page, new hash: no reload, so inject now (the page may drop the hash afterwards; the script stays).
  contents.on('did-navigate-in-page', (_e, url) => {
    if (/^https:\/\/app\.hark\.com\//.test(url) && url.includes(`#${HARK_BROWSER_ONLY_HASH}`)) inject()
  })
}
