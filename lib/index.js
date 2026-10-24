import { containsSecret, recallText, RULES, SKIP_PREFIX, STORE_PREFIX, storeText, titleOf } from './memory.js'
import { runRsrs } from './rsrs.js'

/** @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi */
export default function respire(pi) {
  pi.registerFlag('respire-rsrs', {
    description: 'Respire CLI executable (default: rsrs on PATH)',
    type: 'string',
    default: 'rsrs',
  })

  let starting
  let pending = []
  const contexts = new Map()
  const textOf = message => typeof message.content === 'string' ? message.content
    : message.content.filter(part => part.type === 'text').map(part => part.text).join('')
  let lifetime = new AbortController()
  const reset = () => {
    lifetime.abort()
    lifetime = new AbortController()
    starting = undefined
    pending = []
    contexts.clear()
  }
  pi.on('session_start', reset)
  pi.on('session_switch', reset)
  pi.on('session_shutdown', () => lifetime.abort())

  pi.on('before_agent_start', event => {
    event.systemPromptOptions.sections.respire = RULES
    if (event.messageType === 'user' && starting) starting.prompt = event.prompt
    starting = undefined
  })

  pi.on('input', async (event, ctx) => {
    if (!event.streamingBehavior) starting = undefined
    if (event.source === 'extension') return
    const prompt = event.text.trim()
    if (!prompt) return
    const state = { prompt: event.text, receivedAt: Date.now() }
    pending.push(state)
    if (!event.streamingBehavior) starting = state
    if (SKIP_PREFIX.test(prompt)) return

    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, lifetime.signal]) : lifetime.signal
    let text
    if (containsSecret(prompt)) {
      text = '【respire·已跳过】输入含疑似凭据，不发送给记忆引擎。仅提供去除秘密的事实或安全的位置指针。'
    } else {
      const prefix = STORE_PREFIX.exec(prompt)
      const content = prefix ? prompt.slice(prefix[0].length).trim() : prompt
      if (!content) {
        text = '【respire·未存】存储内容为空，请提供要保存的事实。'
      } else {
        try {
          const doc = await runRsrs(prefix
            ? ['remember', content, '--title', titleOf(content), '--importance', 'important']
            : ['recall', content.replace(/^\$\s*skill\s*:\s*\S+\s*/i, '').trim() || content, '--limit', '5', '--titles'], {
            cwd: ctx.cwd,
            executable: pi.getFlag('respire-rsrs'),
            signal,
          })
          if (prefix) {
            text = storeText(doc).text
          } else {
            text = recallText(doc)
          }
        } catch (error) {
          if (signal.aborted) return
          text = prefix
            ? '【respire·落库未确认】可能已写入，请先查库核实；勿自动重试或声称成功。'
            : '【respire·召回不可用】请检查 rsrs --version 和 rsrs --client-only status --json；依据当前材料继续。'
          // Never forward engine diagnostics, which may contain user input or secrets.
          if (ctx.hasUI) ctx.ui.notify(`Respire: ${error.message}`, 'warning')
        }
      }
    }
    if (signal.aborted || !text) return
    state.content = text
  })

  pi.on('context', event => {
    const messages = []
    for (const message of event.messages) {
      messages.push(message)
      if (message.role !== 'user') continue
      const prompt = textOf(message)
      const key = JSON.stringify([message.timestamp, prompt])
      let state = contexts.get(key)
      if (!state) {
        const index = pending.findLastIndex(item => message.timestamp >= item.receivedAt
          && (prompt === item.prompt || prompt.startsWith(`${item.prompt}\n\n`)))
        if (index !== -1) {
          state = pending.splice(index, 1)[0]
          contexts.set(key, state)
        }
      }
      // Request-only context never enters user messages, the session file, or editor history.
      if (state?.content) messages.push({
        role: 'custom', customType: 'respire-context', content: state.content,
        display: false, timestamp: message.timestamp,
      })
    }
    return { messages }
  })

}
