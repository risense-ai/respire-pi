import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { recallText, storeText } from '../lib/memory.js'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
assert.equal(pkg.name, '@rsrsai/pi')
assert.deepEqual(pkg.pi.extensions, ['./lib/index.js'])
assert.match(recallText({ status: 'ok', details: [{ id: '12345678', title: 'A saved project fact', score: 0.8 }] }), /rsrs --client-only show <id> --json/)
assert.match(storeText({ status: 'pending' }).text, /rsrs --client-only show <候选id> --json/)
const [packed] = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--ignore-scripts', '--json'], { encoding: 'utf8' }))
const files = packed.files.map(file => file.path)
assert.deepEqual(files.sort(), ['LICENSE', 'README.md', 'README.zh-CN.md', 'lib/index.js', 'lib/memory.js', 'lib/rsrs.js', 'package.json'].sort())

const { loadExtensions } = await import(new URL('./core/extensions/loader.js', import.meta.resolve('@earendil-works/pi-coding-agent')))
const loaded = await loadExtensions([resolve(pkg.pi.extensions[0])], process.cwd())
assert.deepEqual(loaded.errors, [])
assert.equal(loaded.extensions.length, 1)
const { handlers } = loaded.extensions[0]
for (const name of ['input', 'context', 'before_agent_start', 'session_switch', 'session_shutdown']) {
  assert.equal(handlers.get(name)?.length, 1, `Missing Pi handler: ${name}`)
}
const event = { messageType: 'user', systemPromptOptions: { sections: { existing: 'preserved' } } }
await handlers.get('before_agent_start')[0](event, {})
assert.equal(event.systemPromptOptions.sections.existing, 'preserved')
assert.match(event.systemPromptOptions.sections.respire, /rsrs --client-only/)
assert.equal(await handlers.get('input')[0]({ source: 'interactive', text: '/nomem check' }, {}), undefined)
assert.equal(handlers.has('agent_before_settle'), false)
const input = { source: 'interactive', text: 'password=redacted', images: [{ type: 'image', data: 'unchanged', mimeType: 'image/png' }] }
assert.equal(await handlers.get('input')[0](input, {}), undefined)
const userMessage = { role: 'user', content: [{ type: 'text', text: input.text }, ...input.images], timestamp: Date.now() }
const history = [userMessage]
const projected = await handlers.get('context')[0]({ messages: history }, {})
assert.equal(history.length, 1)
assert.equal(projected.messages[0], userMessage)
assert.equal(projected.messages[0].content[0].text, input.text)
assert.deepEqual(projected.messages[0].content.slice(1), input.images)
assert.equal(projected.messages[1].customType, 'respire-context')
assert.equal(projected.messages[1].display, false)
assert.match(projected.messages[1].content, /respire·已跳过/)
await handlers.get('session_switch')[0]()
assert.deepEqual((await handlers.get('context')[0]({ messages: history }, {})).messages, history)
await handlers.get('session_shutdown')[0]()
console.log(`Verified ${packed.filename}: ${files.length} files, Pi 1.3.0 loader and lifecycle`)
