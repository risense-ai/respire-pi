// Resolve hook: when lib/index.js imports ./rsrs.js, hand it the behavior stub instead.
// Only used by scripts/behavior-check.js; check-package.js loads via jiti and is unaffected.
export function resolve(specifier, context, nextResolve) {
  if (specifier === './rsrs.js' && context.parentURL?.endsWith('/lib/index.js')) {
    return { shortCircuit: true, url: new URL('../scripts/behavior-rsrs-stub.mjs', context.parentURL).href }
  }
  return nextResolve(specifier, context)
}