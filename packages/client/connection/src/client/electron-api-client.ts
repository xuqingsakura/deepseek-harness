/**
 * Electron IPC carrier: the desktop shell's renderer reaches the host through
 * the preload bridge instead of the browser's HTTP/WebSocket transport.
 *
 * `doFetch` forwards every request to the main process (`dsh:api-fetch`), and
 * the mux/host event streams arrive as pushed `dsh:api-frame` messages; the
 * main process bridges both onto the host's loopback server. This is the
 * carrier the GUI layering note reserves for Electron: "Electron loads dist
 * over file:// and carries fetch over an IPC bridge."
 * @module @deepseek-ai/dsh-client-connection/electron
 */

import type { ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest } from './api.ts'
import { AbstractApiClient } from './api.ts'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'

/** Minimal bridge surface the preload exposes as `window.dshDesktop`. */
export interface ElectronApiBridge {
  apiFetch(request: {
    url: string
    method: string
    headers: Record<string, string>
    body?: string
  }): Promise<{
    status: number
    statusText: string
    headers: Record<string, string>
    text: string
  }>
  subscribeApiStream(
    channel: 'mux' | 'host',
    onFrame: (envelope: unknown) => void,
    onOpen: () => void,
    onEnd: () => void,
  ): () => void
}

declare global {
  interface Window {
    dshDesktop?: ElectronApiBridge
  }
}

type SocketItem<F> = { kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end' }
type Parser<F> = { parse(value: unknown): F }

/** Serialize fetch init headers into a plain record for the IPC boundary. */
function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) return {}
  return Object.fromEntries(new Headers(headers).entries())
}

/**
 * Electron platform subclass: unary/respond go over `dsh:api-fetch`; mux/host
 * streams consume `dsh:api-frame` pushes forwarded by the main process.
 */
export class ElectronApiClient extends AbstractApiClient {
  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const bridge = window.dshDesktop
    if (bridge === undefined) throw new Error('electron api carrier: window.dshDesktop bridge missing')
    const body = typeof init?.body === 'string' ? init.body : undefined
    return bridge.apiFetch({
      url: input.href,
      method: init?.method ?? 'GET',
      headers: headersToRecord(init?.headers),
      ...(body !== undefined ? { body } : {}),
    }).then(response => new Response(response.text, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    }))
  }

  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readIpcStream('mux', signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readIpcStream('host', signal, hostFrameSchema, onOpen)
  }

  private async *readIpcStream<F extends MuxFrame | HostFrame>(
    channel: 'mux' | 'host',
    signal: AbortSignal,
    frameSchema: Parser<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const bridge = window.dshDesktop
    if (bridge === undefined) throw new Error('electron api carrier: window.dshDesktop bridge missing')
    const inbox: SocketItem<F>[] = []
    let wake: (() => void) | undefined
    const enqueue = (item: SocketItem<F>): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    let opened = false
    const handleOpen = (): void => {
      if (opened) return
      opened = true
      onOpen?.()
    }
    const unsubscribe = bridge.subscribeApiStream(channel, (envelope) => {
      let full: ServerRequest
      let frame: F
      try {
        full = serverRequestSchema.parse(envelope)
        frame = frameSchema.parse(full.payload)
      } catch (error) {
        console.error(`[client-connection] dropping malformed IPC frame on ${channel}:`, error)
        return
      }
      this.onEnvelope(full)
      enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } })
    }, handleOpen, () => enqueue({ kind: 'end' }))
    const handleAbort = (): void => {
      unsubscribe()
      enqueue({ kind: 'end' })
    }
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift() as SocketItem<F>
          if (item.kind === 'end') return
          yield item.envelope
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', handleAbort)
      unsubscribe()
    }
  }
}
