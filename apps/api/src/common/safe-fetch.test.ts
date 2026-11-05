import { promises as dns } from 'node:dns'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { assertSafeFetchUrl } from './safe-fetch'

// We need to control DNS lookups deterministically. The SSRF guard reaches
// into node:dns's promises API, so we mock those two specific calls and
// restore them in afterEach. NODE_ENV is also flipped per-test for the
// production-mode branch.

const ORIGINAL_NODE_ENV = process.env.NODE_ENV

function mockDns(v4: string[] | Error, v6: string[] | Error) {
  vi.spyOn(dns, 'resolve4').mockImplementation(async () => {
    if (v4 instanceof Error) throw v4
    return v4
  })
  vi.spyOn(dns, 'resolve6').mockImplementation(async () => {
    if (v6 instanceof Error) throw v6
    return v6
  })
}

describe('assertSafeFetchUrl — URL parsing', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'development'
  })
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV
    vi.restoreAllMocks()
  })

  it('rejects a malformed URL', async () => {
    await expect(assertSafeFetchUrl('not a url')).rejects.toThrow(
      'blocked: malformed URL',
    )
  })

  it('rejects non-http(s) protocols (ftp)', async () => {
    await expect(assertSafeFetchUrl('ftp://example.com')).rejects.toThrow(
      'blocked: only http/https supported',
    )
  })

  it('rejects file:// URLs', async () => {
    await expect(assertSafeFetchUrl('file:///etc/passwd')).rejects.toThrow(
      'blocked: only http/https supported',
    )
  })

  it('rejects gopher://', async () => {
    await expect(assertSafeFetchUrl('gopher://example.com')).rejects.toThrow(
      'blocked: only http/https supported',
    )
  })
})

describe('assertSafeFetchUrl — production HTTPS requirement', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production'
  })
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV
    vi.restoreAllMocks()
  })

  it('rejects http:// in production', async () => {
    await expect(assertSafeFetchUrl('http://example.com')).rejects.toThrow(
      'blocked: https required in production',
    )
  })

  it('rejects http://localhost even in production', async () => {
    await expect(assertSafeFetchUrl('http://localhost')).rejects.toThrow(
      'blocked: https required in production',
    )
  })

  it('rejects https://localhost in production', async () => {
    mockDns([], [])
    await expect(assertSafeFetchUrl('https://localhost')).rejects.toThrow(
      'blocked: localhost',
    )
  })

  it('rejects https://localhost.localdomain in production', async () => {
    mockDns([], [])
    await expect(
      assertSafeFetchUrl('https://localhost.localdomain'),
    ).rejects.toThrow('blocked: localhost')
  })

  it('allows https:// to a public IP in production', async () => {
    mockDns(['8.8.8.8'], [])
    const url = await assertSafeFetchUrl('https://example.com/path')
    expect(url.hostname).toBe('example.com')
    expect(url.pathname).toBe('/path')
  })
})

describe('assertSafeFetchUrl — IPv4 private-range blocks', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'development'
  })
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV
    vi.restoreAllMocks()
  })

  // Literal-IP form goes through the `isIP(url.hostname)` short-circuit.
  it.each([
    ['0.0.0.0', 'http://0.0.0.0/'],
    ['10.0.0.5', 'http://10.0.0.5/'],
    ['127.0.0.1', 'http://127.0.0.1/'],
    ['169.254.169.254', 'http://169.254.169.254/'], // AWS IMDS
    ['172.16.0.1', 'http://172.16.0.1/'],
    ['172.31.255.255', 'http://172.31.255.255/'],
    ['192.168.1.1', 'http://192.168.1.1/'],
    ['100.64.0.1', 'http://100.64.0.1/'], // CGNAT
    ['100.127.255.255', 'http://100.127.255.255/'], // CGNAT high end
    ['224.0.0.1', 'http://224.0.0.1/'], // multicast
    ['240.0.0.1', 'http://240.0.0.1/'], // reserved
  ])('blocks literal IP %s', async (_ip, url) => {
    await expect(assertSafeFetchUrl(url)).rejects.toThrow(
      'blocked: target IP is internal',
    )
  })

  it('does NOT block 172.32.0.0 (just outside the 172.16/12 block)', async () => {
    const u = await assertSafeFetchUrl('http://172.32.0.1/')
    expect(u.hostname).toBe('172.32.0.1')
  })

  it('does NOT block 100.63.255.255 (just below CGNAT start)', async () => {
    const u = await assertSafeFetchUrl('http://100.63.255.255/')
    expect(u.hostname).toBe('100.63.255.255')
  })

  it('does NOT block 100.128.0.1 (just above CGNAT end)', async () => {
    const u = await assertSafeFetchUrl('http://100.128.0.1/')
    expect(u.hostname).toBe('100.128.0.1')
  })

  it('does NOT block 223.255.255.255 (last unicast address before multicast)', async () => {
    const u = await assertSafeFetchUrl('http://223.255.255.255/')
    expect(u.hostname).toBe('223.255.255.255')
  })

  it('allows 8.8.8.8 (Google DNS)', async () => {
    const u = await assertSafeFetchUrl('http://8.8.8.8/')
    expect(u.hostname).toBe('8.8.8.8')
  })
})

describe('assertSafeFetchUrl — IPv6 private-range blocks', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'development'
  })
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV
    vi.restoreAllMocks()
  })

  it.each([
    ['loopback ::1', 'http://[::1]/'],
    ['unspecified ::', 'http://[::]/'],
    ['link-local fe80::', 'http://[fe80::1]/'],
    ['ULA fc00::', 'http://[fc00::1]/'],
    ['ULA fd00::', 'http://[fd00::abcd]/'],
    ['v4-mapped private (::ffff:10.0.0.1)', 'http://[::ffff:10.0.0.1]/'],
    ['v4-mapped IMDS (::ffff:169.254.169.254)', 'http://[::ffff:169.254.169.254]/'],
    ['v4-mapped loopback (::ffff:127.0.0.1)', 'http://[::ffff:127.0.0.1]/'],
  ])('blocks IPv6 %s', async (_name, url) => {
    await expect(assertSafeFetchUrl(url)).rejects.toThrow(
      'blocked: target IP is internal',
    )
  })

  it('allows a v4-mapped public IPv6 (::ffff:8.8.8.8)', async () => {
    const u = await assertSafeFetchUrl('http://[::ffff:8.8.8.8]/')
    // WHATWG URL normalises the dotted-decimal embedded v4 to packed hex —
    // 8.8.8.8 → 0808:0808. The fact that we accept this form proves the
    // packed-hex detection in isPrivateOrMetadataIp correctly classifies
    // the address as public, not just bypasses the check.
    expect(u.hostname).toBe('[::ffff:808:808]')
  })

  it('allows a public IPv6 (2001:db8::1)', async () => {
    const u = await assertSafeFetchUrl('http://[2001:db8::1]/')
    expect(u.hostname).toBe('[2001:db8::1]')
  })
})

describe('assertSafeFetchUrl — DNS resolution', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'development'
  })
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV
    vi.restoreAllMocks()
  })

  it('blocks when DNS resolves to a private IP', async () => {
    mockDns(['10.0.0.5'], [])
    await expect(
      assertSafeFetchUrl('http://attacker.example.com/'),
    ).rejects.toThrow('blocked: target IP is internal')
  })

  it('blocks when AAAA resolves to a private IPv6', async () => {
    mockDns([], ['fe80::1'])
    await expect(
      assertSafeFetchUrl('http://attacker.example.com/'),
    ).rejects.toThrow('blocked: target IP is internal')
  })

  it('blocks when ANY of the resolved IPs is private (rebinding defence)', async () => {
    mockDns(['8.8.8.8', '10.0.0.5'], [])
    await expect(
      assertSafeFetchUrl('http://multi.example.com/'),
    ).rejects.toThrow('blocked: target IP is internal')
  })

  it('passes when all resolved IPs are public', async () => {
    mockDns(['8.8.8.8', '1.1.1.1'], ['2001:db8::1'])
    const u = await assertSafeFetchUrl('http://safe.example.com/path?q=1')
    expect(u.pathname).toBe('/path')
    expect(u.searchParams.get('q')).toBe('1')
  })

  it('passes when resolve4 rejects but resolve6 yields a public address', async () => {
    mockDns(new Error('NXDOMAIN'), ['2001:db8::1'])
    const u = await assertSafeFetchUrl('http://v6only.example.com/')
    expect(u.hostname).toBe('v6only.example.com')
  })

  it('passes when DNS returns nothing at all (no candidates → no blocks)', async () => {
    mockDns([], [])
    // Empty resolution means we have no IP to check → no block. This is
    // the by-design behaviour: the actual fetch will fail at connection
    // time, but our guard's job is only to prevent INTERNAL targets, not
    // to be a generic reachability check.
    const u = await assertSafeFetchUrl('http://nowhere.example.com/')
    expect(u.hostname).toBe('nowhere.example.com')
  })
})

describe('assertSafeFetchUrl — localhost handling', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'development'
  })
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV
    vi.restoreAllMocks()
  })

  it('allows http://localhost in dev (e2e stub URLs use this)', async () => {
    mockDns([], [])
    const u = await assertSafeFetchUrl('http://localhost:3110/foo')
    expect(u.hostname).toBe('localhost')
    expect(u.port).toBe('3110')
  })

  it('allows http://localhost.localdomain in dev', async () => {
    mockDns([], [])
    const u = await assertSafeFetchUrl('http://localhost.localdomain/')
    expect(u.hostname).toBe('localhost.localdomain')
  })
})

describe('assertSafeFetchUrl — IP-list edge cases via isPrivateOrMetadataIp', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'development'
  })
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV
    vi.restoreAllMocks()
  })

  it('does not block when DNS returns an IPv6 we do not recognise (public)', async () => {
    mockDns([], ['2606:4700:4700::1111'])
    const u = await assertSafeFetchUrl('http://cloudflare-dns.example.com/')
    expect(u.hostname).toBe('cloudflare-dns.example.com')
  })

  it('handles a non-IP-looking resolve result without crashing (length check)', async () => {
    // This shouldn't happen in practice — dns.resolve4 returns valid IPs —
    // but the impl defends against it. We feed an obviously bad string
    // and assert no exception (the function falls through to "allowed").
    mockDns(['not-an-ip'], [])
    const u = await assertSafeFetchUrl('http://weird.example.com/')
    expect(u.hostname).toBe('weird.example.com')
  })
})
