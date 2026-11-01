import { containsSecret, recallText, record, RULES, SKIP_PREFIX, STORE_PREFIX, storeText, titleOf, validId } from './memory.js'
import { runRsrs } from './rsrs.js'
import { snapshot, wrapUp } from './wrap-up.js'

/** @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi */
export default function respire(pi) {
  pi.registerFlag('respire-rsrs', {
    description: 'Respire CLI executable (default: rsrs on PATH)',
    type: 'string',
    default: 'rsrs',
  })

  let starting
  let request
  let settling
  let generation = 0
  let activeSession = 0
  const warnings = new Map()
  const sessionKey = ctx => ctx?.sessionManager?.getSessionId?.() ?? generation
  const showWarning = (ctx, content) => {
    try {
      if (ctx.hasUI) ctx.ui.notify(`Respire: ${content}`, 'warning')
      else pi.sendMessage({ customType: 'respire-status', content, display: true }, { triggerTurn: false })
      return true
    } catch { return false } // Disposed host: retain the warning for that session.
  }
  const flushWarnings = ctx => {
    const pending = warnings.get(activeSession)
    if (pending && ctx && showWarning(ctx, pending)) warnings.delete(activeSession)
  }
  let pending = []
  const contexts = new Map()
  const textOf = message => typeof message.content === 'string' ? message.content
    : message.content.filter(part => part.type === 'text').map(part => part.text).join('')
  let lifetime = new AbortController()
  const reset = (_event, ctx) => {
    generation++
    activeSession = sessionKey(ctx)
    flushWarnings(ctx)
    request?.controller.abort('session ended')
    request = undefined
    settling = undefined
    lifetime.abort()
    lifetime = new AbortController()
    starting = undefined
    pending = []
    contexts.clear()
    checked = false
    ready = false
  }
  pi.on('session_start', reset)
  pi.on('session_switch', reset)
  pi.on('session_before_switch', async () => {
    // Cancel while the original session is still active so an unknown write's
    // fixed warning can be attached there, never to the destination session.
    request?.controller.abort('session changing')
    await request?.task
  })
  pi.on('session_shutdown', async () => {
    request?.controller.abort('session ended'); lifetime.abort()
    await request?.task
  })

  // Engine state probe (once per session, on the first actionable user input) + per-request wrap-up bookkeeping.
  let checked = false
  let ready = false

  pi.on('before_agent_start', event => {
    event.systemPromptOptions.sections.respire = RULES
    if (event.messageType === 'user' && starting) starting.prompt = event.prompt
    starting = undefined
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
      return '【respire · status】Engine or runtime unavailable. Verify rsrs --version and rsrs --client-only status --json; if the engine is missing, install @rsrsai/cli. The current task continues.'
    }
  }

  pi.on('input', async (event, ctx) => {
    if (!event.streamingBehavior) starting = undefined
    if (event.source === 'extension') return
    const prompt = event.text.trim()
    if (!prompt) return
    activeSession = sessionKey(ctx)
    flushWarnings(ctx)
    request?.controller.abort('new input')
    const state = { prompt: event.text, receivedAt: Date.now(), controller: new AbortController(), attempted: false,
      sessionKey: activeSession, automatic: !SKIP_PREFIX.test(prompt) && !STORE_PREFIX.test(prompt) && !containsSecret(prompt), stored: false }
    request = state
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
              state.stored = result.stored
              text = result.text
              // PI-02 write read-back (R11): full verification — the shown entry id,
              // title, and complete body must match what was sent. A shared prefix is
              // never called a match. A failed/malformed read-back stays "unavailable";
              // no verdict blocks the receipt or triggers a retry.
              if (result.stored && validId(doc.summary?.id)) {
                const id = doc.summary.id
                const sentTitle = titleOf(content)
                let verdict = 'unavailable'
                try {
                  const shown = await runRsrs(['show', id], { cwd: ctx.cwd, executable: pi.getFlag('respire-rsrs'), signal })
                  const entry = record(shown.details)?.entry
                  if (shown.status !== 'ok' || !record(entry)) verdict = 'unavailable'
                  else if (String(shown.summary?.id ?? '') !== id) verdict = 'mismatch' // show answered with a different entry
                  else {
                    const titleOk = !sentTitle || entry.title === sentTitle
                    const bodyOk = String(entry.content ?? '').trim() === content.trim()
                    verdict = titleOk && bodyOk ? 'verified' : 'mismatch'
                  }
                } catch { verdict = 'unavailable' }
                text += verdict === 'verified'
                  ? ' Write verified by read-back (id, title and full content match).'
                  : verdict === 'mismatch'
                    ? ` Read-back shows a DIFFERENT title/content than sent — inspect rsrs --client-only show ${id.slice(0, 8)} before refining the title.`
                    : ` Read-back unavailable — if it matters, verify with rsrs --client-only show ${id.slice(0, 8)}.`
              }
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

  // Snapshot only: never request a main-agent continuation or inject a prompt.
  pi.on('agent_before_settle', (event, ctx) => {
    const state = request
    if (!state || state.attempted) return
    settling = state
    if (event.outcome !== 'completed') { state.attempted = true; state.controller.abort('main run did not complete'); return }
    if (!state.automatic || state.stored || !ready) { state.attempted = true; return }
    try {
      state.transcript = snapshot(event, state)
      state.unavailable = false
      state.model = ctx.model
      state.registry = ctx.modelRegistry
      state.cwd = ctx.cwd
      state.executable = pi.getFlag('respire-rsrs')
    } catch { state.unavailable = true }
  })

  pi.on('agent_settled', (event, ctx) => {
    const state = settling
    if (!state || state !== request || state.attempted) return
    state.attempted = true // Before any await. Continuation/error/timeout never re-arms.
    if (event.aborted || !state.automatic || state.stored || !ready) return
    const report = content => {
      const warning = request === state ? content : `Previous request: ${content}`
      if (activeSession !== state.sessionKey || !showWarning(ctx, warning)) {
        // Never append an old warning to a different session's history. Re-deliver
        // the fixed status only when the originating session is active again.
        warnings.set(state.sessionKey, warning)
      }
    }
    if (state.unavailable || !state.transcript) { report('Background memory context unavailable; no automatic retry.'); return }
    // Pi awaits handlers, so deliberately return undefined, not this promise.
    state.task = wrapUp({ model: state.model, registry: state.registry, transcript: state.transcript,
      controller: state.controller, report,
      run: (args, signal) => runRsrs(args, { cwd: state.cwd, executable: state.executable, signal }),
    }).catch(() => report('Background memory wrap-up failed; no automatic retry.'))
  })
}
