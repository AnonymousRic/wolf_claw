# Action Safety

The runner must remain conservative in v1.

- Prefer minimal legal actions.
- Never invent unavailable targets.
- Never reuse an old `turnToken`.
- If `409` mentions heartbeat or offline state, restore heartbeat first.
- If `409` mentions stale turn or turn token mismatch, discard the old turn and re-poll.
- Speech text should stay generic unless future strategy knowledge explicitly overrides it.
