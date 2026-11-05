import { describe, expect, it } from 'vitest'

import { PROTOCOL_REUSE_MS, newProtocol, protocolStillOpen } from './protocol'

describe('newProtocol', () => {
  it('is the São Paulo date plus six digits', () => {
    // 02:00 UTC on the 17th is still the 16th in São Paulo.
    expect(newProtocol(new Date('2026-10-17T02:00:00Z'))).toMatch(/^20261016-\d{6}$/)
    expect(newProtocol(new Date('2026-10-17T02:00:00Z'), 'UTC')).toMatch(/^20261017-\d{6}$/)
    expect(newProtocol()).toMatch(/^\d{8}-\d{6}$/)
  })
})

describe('protocolStillOpen', () => {
  const now = new Date('2026-10-16T12:00:00Z')
  it('covers a case still open, or closed within 24 h', () => {
    expect(protocolStillOpen({ status: 'OPEN', resolvedAt: null }, now)).toBe(true)
    expect(protocolStillOpen({ status: 'PENDING', resolvedAt: null }, now)).toBe(true)
    expect(
      protocolStillOpen({ status: 'RESOLVED', resolvedAt: new Date(now.getTime() - PROTOCOL_REUSE_MS) }, now),
    ).toBe(true)
  })

  it('starts a new case after that', () => {
    expect(
      protocolStillOpen({ status: 'RESOLVED', resolvedAt: new Date(now.getTime() - PROTOCOL_REUSE_MS - 1) }, now),
    ).toBe(false)
    expect(protocolStillOpen({ status: 'RESOLVED', resolvedAt: null }, now)).toBe(false)
    expect(protocolStillOpen({ status: 'RESOLVED', resolvedAt: new Date(0) })).toBe(false)
  })
})
