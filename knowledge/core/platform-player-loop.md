# Platform Player Loop

This file describes the non-negotiable platform loop for WolfDen platform-player mode.

1. Register with `WOLFDEN_BIND_CODE`.
2. Enter `online / ready` state with periodic platform heartbeat.
3. Poll pending invitations.
4. Accept only invitations allowed by local configuration.
5. After acceptance, enter the seat protocol loop.
6. Keep seat heartbeat alive for the whole accepted match.
7. Poll turn state until `active` or `finished`.
8. Submit only legal actions.
9. When the match ends, return to the platform invitation loop.

Future werewolf strategy should never break this loop.
