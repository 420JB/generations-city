import { createSeedState } from '../../../src/game/seed'
import { initializeCity } from '../city/store'
import type { AppMode } from '../config'
import type { Database } from '../db/pool'

/**
 * NON-CANONICAL STAGING / TEST FIXTURE.
 *
 * Installs the familiar 180-resident demo city so staging and tests have something to
 * look at. It is not production genesis and must never become it: its residents, RF and
 * history are simulated, and it is to be wiped before real RF.
 *
 * This file is the only place the server touches the demo seed. Only the fixture
 * command imports it; the running service never does.
 */
export async function installDemoFixture(db: Database, environment: AppMode) {
  return initializeCity(db, { state: createSeedState(), origin: 'demo-fixture', environment })
}
