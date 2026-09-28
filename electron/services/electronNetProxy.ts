import { net } from 'electron'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { Readable } from 'stream'

const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024
const REQUEST_HEADER_DENYLIST = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
  'accept-encoding',
])
const RESPONSE_HEADER_DENYLIST = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'content-encoding',
])

type ProxyEndpoint = { server: Server; baseURL: string }

function normalizedTarget(baseURL: string): string | null {
  const value = String(baseURL || '').trim().replace(/\/+$/, '')
  if (!value) return null
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

function forwardedRequestHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    const normalized = name.toLowerCase()
    if (REQUEST_HEADER_DENYLIST.has(normalized) || normalized.startsWith('sec-')) continue
    if (typeof value === 'string') headers[name] = value
    else if (Array.isArray(value)) headers[name] = value.join(', ')
  }
  return headers
}

function writeForwardedResponseHeaders(response: ServerResponse, headers: Headers): void {
  headers.forEach((value, name) => {
    if (RESPONSE_HEADER_DENYLIST.has(name.toLowerCase())) return
    response.setHeader(name, value)
  })
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const method = String(request.method || 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return undefined
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer | Uint8Array) => {
      size += chunk.length
      if (size > MAX_REQUEST_BODY_BYTES) {
        reject(new Error('请求体超过本地安全转发上限'))
        request.destroy()
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    request.once('end', () => resolve(Buffer.concat(chunks)))
    request.once('aborted', () => reject(new Error('本地请求已取消')))
    request.once('error', reject)
  })
}

/**
 * Bridges worker-process requests through Electron's Chromium network service.
 * Only loopback accepts traffic; the worker receives a temporary localhost URL
 * while the original HTTPS base URL remains private to the main process.
 */
export class ElectronNetProxy {
  private readonly endpoints = new Map<string, Promise<ProxyEndpoint>>()

  async baseURLForWorker(baseURL: string): Promise<string> {
    const target = normalizedTarget(baseURL)
    if (!target) return String(baseURL || '').trim().replace(/\/+$/, '')
    let endpoint = this.endpoints.get(target)
    if (!endpoint) {
      endpoint = this.start(target)
      this.endpoints.set(target, endpoint)
    }
    return (await endpoint).baseURL
  }

  private async start(target: string): Promise<ProxyEndpoint> {
    if (typeof net?.fetch !== 'function') throw new Error('Electron 网络服务不可用')
    const server = createServer((request, response) => {
      void this.forward(target, request, response)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('无法创建本地 AI 网络转发端口')
    }
    return { server, baseURL: `http://127.0.0.1:${address.port}` }
  }

  private async forward(target: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestPath = String(request.url || '/')
    if (!requestPath.startsWith('/') || requestPath.startsWith('//')) {
      response.writeHead(400).end('Invalid proxy request path')
      return
    }

    const controller = new AbortController()
    const abort = () => controller.abort()
    request.once('aborted', abort)
    response.once('close', abort)
    try {
      const body = await readRequestBody(request)
      const upstream = await net.fetch(`${target}${requestPath}`, {
        method: request.method || 'GET',
        headers: forwardedRequestHeaders(request),
        body: body ? new Uint8Array(body) : undefined,
        signal: controller.signal,
      })
      writeForwardedResponseHeaders(response, upstream.headers)
      response.writeHead(upstream.status)
      if (!upstream.body) {
        response.end()
        return
      }
      const stream = Readable.fromWeb(upstream.body as never)
      stream.once('error', (error) => {
        if (!response.destroyed) response.destroy(error)
      })
      stream.pipe(response)
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(502, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : '本地 AI 网络转发失败' }))
      } else if (!response.destroyed) {
        response.destroy(error instanceof Error ? error : undefined)
      }
    } finally {
      request.removeListener('aborted', abort)
    }
  }

  async shutdown(): Promise<void> {
    const endpoints = await Promise.allSettled(this.endpoints.values())
    this.endpoints.clear()
    await Promise.all(endpoints.flatMap((result) => (
      result.status === 'fulfilled'
        ? [new Promise<void>((resolve) => result.value.server.close(() => resolve()))]
        : []
    )))
  }
}

export const electronNetProxy = new ElectronNetProxy()