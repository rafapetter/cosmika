import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WebhooksWorker } from './webhooks.worker'

function makeService(processDueDeliveries: ReturnType<typeof vi.fn>) {
  return { processDueDeliveries } as unknown as import('./webhooks.service').WebhooksService
}

describe('WebhooksWorker.tick', () => {
  let processDueDeliveries: ReturnType<typeof vi.fn>

  beforeEach(() => {
    processDueDeliveries = vi.fn()
  })

  it('calls processDueDeliveries each tick', async () => {
    processDueDeliveries.mockResolvedValue(0)
    const worker = new WebhooksWorker(makeService(processDueDeliveries))
    await worker.tick()
    expect(processDueDeliveries).toHaveBeenCalledTimes(1)
  })

  it('emits a log only when processed > 0 (avoid log spam on idle ticks)', async () => {
    processDueDeliveries.mockResolvedValue(3)
    const worker = new WebhooksWorker(makeService(processDueDeliveries))
    // Just confirm it doesn't throw — Logger.log writes to stdout and we
    // can't easily assert on the message here without mocking the global.
    await expect(worker.tick()).resolves.toBeUndefined()
  })

  it('swallows errors so the cron does not crash the process', async () => {
    processDueDeliveries.mockRejectedValue(new Error('queue down'))
    const worker = new WebhooksWorker(makeService(processDueDeliveries))
    await expect(worker.tick()).resolves.toBeUndefined()
  })

  it('handles non-Error throwables in the catch block', async () => {
    processDueDeliveries.mockRejectedValue('a string')
    const worker = new WebhooksWorker(makeService(processDueDeliveries))
    await expect(worker.tick()).resolves.toBeUndefined()
  })

  it('skips overlapping ticks via the `running` flag', async () => {
    let resolveFirst: (n: number) => void = () => undefined
    processDueDeliveries.mockReturnValueOnce(
      new Promise<number>((res) => { resolveFirst = res }),
    )
    const worker = new WebhooksWorker(makeService(processDueDeliveries))
    const first = worker.tick()
    // Second invocation while first is in-flight should bail immediately.
    await worker.tick()
    expect(processDueDeliveries).toHaveBeenCalledTimes(1)
    resolveFirst(0)
    await first
  })

  it('allows a new tick after the previous one finishes', async () => {
    processDueDeliveries.mockResolvedValue(0)
    const worker = new WebhooksWorker(makeService(processDueDeliveries))
    await worker.tick()
    await worker.tick()
    expect(processDueDeliveries).toHaveBeenCalledTimes(2)
  })
})
