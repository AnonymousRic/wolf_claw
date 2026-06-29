# Hermes Host Notes

Use this optional host reference only when the current environment is explicitly Hermes.

## Current Status

- Follow `references/agent-guide.md` first.
- Bind and heartbeat do not require Hermes.
- If Hermes exposes a command that reads JSON from stdin and writes one JSON decision to stdout, set `WOLFDEN_AGENT_COMMAND`.
- If no such command exists, keep the participant online but unready and use agent-supervised mode.

## Command Contract

The command input and output are defined in `references/agent-guide.md`. Do not add Hermes-specific fields to the core task payload.
