# Rare City on a local Proofy Play

The Proofy Play launch page (`proofy-city-play/`) is Rare City's registered launch URL. Play
sends a player there with a run token in the fragment (`#runToken=…`). The page posts it to
the Rare City server (`POST /v1/play/session`), which redeems it with Play using Rare City's
service credential, loads the configuration version the run was pinned to, checks it against
the run (installation, server, version, hash), validates it, and returns it. The page draws it
with the standard renderer. The browser never names an installation.

Proofy Core's context-token issuer is not deployed, so locally Core is stood in for by Play's
own dev issuer key. Everything else is the real Play service and contract (1.1.0).

## 1. A local Proofy Play (outside this repository)

Use a copy, not the Play checkout itself (building writes into the tree). Node 24.

```sh
git -C ~/workspace/proofy-play-catalog archive HEAD | tar -x -C /path/to/play-copy
cd /path/to/play-copy && npm ci && npm run build
npm run -s dev:keys -w @proofy/play-api > play.env      # then point DATABASE_URL at a disposable Postgres
echo PORT=18090 >> play.env; echo HOST=127.0.0.1 >> play.env
set -a; . ./play.env; set +a
npm run db:migrate && node apps/api/dist/server.js
```

## 2. Environment for Rare City's side

From `play.env`:

```sh
export PLAY_API_URL=http://127.0.0.1:18090
export PLAY_DEV_OPERATOR_KEY=$DEV_OPERATOR_KEY
export PLAY_DEV_CORE_ISSUER_PRIVATE_KEY=$DEV_CORE_ISSUER_PRIVATE_KEY
export PLAY_DEV_CORE_ISSUER_KEY_ID=$DEV_CORE_ISSUER_KEY_ID
```

## 3. Run it

Browser tests (they start everything below themselves):

```sh
npm run test:e2e:city-play
```

By hand:

```sh
node_modules/.bin/tsx e2e-city-play/serve.ts     # registers the game, mints a credential, registers the schema, starts the server on :4351
npm run dev:city-play                            # the launch page on http://localhost:4352/
```

Then install Rare City on a Discord server, publish a configuration and launch, with the
helpers in `play.ts` (`install`, `publish`, `launch`, `launchHref`), and open the printed
`http://localhost:4352/#runToken=…`. Each launch opens once; launch again for a new one.

## For a deployment

The server reads `PLAY_API_URL`, `PLAY_SERVICE_CREDENTIAL` and optionally `PLAY_GAME_KEY`
(default `rare-city`). The credential's Play environment must match `APP_MODE`
(local → dev/test, staging → staging, production → live). Register the schema once per Play
environment with `npm run play:register-schema`.
