import { useEffect, useRef, useState } from 'react'

type WebviewEl = HTMLElement & { executeJavaScript(code: string): Promise<unknown> }

/**
 * GOXF 2026-11-26: Hark's live browser stream (/api/liveview/view?t=…). The relay only streams to a viewer that
 * carries the Hark sign-in cookie, which lives in the account's partition, so this is a <webview> in that partition
 * (main maps `hark-live:<accountId>` to the real one in will-attach-webview). While the page has no frame, or says the
 * session ended, the caller's screenshot shows instead.
 */
export function HarkLiveView({ src, accountId, className, onState }: {
  src: string
  accountId: string
  className?: string
  onState: (live: boolean) => void
}) {
  const ref = useRef<WebviewEl | null>(null)
  const [painted, setPainted] = useState(false)
  useEffect(() => { onState(painted) }, [painted, onState])
  useEffect(() => {
    setPainted(false)
    const el = ref.current
    if (!el) return
    let ready = false
    const onReady = () => { ready = true }
    el.addEventListener('dom-ready', onReady)
    const timer = window.setInterval(() => {
      if (!ready) return
      el.executeJavaScript(
        "(function(){var s=document.getElementById('s'),c=document.getElementById('c');return {t:s?s.textContent:'',w:c?c.width:0}})()"
      ).then((r) => {
        const v = (r ?? {}) as { t?: string; w?: number }
        const text = String(v.t ?? '')
        setPainted(text === 'live' || (!/ended|disconnected|connecting|reconnecting/.test(text) && (v.w ?? 0) > 0))
      }).catch(() => setPainted(false))
    }, 1000)
    return () => { window.clearInterval(timer); el.removeEventListener('dom-ready', onReady) }
  }, [src])
  // React passes unknown lowercase attributes through to the custom element.
  return (
    <webview ref={ref as never} src={src} partition={`hark-live:${accountId}`}
      className={className} style={painted ? { display: 'flex' } : { position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }} />
  )
}
