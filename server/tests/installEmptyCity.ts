/**
 * TEST HELPER, run by e2e-server/serve.ts: install an EMPTY city (genesis state) into the
 * throwaway schema named by DATABASE_URL, for the empty-city browser tests.
 *
 * The operator's rehearsal installer only runs on staging. A local test server gets the
 * same thing through the store primitive that installer is built on: genesis state,
 * non-canonical, activation rehearsal. It refuses any database that is not a *_test one.
 */
import { initializeCity } from '../src/city/store'
import { createPool } from '../src/db/pool'
import { createGenesisState } from '../src/engine'
import { silentLogger } from '../src/log'

const url = process.env.DATABASE_URL ?? ''
if (!/^postgres(ql)?:\/\/[^/]+\/[^/?]*_test(\?|$)/.test(url)) throw new Error('installEmptyCity only runs against a disposable *_test database.')

const db = createPool(url, silentLogger)
try {
  const city = await initializeCity(db, { state: createGenesisState(), origin: 'demo-fixture', rehearsal: true, environment: 'local' })
  process.stdout.write(`${JSON.stringify({ message: 'EMPTY test city installed', instance: city.instance, sequence: city.sequence })}\n`)
} finally {
  await db.end()
}
