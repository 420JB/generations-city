import { describe, expect, it } from 'vitest'
import { clientKey, FALLBACK_CLIENT, normalizeClientAddress } from '../src/clientKey'

const req = (headers: Record<string, string | string[]>, remoteAddress?: string) => ({ headers, socket: { remoteAddress } })

describe('client address normalisation', () => {
  it('keeps IPv4 as its one dotted spelling and refuses every other', () => {
    expect(normalizeClientAddress('203.0.113.7')).toBe('ip4:203.0.113.7')
    expect(normalizeClientAddress('0.0.0.0')).toBe('ip4:0.0.0.0')
    expect(normalizeClientAddress('255.255.255.255')).toBe('ip4:255.255.255.255')
    for (const other of ['203.0.113.07', '203.0.113', '203.0.113.7.1', '203.0.113.256', '0x7f.0.0.1', '2130706433', '203.0.113.7 ', ' 203.0.113.7', '203.0.113.7:443', '203.0.113.7/32'])
      expect(normalizeClientAddress(other), JSON.stringify(other)).toBeNull()
  })

  it('treats an IPv4-mapped IPv6 address as that IPv4 address, however it is written', () => {
    for (const mapped of ['::ffff:203.0.113.7', '::FFFF:203.0.113.7', '0:0:0:0:0:ffff:203.0.113.7', '::ffff:cb00:7107', '0000:0000:0000:0000:0000:ffff:cb00:7107'])
      expect(normalizeClientAddress(mapped), mapped).toBe('ip4:203.0.113.7')
    // Only the mapped prefix means IPv4: these are IPv6 addresses that merely end in a dotted quad.
    expect(normalizeClientAddress('::203.0.113.7')).toBe('ip6:0:0:0:0')
    expect(normalizeClientAddress('64:ff9b::203.0.113.7')).toBe('ip6:64:ff9b:0:0')
    expect(normalizeClientAddress('::fffe:203.0.113.7')).toBe('ip6:0:0:0:0')
  })

  it('groups IPv6 by /64, in one spelling', () => {
    const sameNetwork = ['2001:db8:12:3400::1', '2001:0db8:0012:3400:ffff:ffff:ffff:ffff', '2001:DB8:12:3400:1:2:3:4', '2001:db8:12:3400:0:0:0:0', '2001:db8:12:3400::']
    for (const address of sameNetwork) expect(normalizeClientAddress(address), address).toBe('ip6:2001:db8:12:3400')
    expect(normalizeClientAddress('2001:db8:12:3401::1')).toBe('ip6:2001:db8:12:3401')
    expect(normalizeClientAddress('2001:db8:13:3400::1')).toBe('ip6:2001:db8:13:3400')
    expect(normalizeClientAddress('::1')).toBe('ip6:0:0:0:0')
    expect(normalizeClientAddress('::')).toBe('ip6:0:0:0:0')
    expect(normalizeClientAddress('fe80::1')).toBe('ip6:fe80:0:0:0')
    expect(normalizeClientAddress('1:2:3:4:5:6:7:8')).toBe('ip6:1:2:3:4')
  })

  it('refuses anything that is not exactly one address', () => {
    for (const bad of ['', 'localhost', 'example.com', '::g', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '1::2::3', 'fe80::1%en0', '[::1]', '[::1]:443', '::1, ::2', '203.0.113.7, 198.51.100.1', 'unknown', '-', '\u0000'])
      expect(normalizeClientAddress(bad), JSON.stringify(bad)).toBeNull()
  })
})

describe('client key: TRUSTED_PROXY=none', () => {
  it('is the socket peer and nothing else', () => {
    expect(clientKey(req({}, '203.0.113.7'), 'none')).toEqual({ key: 'ip4:203.0.113.7', source: 'socket' })
    expect(clientKey(req({}, '::ffff:203.0.113.7'), 'none')).toEqual({ key: 'ip4:203.0.113.7', source: 'socket' })
    expect(clientKey(req({}, '2001:db8:12:3400::9'), 'none')).toEqual({ key: 'ip6:2001:db8:12:3400', source: 'socket' })
    // A link-local peer's zone names an interface of this machine; it is not part of the address.
    expect(clientKey(req({}, 'fe80::1%en0'), 'none')).toEqual({ key: 'ip6:fe80:0:0:0', source: 'socket' })
  })

  it('ignores every header a client can send about itself', () => {
    const spoofed = { 'x-real-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.2', forwarded: 'for=198.51.100.3', 'cf-connecting-ip': '198.51.100.4', 'true-client-ip': '198.51.100.5', 'x-client-ip': '198.51.100.6' }
    expect(clientKey(req(spoofed, '203.0.113.7'), 'none')).toEqual({ key: 'ip4:203.0.113.7', source: 'socket' })
  })

  it('falls back to the shared key when the socket has no peer address', () => {
    expect(clientKey(req({ 'x-real-ip': '198.51.100.1' }, undefined), 'none')).toBe(FALLBACK_CLIENT)
    expect(clientKey(req({}, 'not-an-address'), 'none')).toBe(FALLBACK_CLIENT)
  })
})

describe('client key: TRUSTED_PROXY=railway', () => {
  const EDGE = '100.64.0.2'

  it('is X-Real-IP and nothing else: never the socket, never X-Forwarded-For', () => {
    expect(clientKey(req({ 'x-real-ip': '203.0.113.7' }, EDGE), 'railway')).toEqual({ key: 'ip4:203.0.113.7', source: 'x-real-ip' })
    expect(clientKey(req({ 'x-real-ip': ' 203.0.113.7\t' }, EDGE), 'railway')).toEqual({ key: 'ip4:203.0.113.7', source: 'x-real-ip' })
    expect(clientKey(req({ 'x-real-ip': '2001:db8:12:3400::9' }, EDGE), 'railway')).toEqual({ key: 'ip6:2001:db8:12:3400', source: 'x-real-ip' })
    expect(clientKey(req({ 'x-real-ip': '::ffff:203.0.113.7' }, EDGE), 'railway')).toEqual({ key: 'ip4:203.0.113.7', source: 'x-real-ip' })
    const other = { 'x-forwarded-for': '198.51.100.2, 198.51.100.9', forwarded: 'for=198.51.100.3', 'cf-connecting-ip': '198.51.100.4' }
    expect(clientKey(req({ ...other, 'x-real-ip': '203.0.113.7' }, EDGE), 'railway')).toEqual({ key: 'ip4:203.0.113.7', source: 'x-real-ip' })
  })

  it('uses the one shared fallback when X-Real-IP is missing or unusable, and never another header', () => {
    const other = { 'x-forwarded-for': '198.51.100.2', forwarded: 'for=198.51.100.3' }
    expect(clientKey(req(other, EDGE), 'railway')).toBe(FALLBACK_CLIENT)
    // Node hands a repeated header over joined with ", ": two values are not an address.
    for (const value of ['', ' ', 'unknown', '203.0.113.7, 198.51.100.1', '203.0.113.7:51234', '203.0.113.07', 'fe80::1%en0', '[2001:db8::1]', 'localhost', '203.0.113.7\n198.51.100.1'])
      expect(clientKey(req({ ...other, 'x-real-ip': value }, EDGE), 'railway'), JSON.stringify(value)).toBe(FALLBACK_CLIENT)
    expect(clientKey(req({ 'x-real-ip': ['203.0.113.7', '198.51.100.1'] }, EDGE), 'railway')).toBe(FALLBACK_CLIENT)
    expect(FALLBACK_CLIENT).toEqual({ key: 'unidentified', source: 'fallback' })
  })
})
