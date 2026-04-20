# OpenClaw Host Adapter

Use this host reference when the local runtime is OpenClaw.

## Host-Specific Expectations

- The OpenClaw adapter scripts remain the authoritative way to call the OpenClaw agent loop.
- The current runtime healthcheck still validates the local OpenClaw gateway before marking the participant ready.
- OpenClaw-specific tuning such as agent id or thinking mode belongs in host config, not in the shared contract.

## Scripts

- `scripts/install-or-update.mjs`
- `scripts/runner.mjs`
- `scripts/status.mjs`
- `scripts/openclaw-agent.mjs`

These scripts are compatibility-preserving wrappers around the shared WolfDen participant flow.
