import { describe, expect, it } from 'vitest'

import { runSandboxedCode } from './flow-code-sandbox'

// isolated-vm is an optional native dep. In CI/local without the native build
// it isn't loadable, so runSandboxedCode degrades to returning the variables
// unchanged (it must NEVER run untrusted JS unsandboxed). When the native
// module IS present, it runs the JS against `user`. We assert the contract
// either way: vars are returned, and a Code block can't crash the flow.
describe('runSandboxedCode', () => {
  it('returns a variables object (unchanged if the sandbox is unavailable)', async () => {
    const vars = { counter: 2, name: 'Ada' }
    const out = await runSandboxedCode('user.counter = user.counter + 1', vars)
    expect(out && typeof out).toBe('object')
    // Either the sandbox ran (counter=3) or it degraded (counter=2).
    expect([2, 3]).toContain(out.counter)
    expect(out.name).toBe('Ada')
  })

  it('never throws on malformed code', async () => {
    const out = await runSandboxedCode('this is not valid javascript ;;;', { a: 1 })
    expect(out.a).toBe(1)
  })

  it('warns once and no-ops when COSMIKA_CODE_SANDBOX is not enabled', async () => {
    // Reach past the vitest early-return to the env-flag gate. The flag gate
    // sits BEFORE the isolated-vm import, so this never loads the native
    // addon (which crashes vitest workers).
    const hadVitest = process.env.VITEST
    const hadFlag = process.env.COSMIKA_CODE_SANDBOX
    delete process.env.VITEST
    delete process.env.COSMIKA_CODE_SANDBOX
    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (msg: string) => void warnings.push(String(msg))
    try {
      const out1 = await runSandboxedCode('user.a = 99', { a: 1 })
      const out2 = await runSandboxedCode('user.a = 99', { a: 1 })
      expect(out1.a).toBe(1)
      expect(out2.a).toBe(1)
      const sandboxWarnings = warnings.filter((w) => w.includes('flow-code-sandbox'))
      expect(sandboxWarnings).toHaveLength(1)
      expect(sandboxWarnings[0]).toContain('COSMIKA_CODE_SANDBOX')
    } finally {
      console.warn = origWarn
      if (hadVitest !== undefined) process.env.VITEST = hadVitest
      if (hadFlag !== undefined) process.env.COSMIKA_CODE_SANDBOX = hadFlag
    }
  })
})
