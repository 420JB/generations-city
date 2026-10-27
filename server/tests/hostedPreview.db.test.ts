import { describe, expect, it } from 'vitest'
import { migrate } from '../src/db/migrations'
import { createPool } from '../src/db/pool'
import { silentLogger } from '../src/log'
import { assertPreviewDatabase } from '../src/preview'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'

/**
 * HOSTED PREVIEW start-up: the database it is pointed at must be migrated and stamped local, checked before anything is
 * served. A staging or production database, an empty one, a half-migrated one or an unreachable one stops start-up.
 */
describe.skipIf(NO_TEST_DATABASE)('hosted preview database check', () => {
  const t = useTestSchema()

  it('accepts a fully migrated database stamped local', async () => {
    await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })
    await expect(assertPreviewDatabase(t.db, MIGRATIONS_DIR)).resolves.toBeUndefined()
  })

  for (const environment of ['staging', 'production'] as const)
    it(`refuses a database stamped ${environment}`, async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment })
      await expect(assertPreviewDatabase(t.db, MIGRATIONS_DIR)).rejects.toThrow('the preview database is not stamped local: a preview never uses a staging or production database.')
    })

  it('refuses an unmigrated or half-migrated database, and never migrates it', async () => {
    await expect(assertPreviewDatabase(t.db, MIGRATIONS_DIR)).rejects.toThrow(/not fully migrated \(pending\)/)
    expect(await t.tables()).toEqual([])
    // One more migration shipped than this database has: still pending.
    await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })
    await expect(assertPreviewDatabase(t.db, await t.migrationsPlus(['SELECT 1']))).rejects.toThrow(/not fully migrated/)
  })

  it('refuses an unreachable database within its deadline', async () => {
    const nowhere = createPool('postgres://nobody@127.0.0.1:1/nothing_test', silentLogger)
    try {
      await expect(assertPreviewDatabase(nowhere, MIGRATIONS_DIR, 2_000)).rejects.toThrow('the preview database is unreachable.')
    } finally {
      await nowhere.end()
    }
  })
})
