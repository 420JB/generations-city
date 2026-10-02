/**
 * Disposable-database harness for integration tests.
 *
 * Database tests run only against TEST_DATABASE_URL, never DATABASE_URL, and only against
 * a database whose name ends in `_test`. Each test file then works inside its own
 * throwaway schema, which is the only thing these tests ever drop.
 */
export type TestDatabase = { url: string } | { skip: string }

export function resolveTestDatabase(env: Record<string, string | undefined>): TestDatabase {
  const url = env.TEST_DATABASE_URL?.trim()
  if (!url) {
    const reason = 'TEST_DATABASE_URL is not set'
    if (env.REQUIRE_DB_TESTS === '1') throw new Error(`${reason}, but REQUIRE_DB_TESTS=1 demands the database tests run.`)
    return { skip: reason }
  }
  if (url === env.DATABASE_URL?.trim()) throw new Error('TEST_DATABASE_URL must not be the same database as DATABASE_URL.')
  let name: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') throw new Error('not postgres')
    name = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  } catch {
    throw new Error('TEST_DATABASE_URL is not a valid postgres:// URL.')
  }
  if (!name.endsWith('_test')) throw new Error('TEST_DATABASE_URL must point at a database whose name ends in "_test".')
  return { url }
}

export function testSchemaName(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
