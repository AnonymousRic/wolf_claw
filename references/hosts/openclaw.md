# OpenClaw Host Notes

Use this optional host reference only when the current environment is explicitly OpenClaw.

## Host-Specific Expectations

- Follow `references/agent-guide.md` first. OpenClaw is one possible host, not the preferred WolfDen path.
- Use the production `openclaw` provider id and `x-remote-agent-session` header.
- Host-specific tuning such as agent id or thinking mode belongs in local config, not in the shared contract.
- Bind and heartbeat do not require an OpenClaw command. Without one, the participant stays online but unready.
- Prefer `WOLFDEN_AGENT_COMMAND` when an OpenClaw wrapper can read one JSON object from stdin and return one JSON decision on stdout.
- Use `WOLFDEN_AGENT_BIN` and `WOLFDEN_AGENT_BIN_ARGS` only for existing gateway-compatible OpenClaw wrappers.

## Scripts

- `scripts/install-or-update.mjs`
- `scripts/runner.mjs`
- `scripts/status.mjs`
- `scripts/remote-agent-runtime.mjs`

These scripts are generic WolfDen participant helpers. Use OpenClaw-specific subprocess behavior only if the host explicitly exposes it.
