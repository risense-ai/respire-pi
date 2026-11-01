import assert from 'node:assert/strict'
import { wrapUp, snapshot, LIMITS } from '../lib/wrap-up.js'

const id = 'abcdef12-1111-2222-3333-444455556666'
const text = 'The project release requires a smoke test.'
const fact = { text, title: text, status: 'confirmed', sources: [{ index: 0, quote: text }] }
const transcript = JSON.stringify([{ role: 'user', text }])
const answer = content => ({ role: 'assistant', content, stopReason: 'stop', timestamp: Date.now() })
const extract = value => answer([{ type: 'text', text: JSON.stringify(value) }])
const call = (command, extra = {}) => ({ type: 'toolCall', id: `tool-${command}`, name: 'respire_memory', arguments: { command, ...extra } })
const flow = (command = 'remember') => [extract({ facts: [fact] }),
  answer([call('prompt'), call('recall', { text: 'release smoke test' })]),
  answer([call('show', { id })]),
  answer([call(command, { text, title: text, ...(command === 'remember' ? { parent: id } : { id }) })])]
let tests = 0
async function fixture({ responses = flow(), runImpl, completeImpl, timeoutMs = 1000 } = {}) {
  const reports = [], calls = [], completions = [], controller = new AbortController()
  const run = async (args, signal) => {
    calls.push(args)
    if (args[0] === 'update') assert.deepEqual(args, ['update', id, '--content', text, '--title', text], 'actual CLI parser requires --content')
    if (runImpl) { const result = await runImpl(args, signal); if (result !== undefined) return result }
    if (args[0] === 'list') return { status: 'ok', details: [] }
    if (args[0] === 'prompt') return { status: 'ok', summary: { instructions: 'Read before write. Do not force.' } }
    if (args[0] === 'recall') return { status: 'ok', details: [{ id, title: 'Existing fact' }] }
    if (args[0] === 'show') return { status: 'ok', summary: { id }, details: { entry: { content: text, title: text } } }
    return { status: 'ok', summary: { id } }
  }
  const model = { id: 'synthetic-model' }
  const registry = { async complete(selected, context, options) {
    assert.equal(selected, model); assert.equal(options.maxRetries, 0); assert.equal(options.signal, controller.signal)
    completions.push(structuredClone(context))
    if (completeImpl) return completeImpl(context, options)
    assert.ok(responses.length, 'unexpected extra model request')
    return responses.shift()
  } }
  await wrapUp({ model, registry, transcript, controller, run, report: m => reports.push(m), timeoutMs })
  return { reports, calls, completions, controller }
}

// A real write is deduplicated, parented (or updates an observed candidate), read back,
// and cannot produce an ordinary chat/history message: the worker has no such API.
for (const command of ['remember']) {
  const r = await fixture({ responses: flow(command) })
  assert.deepEqual(r.reports, [])
  assert.deepEqual(r.calls.map(c => c[0]), ['prompt','recall','show',command,'show'])
  assert.equal(r.completions.length, 4)
  assert.ok(r.calls.every(c => !c.includes('--force')))
  tests++
}
// No whole-store time suppression remains: the wrap-up never queries list
// timestamps at all, so a record written one second before this request, long
// before it, or by a parallel client during it can never suppress the review.
{
  let lists = 0
  const r = await fixture({ runImpl: args => { if (args[0] === 'list') lists++; return undefined } })
  assert.equal(lists, 0)
  assert.equal(r.calls.filter(c => c[0] === 'remember').length, 1)
  assert.deepEqual(r.reports, [])
  tests++
}
// Already-stored is decided by the worker's own reads: recall + show, then a JSON
// finish naming the shown ids — no write attempt, no report, bounded as before.
{
  const responses = [extract({ facts: [fact] }),
    answer([call('prompt'), call('recall', { text: 'release smoke test' }), call('show', { id })]),
    answer([{ type: 'text', text: JSON.stringify({ result: 'already-stored', ids: [id] }) }])]
  const r = await fixture({ responses })
  assert.deepEqual(r.calls.map(c => c[0]), ['prompt','recall','show'])
  assert.deepEqual(r.reports, [])
  assert.equal(r.completions.length, 3)
  tests++
}
{
  const r = await fixture({ responses: [extract({ facts: [] })] })
  assert.deepEqual(r.reports, []); assert.equal(r.calls.length, 0); assert.equal(r.completions.length, 1); tests++
}
// No partial/unknown write is retried. Controlled status survives; provider prose does not.
for (const state of ['pending','skip','invalid','throw','cancel','bad-readback','mismatch-content']) {
  let shows = 0
  const r = await fixture({ runImpl: (args, signal) => {
    if (args[0] === 'show' && ++shows === 2) {
      if (state === 'bad-readback') return { status: 'ok', summary: { id: '99999999' } }
      if (state === 'mismatch-content') return { status: 'ok', summary: { id }, details: { entry: { content: 'different fact', title: text } } }
    }
    if (args[0] !== 'remember') return
    if (state === 'throw') throw Error('secret raw engine output')
    if (state === 'cancel') { signal.dispatchEvent(new Event('abort')); return new Promise(() => {}) }
    if (!['bad-readback','mismatch-content'].includes(state)) return { status: state }
  } })
  assert.equal(r.calls.filter(c => c[0] === 'remember').length, 1)
  assert.equal(r.reports.length, 1); assert.match(r.reports[0], state === 'pending' ? /nothing was written/ : /unconfirmed/)
  assert.doesNotMatch(r.reports[0], /secret raw/); tests++
}
// A warn receipt is a committed write: with a successful read-back its engine
// warnings surface as exactly one fixed sanitized notice — never a failure, a
// re-send, or a second write.
{
  const r = await fixture({ runImpl: args => args[0] === 'remember'
    ? { status: 'warn', summary: { id }, errors: ['unresolvable parent abcdef12'] } : undefined })
  assert.equal(r.calls.filter(c => c[0] === 'remember').length, 1)
  assert.deepEqual(r.reports, ['Background memory stored with engine warnings (id abcdef12); inspect if needed'])
  tests++
}
// warn + failed read-back: the existing unconfirmed path, one write attempt only.
{
  let shows = 0
  const r = await fixture({ runImpl: args => {
    if (args[0] === 'show' && ++shows === 2) return { status: 'ok', summary: { id: '99999999' } }
    if (args[0] === 'remember') return { status: 'warn', summary: { id } }
  } })
  assert.equal(r.calls.filter(c => c[0] === 'remember').length, 1)
  assert.equal(r.reports.length, 1); assert.match(r.reports[0], /unconfirmed/)
  tests++
}
// An uncooperative provider, read or write has a hard total deadline, and late
// completions cannot dispatch more actions. A timed-out write stays unconfirmed.
for (const phase of ['model','read','write']) {
  let late
  const opts = { timeoutMs: 10 }
  if (phase === 'model') opts.completeImpl = () => new Promise(resolve => { late = resolve })
  else opts.runImpl = args => args[0] === (phase === 'read' ? 'prompt' : 'remember') ? new Promise(resolve => { late = resolve }) : undefined
  const r = await fixture(opts)
  const before = r.calls.length
  assert.equal(r.controller.signal.aborted, true); assert.equal(r.reports.length, 1)
  if (phase === 'write') assert.match(r.reports[0], /unconfirmed/)
  late(answer([call('remember', { text, title: text, parent: id })]))
  await new Promise(resolve => setImmediate(resolve)); assert.equal(r.calls.length, before); tests++
}
// Strict extraction: limit/shape/provenance/secret violations never dispatch a write.
for (const value of [
  { facts: [fact, fact] }, { facts: [ { ...fact, sources: [{ index: 0, quote: 'fabricated support' }] } ] },
  { facts: [ { ...fact, sources: [{ index: -1, quote: text }] } ] },
  { facts: [ { ...fact, extra: true } ] }, { facts: [ { ...fact, text: 'x'.repeat(4001) } ] },
  { facts: [ { ...fact, text: 'password=do-not-store' } ] }, { facts: [], unexpected: true },
]) {
  const r = await fixture({ responses: [extract(value)] })
  assert.equal(r.reports.length, 1); assert.equal(r.calls.length, 0); tests++
}
// Bypass attempts: no missing policy/candidate body, no unknown commands/options,
// no altered candidate fact, and no second write even in one model response.
for (const bad of [call('forget', { id }), call('remember', { text, title: text, parent: id }),
  { ...call('prompt'), arguments: { command: 'prompt', args: ['--force'] } },
  call('remember', { text: 'invented fact', title: text, parent: id }),
]) {
  const r = await fixture({ responses: [extract({ facts: [fact] }), answer([bad])] })
  assert.equal(r.calls.filter(c => ['remember','update'].includes(c[0])).length, 0)
  assert.equal(r.reports.length, 1); tests++
}
{
  const responses = flow(); responses[3].content.push(call('remember', { text, title: text, parent: id }))
  const r = await fixture({ responses }); assert.equal(r.calls.filter(c => c[0] === 'remember').length, 1); tests++
}
// Preserve negation and exclude proposals/unsupported assistant assertions.
for (const [observation, candidate, role] of [
  ['release not approved', 'release approved', 'user'],
  ['release not approved', 'release', 'user'],
  ['I propose approving the release', 'I propose approving the release', 'user'],
  ['release approved', 'release approved', 'assistant'],
]) {
  const reports = [], writes = []
  const input = JSON.stringify([{ role, text: observation, confirmed: role === 'user' }])
  const candidateFact = { text: candidate, title: candidate, status: 'confirmed', sources: [{ index: 0, quote: candidate }] }
  await wrapUp({ model: {}, registry: { complete: async () => extract({ facts: [candidateFact] }) }, transcript: input,
    controller: new AbortController(), run: async args => { writes.push(args); return { status: 'ok', details: [] } }, report: m => reports.push(m) })
  assert.equal(reports.length, 1); assert.deepEqual(writes, []); tests++
}

// Reasoning model thinking blocks are ignored, never copied to status/history.
{
  const extraction=extract({facts:[]});extraction.content.unshift({type:'thinking',thinking:'private hidden reasoning'})
  const r=await fixture({responses:[extraction]});assert.deepEqual(r.reports,[]);tests++
}
{
  const finish=extract({result:'nothing-to-store',ids:[]});finish.content.unshift({type:'thinking',thinking:'private hidden reasoning'})
  const r=await fixture({responses:[extract({facts:[fact]}),finish]});assert.deepEqual(r.reports,[]);tests++
}
// Existing bodies cannot be replaced by a single extracted fact.
{
  const responses=flow('update')
  const r=await fixture({responses})
  assert.equal(r.calls.filter(c=>['remember','update'].includes(c[0])).length,0)
  assert.equal(r.reports.length,1);tests++
}

// Positional arguments cannot become CLI flags; schema cannot open a shell path.
{
  const r = await fixture({ responses: [extract({ facts: [fact] }), answer([call('recall', { text: '--force' })])] })
  assert.equal(r.calls.length, 0); assert.equal(r.reports.length, 1); tests++
}

// Successful ordinary final text from the isolated worker never leaks into reports.
{
  const r = await fixture({ responses: [extract({ facts: [fact] }), answer([{ type: 'text', text: '无新增事实，无需存储' }])] })
  assert.equal(r.reports.length, 1); assert.doesNotMatch(r.reports[0], /无新增事实/); tests++
}
// Infinite read calls are bounded; no resetting on no facts/failure/timeout.
{
  const r = await fixture({ completeImpl: (_ctx, _opts) => extract({ facts: [] }) })
  assert.equal(r.completions.length, 1); tests++
}
{
  let n = 0
  const r = await fixture({ completeImpl: () => n++ === 0 ? extract({ facts: [fact] }) : answer([call('prompt')]) })
  assert.equal(r.completions.length, LIMITS.rounds); assert.equal(r.reports.length, 1); tests++
}
// Context is copied, request-local, text-only; a continuation does not add history.
{
  const messages = [{ role: 'user', content: 'earlier unrelated input' }, { role: 'assistant', content: [{ type: 'text', text: 'older answer' }] },
    { role: 'user', content: text }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'normal answer' }] }]
  const before = structuredClone(messages)
  const result = snapshot({ context: { llmMessages: messages } }, { prompt: text })
  assert.doesNotMatch(result, /earlier|older|private reasoning/); assert.match(result, /normal answer/)
  assert.deepEqual(messages, before)
  assert.throws(() => snapshot({ context: { llmMessages: messages } }, { prompt: 'another request' }))
  tests++
}
console.log(`Wrap-up check: ${tests} bounded background scenarios green (synthetic models and memory only)`)
