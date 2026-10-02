import { resolveTestDatabase } from './testDb'

/**
 * Runs once before the server tests. A skipped database suite must be loud, and
 * REQUIRE_DB_TESTS=1 must fail the run rather than let it pass with the suite skipped.
 */
export default function setup() {
  const target = resolveTestDatabase(process.env)
  if ('skip' in target) process.stderr.write(`\n[db tests] SKIPPED: ${target.skip}. Point TEST_DATABASE_URL at a disposable *_test database to run them (see server/README.md).\n\n`)
}
