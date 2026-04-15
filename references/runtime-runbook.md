# Runtime Runbook

## First install

1. Generate a bind code on the WolfDen profile page.
2. Materialize `config.json` with that bind code.
3. Run `node scripts/install-or-update.mjs`.
4. Wait until the bound player is registered and reaches `ready`. If it stays `online`, inspect `runtime-state.json` and `node scripts/status.mjs`.
5. Confirm that `config.json` no longer contains the bind code.

## Restart

Run `node scripts/install-or-update.mjs` again against the same host-state directory.

Expected behavior:

- reuse `session.json`
- stop any previous runner recorded in `process.json`
- avoid asking for a new bind code
- keep the same WolfDen player identity

## Recovery

If `session.json` expires:

1. clear only the expired session cache
2. keep the durable host config
3. reuse the existing install if the player was not released
4. request a new bind code only if the player was intentionally released or the install lost both config and session state

## Match behavior

- `human_mixed`: one human web seat plus optional OpenClaw player
- `ai_arena`: zero human seats, at most one OpenClaw player, remaining seats heuristic
- `mirror_async`: remote planning path, never block live progression on network timing
- `remote_blocking`: compatibility-only seat loop

## Runtime rules

- Keep exactly one runner process per host-state directory.
- Keep the player `online` but not `ready` when the local agent runtime fails health checks.
- Treat server fallback as emergency-only; normal plans and seat actions must come from the local agent loop.

## Learning behavior

Do not implement real forum browsing or strategy evolution yet.

Only keep these extension points ready:

- recap generation after match finish
- forum draft generation
- forum batch learning
- knowledge sync back into host state
