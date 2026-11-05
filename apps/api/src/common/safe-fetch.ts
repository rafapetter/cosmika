import { promises as dns } from 'node:dns'
import { isIP } from 'node:net'

/**
 * Reject URLs that point at internal infrastructure. Called before every
 * outbound `fetch` whose destination is operator-controlled (webhooks,
 * AI custom tools).
 *
 * Throws Error with a stable code-like message so callers can surface a
 * clean delivery failure instead of leaking DNS/network details.
 *
 * Allow http+https only. In production https is required; in dev we keep
 * http for httpbin/localhost-stub URLs that the e2e suite relies on.
 */
export async function assertSafeFetchUrl(rawUrl: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('blocked: malformed URL')
  }

  const allowHttp = process.env.NODE_ENV !== 'production'
  if (url.protocol === 'http:') {
    if (!allowHttp) throw new Error('blocked: https required in production')
  } else if (url.protocol !== 'https:') {
    throw new Error('blocked: only http/https supported')
  }

  // WHATWG URL keeps IPv6 hostnames in bracketed form (`[::1]`), which
  // isIP() rejects. Strip the brackets before classifying.
  const bareHost = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname

  // If the host is a literal IP, check it directly. Otherwise resolve it and
  // check every A/AAAA record. This prevents DNS rebinding-ish bypass where
  // a hostname resolves to a public IP first then a private one on retry.
  const candidates: string[] = []
  if (isIP(bareHost)) {
    candidates.push(bareHost)
  } else {
    // resolve4 + resolve6, swallow individual failures.
    const [v4, v6] = await Promise.all([
      dns.resolve4(url.hostname).catch(() => [] as string[]),
      dns.resolve6(url.hostname).catch(() => [] as string[]),
    ])
    candidates.push(...v4, ...v6)
  }

  // Localhost shortcut — sometimes dns can return empty for `localhost`
  // depending on /etc/nsswitch.conf.
  if (bareHost === 'localhost' || bareHost === 'localhost.localdomain') {
    if (!allowHttp) throw new Error('blocked: localhost')
    // allowed in dev for stub URLs
  } else {
    for (const ip of candidates) {
      if (isPrivateOrMetadataIp(ip)) {
        throw new Error('blocked: target IP is internal')
      }
    }
  }

  return url
}

function isPrivateOrMetadataIp(ip: string): boolean {
  // IPv6 — anything other than a public unicast address blocks. We only
  // catch the obvious ranges; rarer ones are unlikely targets.
  if (ip.includes(':')) {
    const lower = ip.toLowerCase()
    if (lower === '::1') return true                       // loopback
    if (lower.startsWith('fe80:')) return true             // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true // ULA
    if (lower === '::') return true
    // Mapped/embedded v4. Both WHATWG URL parsing and `dns.resolve6()`
    // canonicalise `::ffff:10.0.0.1` to packed hex form `::ffff:a00:1` —
    // the dotted-decimal form simply never reaches us in production, so
    // we only handle the packed form. We extract the last two 16-bit
    // groups and convert to v4 before recursing.
    const packed = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (packed) {
      const hi = parseInt(packed[1]!, 16)
      const lo = parseInt(packed[2]!, 16)
      const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
      return isPrivateOrMetadataIp(v4)
    }
    return false
  }
  // IPv4.
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false
  const [a, b] = parts as [number, number, number, number]
  if (a === 0) return true                                  // 0.0.0.0/8
  if (a === 10) return true                                 // 10.0.0.0/8
  if (a === 127) return true                                // loopback
  if (a === 169 && b === 254) return true                   // link-local + AWS IMDS
  if (a === 172 && b >= 16 && b <= 31) return true          // 172.16/12
  if (a === 192 && b === 168) return true                   // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true         // CGNAT 100.64/10
  if (a >= 224) return true                                 // multicast + reserved
  return false
}
