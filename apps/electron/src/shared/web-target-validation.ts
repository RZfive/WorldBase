/**
 * Tool-side gate for AI-initiated browser tabs.
 *
 * Only literal host checks are performed here — there is intentionally no DNS
 * resolution, so a public-looking hostname can still resolve to a private
 * address. Callers that need stronger guarantees must resolve and re-check.
 */
export type AiBrowserTargetValidation =
  | { ok: true; url: string }
  | { ok: false; reason: string }

const BLOCKED_EXACT_HOSTS = new Set([
  'localhost',
  'local',
  'internal',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'localhost4',
  'localhost6'
])
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal'] as const

function stripTrailingDots (hostname: string): string {
  return hostname.replace(/\.+$/, '')
}

function parseIpv4 (hostname: string): number[] | null {
  const parts = hostname.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    octets.push(value)
  }
  return octets
}

function blockedIpv4Reason (octets: number[]): string | null {
  const [first, second] = octets
  if (first === 0) return 'Unspecified or local IPv4 addresses are not allowed.'
  if (first === 10) return 'Private IPv4 addresses are not allowed.'
  if (first === 127) return 'Loopback IPv4 addresses are not allowed.'
  if (first === 169 && second === 254) return 'Link-local IPv4 addresses are not allowed.'
  if (first === 172 && second >= 16 && second <= 31) return 'Private IPv4 addresses are not allowed.'
  if (first === 192 && second === 168) return 'Private IPv4 addresses are not allowed.'
  if (first === 100 && second >= 64 && second <= 127) return 'CGNAT IPv4 addresses are not allowed.'
  if (first >= 224) return 'Multicast or reserved IPv4 addresses are not allowed.'
  return null
}

function parseIpv6 (hostname: string): number[] | null {
  const input = hostname.toLowerCase()
  if (!input.includes(':')) return null

  let expanded = input
  const embeddedIpv4 = input.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (embeddedIpv4) {
    const octets = parseIpv4(embeddedIpv4[1])
    if (!octets) return null
    const high = ((octets[0] << 8) | octets[1]).toString(16)
    const low = ((octets[2] << 8) | octets[3]).toString(16)
    expanded = `${input.slice(0, -embeddedIpv4[1].length)}${high}:${low}`
  }

  const halves = expanded.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const groups = halves.length === 2
    ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail]
    : head
  if (groups.length !== 8) return null

  const words: number[] = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    words.push(Number.parseInt(group, 16))
  }
  return words
}

function ipv4FromWords (high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff]
}

function blockedIpv6Reason (words: number[]): string | null {
  if (words.every(word => word === 0)) {
    return 'Unspecified IPv6 addresses are not allowed.'
  }
  if (words.slice(0, 7).every(word => word === 0) && words[7] === 1) {
    return 'IPv6 loopback addresses are not allowed.'
  }
  if ((words[0] & 0xffc0) === 0xfec0) {
    return 'Deprecated IPv6 site-local addresses are not allowed.'
  }
  if ((words[0] & 0xffc0) === 0xfe80) {
    return 'IPv6 link-local addresses are not allowed.'
  }
  if ((words[0] & 0xfe00) === 0xfc00) {
    return 'IPv6 unique-local addresses are not allowed.'
  }
  if ((words[0] & 0xff00) === 0xff00) {
    return 'IPv6 multicast addresses are not allowed.'
  }

  // 6to4 (2002::/16) embeds the IPv4 destination in bits 16-47.
  if (words[0] === 0x2002) {
    return blockedIpv4Reason(ipv4FromWords(words[1], words[2]))
  }

  // Teredo (2001::/32) embeds the server IPv4 in bits 32-63 and the
  // obfuscated client IPv4 in bits 96-127 (one's complement).
  if (words[0] === 0x2001 && words[1] === 0) {
    const serverReason = blockedIpv4Reason(ipv4FromWords(words[2], words[3]))
    if (serverReason) return serverReason
    const obfuscated = ((words[6] << 16) | words[7]) >>> 0
    const client = (~obfuscated) >>> 0
    return blockedIpv4Reason([
      (client >>> 24) & 0xff,
      (client >>> 16) & 0xff,
      (client >>> 8) & 0xff,
      client & 0xff
    ])
  }

  // NAT64 well-known prefix (64:ff9b::/96) embeds the IPv4 destination in
  // the last 32 bits.
  if (
    words[0] === 0x64 &&
    words[1] === 0xff9b &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0
  ) {
    return blockedIpv4Reason(ipv4FromWords(words[6], words[7]))
  }

  // IPv4-translated addresses embed IPv4 in the last 32 bits. RFC 2765
  // defines the prefix as 0:0:0:0:ffff:0::/96; also handle the common
  // ::ffff:0:0:a.b.c.d textual form (0:0:0:ffff:0:0::/96).
  const translated =
    (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0xffff && words[5] === 0) ||
    (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0xffff && words[4] === 0 && words[5] === 0)
  if (translated) {
    return blockedIpv4Reason(ipv4FromWords(words[6], words[7]))
  }

  // ::ffff:a.b.c.d (IPv4-mapped) and the deprecated ::a.b.c.d form.
  const leadingZero = words.slice(0, 5).every(word => word === 0)
  if (leadingZero && (words[5] === 0xffff || words[5] === 0)) {
    return blockedIpv4Reason(ipv4FromWords(words[6], words[7]))
  }

  // The rest of 0000::/8 is reserved. If the low 32 bits embed a private
  // IPv4, treat the address as a transition-style local target.
  if (words[0] === 0) {
    return blockedIpv4Reason(ipv4FromWords(words[6], words[7]))
  }

  return null
}

function blockedHostReason (hostname: string): string | null {
  const host = stripTrailingDots(hostname.toLowerCase())
  if (!host) return 'The URL must include a host.'

  if (host.startsWith('[') && host.endsWith(']')) {
    const ipv6 = parseIpv6(host.slice(1, -1))
    if (!ipv6) return 'The URL contains an invalid IPv6 host.'
    return blockedIpv6Reason(ipv6)
  }

  const ipv4 = parseIpv4(host)
  if (ipv4) return blockedIpv4Reason(ipv4)

  if (BLOCKED_EXACT_HOSTS.has(host)) {
    return `Local network hosts are not allowed: ${host}`
  }
  if (BLOCKED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))) {
    return `Local network hosts are not allowed: ${host}`
  }

  return null
}

export function validateAiBrowserTarget (rawUrl: string): AiBrowserTargetValidation {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  if (!trimmed) return { ok: false, reason: 'A browser URL is required.' }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'The browser URL is invalid.' }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: `Unsupported URL scheme "${parsed.protocol}". Only http and https are allowed.`
    }
  }

  if (!parsed.hostname) {
    return { ok: false, reason: 'The URL must include a host.' }
  }

  const blocked = blockedHostReason(parsed.hostname)
  if (blocked) return { ok: false, reason: blocked }

  return { ok: true, url: parsed.toString() }
}
