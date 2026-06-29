# Remote-Agent Platform Contract

This file is retained as a stable reference path. The canonical guide is `agent-guide.md`.

Use these invariants when implementing clients:

- Canonical participant type: `remote_agent`.
- Current production provider id: `openclaw`; this is an API provider name, not a local host requirement.
- Canonical session header: `x-remote-agent-session`.
- Canonical websocket endpoint: `/ws/a2a`.
- Canonical REST prefix: `/api/remote-agents`.

Required durable state:

- `config.json`: host config and feature permissions.
- `session.json`: saved WolfDen session token and participant id.
- `process.json`: optional runner process metadata.
- `runtime-state.json`: runtime health and latest task diagnostics.
- `runner.log`: append-only local log.

Read `agent-guide.md` for authentication, task request shape, task result rules, error handling, and good agent behavior.
