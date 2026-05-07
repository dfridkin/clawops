import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock all MCP server dependencies so we can test transport selection in isolation
vi.mock('../../src/mcp/tools/registry.js', () => ({ registerTools: vi.fn() }))
vi.mock('../../src/mcp/resources.js',       () => ({ registerResources: vi.fn() }))
vi.mock('../../src/mcp/prompts.js',         () => ({ registerPrompts: vi.fn() }))

// Mock McpServer
const mockConnect = vi.fn()
const mockServerClose = { onclose: undefined as (() => void) | undefined }
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    server: mockServerClose,
    registerTool: vi.fn(),
    registerResource: vi.fn(),
    registerPrompt: vi.fn(),
  })),
}))

// Mock StdioServerTransport
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn().mockImplementation(() => ({ type: 'stdio' })),
}))

// Mock StreamableHTTPServerTransport
const mockHandleRequest = vi.fn()
const mockHttpTransport = {
  type: 'http',
  handleRequest: mockHandleRequest,
  onclose: undefined as (() => void) | undefined,
}
vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: vi.fn().mockImplementation(() => mockHttpTransport),
}))

// Mock node:http createServer
const mockListen = vi.fn((_port: number, _bind: string, cb?: () => void) => {
  cb?.()
  return mockHttpServer
})
const mockOnce = vi.fn()
const mockHttpServer = { listen: mockListen, once: mockOnce, on: vi.fn() }
vi.mock('node:http', () => ({
  createServer: vi.fn(() => mockHttpServer),
}))

// Mock package.json (needs both default and named export for assert {type:'json'} import)
vi.mock('../../package.json', () => ({ default: { version: '0.0.0' }, version: '0.0.0' }))

beforeEach(() => {
  vi.clearAllMocks()
  mockServerClose.onclose = undefined
  mockHttpTransport.onclose = undefined

  mockConnect.mockResolvedValue(undefined)
  mockListen.mockImplementation((_port: number, _bind: string, cb?: () => void) => {
    cb?.()
    return mockHttpServer
  })
})

describe('serveMcp HTTP transport', () => {
  it('creates StreamableHTTPServerTransport with sessionIdGenerator when port is provided', async () => {
    mockOnce.mockImplementation((_event: string, cb: () => void) => {
      setTimeout(cb, 0)
      return mockHttpServer
    })
    const { serveMcp } = await import('../../src/mcp/server.js')
    await serveMcp({ port: 3001 })

    const { StreamableHTTPServerTransport } = await import(
      '@modelcontextprotocol/sdk/server/streamableHttp.js'
    )
    expect(StreamableHTTPServerTransport).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdGenerator: expect.any(Function) }),
    )
  })

  it('calls httpServer.listen with the specified port and default bind', async () => {
    mockOnce.mockImplementation((_event: string, cb: () => void) => {
      setTimeout(cb, 0)
      return mockHttpServer
    })
    const { serveMcp } = await import('../../src/mcp/server.js')
    await serveMcp({ port: 8080 })

    expect(mockListen).toHaveBeenCalledWith(8080, '127.0.0.1', expect.any(Function))
  })

  it('respects custom bind address', async () => {
    mockOnce.mockImplementation((_event: string, cb: () => void) => {
      setTimeout(cb, 0)
      return mockHttpServer
    })
    const { serveMcp } = await import('../../src/mcp/server.js')
    await serveMcp({ port: 9000, bind: '0.0.0.0' })

    expect(mockListen).toHaveBeenCalledWith(9000, '0.0.0.0', expect.any(Function))
  })

  it('uses StdioServerTransport when no port is given', async () => {
    mockConnect.mockImplementation(() => {
      setTimeout(() => mockServerClose.onclose?.(), 0)
      return Promise.resolve()
    })
    const { serveMcp } = await import('../../src/mcp/server.js')
    await serveMcp({})

    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
    expect(StdioServerTransport).toHaveBeenCalledOnce()
    expect(mockListen).not.toHaveBeenCalled()
  })
})
