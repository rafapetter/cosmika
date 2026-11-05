import { describe, expect, it } from 'vitest'

import { defaultGateway, trustProxyFromEnv } from './trust-proxy'

// Copied from `cat /proc/net/route` inside cosmika-api-1 on the box: the
// bridge gateway 172.18.0.1 is 010012AC little-endian.
const ROUTES = [
  'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
  'eth0\t00000000\t010012AC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
  'eth0\t000012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
].join('\n')

describe('defaultGateway', () => {
  it('reads the default route gateway as a dotted IPv4 address', () => {
    expect(defaultGateway(ROUTES)).toBe('172.18.0.1')
  })

  it('returns null when there is no default route', () => {
    expect(defaultGateway(ROUTES.split('\n').filter((l) => !l.includes('010012AC')).join('\n'))).toBeNull()
  })

  it('skips a default route with no gateway and malformed lines', () => {
    const table = ['header', '', 'eth0\t00000000\t00000000\t0001', 'eth0\t00000000\tzz', 'eth1\t00000000'].join('\n')
    expect(defaultGateway(table)).toBeNull()
  })
})

describe('trustProxyFromEnv', () => {
  it('trusts loopback and the Docker gateway by default', () => {
    expect(trustProxyFromEnv({}, () => ROUTES)).toEqual(['loopback', '172.18.0.1'])
  })

  it('trusts only loopback when the route table cannot be read (macOS dev)', () => {
    expect(
      trustProxyFromEnv({}, () => {
        throw new Error('ENOENT')
      }),
    ).toEqual(['loopback'])
  })

  it('trusts only loopback when there is no default route', () => {
    expect(trustProxyFromEnv({}, () => 'header\n')).toEqual(['loopback'])
  })

  it('takes an explicit comma-separated list from COSMIKA_TRUST_PROXY', () => {
    expect(
      trustProxyFromEnv({ COSMIKA_TRUST_PROXY: ' loopback, 10.0.0.0/8 ,,' }, () => ROUTES),
    ).toEqual(['loopback', '10.0.0.0/8'])
  })

  it.each(['0', 'false', 'OFF', 'none'])('disables trust with COSMIKA_TRUST_PROXY=%s', (v) => {
    expect(trustProxyFromEnv({ COSMIKA_TRUST_PROXY: v }, () => ROUTES)).toBe(false)
  })

  it('falls back to the default when the variable is blank', () => {
    expect(trustProxyFromEnv({ COSMIKA_TRUST_PROXY: '  ' }, () => ROUTES)).toEqual([
      'loopback',
      '172.18.0.1',
    ])
  })

  it('reads /proc/net/route when no reader is given', () => {
    // Linux CI has the file, macOS does not; both must come back with loopback.
    expect(trustProxyFromEnv({})).toContain('loopback')
  })
})
