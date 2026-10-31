// Test double for lib/rsrs.js: records every runRsrs call and delegates to control.impl.
// behavior-check.js imports this module directly, so both share one instance.

export const calls = []
export const control = {
  /** @type {(args: string[], options: {cwd?: string, executable?: string, signal?: AbortSignal}) => unknown} */
  impl: () => { throw new Error('behavior stub: no impl configured') },
}

export function resetCalls() {
  calls.length = 0
}

export const statusCalls = () => calls.filter(call => call.args[0] === 'status')
export const listCalls = () => calls.filter(call => call.args[0] === 'list')

export function runRsrs(args, options = {}) {
  calls.push({
    args: [...args],
    cwd: options.cwd,
    executable: options.executable,
    signal: options.signal ?? null,
  })
  return (async () => control.impl(args, options))()
}
