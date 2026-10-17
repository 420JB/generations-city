import { createHash } from 'node:crypto'

/**
 * Proofy Play's canonical JSON (contract 1.1.0 §2), reproduced byte for byte from
 * `@proofy/play-contract` `canonical.ts`: object keys sorted by UTF-16 code unit, arrays in
 * order, no whitespace, `undefined` properties dropped, anything JSON cannot represent
 * refused. Play's `configHash` is the lowercase hex SHA-256 of this text, UTF-8 encoded.
 *
 * Rare City recomputes it to check that the configuration Play served is the one the run
 * was pinned to. Golden vectors from Play's own tests live in server/tests/play.canonical.test.ts.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number')
      return JSON.stringify(value)
    case 'string':
      return JSON.stringify(value)
    case 'object':
      break
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value}`)
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('canonicalJson: only plain objects are supported')
  const record = value as Record<string, unknown>
  const parts: string[] = []
  for (const key of Object.keys(record).sort()) {
    const item = record[key]
    if (item === undefined) continue
    parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`)
  }
  return `{${parts.join(',')}}`
}

/** Lowercase hex SHA-256 of the canonical JSON text of a value: Play's `configHash`. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}
