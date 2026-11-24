import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetch } = vi.hoisted(() => ({ fetch: vi.fn() }))

vi.mock('electron', () => ({ session: { fromPartition: () => ({ fetch }) } }))
vi.mock('../webContentsViewManager', () => ({ partitionForAccount: (id: string) => id }))
vi.mock('../muse/accountProxy', () => ({ applyProxyToPartition: vi.fn() }))

import { downloadHarkArtifact } from './harkClient'

beforeEach(() => {
  fetch.mockReset()
  fetch.mockResolvedValue(
    new Response('# Test document', { headers: { 'Content-Type': 'text/markdown' } })
  )
})

describe('Hark artifact downloads', () => {
  it.each([
    ['url', '/api/files/file-id'],
    ['fileId', '/api/files/file-id']
  ])('resolves a relative API path supplied as %s against the Hark origin', async (kind, path) => {
    const result = await downloadHarkArtifact('account', { [kind]: path, name: 'test.md' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith('https://app.hark.com/api/files/file-id')
    expect(fetch.mock.calls[0]?.[0]).not.toContain('/api/api/')
    expect(result.text).toBe('# Test document')
  })

  it('preserves an absolute artifact URL', async () => {
    await downloadHarkArtifact('account', { url: 'https://app.hark.com/api/files/file-id?download=1' })
    expect(fetch).toHaveBeenCalledWith('https://app.hark.com/api/files/file-id?download=1')
  })

  it.each([true, false])('bounds screenshots with or without content-length (%s)', async (hasLength) => {
    const cancel = vi.fn()
    const body = new ReadableStream({
      start(controller) {
        if (!hasLength) controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1))
      },
      cancel
    })
    fetch.mockResolvedValueOnce(new Response(body, {
      headers: hasLength ? { 'content-length': String(9 * 1024 * 1024) } : undefined
    }))
    await expect(downloadHarkArtifact('account', { url: 'https://app.hark.com/screenshot.png', preview: true }))
      .rejects.toThrow('exceeds 8 MiB')
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })

  it('cancels an unread preview body when a newer screenshot supersedes it', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream({ cancel })
    fetch.mockResolvedValueOnce(new Response(body))
    const controller = new AbortController()
    const preview = downloadHarkArtifact('account', {
      url: 'https://app.hark.com/screenshot.png', preview: true, signal: controller.signal
    })
    await vi.waitFor(() => expect(body.locked).toBe(true))
    controller.abort()
    await expect(preview).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })
})
