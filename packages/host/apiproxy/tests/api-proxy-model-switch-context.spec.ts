/**
 * One session, two providers: selecting a different provider/model mid-conversation
 * must route the next request to the new selection while deriving the FULL prior
 * history (user turns + assistant replies) — the conversation continues, not
 * restarts. This pins the contract behind the composer model seat and /model popup.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, {
  LlmAdapter,
  type GenerateOptions, type LlmModelInfo, type LlmProviderInfo,
  type LlmResolvedModelInfo, type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`switch-${String(nextRpc++)}`), payload }
}

/** Records every assembled request; serves two provider routes. */
class SwitchAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([
      { provider: 'switch-a', id: 'model-a', name: 'Model A' },
      { provider: 'switch-b', id: 'model-b', name: 'Model B' },
    ])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(_options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness(): Promise<{
  ctx: Context
  agent: Agent
  sessionId: SessionId
  adapter: SwitchAdapter
  api: ReturnType<typeof createApiProxy>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(UserQuestionService)
  const adapter = new SwitchAdapter()
  ctx.llm.registerAdapter(['switch-a', 'switch-b'], adapter)
  const sessionId = SessionId('switch-context')
  const agent = ctx.agentLoop.create(sessionId, { provider: 'switch-a', model: 'model-a' })
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'switch-a', model: 'model-a' }),
    cwd: '/tmp',
  })
  return { ctx, agent, sessionId, adapter, api }
}

describe('Web session model switch keeps conversation context', () => {
  it('routes the next request to the new selection with the full prior history', async () => {
    const { ctx, agent, sessionId, adapter, api } = await harness()

    const first = await api.sessions.prompt(request({
      sessionId, mode: 'queue' as const, content: [{ type: 'text' as const, text: 'first question' }],
    }))
    expect(first.result).toMatchObject({ ok: true })
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ provider: 'switch-a', model: 'model-a' })
    const firstMessages = adapter.requests[0]!.messages
    // Before the first reply exists, the request carries only the user turn.
    expect(firstMessages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(firstMessages.filter(message => message.role === 'assistant')).toHaveLength(0)

    const switched = await api.sessions.selectModel(request({
      sessionId, provider: 'switch-b', model: 'model-b',
    }))
    expect(switched.result).toMatchObject({
      ok: true,
      value: { selected: { provider: 'switch-b', model: 'model-b' } },
    })

    const second = await api.sessions.prompt(request({
      sessionId, mode: 'queue' as const, content: [{ type: 'text' as const, text: 'second question' }],
    }))
    expect(second.result).toMatchObject({ ok: true })
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]).toMatchObject({ provider: 'switch-b', model: 'model-b' })
    const secondMessages = adapter.requests[1]!.messages
    // Both user turns and the first assistant reply survive the switch.
    expect(secondMessages.filter(message => message.role === 'user')).toHaveLength(2)
    expect(secondMessages.filter(message => message.role === 'assistant')).toHaveLength(1)
    const texts = secondMessages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
    expect(texts).toContain('first question')
    expect(texts).toContain('ok')
    expect(texts).toContain('second question')

    await ctx.fiber.dispose()
  })
})
