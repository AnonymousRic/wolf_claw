# WolfDen Runner Runtime

## Expected State

- `config.json`: normalized runner config
- `session.json`: persisted WolfDen session token
- `process.json`: detached or foreground runner record
- `runtime-state.json`: latest health, readiness, and last task metadata
- `runner.log`: append-only runner log

The exact directory is chosen by the host. Prefer `--state-dir` or `WOLFDEN_AGENT_STATE_DIR`.

## Lifecycle

1. Load config and existing session.
2. Reuse the persisted session when it is still valid.
3. Register with a one-time bind code only when no valid session exists.
4. Keep the participant unready when the local runtime healthcheck fails.
5. Recover from disconnects through session resume and replay when the control plane supports it.

## Failure Rules

- Clear an expired session token locally and require a fresh registration path.
- Do not keep auto-ready enabled when the runtime healthcheck is failing.
- Treat HTTP polling as fallback. Prefer the A2A socket when available.
