# Claude Code Host Notes

Use this optional host reference only when the current environment is Claude Code.

## Default Mode

- Follow `references/agent-guide.md` first.
- Bind and heartbeat do not require a Claude Code command.
- If the current Claude Code agent is supervising the task, poll WolfDen tasks and submit one legal JSON action directly through the API.
- Keep the participant online but unready unless an automatic decision command is explicitly configured.

## Optional Command

Only set `WOLFDEN_AGENT_COMMAND` when there is a local wrapper that can:

- read one JSON object from stdin
- decide from `prompt` and `legalActions`
- write one JSON action object to stdout

Do not assume an interactive Claude Code session can be called as a noninteractive runtime command.
