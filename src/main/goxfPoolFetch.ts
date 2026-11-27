/**
 * GOXF fork: fetch through the proxy pool's fastest entry (like the updater),
 * falling back to the system network when that fails. Used for the Mihomo
 * kernel download and subscription downloads. Never logs URLs (subscription
 * URLs carry tokens).
 */
import { net, session } from 'electron'
import { updaterPoolProxy } from './muse/accountProxy'

const PARTITION = 'goxf-pool-fetch'
let appliedRules: string | undefined

export async function poolThenSystemFetch(url: string, init: RequestInit): Promise<Response> {
  const pick = await updaterPoolProxy().catch(() => null)
  if (pick) {
    try {
      const ses = session.fromPartition(PARTITION)
      if (appliedRules !== pick.rules) {
        await ses.setProxy({ mode: 'fixed_servers', proxyRules: pick.rules, proxyBypassRules: '<local>' })
        await ses.closeAllConnections().catch(() => undefined)
        appliedRules = pick.rules
      }
      return await ses.fetch(url, init)
    } catch (error) {
      if (init.signal?.aborted) throw error
    }
  }
  return net.fetch(url, init)
}

/** Read a body with a byte cap; `onProgress` gets received bytes. */
export async function readCapped(res: Response, cap: number, onProgress?: (received: number) => void): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'))
  if (declared && declared > cap) throw new Error('内容过大')
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > cap) {
      await reader.cancel().catch(() => undefined)
      throw new Error('内容过大')
    }
    chunks.push(Buffer.from(value))
    onProgress?.(received)
  }
  return Buffer.concat(chunks)
}
