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
for (const name of ['input', 'before_agent_start', 'agent_before_settle', 'session_switch', 'session_shutdown']) {
  assert.equal(handlers.get(name)?.length, 1, `Missing Pi handler: ${name}`)
}
const event = { messageType: 'user', systemPromptOptions: { sections: { existing: 'preserved' } } }
await handlers.get('before_agent_start')[0](event, {})
assert.equal(event.systemPromptOptions.sections.existing, 'preserved')
assert.match(event.systemPromptOptions.sections.respire, /rsrs --client-only/)
assert.equal(await handlers.get('input')[0]({ source: 'interactive', text: '/nomem check' }, {}), undefined)
assert.equal(await handlers.get('agent_before_settle')[0]({ outcome: 'completed', context: { canContinue: true }, entries: [] }, {}), undefined)
await handlers.get('session_shutdown')[0]()
console.log(`Verified ${packed.filename}: ${files.length} files, Pi 1.3.0 loader and lifecycle`)
