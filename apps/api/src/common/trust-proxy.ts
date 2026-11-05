import { readFileSync } from 'node:fs'

/**
 * Which peers may tell us the client's address through `X-Forwarded-For`.
 *
 * In production Caddy runs on the host (network_mode host) and proxies to
 * 127.0.0.1:3110, which Docker forwards into the container. The socket the
 * API sees is therefore always the bridge gateway (172.18.0.1 on the box),
 * for every visitor. Without trustProxy `req.ip` is that gateway, and every
 * per-IP throttle (5 sign-ups an hour, 10 sign-ins a minute, 60 requests a
 * minute by default) is one bucket shared by the whole internet.
 *
 * Trusting only loopback and the gateway keeps the header unforgeable: a
 * client that reaches the port directly shows up with its own address and
 * its `X-Forwarded-For` is ignored. That holds only while the published
 * ports are bound to 127.0.0.1 (docker-compose.production.yml); exposed on
 * [::], IPv6 traffic also arrives through docker-proxy as the gateway.
 *
 * `COSMIKA_TRUST_PROXY` overrides the default: a comma-separated list of
 * addresses, CIDRs or proxy-addr names (`loopback`, `uniquelocal`), or
 * `0`/`false`/`off` to trust nobody.
 */
export function trustProxyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  readRouteTable: () => string = () => readFileSync('/proc/net/route', 'utf8'),
): string[] | false {
  const raw = env.COSMIKA_TRUST_PROXY?.trim()
  if (raw) {
    if (['0', 'false', 'off', 'none'].includes(raw.toLowerCase())) return false
    return raw
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  }
  let gateway: string | null = null
  try {
    gateway = defaultGateway(readRouteTable())
  } catch {
    // No /proc/net/route (macOS dev, tests): loopback is all there is.
  }
  return gateway ? ['loopback', gateway] : ['loopback']
}

/**
 * IPv4 default gateway from the Linux `/proc/net/route` table, where
 * addresses are little-endian hex (`010012AC` is 172.18.0.1).
 */
export function defaultGateway(routeTable: string): string | null {
  for (const line of routeTable.split('\n').slice(1)) {
    const [, destination, gateway] = line.trim().split(/\s+/)
    if (destination !== '00000000' || !gateway || !/^[0-9A-Fa-f]{8}$/.test(gateway)) continue
    if (gateway === '00000000') continue
    const bytes = gateway.match(/../g)!.map((b) => parseInt(b, 16))
    return bytes.reverse().join('.')
  }
  return null
}
