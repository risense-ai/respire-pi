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
  const sent = []
  pi.sendMessage = (...args) => sent.push(args)
  const ctx = {
    cwd,
    hasUI,
    signal: undefined,
    model: { id: 'fixture' },
    modelRegistry: { complete: async () => ({ content: [{ type: 'text', text: '{"facts":[]}' }], stopReason: 'stop' }) },
    ui: { notify(message, level) { notifications.push({ message, level }) } },
  }
  const emit = async (name, event, ctxArg = ctx) => {
    let result
    for (const handler of handlers.get(name) ?? []) result = await handler(event, ctxArg)
    return result
  }
  return { ctx, emit, notifications, sent }
}

const turn = (h, text, { streaming } = {}) => { h.prompt = text; return h.emit('input', { type: 'input', source: 'interactive', text, streamingBehavior: streaming }) }

const settle = (h, { outcome = 'completed' } = {}) =>
  h.emit('agent_before_settle', { type: 'agent_before_settle', entries: [], continue: false, outcome,
    context: { llmMessages: [{ role: 'user', content: h.prompt, timestamp: Date.now() },
      { role: 'assistant', content: [{ type: 'text', text: 'Normal answer preserved' }], timestamp: Date.now() }] } })
const flush = async () => { for (let i=0;i<12;i++) await new Promise(resolve => setImmediate(resolve)) }

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

// --- Real lifecycle: settle -> continuation -> agent_start -> settle -> settled.
{
  resetCalls()
  const h = await readyHarness()
  let modelCalls = 0
  h.ctx.modelRegistry.complete = async () => { modelCalls++; return { content: [{ type: 'text', text: '{"facts":[]}' }], stopReason: 'stop' } }
  assert.equal(await settle(h), undefined)
  await h.emit('agent_start', {})
  assert.equal(await settle(h), undefined)
  await h.emit('agent_settled', { aborted: false })
  await flush()
  for (let i=0;i<12;i++) { await h.emit('agent_start', {}); await settle(h); await h.emit('agent_settled', { aborted: false }) }
  await flush()
  assert.equal(modelCalls, 1)
  assert.equal(listCalls().length, 1)
  assert.equal(calls.filter(c => c.args[0] === 'remember').length, 0)
  assert.deepEqual(h.sent, [])
  assert.deepEqual(h.notifications, [])
  await turn(h, 'second real input')
  await h.emit('agent_start', {})
  await settle(h); await h.emit('agent_settled', { aborted: false }); await flush()
  assert.equal(modelCalls, 2)
  groups++
}

// Fresh store, explicit store (including pending), and unsuccessful runs never run a worker.
for (const kind of ['fresh','explicit','pending','aborted','error']) {
  resetCalls()
  const h = await readyHarness({ fresh: kind === 'fresh' })
  let models = 0
  h.ctx.modelRegistry.complete = async () => { models++; throw Error('must not call') }
  if (kind === 'explicit' || kind === 'pending') {
    control.impl = args => args[0] === 'remember' ? (kind === 'explicit' ? storeOk() : { status: 'pending' }) : wrapUpImpl()(args)
    await turn(h, '记： confirmed fact', { streaming: 'steer' })
  }
  await settle(h, { outcome: kind === 'aborted' || kind === 'error' ? kind : 'completed' })
  await h.emit('agent_settled', { aborted: kind === 'aborted' }); await flush()
  assert.equal(models, 0)
  if (kind === 'pending') assert.match((await project(h, h.prompt)).messages[1].content, /store pending/)
  groups++
}

// Detached worker: an uncooperative provider never keeps the host handler pending.
// Real new inputs, queued followUp/steer, reload, switch and shutdown cancel it.
for (const next of ['input','steer','followUp','session_start','session_switch','session_shutdown']) {
  resetCalls()
  const h = await readyHarness({ flags: { 'respire-rsrs': '/fixture/rsrs' } })
  let options, complete
  h.ctx.modelRegistry.complete = (_model, _context, opts) => { options = opts; return new Promise(resolve => { complete=resolve }) }
  await settle(h)
  await Promise.race([h.emit('agent_settled', { aborted: false }), new Promise((_, reject) => setTimeout(() => reject(Error('host blocked')), 100))])
  await flush(); assert.ok(options)
  if (['input','steer','followUp'].includes(next)) await turn(h, 'next real input', { streaming: next === 'input' ? undefined : next })
  else await h.emit(next, {})
  assert.equal(options.signal.aborted, true)
  complete({ content: [{ type: 'toolCall', id: 'late', name: 'respire_memory', arguments: { command: 'remember', text: 'must not write', title: 'late' } }], stopReason: 'toolUse' })
  await flush()
  assert.equal(calls.filter(c => c.args[0] === 'remember').length, 0)
  assert.equal(h.notifications.length, 0)
  groups++
}

// A new queued request arriving between the two boundaries cannot consume the
// new request's budget or launch an old request with new model/cwd/flags.
{
  resetCalls()
  const h = await readyHarness()
  let count = 0
  h.ctx.modelRegistry.complete = async () => { count++; return { content: [{ type: 'text', text: '{"facts":[]}' }], stopReason: 'stop' } }
  await settle(h)
  await turn(h, 'queued new request', { streaming: 'followUp' })
  await h.emit('agent_settled', { aborted: false }); await flush()
  assert.equal(count, 0)
  await settle(h); await h.emit('agent_settled', { aborted: false }); await flush()
  assert.equal(count, 1)
  groups++
}

// Background failure surfaces a fixed warning, also in non-TUI, without another turn.
{
  resetCalls()
  const h = await readyHarness({ hasUI: false })
  h.ctx.modelRegistry.complete = async () => { throw Error('raw private provider error') }
  await settle(h); await h.emit('agent_settled', { aborted: false }); await flush()
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0][1].triggerTurn, false)
  assert.doesNotMatch(h.sent[0][0].content, /raw private/)
  await h.emit('agent_start', {}); await settle(h); await h.emit('agent_settled', { aborted: false }); await flush()
  assert.equal(h.sent.length, 1)
  groups++
}

console.log(`Behavior check: ${groups} scenario groups green (probe, real lifecycle, cancellation, UI isolation)`)
