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
    reminded = false
    stored = false
  }
  pi.on('session_start', reset)
  pi.on('session_switch', reset)
  pi.on('session_shutdown', () => lifetime.abort())

  // Engine state probe (once per session, on the first actionable user input) + per-run wrap-up bookkeeping.
  let checked = false
  let ready = false
  let reminded = false
  let stored = false

  pi.on('before_agent_start', event => {
    event.systemPromptOptions.sections.respire = RULES
    if (event.messageType === 'user' && starting) starting.prompt = event.prompt
    starting = undefined
  })

  // Wrap-up state is per run: every new agent loop gets one wrap-up chance again.
  pi.on('agent_start', () => {
    reminded = false
    stored = false
  })

  const runSignal = ctx => ctx?.signal
    ? AbortSignal.any([ctx.signal, lifetime.signal]) : lifetime.signal

  // Returns the status note ('' when healthy), or null when the probe was cancelled.
  async function probe(signal, cwd, executable) {
    try {
      const doc = await runRsrs(['status'], { cwd, executable, signal })
      checked = true
      if (doc.status !== 'ok') {
        ready = false
        return '【respire · status】The engine is unavailable or paused; follow engine mode and never force reads or stores.'
      }
      ready = true
      const summary = doc.summary ?? {}
      const notes = []
      if (summary.session?.has_session === false) notes.push('【respire · status】Not signed in. Configure the account via the rsrs interactive flow (rsrs register / rsrs login on this machine).')
      if (typeof summary.local_alive === 'number' && summary.local_alive < 10) notes.push('【respire · status】The store has few records; empty recall may be normal. Explicitly save confirmed project agreements, error lessons, and key conclusions.')
      if (summary.unlocked === false) notes.push('【respire · status】The store is locked. Ask the user to unlock it via the rsrs interactive flow; never collect passwords.')
      return notes.join('\n')
    } catch (error) {
      if (signal.aborted) return null
      checked = true
      ready = false
      return '【respire · status】Engine or runtime unavailable. Verify rsrs --version and rsrs --client-only status --json; if the engine is missing, install rsrs-cli. The current task continues.'
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

    const signal = runSignal(ctx)
    let status
    let text
    if (containsSecret(prompt)) {
      // Credential-bearing inputs never touch the engine, the status probe included.
      text = '【respire · skipped】The input looks like it contains a credential and was not sent to the memory engine. Provide only the fact with the secret removed, or a safe location pointer.'
    } else {
      // Probe on the first actionable input so the status note rides this same request-only context.
      if (!checked) status = await probe(signal, ctx.cwd, pi.getFlag('respire-rsrs'))
      if (!signal.aborted) {
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
    }
    if (signal.aborted) return
    // Status note first, then the recall/store text; either may be empty.
    const note = [status, text].filter(Boolean).join('\n')
    if (note) state.content = note
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

  // Wrap-up storage check (once per run): if this run has no recent store, ask for one.
  pi.on('agent_before_settle', async (event, ctx) => {
    if (!ready || reminded || stored) return
    if (event.outcome === 'aborted') return
    const signal = runSignal(ctx)
    const last = await lastStoreTs({ cwd: ctx?.cwd, executable: pi.getFlag('respire-rsrs'), signal })
    // No evidence (query failed/cancelled, or the response carried no usable evidence):
    // stay silent and stay armed; a later round retries.
    if (last === undefined || signal.aborted) return
    if (last !== null && Date.now() / 1000 - last < 600) return
    reminded = true
    return {
      entries: [{
        type: 'custom_message',
        customType: 'respire-context',
        content: '【respire · wrap-up check, once】If this run produced new facts, decisions, agreements, or lessons, check same-subject candidates first and read them, then update, merge, or attach; store them one by one with rsrs --client-only remember (--importance important; fact-sentence titles; new important records pick a parent with --parent). If already stored or nothing needs storing, end directly without repeating the answer.',
        display: false,
      }],
      continue: true,
    }
  })
}

// Recent store timestamp in seconds. Evidence rules: only status ok counts; an empty
// details array verifiably means no records (null); every listed record must carry a
// parsable updated_at/created_at, so any invalid entry makes freshness undeterminable
// (undefined). undefined means no evidence — the same as query failure or cancellation —
// and never grounds for a nudge.
async function lastStoreTs({ cwd, executable, signal }) {
  try {
    const doc = await runRsrs(['list', '--limit', '3'], { cwd, executable, signal })
    if (doc.status !== 'ok' || !Array.isArray(doc.details)) return undefined
    if (doc.details.length === 0) return null
    let best = null
    for (const d of doc.details) {
      if (!d || typeof d !== 'object') return undefined
      const ts = recordTs(d)
      if (ts === undefined) return undefined
      if (best === null || ts > best) best = ts
    }
    return best
  } catch {
    return undefined
  }
}

// Best parsable timestamp of one record in seconds, undefined when neither
// updated_at nor created_at parses.
function recordTs(d) {
  let best
  for (const key of ('updated_at created_at').split(' ')) {
    const ts = Date.parse(d[key] ?? '')
    if (Number.isFinite(ts) && (best === undefined || ts / 1000 > best)) best = ts / 1000
  }
  return best
}
