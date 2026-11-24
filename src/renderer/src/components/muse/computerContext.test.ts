import { describe, expect, it, vi } from 'vitest'
import {
  computerPreviewRef, isComputerTaskRunning, loadComputerPreview, matchesComputerPreview, parseComputerContext, parseComputerPreview,
  readComputerContext
} from './computerContext'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII='
const pngUrl = `data:image/png;base64,${png}`

describe('parseComputerContext', () => {
  it('reads a nested active task and its latest screenshot reference', () => {
    const task = { id: 'task-1', status: 'RUNNING', page_url: 'https://google.com', page_title: 'Google' }
    const context = { result: { context: { computer: { browser: {
      active_task: task, latest_preview: { image_hash: 'frame-1' }
    } } } } }
    expect(parseComputerContext(context)).toMatchObject({
      taskId: 'task-1', sha256: 'frame-1', status: 'RUNNING', url: 'https://google.com', title: 'Google', raw: task
    })
  })

  it('reads recent tasks and inline screenshots, including wrapped and direct data URLs', () => {
    expect(parseComputerContext({ context: { latest_task: {
      taskId: 'task-1', state: 'completed', screenshot: { data_base64: png, content_type: 'image/png' }
    } } })).toMatchObject({ taskId: 'task-1', status: 'completed', inlineSrc: pngUrl })
    expect(parseComputerContext({ tasks: [{ id: 'task-2', latest_preview: { url: pngUrl } }] }))
      .toMatchObject({ taskId: 'task-2', inlineSrc: pngUrl, url: undefined })
    expect(parseComputerContext({ browser: { screenshot: png } }).inlineSrc).toBe(pngUrl)
  })

  it('distinguishes a browser page URL from an image URL', () => {
    const page = 'https://google.com'
    const shot = 'https://muse.ai/previews/frame.png?token=example'
    expect(parseComputerContext({ current_url: page, preview: { url: shot } }))
      .toMatchObject({ url: page, inlineSrc: shot })
    expect(parseComputerContext({ preview: { url: page } })).toMatchObject({ url: page, inlineSrc: undefined })
    expect(parseComputerContext({ screenshot: { image_url: shot } }).inlineSrc).toBe(shot)
    expect(parseComputerContext({ preview: { url: '/api/computer/previews/task-1/frame-1' } })).toMatchObject({
      taskId: 'task-1', sha256: 'frame-1', url: undefined
    })
    expect(parseComputerContext({ context: { current_url: page, viewer_url: 'https://muse.ai/browser/view' } }))
      .toMatchObject({ url: page, interactionUrl: 'https://muse.ai/browser/view' })
  })

  it('selects the requested session and keeps other tasks’ screenshots out', () => {
    const own = { id: 'task-1', thread_id: 'thread-1', preview_sha256: 'frame-1' }
    const other = { id: 'task-2', session_id: 'thread-2' }
    const context = {
      result: { active_task: other, tasks: [other, own], active_task_id: 'task-2',
        preview: { task_id: 'task-2', hash: 'frame-2', dataBase64: png } }
    }
    expect(parseComputerContext(context, 'thread-1')).toMatchObject({
      taskId: 'task-1', sessionId: 'thread-1', sha256: 'frame-1', inlineSrc: undefined
    })
    expect(parseComputerContext({ context: { session_id: 'thread-2', task: other } }, 'thread-1')).toEqual({ raw: {} })
    expect(parseComputerContext({ task: own, preview: { task_id: 'task-2', sha256: 'frame-2', dataBase64: png } }))
      .toMatchObject({ sha256: 'frame-1', inlineSrc: undefined })
  })

  it('leaves an idle or empty context without a task or screenshot', () => {
    const parsed = parseComputerContext({ result: { context: { status: 'idle', task: null, preview: null } } })
    expect(parsed).toMatchObject({ status: 'idle', taskId: undefined, sha256: undefined, url: undefined, inlineSrc: undefined })
    expect(isComputerTaskRunning('PENDING')).toBe(true)
    expect(isComputerTaskRunning('in-progress')).toBe(true)
    expect(isComputerTaskRunning(parsed.status)).toBe(false)
    expect(isComputerTaskRunning('completed')).toBe(false)
    expect(parseComputerContext({ context: { id: 'request-id', status: 'idle' } }).taskId).toBeUndefined()
  })
})

describe('Muse screenshot loading', () => {
  it.each([
    { dataBase64: png, contentType: 'image/png' },
    { result: { data: png, mime_type: 'image/png' } },
    { result: { preview: { imageBase64: png, mimeType: 'image/png' } } },
    { base64: png },
    { png_base64: png },
    { dataUrl: pngUrl },
    { url: pngUrl },
    { data: { data_base64: png, content_type: 'application/octet-stream' } }
  ])('normalizes alternative preview payloads to an image source', (response) => {
    expect(parseComputerPreview(response)).toBe(pngUrl)
  })

  it('handles JPEG and rejects failed, truncated, and non-image responses', () => {
    expect(parseComputerPreview({ jpeg_base64: '/9j/4AAQSkZJRg==' })).toBe('data:image/jpeg;base64,/9j/4AAQSkZJRg==')
    expect(parseComputerPreview({ ok: false, result: { base64: png } })).toBeUndefined()
    expect(parseComputerPreview({ dataBase64: png, truncated: true })).toBeUndefined()
    expect(parseComputerPreview({ dataBase64: 'aGk=', contentType: 'text/html' })).toBeUndefined()
    expect(parseComputerPreview({ dataUrl: 'data:text/html;base64,aGk=' })).toBeUndefined()
    expect(parseComputerPreview({ url: 'javascript:alert(1)' })).toBeUndefined()
  })

  it('handles a binary response from the Muse page hook', async () => {
    const data = Uint8Array.from(atob(png), (char) => char.charCodeAt(0))
    expect(parseComputerPreview({ result: { body: data, contentType: 'image/png' } })).toBe(pngUrl)
    const muse = { rpc: vi.fn().mockResolvedValue(new Blob([data], { type: 'image/png' })), previewWorkspaceFile: vi.fn() }
    await expect(loadComputerPreview(muse, 'account-1', { taskId: 'task-1', sha256: 'frame-1' })).resolves.toBe(pngUrl)
  })

  it('resolves a card without identifiers from context, then fetches its binary screenshot', async () => {
    const muse = {
      rpc: vi.fn().mockResolvedValueOnce({ context: { task: { id: 'task-1' }, preview: { hash: 'frame-1' } } })
        .mockResolvedValueOnce({ data: png, mimeType: 'image/png' }),
      previewWorkspaceFile: vi.fn()
    }
    const snapshot = await readComputerContext(muse.rpc, 'account-1', 'thread-1')
    expect(matchesComputerPreview(snapshot, {})).toBe(true)
    expect(matchesComputerPreview(snapshot, { taskId: 'other-task', sha256: 'frame-1' })).toBe(false)
    expect(matchesComputerPreview(snapshot, { sha256: 'frame-1' })).toBe(true)
    await expect(loadComputerPreview(muse, 'account-1', snapshot)).resolves.toBe(pngUrl)
    expect(muse.rpc.mock.calls).toEqual([
      [{ accountId: 'account-1', method: 'computer.context', params: { session_id: 'thread-1' } }],
      [{ accountId: 'account-1', method: 'computer.preview', params: { task_id: 'task-1', sha256: 'frame-1' } }]
    ])
  })

  it('uses a newer frame reference when refreshing a card with an older embedded image', () => {
    const stored = { taskId: 'task-1', sha256: 'old', inlineSrc: pngUrl }
    const snapshot = parseComputerContext({ task: { id: 'task-1', preview_sha256: 'new' } })
    expect(computerPreviewRef(snapshot, stored)).toEqual({ taskId: 'task-1', sha256: 'new', inlineSrc: undefined })
  })

  it('renders an inline screenshot without a second RPC and downloads URL previews in the account partition', async () => {
    const url = 'https://muse.ai/previews/frame'
    const muse = { rpc: vi.fn().mockResolvedValue({ result: { url } }),
      previewWorkspaceFile: vi.fn().mockResolvedValue({ dataBase64: png, mimeType: 'image/png' }) }
    await expect(loadComputerPreview(muse, 'account-1', { inlineSrc: pngUrl })).resolves.toBe(pngUrl)
    expect(muse.rpc).not.toHaveBeenCalled()

    const ref = { taskId: 'task-1', sha256: 'frame-1' }
    const first = loadComputerPreview(muse, 'account-1', ref)
    const concurrent = loadComputerPreview(muse, 'account-1', ref)
    await expect(Promise.all([first, concurrent])).resolves.toEqual([pngUrl, pngUrl])
    expect(muse.rpc).toHaveBeenCalledOnce()
    expect(muse.previewWorkspaceFile).toHaveBeenCalledExactlyOnceWith('account-1', url)
  })
})
