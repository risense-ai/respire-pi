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
    checked = false
    ready = false
    rounds = 0
    reminded = false
    stored = false
  }
  pi.on('session_start', reset)
  pi.on('session_switch', reset)
  pi.on('session_shutdown', () => lifetime.abort())

  // Engine state probe (lazy, once per session) + per-turn storage bookkeeping.
  let checked = false
  let ready = false
  let rounds = 0
  let reminded = false
  let stored = false

  pi.on('before_agent_start', event => {
    event.systemPromptOptions.sections.respire = RULES
    if (event.messageType === 'user' && starting) starting.prompt = event.prompt
    starting = undefined
  })

  const contextMessage = text => ({
    role: 'custom', customType: 'respire-context', content: text,
    display: false, timestamp: Date.now(),
  })

  async function probe(signal, cwd, executable) {
    try {
      const doc = await runRsrs(['status'], { cwd, executable, signal })
      checked = true
      if (doc.status !== 'ok') {
        ready = false
        return contextMessage('【respire · status】The engine is unavailable or paused; follow engine mode and never force reads or stores.')
      }
      ready = true
      const summary = doc.summary ?? {}
      const notes = []
      if (summary.session?.has_session === false) notes.push('【respire · status】Not signed in. Configure the account via the rsrs interactive flow (rsrs register / rsrs login on this machine).')
      if (typeof summary.local_alive === 'number' && summary.local_alive < 10) notes.push('【respire · status】The store has few records; empty recall may be normal. Explicitly save confirmed project agreements, error lessons, and key conclusions.')
      if (summary.unlocked === false) notes.push('【respire · status】The store is locked. Ask the user to unlock it via the rsrs interactive flow; never collect passwords.')
      return notes.map(contextMessage)
    } catch (error) {
      if (signal.aborted) return []
      checked = true
      ready = false
      return [contextMessage('【respire · status】Engine or runtime unavailable. Verify rsrs --version and rsrs --client-only status --json; if the engine is missing, install rsrs-cli. The current task continues.')]
    }
  }

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
      text = '【respire · skipped】The input looks like it contains a credential and was not sent to the memory engine. Provide only the fact with the secret removed, or a safe location pointer.'
    } else {
      const prefix = STORE_PREFIX.exec(prompt)
      const content = prefix ? prompt.slice(prefix[0].length).trim() : prompt
      if (!content) {
        text = '【respire · not stored】The content is empty; provide the fact to save.'
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
            stored = stored || result.stored
            text = result.text
          } else {
            text = recallText(doc)
          }
        } catch (error) {
          if (signal.aborted) return
          text = prefix
            ? '【respire · store unconfirmed】It may have been written; verify against the store first; never retry automatically or claim success.'
            : '【respire · recall unavailable】Verify rsrs --version and rsrs --client-only status --json; continue with the current materials.'
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

  // Probe once per session, right before the first agent run of the session.
  pi.on('agent_start', async (event, ctx) => {
    if (checked || lifetime.signal.aborted || !ctx) return
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, lifetime.signal]) : lifetime.signal
    const notes = await probe(signal, ctx.cwd, pi.getFlag('respire-rsrs'))
    if (notes.length && ctx.hasUI) {
      // Status guidance rides the same request-only channel as recall on the next context build.
      pending.push({ prompt: `respire-probe-${Date.now()}`, receivedAt: Date.now() - 1, content: notes.map(note => note.content).join('\n') })
    }
  })

  // Wrap-up storage check (once per run): if this turn has no recent store, ask for one.
  pi.on('agent_before_settle', async event => {
    if (!ready || !event.continue || reminded || stored) return
    if (event.outcome === 'aborted') return
    reminded = true
    const last = await lastStoreTs(pi)
    if (last !== null && Date.now() / 1000 - last < 600) return
    return {
      entries: [{
        type: 'custom_message',
        customType: 'respire-context',
        content: '【respire · wrap-up check, once】If this run produced new facts, decisions, agreements, or lessons, check same-subject candidates first, then update or store them one by one with rsrs --client-only remember (--importance important; fact-sentence titles; on dedup candidates pick a parent with --parent or force with --force first). If already stored or nothing needs storing, end directly without repeating the answer.',
        display: false,
      }],
      continue: true,
    }
  })
}

async function lastStoreTs(pi) {
  try {
    const doc = await runRsrs(['list', '--limit', '3'], {})
    let best = null
    for (const d of (Array.isArray(doc.details) ? doc.details : [])) {
      if (!d || typeof d !== 'object') continue
      for (const key of ('updated_at created_at').split(' ')) {
        const ts = Date.parse(d[key] ?? '')
        if (Number.isFinite(ts) && (best === null || ts / 1000 > best)) best = ts / 1000
      }
    }
    return best
  } catch {
    return null  // Ask anyway when the engine query fails (fail-open to the nudge).
  }
}
