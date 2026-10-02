/**
 * The server's single doorway into the shared deterministic engine (`src/game`, `src/config`).
 *
 * Everything the service reuses from the client codebase is re-exported here, so the
 * surface the server depends on stays visible in one place and is type-checked without
 * DOM types. Demo fixtures (the seed city, the demo player, demo-only commands) are
 * off limits here, and lint enforces it: a server authority never applies them.
 */
export { applyCityCommand, type CityCommand } from '../../src/game/commands'
export type { ActionResult, GameEvent, GameState } from '../../src/game/types'
