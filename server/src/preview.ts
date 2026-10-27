import { databaseStatus, type DatabaseStatus } from './db/migrations'
import type { Database } from './db/pool'

/**
 * HOSTED PREVIEW start-up checks (LOCAL_HOSTED_PREVIEW=true). Configuration has already refused every contradiction it
 * can see (`config.ts`); these need the database, and stop start-up rather than serve anything.
 *
 * The preview's database is stamped `local`, only because the local rehearsal's guarded writes exist nowhere else. That
 * stamp makes nothing safe to expose: the profile's own rules do, and they do not depend on it. This check is the other
 * direction: a database stamped for staging or production, or not migrated, is never served as a preview.
 */
export class PreviewStartupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PreviewStartupError'
  }
}

const PREVIEW_DB_CHECK_MS = 15_000

export async function assertPreviewDatabase(db: Database, migrationsDir: string, timeoutMs = PREVIEW_DB_CHECK_MS): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<DatabaseStatus>((resolve) => {
    timer = setTimeout(() => resolve({ database: 'unreachable', migrations: 'unknown', environment: 'unknown' }), timeoutMs)
  })
  let status: DatabaseStatus
  try {
    status = await Promise.race([databaseStatus(db, { dir: migrationsDir, environment: 'local' }), timedOut])
  } finally {
    clearTimeout(timer)
  }
  if (status.database !== 'ok') throw new PreviewStartupError('the preview database is unreachable.')
  if (status.migrations !== 'ok') throw new PreviewStartupError(`the preview database is not fully migrated (${status.migrations}); run npm run db:migrate first.`)
  if (status.environment !== 'ok') throw new PreviewStartupError('the preview database is not stamped local: a preview never uses a staging or production database.')
}
