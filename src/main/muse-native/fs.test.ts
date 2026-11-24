import { expect, it, vi } from 'vitest'
import { downloadFsRawFile, fetchFsRawPreview, fetchHttpWorkspaceFile } from './fs'
import type { MuseNativeGateway } from './gateway'

const MiB = 1024 * 1024

it('downloads the entire 9 MiB file separately from its marked 8 MiB preview', async () => {
  const sample = new Uint8Array(9 * MiB).fill(42)
  sample[sample.length - 1] = 9
  const requestBinary = vi.fn<MuseNativeGateway['requestBinary']>()
    .mockResolvedValueOnce({
      status: 206, contentRange: `bytes 0-${8 * MiB - 1}/${9 * MiB}`,
      body: sample.subarray(0, 8 * MiB), truncated: false
    })
    .mockResolvedValueOnce({ status: 200, body: sample, contentLength: sample.length, truncated: false })
  const gateway = { requestBinary } as unknown as MuseNativeGateway
  const path = 'workspace/report.bin'
  const preview = await fetchFsRawPreview(gateway, path)
  expect(preview).toMatchObject({ byteLength: 8 * MiB, truncated: true })
  expect(requestBinary).toHaveBeenNthCalledWith(1, 'fs.raw', { path, _range: { start: 0, end: 8 * MiB - 1 } }, 120_000, 8 * MiB)
  const download = await downloadFsRawFile(gateway, path)
  expect(download).toMatchObject({ byteLength: 9 * MiB, truncated: false })
  expect(Buffer.from(download.dataBase64, 'base64').at(-1)).toBe(9)
  expect(requestBinary).toHaveBeenNthCalledWith(2, 'fs.raw', { path }, 120_000, undefined)
})

it('rejects partial and unexpectedly short download responses', async () => {
  const requestBinary = vi.fn<MuseNativeGateway['requestBinary']>()
    .mockResolvedValueOnce({ status: 206, body: new Uint8Array(5), truncated: false })
    .mockResolvedValueOnce({ status: 200, body: new Uint8Array(5), contentLength: 9, truncated: false })
  const gateway = { requestBinary } as unknown as MuseNativeGateway
  await expect(downloadFsRawFile(gateway, 'workspace/a')).rejects.toThrow('complete file')
  await expect(downloadFsRawFile(gateway, 'workspace/a')).rejects.toThrow('complete file')
})

it('cancels an HTTP preview stream at its byte limit even without Content-Length', async () => {
  let pulls = 0
  const cancel = vi.fn()
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++
      controller.enqueue(new Uint8Array(3 * MiB))
    },
    cancel
  }))
  const preview = await fetchHttpWorkspaceFile(async () => response, 'https://muse.ai/file.bin', false)
  expect(preview).toMatchObject({ byteLength: 8 * MiB, truncated: true })
  expect(pulls).toBeLessThanOrEqual(4)
  expect(cancel).toHaveBeenCalledOnce()
})
