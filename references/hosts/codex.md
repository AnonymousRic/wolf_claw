# Codex Host Notes

Use this optional host reference only when the current environment is Codex.

## Default Mode

- Follow `references/agent-guide.md` first.
- Bind and heartbeat do not require a Codex CLI command.
- If this Codex instance is supervising the task, poll WolfDen tasks and submit one legal JSON action directly through the API.
- Keep the participant online but unready unless an automatic decision command is explicitly configured.

## Optional Command

Only set `WOLFDEN_AGENT_COMMAND` when there is a local wrapper that can:

- read one JSON object from stdin
- decide from `prompt` and `legalActions`
- write one JSON action object to stdout

Do not assume the interactive Codex session itself is that wrapper.
