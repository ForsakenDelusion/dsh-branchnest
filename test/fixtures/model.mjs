// Local deterministic model for integration checks. Never distributed with the plugin.
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { appendFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'
export const inject = ['llm']
class FixtureModel extends LlmAdapter {
  providerInfo(id) { return { id, name: 'Canvas local test model' } }
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Canvas local fixture' }] }
  async resolveModel(provider, id) { return { provider, id, name: 'Canvas local fixture', context: { contextWindow: 100000 } } }
  async *stream(options) {
    const users = options.messages.filter(m => m.role === 'user').map(m => m.content.filter(p => p.type === 'text').map(p => p.text).join('\n'))
    const tools = (options.tools ?? []).map(tool => tool.name)
    if (process.env.CANVAS_FIXTURE_LOG) await appendFile(process.env.CANVAS_FIXTURE_LOG, JSON.stringify({ users, tools,
      contexts: options.messages.filter(message => message.role === 'context').map(message => message.content),
      attachments: options.messages.filter(message => message.role === 'user').flatMap(message => message.content.filter(block => block.type !== 'text')) }) + '\n')
    if (users.some(text => text.includes('CANVAS_QUESTION_CHECK')) && tools.includes('ask_user_question')
      && !options.messages.some(message => message.role === 'tool')) {
      const argumentsText = JSON.stringify({ questions: [{ id: 'canvas-choice', header: '画布交互测试',
        question: '在画布中选择一个答案', options: [{ label: '继续探索', description: '提交原生问答并继续当前会话。' },
          { label: '整理笔记', description: '验证另一个可选择答案。' }] }] })
      const block = { type: 'tool-call', id: 'canvas-fixture-question', name: 'ask_user_question', arguments: argumentsText }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: argumentsText }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (users.some(text => text.includes('CANVAS_MCP_CHECK')) && tools.includes('mcp__canvas_fixture__echo')
      && !options.messages.some(message => message.role === 'tool')) {
      const block = { type: 'tool-call', id: 'canvas-fixture-echo', name: 'mcp__canvas_fixture__echo', arguments: '{}' }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const branch = users.some(text => text.includes('<canvas_reference>'))
    const text = branch
      ? '## 深入理解注意力机制\n\n这是一个独立的分支对话。它引用了来源回答中的选区，并保留相关的探索路径。\n\n**注意力机制**让模型根据当前问题，为不同位置的信息分配不同权重。\n\n例如阅读一句话时，代词可以把更多注意力放到它指代的名词上。\n\n### 继续探索\n\n可以选中这段回答中的概念，再创建下一层分支。'
      : '## 用一个问题，展开新的理解\n\nTransformer 通过**注意力机制**处理序列。它允许每个位置参考其他位置的信息，再根据相关程度汇总表示。\n\n### 为什么有用？\n\n- 可以关联相距很远的内容。\n- 不同的注意力头可以关注不同关系。\n- 来源回答和后续追问可以并排阅读。\n\n选中「注意力机制」继续追问，即可创建一个带来源关系的新 session。\n\n> 此回答由本地集成测试模型生成，用于验证插件，不代表真实模型推理。'
    const reasoning = users.some(text => text.includes('请检查思考过程折叠'))
      ? '先确认来源和问题，再把推导与最终回答分开。这里是测试模型实际返回的思考文本，用来验证实时输出、历史读取和折叠展示。\n\n**核对步骤**\n\n- 保留可见的思考内容。\n- 回答正文独立呈现。\n- 工具参数不混进回答。\n' : ''
    if (reasoning) {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      for (let i = 0; i < reasoning.length; i += 5) {
        await setTimeout(60, undefined, { signal: options.signal })
        yield { type: 'reasoning-delta', index: 0, text: reasoning.slice(i, i + 5) }
      }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }
    }
    const textIndex = reasoning ? 1 : 0
    yield { type: 'block-start', index: textIndex, blockType: 'text' }
    for (let i = 0; i < text.length; i += 10) {
      options.signal?.throwIfAborted()
      await setTimeout(20, undefined, { signal: options.signal })
      yield { type: 'text-delta', index: textIndex, text: text.slice(i, i + 10) }
    }
    yield { type: 'block-end', index: textIndex, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 50, outputTokens: text.length } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
export function apply(ctx) { ctx.llm.registerAdapter(['canvas-fixture'], new FixtureModel()) }
