import { containsSecret, NUDGE, recallText, RULES, SKIP_PREFIX, STORE_PREFIX, storeText, titleOf } from './memory.js'
import { runRsrs } from './rsrs.js'

/** @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi */
export default function respire(pi) {
  pi.registerFlag('respire-rsrs', {
    description: 'Respire CLI executable (default: rsrs on PATH)',
    type: 'string',
    default: 'rsrs',
  })

  let current
  let lifetime = new AbortController()
  const reset = () => {
    lifetime.abort()
    lifetime = new AbortController()
    current = undefined
  }
  pi.on('session_start', reset)
  pi.on('session_switch', reset)
  pi.on('session_shutdown', () => lifetime.abort())

  pi.on('before_agent_start', event => {
    event.systemPromptOptions.sections.respire = RULES
    if (event.messageType === 'custom') current = undefined
  })

  pi.on('input', async (event, ctx) => {
    if (event.source === 'extension') return
    const prompt = event.text.trim()
    if (!prompt) return
    const state = { ready: false, stored: false, reminded: false }
    current = state
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
            const result = storeText(doc)
            text = result.text
            state.stored = result.stored
          } else {
            text = recallText(doc)
          }
          state.ready = prefix ? state.stored || doc.status === 'pending' : doc.status === 'ok'
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
    // Keep context attached to its input, including queued steering/follow-up messages.
    return { action: 'transform', text: `${event.text}\n\n${text}`, images: event.images }
  })

  pi.on('agent_before_settle', (event, ctx) => {
    const state = current
    if (ctx.signal?.aborted || event.outcome !== 'completed'
      || !state?.ready || state.stored || state.reminded) return
    state.reminded = true
    return {
      entries: [...event.entries, { type: 'custom_message', customType: 'respire-check', content: NUDGE, display: false }],
      continue: true,
    }
  })
}
