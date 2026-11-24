import { describe, expect, it } from 'vitest'
import { isToolRequest, requestedTool } from './toolRequests'

describe('requestedTool', () => {
  it('returns undefined when text does not start with [TOOL]', () => {
    expect(requestedTool('Hello world')).toBeUndefined()
    expect(requestedTool('Let me call [TOOL] {"name":"read","args":{}}')).toBeUndefined()
  })

  it('parses standard single-line [TOOL] JSON', () => {
    expect(requestedTool('[TOOL] {"name":"read","args":{"path":"notes.txt"}}')).toEqual({
      name: 'read',
      args: { path: 'notes.txt' }
    })
  })

  it('parses [TOOL] JSON followed by trailing prose on same line or new lines', () => {
    expect(
      requestedTool('[TOOL] {"name":"list","args":{"path":"."}} I will inspect the directory next.')
    ).toEqual({
      name: 'list',
      args: { path: '.' }
    })
    expect(
      requestedTool('  [TOOL] {"name":"read","args":{"path":"src/App.tsx"}}\n\nWaiting for approval.')
    ).toEqual({
      name: 'read',
      args: { path: 'src/App.tsx' }
    })
  })

  it('parses [TOOL] wrapped in fenced markdown code blocks', () => {
    expect(
      requestedTool('[TOOL]\n```json\n{"name":"search","args":{"path":".","query":"mcp"}}\n```\nDone!')
    ).toEqual({
      name: 'search',
      args: { path: '.', query: 'mcp' }
    })
    expect(
      requestedTool('[TOOL] ```\n{"name":"read","args":{"path":"README.md"}}\n```')
    ).toEqual({
      name: 'read',
      args: { path: 'README.md' }
    })
  })

  it('handles braces, escaped quotes, and backslashes inside string values', () => {
    expect(
      requestedTool(
        '[TOOL] {"name":"write","args":{"path":"a.json","text":"{\\"k\\": \\"v\\\\n\\"}"}} trailing {ignored}'
      )
    ).toEqual({
      name: 'write',
      args: { path: 'a.json', text: '{"k": "v\\n"}' }
    })
  })

  it('classifies malformed leading tool requests and reports invalid JSON without exposing arguments', () => {
    expect(isToolRequest('  [tool]\n{"name":"read"')).toBe(true)
    expect(isToolRequest('[FINAL]\nExample: [TOOL] {}')).toBe(false)
    expect(() => requestedTool('  [tool] {"name":"read", "args":{"secret":"@Peer"}')).toThrow(
      /^无效的工具请求：JSON 格式有误$/
    )
    expect(() => requestedTool('[TOOL] hello world')).toThrow('JSON 格式有误')
  })

  it('treats control labels and mentions inside tool arguments as data', () => {
    const text = '[TOOL] {"name":"read","args":{"path":".","query":"[FINAL] @Peer"}}'
    expect(requestedTool(text)).toEqual({ name: 'read', args: { path: '.', query: '[FINAL] @Peer' } })
  })

  it('throws "无效的工具请求" on invalid tool payload structures', () => {
    expect(() => requestedTool('[TOOL] {"name":"","args":{}}')).toThrow('无效的工具请求')
    expect(() => requestedTool('[TOOL] {"name":"read","args":[]}')).toThrow('无效的工具请求')
    expect(() => requestedTool('[TOOL] {"args":{}}')).toThrow('无效的工具请求')
  })
})
