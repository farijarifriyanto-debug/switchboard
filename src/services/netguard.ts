import { lookup } from 'node:dns/promises'
import net from 'node:net'

/** True for loopback, private, link-local, CGNAT, multicast, reserved and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped) return isPrivateAddress(mapped[1])
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase()
    return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff')
  }
  return true // not an address we understand: refuse
}

/**
 * Parses `raw` and refuses non-http(s) URLs and hosts that resolve to a private
 * address, so a model-chosen URL cannot reach loopback services, cloud metadata
 * endpoints or the LAN.
 *
 * ponytail: fetch() resolves the name again after this check, so a DNS rebind
 * between the two can still win; pinning the address needs a custom dispatcher.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`invalid URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`only http(s) URLs are allowed (got ${url.protocol})`)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = net.isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address)
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new Error(`refusing to fetch ${url.hostname}: it resolves to a private or local address (set tools.web.allowPrivateNetwork to allow)`)
  }
  return url
}
