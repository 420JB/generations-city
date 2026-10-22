import pg from 'pg'

/**
 * TIME TRAVEL for the claim-experience browser tests, exactly as the server's own tests do it (`leaveOnly` in
 * server/tests/ticketHarness.ts): the claim window is a fixed 900 seconds by the database's clock (policy D2), so rather
 * than wait, a test moves a player's OPEN claim window, and every ticket issued in it, back by the same amount so that
 * exactly `seconds` remain (negative: it ran out that long ago). Done past the guards (replica role) in the DISPOSABLE
 * database the tests run against (CITY_PLAY_DATABASE_URL, a `*_test` database); the window stays exactly 900 seconds long,
 * and every check of the server and the database still reads the database's clock. The page is never told: it must find
 * out from the server.
 */
export async function leaveOnly(worldId: string, discordUserId: string, seconds: number): Promise<void> {
  const url = process.env.CITY_PLAY_DATABASE_URL ?? ''
  if (!/^postgres(ql)?:\/\/[^/]+\/[^/?]*_test(\?|$)/.test(url)) throw new Error('CITY_PLAY_DATABASE_URL must name a disposable *_test database')
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL session_replication_role = 'replica'`)
    const moved = await client.query(
      `WITH w AS (SELECT id, expires_at - (clock_timestamp() + make_interval(secs => $3::double precision)) AS d FROM world_claim_windows WHERE world_id = $1 AND actor_discord_user_id = $2 AND closed_at IS NULL),
            moved AS (UPDATE world_claim_windows c SET opened_at = c.opened_at - w.d, expires_at = c.expires_at - w.d FROM w WHERE c.id = w.id RETURNING c.id)
       UPDATE world_district_tickets t SET issued_at = t.issued_at - w.d, expires_at = t.expires_at - w.d FROM w WHERE t.claim_window = w.id`,
      [worldId, discordUserId, seconds],
    )
    if (!moved.rowCount) throw new Error('no open claim window to move')
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    await client.end()
  }
}
