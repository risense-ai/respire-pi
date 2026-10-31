// Behavioral tests for the Pi extension, run against a fake pi harness with a stubbed
// rsrs engine (scripts/behavior-rsrs-stub.mjs, wired in through scripts/behavior-hooks.mjs).
// Covers: probe states on the request-only channel, wrap-up gating per run, and the
// run-context plumbing (executable, cwd, abort signal) of the engine calls.
import * as nodeModule from 'node:module'
import assert from 'node:assert/strict'

const { resolve } = await import('./behavior-hooks.mjs')
if (typeof nodeModule.registerHooks === 'function') nodeModule.registerHooks({ resolve })
else nodeModule.register(new URL('./behavior-hooks.mjs', import.meta.url).href)

const { default: respire } = await import('../lib/index.js')
const { RULES } = await import('../lib/memory.js')
const { calls, control, resetCalls, statusCalls, listCalls } = await import('./behavior-rsrs-stub.mjs')

function harness({ cwd = '/proj/work', hasUI = true, flags = {} } = {}) {
  const handlers = new Map()
  const flagDefaults = {}
  const pi = {
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(handler)
    },
    registerFlag(name, def) { flagDefaults[name] = def.default },
    getFlag(name) { return name in flags ? flags[name] : flagDefaults[name] },
  }
  respire(pi)
  const notifications = []
  const ctx = {
    cwd,
    hasUI,
    signal: undefined,
    ui: { notify(message, level) { notifications.push({ message, level }) } },
  }
  const emit = async (name, event, ctxArg = ctx) => {
    let result
    for (const handler of handlers.get(name) ?? []) result = await handler(event, ctxArg)
    return result
  }
  return { ctx, emit, notifications }
}

const turn = (h, text, { streaming } = {}) =>
  h.emit('input', { type: 'input', source: 'interactive', text, streamingBehavior: streaming })

const settle = (h, { outcome = 'completed' } = {}) =>
  h.emit('agent_before_settle', { type: 'agent_before_settle', entries: [], continue: false, outcome })

async function project(h, text, timestamp = Date.now()) {
  const history = [{ role: 'user', content: [{ type: 'text', text }], timestamp }]
  const result = await h.emit('context', { type: 'context', messages: history })
  return { history, messages: result.messages }
}

const healthyStatus = () => ({ status: 'ok', summary: { session: { has_session: true }, local_alive: 30, unlocked: true } })
const recallDoc = () => ({ status: 'ok', details: [{ id: 'a1b2c3d4-1111-2222-3333-444455556666', title: 'Known project fact', score: 0.5 }] })
const storeOk = () => ({ status: 'ok', summary: { id: 'b2c3d4e5' } })

function wrapUpImpl({ fresh = false } = {}) {
  return args => {
    if (args[0] === 'status') return healthyStatus()
    if (args[0] === 'recall') return recallDoc()
    if (args[0] === 'list') {
      return fresh
        ? { status: 'ok', details: [{ id: 'recent-1', updated_at: new Date().toISOString() }] }
        : { status: 'ok', details: [{ id: 'old-1', updated_at: '2020-01-01T00:00:00.000Z' }] }
    }
    return { status: 'skip' }
  }
}

// Probe rides the first actionable input; ready harness for wrap-up tests.
async function readyHarness(opts) {
  const h = harness(opts)
  control.impl = wrapUpImpl(opts)
  await turn(h, 'kick-off question')
  return h
}

let groups = 0

// --- Probe states ---------------------------------------------------------

// Healthy engine: recall only, no status note, user history untouched, probe once per session.
{
  resetCalls()
  const h = harness()
  control.impl = args => args[0] === 'status' ? healthyStatus() : recallDoc()
  await turn(h, 'first question')
  assert.equal(statusCalls().length, 1)
  const ts = Date.now()
  const { history, messages } = await project(h, 'first question', ts)
  assert.equal(messages.length, 2)
  assert.equal(messages[0], history[0])
  assert.equal(history.length, 1)
  assert.deepEqual(history[0].content, [{ type: 'text', text: 'first question' }])
  assert.equal(messages[1].customType, 'respire-context')
  assert.equal(messages[1].display, false)
  assert.match(messages[1].content, /auto-recall/)
  assert.doesNotMatch(messages[1].content, /respire · status/)
  // The note is cached per user message: every LLM call of the run sees it again.
  assert.equal((await project(h, 'first question', ts)).messages.length, 2)
  // Probe runs once per session; later turns do not re-probe.
  await turn(h, 'second question')
  assert.equal(statusCalls().length, 1)
  groups++
}

// Not signed in: the note rides the context even without UI, ahead of the recall text.
{
  resetCalls()
  const h = harness({ hasUI: false })
  control.impl = args => args[0] === 'status'
    ? { status: 'ok', summary: { session: { has_session: false }, local_alive: 30, unlocked: true } }
    : recallDoc()
  await turn(h, 'signed out question')
  const { messages } = await project(h, 'signed out question')
  assert.equal(messages.length, 2)
  const content = messages[1].content
  assert.match(content, /Not signed in\./)
  assert.match(content, /auto-recall/)
  assert.ok(content.indexOf('Not signed in.') < content.indexOf('auto-recall'), 'status note comes first')
  groups++
}

// Locked store: note present, and it is the whole content when recall has no hits.
{
  resetCalls()
  const h = harness({ hasUI: false })
  control.impl = args => args[0] === 'status'
    ? { status: 'ok', summary: { session: { has_session: true }, local_alive: 30, unlocked: false } }
    : { status: 'ok', details: [] }
  await turn(h, 'locked question')
  const { messages } = await project(h, 'locked question')
  assert.equal(messages.length, 2)
  assert.match(messages[1].content, /store is locked/)
  assert.doesNotMatch(messages[1].content, /auto-recall/)
  groups++
}

// Engine unavailable: note in context; without UI the failure stays silent; no re-probe.
{
  resetCalls()
  const h = harness({ hasUI: false })
  control.impl = async () => { throw new Error('boom') }
  await turn(h, 'broken question')
  const { messages } = await project(h, 'broken question')
  assert.equal(messages.length, 2)
  assert.match(messages[1].content, /Engine or runtime unavailable/)
  assert.match(messages[1].content, /recall unavailable/)
  assert.equal(h.notifications.length, 0)
  await turn(h, 'still broken question')
  assert.equal(statusCalls().length, 1)
  groups++
}

// Engine unavailable with UI: the same notes reach the context and ui.notify fires.
{
  resetCalls()
  const h = harness({ hasUI: true })
  control.impl = async () => { throw new Error('boom') }
  await turn(h, 'broken question with ui')
  const { messages } = await project(h, 'broken question with ui')
  assert.match(messages[1].content, /Engine or runtime unavailable/)
  assert.equal(h.notifications.length, 1)
  assert.match(h.notifications[0].message, /boom/)
  groups++
}

// Cancelled probe: nothing is injected, checked stays false, the next turn probes again.
{
  resetCalls()
  const h = harness()
  const ac = new AbortController()
  h.ctx.signal = ac.signal
  let releaseProbe
  control.impl = (args, options) => {
    if (args[0] === 'status') {
      return new Promise((res, rej) => {
        const onAbort = () => rej(new Error('cancelled'))
        options.signal?.addEventListener('abort', onAbort, { once: true })
        if (options.signal?.aborted) return rej(new Error('cancelled'))
        releaseProbe = () => { options.signal?.removeEventListener('abort', onAbort); res(healthyStatus()) }
      })
    }
    return recallDoc()
  }
  const cancelled = turn(h, 'cancelled question')
  ac.abort()
  await cancelled
  assert.equal((await project(h, 'cancelled question')).messages.length, 1)
  assert.equal(statusCalls().length, 1)
  h.ctx.signal = undefined
  const retry = turn(h, 'retry question')
  releaseProbe()
  await retry
  assert.equal(statusCalls().length, 2)
  assert.equal((await project(h, 'retry question')).messages.length, 2)
  groups++
}

// /nomem and credential-bearing inputs make no engine call at all.
{
  resetCalls()
  const h = harness()
  control.impl = () => { throw new Error('must not be called') }
  await turn(h, '/nomem check')
  await turn(h, 'api_key=supersecretvalue123')
  assert.equal((await project(h, '/nomem check')).messages.length, 1)
  const { messages } = await project(h, 'api_key=supersecretvalue123')
  assert.equal(messages.length, 2)
  assert.match(messages[1].content, /respire · skipped/)
  assert.equal(calls.length, 0)
  groups++
}

// Explicit store turn: probe rides along and the receipt reaches the context.
{
  resetCalls()
  const h = harness()
  control.impl = args => {
    if (args[0] === 'status') return healthyStatus()
    if (args[0] === 'remember') return storeOk()
    return { status: 'skip' }
  }
  await turn(h, '记： a fact worth keeping')
  const remember = calls.find(call => call.args[0] === 'remember')
  assert.match(remember.args.join(' '), /a fact worth keeping/)
  assert.equal(remember.executable, 'rsrs')
  const { messages } = await project(h, '记： a fact worth keeping')
  assert.match(messages[1].content, /【respire · stored】/)
  groups++
}

// --- Wrap-up gating -------------------------------------------------------

// Stale store: one nudge per run, no --force guidance, aligned with the RULES policy.
{
  resetCalls()
  const h = await readyHarness()
  await h.emit('agent_start', { type: 'agent_start' })
  const result = await settle(h)
  assert.ok(result, 'wrap-up nudge fires on a stale store')
  assert.equal(result.continue, true)
  assert.equal(result.entries.length, 1)
  const entry = result.entries[0]
  assert.equal(entry.type, 'custom_message')
  assert.equal(entry.display, false)
  assert.match(entry.content, /wrap-up check, once/)
  assert.doesNotMatch(entry.content, /--force/)
  assert.match(entry.content, /--client-only remember/)
  assert.match(entry.content, /same-subject/)
  assert.match(entry.content, /update, merge, or attach/)
  assert.match(entry.content, /--parent/)
  assert.match(RULES, /Never use --force to bypass dedup/)
  assert.equal(calls.find(call => call.args[0] === 'status').executable, 'rsrs')
  groups++
}

// Same run never nudges twice; the next agent_start re-arms the check.
{
  resetCalls()
  const h = await readyHarness()
  await h.emit('agent_start', { type: 'agent_start' })
  assert.ok(await settle(h))
  assert.equal(await settle(h), undefined)
  assert.equal(listCalls().length, 1)
  await h.emit('agent_start', { type: 'agent_start' })
  assert.ok(await settle(h))
  assert.equal(listCalls().length, 2)
  groups++
}

// Fresh store (engine reported a recent write): no nudge.
{
  resetCalls()
  const h = await readyHarness({ fresh: true })
  await h.emit('agent_start', { type: 'agent_start' })
  assert.equal(await settle(h), undefined)
  groups++
}

// Explicit store mid-run (steering input) sets the run flag: no nudge despite a stale store.
{
  resetCalls()
  const h = await readyHarness()
  await h.emit('agent_start', { type: 'agent_start' })
  control.impl = args => args[0] === 'remember' ? storeOk() : wrapUpImpl()(args)
  await turn(h, '记： mid-run fact', { streaming: 'steer' })
  assert.equal(await settle(h), undefined)
  groups++
}

// Idle explicit store before the run: the engine's fresh write suppresses the nudge.
{
  resetCalls()
  const h = harness()
  control.impl = args => {
    if (args[0] === 'status') return healthyStatus()
    if (args[0] === 'remember') return storeOk()
    if (args[0] === 'list') return { status: 'ok', details: [{ id: 'fresh', updated_at: new Date().toISOString() }] }
    return { status: 'skip' }
  }
  await turn(h, '记住： explicit fact before the run')
  await h.emit('agent_start', { type: 'agent_start' })
  assert.equal(await settle(h), undefined)
  groups++
}

// Aborted run: no nudge and no engine query.
{
  resetCalls()
  const h = await readyHarness()
  await h.emit('agent_start', { type: 'agent_start' })
  assert.equal(await settle(h, { outcome: 'aborted' }), undefined)
  assert.equal(listCalls().length, 0)
  groups++
}

// Session switch disarms everything; the probe re-arms on the next session's input.
{
  resetCalls()
  const h = await readyHarness()
  await h.emit('session_switch', { type: 'session_switch' })
  assert.equal(await settle(h), undefined)
  assert.equal(listCalls().length, 0)
  await turn(h, 'new session question')
  assert.equal(statusCalls().length, 2)
  groups++
}

// Failed list query: silent now, latch stays armed, a later round nudges.
{
  resetCalls()
  const h = await readyHarness()
  await h.emit('agent_start', { type: 'agent_start' })
  control.impl = args => args[0] === 'list' ? Promise.reject(new Error('boom')) : wrapUpImpl()(args)
  assert.equal(await settle(h), undefined)
  control.impl = wrapUpImpl()
  assert.ok(await settle(h))
  assert.equal(listCalls().length, 2)
  groups++
}

// Cancelled list query: silent, no nudge.
{
  resetCalls()
  const h = await readyHarness()
  const ac = new AbortController()
  h.ctx.signal = ac.signal
  await h.emit('agent_start', { type: 'agent_start' })
  control.impl = (args, options) => {
    if (args[0] === 'list') {
      return new Promise((_, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        if (options.signal?.aborted) reject(new Error('cancelled'))
      })
    }
    return wrapUpImpl()(args)
  }
  const running = settle(h)
  ac.abort()
  assert.equal(await running, undefined)
  groups++
}

// --- Run-context plumbing -------------------------------------------------

// Every engine call carries the configured executable, the run cwd and an abort-combined signal.
{
  resetCalls()
  const h = await readyHarness({ flags: { 'respire-rsrs': '/custom/rsrs-driver' } })
  assert.equal(h.ctx.cwd, '/proj/work')
  await h.emit('agent_start', { type: 'agent_start' })
  assert.ok(await settle(h))
  assert.ok(calls.length >= 3)
  for (const call of calls) {
    assert.equal(call.executable, '/custom/rsrs-driver')
    assert.equal(call.cwd, '/proj/work')
    assert.ok(call.signal instanceof AbortSignal)
  }
  assert.equal(statusCalls()[0].args.join(' '), 'status')
  assert.match(calls.find(call => call.args[0] === 'recall').args.join(' '), /^recall /)
  assert.equal(listCalls()[0].args.join(' '), 'list --limit 3')
  groups++
}

console.log(`Behavior check: ${groups} scenario groups green (probe states, wrap-up gating, run-context plumbing)`)
