// Sandboxed execution of author-supplied Code blocks.
//
// Runs the block's JS in an isolated-vm V8 isolate with ONLY a `user` object
// (the flow variables) exposed — no require, process, network, or host
// globals — under a hard CPU/wall-clock + memory limit. The JS may read/write
// `user.<var>`; we copy the mutated `user` back out.
//
// isolated-vm is a native module loaded lazily: if it isn't available (e.g. the
// native build is missing), we DO NOT fall back to running untrusted JS in this
// process — we return the variables unchanged. The engine treats that the same
// as a no-op Code block.

const MEMORY_LIMIT_MB = 16
const TIMEOUT_MS = 1000

// The no-op degrade is safe but changes flow branching (variables the code
// would have set stay unset), which is invisible without a log — warn once
// per process per cause so operators can tell a disabled sandbox apart from
// a broken flow.
const warned = new Set<string>()
function warnOnce(cause: string): void {
  if (warned.has(cause)) return
  warned.add(cause)
  console.warn(`[flow-code-sandbox] Code blocks are NO-OPs: ${cause}`)
}

// console.* are stubbed; the code runs against the shared vars object, which is
// then serialized out. `user`, `context`, and `variables` all alias the SAME
// object (Nebula Code blocks read `user.*` and write `context.*`), so a write
// to any of them lands in the returned variables.
function wrap(code: string): string {
  return (
    'const console = { log(){}, error(){}, warn(){}, info(){}, debug(){} };\n' +
    // `user` is the injected vars object; alias the names Nebula authors use.
    'var context = user, variables = user;\n' +
    code +
    '\n;JSON.stringify(user)'
  )
}

export async function runSandboxedCode(
  code: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Under vitest, never load the native isolated-vm addon: it spawns a V8
  // isolate on its own thread that doesn't survive the test worker's teardown
  // (crashes the worker). Tests assert the degrade contract.
  if (process.env.VITEST) return variables

  // Code execution is OFF by default and enabled per-environment via
  // COSMIKA_CODE_SANDBOX=1. Rationale: isolated-vm is a native addon whose
  // stability is platform-specific (it segfaults on some build/host combos,
  // and a segfault would crash the whole API process — not just the block).
  // The operator turns this on ONLY after confirming isolated-vm runs cleanly
  // in the target environment (see the deploy runbook smoke step). Until then,
  // Code blocks degrade to a safe no-op, exactly as when the addon is absent.
  if (process.env.COSMIKA_CODE_SANDBOX !== '1') {
    warnOnce('COSMIKA_CODE_SANDBOX is not set to 1 in this environment')
    return variables
  }

  // isolated-vm is an optional native dep with no bundled types; load it via a
  // variable specifier so tsc doesn't require it to be present at build time.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mod: any
  try {
    const spec = 'isolated-vm'
    mod = await import(spec)
  } catch {
    // Native sandbox unavailable — never run untrusted JS unsandboxed.
    warnOnce('isolated-vm native module failed to load')
    return variables
  }
  // CJS/ESM interop: the constructors live on the module or on `.default`.
  const ivm: any = mod && mod.Isolate ? mod : (mod && mod.default) || mod
  if (!ivm || typeof ivm.Isolate !== 'function') return variables

  const isolate: any = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB })
  try {
    const context = await isolate.createContext()
    // One copied object, exposed under every alias Nebula authors use
    // (`user`, `context`, `variables` reference the same object).
    const copy = new ivm.ExternalCopy(variables).copyInto()
    await context.global.set('user', copy)
    const json = (await context.eval(wrap(code), { timeout: TIMEOUT_MS })) as
      | string
      | undefined
    if (typeof json !== 'string') return variables
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : variables
  } catch {
    // syntax error, timeout, OOM, or non-serializable result → keep vars.
    return variables
  } finally {
    isolate.dispose()
  }
}
