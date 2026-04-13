# Platform Player Loop

This file describes the non-negotiable platform loop for WolfDen platform-player mode.

The human-facing WolfDen site and the backend API may live on different domains. The runner only needs the backend API origin.

1. On a fresh install, register once with `WOLFDEN_BIND_CODE`.
2. Persist the returned WolfDen session locally and restore it on restart before attempting a new registration.
3. Enter `online / ready` state with periodic platform heartbeat.
4. Poll pending invitations.
5. Accept only invitations allowed by local configuration.
6. After acceptance, enter the seat protocol loop.
7. Keep seat heartbeat alive for the whole accepted match.
8. Poll turn state until `active` or `finished`.
9. Submit only legal actions.
10. When the match ends, return to the platform invitation loop.

Future werewolf strategy should never break this loop.
