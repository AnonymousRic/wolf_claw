import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_AGENT_NAME,
  DEFAULT_ALLOWED_MATCH_MODES,
  DEFAULT_CAPABILITIES,
  DEFAULT_FEATURE_FLAGS,
  DEFAULT_AGENT_RUNTIME_ID,
  DEFAULT_AGENT_THINKING,
  DEFAULT_PLATFORM_PROVIDER_ID,
  DEFAULT_PLATFORM_HEARTBEAT_INTERVAL_MS,
  DEFAULT_PLATFORM_POLL_MS,
  DEFAULT_TURN_POLL_MS,
  HttpError,
  clearBindCodeFromConfig,
  clearSession,
  createLogger,
  ensureHostStateDir,
  getNumberEnv,
  loadRuntimeState,
  loadSession,
  loadSkillConfig,
  normalizeBaseUrl,
  normalizePlatformPlayer,
  parseArgs,
  PLATFORM_PROVIDER_PATH,
  PLATFORM_PROVIDER_QUERY,
  PLATFORM_SESSION_HEADER,
  requestJson,
  resolveRunnerPaths,
  saveRuntimeState,
  saveSession,
  sleep,
} from './common.mjs';
import {
  buildMirrorPlanFromRemoteAgent,
  buildSeatActionFromRemoteAgent,
  checkRemoteAgentRuntimeHealth,
} from './remote-agent-runtime.mjs';

async function readTextResource(relativePath) {
  const resourceUrl = new URL(relativePath, import.meta.url);
  if (resourceUrl.protocol === 'file:') {
    return readFile(resourceUrl, 'utf8');
  }

  const response = await fetch(resourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to load resource ${resourceUrl.href}: ${response.status}`);
  }
  return response.text();
}

async function readJsonResource(relativePath) {
  return JSON.parse(await readTextResource(relativePath));
}

async function loadReferenceBundle() {
  const manifest = await readJsonResource('../references/manifest.json');

  const coreDocuments = await Promise.all(
    manifest.coreFiles.map(async (referencePath) => ({
      path: referencePath,
      content: await readTextResource(`../references/${referencePath}`),
    })),
  );

  const roleDocuments = Object.fromEntries(await Promise.all(
    Object.entries(manifest.roleFiles).map(async ([role, referencePath]) => [
      role,
      {
        path: referencePath,
        content: await readTextResource(`../references/${referencePath}`),
      },
    ]),
  ));

  const phaseDocuments = Object.fromEntries(await Promise.all(
    Object.entries(manifest.phaseFiles).map(async ([phase, referencePath]) => [
      phase,
      {
        path: referencePath,
        content: await readTextResource(`../references/${referencePath}`),
      },
    ]),
  ));

  return {
    manifest,
    coreDocuments,
    roleDocuments,
    phaseDocuments,
  };
}

async function heartbeatSeat(apiBaseUrl, seatToken) {
  return requestJson(apiBaseUrl, '/api/agents/heartbeat', {
    method: 'POST',
    body: { seatToken },
  });
}

async function getSeatTurn(apiBaseUrl, seatId, seatToken) {
  return requestJson(apiBaseUrl, `/api/agent-seats/${seatId}/turn`, {
    headers: { 'x-seat-token': seatToken },
  });
}

async function submitSeatAction(apiBaseUrl, seatId, payload) {
  return requestJson(apiBaseUrl, `/api/agent-seats/${seatId}/actions`, {
    method: 'POST',
    body: payload,
  });
}

async function getRoom(apiBaseUrl, roomId) {
  return requestJson(apiBaseUrl, `/api/rooms/${roomId}`);
}

async function updatePlatformPreferences(apiBaseUrl, remoteAgentParticipantId, preferences) {
  return requestJson(apiBaseUrl, `/api/remote-agents/participants/${remoteAgentParticipantId}/preferences?${PLATFORM_PROVIDER_QUERY}`, {
    method: 'PATCH',
    body: preferences,
  });
}

async function getCapabilities(apiBaseUrl) {
  try {
    return await requestJson(apiBaseUrl, `/api/remote-agents/capabilities?${PLATFORM_PROVIDER_QUERY}`);
  } catch {
    return { ...DEFAULT_CAPABILITIES };
  }
}

function buildA2ASocketUrl(apiBaseUrl) {
  const url = new URL(normalizeBaseUrl(apiBaseUrl));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws/a2a';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function isDecisionCheckpointStatus(status) {
  return status === 'actionable' || status === 'waiting_remote';
}

export function extractActionableCheckpointFromRoom(room) {
  const sync = room?.remoteAgentSync;
  if (!sync || sync.requiresDecision !== true || !sync.checkpointId || !sync.fingerprint || !sync.matchId) {
    return null;
  }
  if (!isDecisionCheckpointStatus(sync.checkpointStatus ?? 'actionable')) {
    return null;
  }
  return {
    matchId: sync.matchId,
    checkpointId: sync.checkpointId,
    fingerprint: sync.fingerprint,
    phase: sync.phase ?? room?.phase ?? null,
  };
}

export function extractActionableCheckpointFromSnapshot(snapshot) {
  const telemetry = snapshot?.remoteAgentTelemetry;
  if (!telemetry?.currentCheckpointId || !telemetry?.currentFingerprint) {
    return null;
  }
  const checkpointStatus = telemetry.checkpointStatus ?? telemetry.currentStatus ?? 'idle';
  if (!isDecisionCheckpointStatus(checkpointStatus)) {
    return null;
  }
  return {
    matchId: snapshot.matchId,
    checkpointId: telemetry.currentCheckpointId,
    fingerprint: telemetry.currentFingerprint,
    phase: snapshot.phase ?? null,
  };
}

function createA2ASessionSubscription({
  apiBaseUrl,
  sessionToken,
  participantId,
  logger,
  onInvitation,
  onInvitationCancelled,
  onTaskOpen,
  onTaskCancel,
}) {
  if (typeof WebSocket !== 'function') {
    return {
      close() {},
    };
  }

  let socket = null;
  let reconnectTimer = null;
  let closed = false;
  let resumeToken = null;

  const send = (payload) => {
    try {
      socket?.send(JSON.stringify(payload));
    } catch {
      // Reconnect handling is owned by the websocket close/error handlers.
    }
  };

  const connect = () => {
    if (closed) {
      return;
    }

    try {
      socket = new WebSocket(buildA2ASocketUrl(apiBaseUrl));
    } catch (error) {
      void logger.warn('Failed to open WolfDen A2A websocket subscription.', {
        message: error instanceof Error ? error.message : String(error),
      });
      reconnectTimer = setTimeout(connect, 1000);
      return;
    }

    socket.addEventListener('open', () => {
      send(resumeToken
        ? {
            type: 'session.resume',
            resumeToken,
          }
        : {
            type: 'session.connect',
            providerId: DEFAULT_PLATFORM_PROVIDER_ID,
            sessionToken,
            participantId,
          });
    });

    socket.addEventListener('message', (event) => {
      void (async () => {
        let seq = null;
        try {
          const message = JSON.parse(String(event.data ?? ''));
          seq = Number.isInteger(message?.seq) ? message.seq : null;
          switch (message?.type) {
            case 'session.welcome':
              resumeToken = typeof message.resumeToken === 'string' ? message.resumeToken : resumeToken;
              await logger.info('WolfDen A2A session connected.', {
                participantId: message.participantId ?? participantId,
              });
              break;
            case 'invite.pending':
              onInvitation?.(message.invitation);
              break;
            case 'invite.cancelled':
              onInvitationCancelled?.(message.inviteId);
              break;
            case 'task.open':
              onTaskOpen?.(message.task);
              break;
            case 'task.cancel':
              onTaskCancel?.(message);
              break;
            case 'node.state':
            case 'task.status':
            case 'session.resync':
              break;
            case 'error':
              await logger.warn('WolfDen A2A websocket returned an error.', {
                message: typeof message.message === 'string' ? message.message : 'unknown',
              });
              break;
            default:
              await logger.warn('Ignoring unknown WolfDen A2A websocket payload.', {
                type: message?.type ?? null,
              });
          }
        } catch (error) {
          await logger.warn('Failed to parse WolfDen A2A websocket payload.', {
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          if (seq !== null) {
            send({
              type: 'ack',
              seq,
            });
          }
        }
      })();
    });

    socket.addEventListener('close', () => {
      if (closed) {
        return;
      }
      reconnectTimer = setTimeout(connect, 1000);
    });

    socket.addEventListener('error', () => {
      try {
        socket?.close();
      } catch {
        // Ignore the close failure and let the reconnect timer handle recovery.
      }
    });
  };

  connect();

  return {
    close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      try {
        socket?.close();
      } catch {
        // Ignore close errors during shutdown.
      }
    },
  };
}

async function getMirrorPlanRequest(apiBaseUrl, matchId, sessionToken) {
  return requestJson(apiBaseUrl, `/api/remote-agents/matches/${matchId}/task-request?${PLATFORM_PROVIDER_QUERY}`, {
    headers: { [PLATFORM_SESSION_HEADER]: sessionToken },
  });
}

async function submitMirrorPlan(apiBaseUrl, matchId, sessionToken, payload) {
  return requestJson(apiBaseUrl, `/api/remote-agents/matches/${matchId}/task-result?${PLATFORM_PROVIDER_QUERY}`, {
    method: 'POST',
    headers: { [PLATFORM_SESSION_HEADER]: sessionToken },
    body: payload,
  });
}

async function heartbeatPlatformSession(apiBaseUrl, sessionToken, ready) {
  return requestJson(apiBaseUrl, `/api/remote-agents/providers/${PLATFORM_PROVIDER_PATH}/heartbeat`, {
    method: 'POST',
    body: {
      sessionToken,
      ready,
    },
  });
}

function buildPlatformPreferences(playerPreferences, config) {
  return {
    ...playerPreferences,
    enabled: true,
    autoAcceptEnabled: config.autoAccept,
    allowedMatchModes: config.allowedMatchModes,
    allowForumAutopost: Boolean(config.featureFlags.allowForumAutopost),
    allowForumLearning: Boolean(config.featureFlags.allowForumLearning),
    allowKnowledgeSync: Boolean(config.featureFlags.allowKnowledgeSync),
  };
}

async function restorePersistedPlatformSession(config, paths, logger, ready = false) {
  const persistedSession = await loadSession(paths.sessionPath);
  if (!persistedSession) {
    return null;
  }

  if (persistedSession.apiBaseUrl !== config.apiBaseUrl) {
    await logger.warn('Ignoring saved session from a different WolfDen API origin.', {
      savedApiBaseUrl: persistedSession.apiBaseUrl,
      currentApiBaseUrl: config.apiBaseUrl,
    });
    return null;
  }

  try {
    const heartbeat = await heartbeatPlatformSession(config.apiBaseUrl, persistedSession.sessionToken, ready);
    const player = normalizePlatformPlayer(heartbeat.player);
    if (!player) {
      throw new Error('WolfDen platform heartbeat returned a player without a participant id.');
    }

    await saveSession(paths.sessionPath, {
      apiBaseUrl: config.apiBaseUrl,
      remoteAgentParticipantId: player.remoteAgentParticipantId,
      sessionToken: persistedSession.sessionToken,
      agentName: player.agentName ?? persistedSession.agentName ?? config.agentName,
    });

    return {
      restored: true,
      sessionToken: persistedSession.sessionToken,
      heartbeatIntervalMs: DEFAULT_PLATFORM_HEARTBEAT_INTERVAL_MS,
      player,
      invitations: heartbeat.invitations,
    };
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 401) {
      await logger.warn('Saved WolfDen session expired. Clearing local session cache.');
      await clearSession(paths.sessionPath);
      return null;
    }
    throw error;
  }
}

async function registerPlatformSession(config, paths, logger, ready = false) {
  if (!config.bindCode) {
    throw new Error(
      'No saved WolfDen session was found. Use a fresh bind code only when this remote agent installation has not been bound before or was intentionally released.',
    );
  }

  const registration = await requestJson(config.apiBaseUrl, `/api/remote-agents/providers/${PLATFORM_PROVIDER_PATH}/register`, {
    method: 'POST',
    body: {
      bindCode: config.bindCode,
      agentName: config.agentName,
      displayName: config.agentName,
      autoReady: ready,
    },
  });
  const player = normalizePlatformPlayer(registration.player);
  if (!player) {
    throw new Error('WolfDen platform registration returned a player without a participant id.');
  }

  await saveSession(paths.sessionPath, {
    apiBaseUrl: config.apiBaseUrl,
    remoteAgentParticipantId: player.remoteAgentParticipantId,
    sessionToken: registration.sessionToken,
    agentName: player.agentName ?? config.agentName,
  });
  await clearBindCodeFromConfig(paths.configPath);
  await logger.info('Registered WolfDen platform session and cleared the one-time bind code from host config.', {
    remoteAgentParticipantId: player.remoteAgentParticipantId,
  });

  return {
    ...registration,
    player,
    restored: false,
  };
}

function computeActivePollMs(config, deadlineMs) {
  if (Number.isFinite(deadlineMs) && deadlineMs > 0) {
    return Math.max(25, Math.min(100, Math.ceil(deadlineMs / 4)));
  }
  return Math.min(config.platformPollMs, 100);
}

function isRuntimeTransportFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('timed out')
    || message.includes('gateway call failed')
    || message.includes('ENOENT')
    || message.includes('spawn');
}

async function maybeRunDeferredLearningHooks({
  capabilities,
  config,
  logger,
  room,
}) {
  if (room.status !== 'finished') {
    return;
  }

  if (capabilities.forumAutopost && config.featureFlags.allowForumAutopost) {
    await logger.info('Forum autopost capability is enabled, but the current build only keeps the placeholder hook.');
  }
  if (capabilities.forumLearning && config.featureFlags.allowForumLearning) {
    await logger.info('Forum learning capability is enabled, but the current build only keeps the placeholder hook.');
  }
  if (capabilities.knowledgeSync && config.featureFlags.allowKnowledgeSync) {
    await logger.info('Knowledge sync capability is enabled, but the current build only keeps the placeholder hook.');
  }
}

export async function refreshMirrorAsyncPlan({
  config,
  sessionToken,
  remoteAgentParticipantId,
  matchId,
  referenceBundle,
  planCache,
  inFlightPlans,
  latestCheckpoints,
  logger,
  updateRuntimeState,
  deps = {
    getMirrorPlanRequest,
    buildMirrorPlanFromRemoteAgent,
    submitMirrorPlan,
  },
}) {
  let planRequest;
  try {
    planRequest = await deps.getMirrorPlanRequest(config.apiBaseUrl, matchId, sessionToken);
  } catch (error) {
    if (error instanceof HttpError && (error.statusCode === 404 || error.statusCode === 409)) {
      return computeActivePollMs(config, null);
    }
    throw error;
  }

  const nextPollMs = computeActivePollMs(config, planRequest?.deadlineMs ?? null);
  if (!planRequest || !Array.isArray(planRequest.legalActions) || planRequest.legalActions.length === 0) {
    return nextPollMs;
  }

  const cacheKey = `${matchId}:${planRequest.playerId}`;
  const checkpointRef = {
    checkpointId: planRequest.requestId,
    fingerprint: planRequest.fingerprint,
  };
  latestCheckpoints?.set(matchId, checkpointRef);
  if (planCache.get(cacheKey) === planRequest.fingerprint) {
    return nextPollMs;
  }
  const inFlightKey = `${cacheKey}:${planRequest.requestId}`;
  if (inFlightPlans.has(inFlightKey)) {
    return nextPollMs;
  }

  const startedAt = Date.now();
  inFlightPlans.add(inFlightKey);
  let remotePlan = null;
  try {
    remotePlan = await deps.buildMirrorPlanFromRemoteAgent({
      config,
      remoteAgentParticipantId,
      planRequest,
      referenceBundle,
    });
    const latestCheckpoint = latestCheckpoints?.get(matchId);
    if (
      latestCheckpoint
      && (
        latestCheckpoint.checkpointId !== checkpointRef.checkpointId
        || latestCheckpoint.fingerprint !== checkpointRef.fingerprint
      )
    ) {
      await logger.info('Discarded stale remote agent mirror_async plan before submit.', {
        matchId,
        phase: planRequest.phase,
        discardedCheckpointId: checkpointRef.checkpointId,
        latestCheckpointId: latestCheckpoint.checkpointId,
      });
      return nextPollMs;
    }

    const submitted = await deps.submitMirrorPlan(config.apiBaseUrl, matchId, sessionToken, remotePlan.payload);
    planCache.set(cacheKey, submitted.fingerprint);
    await updateRuntimeState({
      remoteAgentRuntimeHealthy: true,
      ready: config.autoReady,
      lastRunAt: new Date().toISOString(),
      lastRunLatencyMs: remotePlan.latencyMs,
      lastPlanSource: 'remote-agent',
      lastFailureReason: null,
      lastMatchId: matchId,
      lastPhase: planRequest.phase,
      lastActionType: remotePlan.payload.actionType,
      lastRequestId: remotePlan.requestId ?? planRequest.requestId,
      lastFingerprint: remotePlan.fingerprint ?? planRequest.fingerprint,
      lastDeadlineMs: remotePlan.deadlineMs ?? planRequest.deadlineMs ?? null,
      lastPromptChars: remotePlan.promptChars ?? null,
      lastTimeoutSeconds: remotePlan.timeoutSeconds ?? null,
    }, true);
    await logger.info('Submitted remote remote agent mirror_async plan.', {
      matchId,
      playerId: planRequest.playerId,
      phase: planRequest.phase,
      requestId: remotePlan.requestId ?? planRequest.requestId,
      fingerprint: submitted.fingerprint,
      remoteAgentLatencyMs: remotePlan.latencyMs,
      promptChars: remotePlan.promptChars ?? null,
      timeoutSeconds: remotePlan.timeoutSeconds ?? null,
    });
  } catch (error) {
    planCache.delete(cacheKey);
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof HttpError && error.statusCode === 409) {
      await logger.info('remote agent mirror_async plan was superseded before submission.', {
        matchId,
        phase: planRequest.phase,
        message,
      });
      return nextPollMs;
    }
    const lastPlanSource = message.includes('timed out') ? 'timeout' : 'invalid-remote-response';
    const runtimeHealthy = !isRuntimeTransportFailure(error) && lastPlanSource !== 'timeout';
    await updateRuntimeState({
      remoteAgentRuntimeHealthy: runtimeHealthy,
      ready: runtimeHealthy && config.autoReady,
      lastRunAt: new Date().toISOString(),
      lastRunLatencyMs: Date.now() - startedAt,
      lastPlanSource,
      lastFailureReason: message,
      lastMatchId: matchId,
      lastPhase: planRequest.phase,
      lastActionType: null,
      lastRequestId: remotePlan?.requestId ?? planRequest.requestId,
      lastFingerprint: remotePlan?.fingerprint ?? planRequest.fingerprint,
      lastDeadlineMs: remotePlan?.deadlineMs ?? planRequest.deadlineMs ?? null,
      lastPromptChars: remotePlan?.promptChars ?? null,
      lastTimeoutSeconds: remotePlan?.timeoutSeconds ?? null,
    }, true);
    await logger.warn('remote agent mirror_async planning failed. The server may fall back locally.', {
      matchId,
      phase: planRequest.phase,
      requestId: remotePlan?.requestId ?? planRequest.requestId,
      fingerprint: remotePlan?.fingerprint ?? planRequest.fingerprint,
      promptChars: remotePlan?.promptChars ?? null,
      timeoutSeconds: remotePlan?.timeoutSeconds ?? null,
      message,
    });
  } finally {
    inFlightPlans.delete(inFlightKey);
  }

  return nextPollMs;
}

async function playAcceptedInvitation(
  config,
  invitation,
  seatToken,
  heartbeatIntervalMs,
  referenceBundle,
  capabilities,
  sessionToken,
  remoteAgentParticipantId,
  logger,
  updateRuntimeState,
  executionMode = 'remote_blocking',
  a2aState = null,
) {
  const seatId = invitation.seatId;
  const planCache = new Map();
  const inFlightPlans = new Set();
  const latestCheckpoints = new Map();
  let stopped = false;

  const heartbeatLoop = (async () => {
    while (!stopped) {
      try {
        await heartbeatSeat(config.apiBaseUrl, seatToken);
      } catch (error) {
        await logger.warn('Seat heartbeat failed.', {
          roomId: invitation.roomId,
          seatId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      await sleep(heartbeatIntervalMs);
    }
  })();

  await logger.info('Accepted WolfDen invitation.', {
    roomId: invitation.roomId,
    seatId,
    executionMode,
    matchMode: invitation.matchMode,
  });

  try {
    await heartbeatSeat(config.apiBaseUrl, seatToken);

    if (executionMode === 'mirror_async') {
      let activeMatchId = null;
      const requestMirrorPlan = async (matchId) => refreshMirrorAsyncPlan({
        config,
        sessionToken,
        remoteAgentParticipantId,
        matchId,
        referenceBundle,
        planCache,
        inFlightPlans,
        latestCheckpoints,
        logger,
        updateRuntimeState,
      });

      while (true) {
        const room = await getRoom(config.apiBaseUrl, invitation.roomId);
        if (room.status === 'finished') {
          if (room.matchId) {
            a2aState?.tasks?.delete(room.matchId);
            latestCheckpoints.delete(room.matchId);
          }
          await logger.info('mirror_async room finished.', {
            roomId: invitation.roomId,
            matchId: room.matchId ?? null,
          });
          await maybeRunDeferredLearningHooks({
            capabilities,
            config,
            logger,
            room,
          });
          break;
        }

        if (room.matchId && room.matchId !== activeMatchId) {
          activeMatchId = room.matchId;
        }

        let pollMs = config.platformPollMs;
        const pushedTask = room.matchId ? a2aState?.tasks?.get(room.matchId) : null;
        if (room.matchId && pushedTask) {
          latestCheckpoints.set(room.matchId, {
            checkpointId: pushedTask.requestId,
            fingerprint: pushedTask.fingerprint,
          });
          pollMs = await requestMirrorPlan(room.matchId);
        } else {
          const roomCheckpoint = extractActionableCheckpointFromRoom(room);
          if (room.matchId && roomCheckpoint) {
            latestCheckpoints.set(room.matchId, roomCheckpoint);
            pollMs = await requestMirrorPlan(room.matchId);
          }
        }

        await sleep(room.matchId ? pollMs : config.platformPollMs);
      }
      return;
    }

    while (true) {
      const turn = await getSeatTurn(config.apiBaseUrl, seatId, seatToken);

      if (turn.status === 'finished') {
        await logger.info('remote_blocking room finished.', {
          roomId: invitation.roomId,
          matchId: turn.matchId,
        });
        break;
      }

      if (turn.status !== 'active') {
        await sleep(config.turnPollMs);
        continue;
      }

      try {
        const remoteAction = await buildSeatActionFromRemoteAgent({
          config,
          remoteAgentParticipantId,
          turn,
          referenceBundle,
        });
        await submitSeatAction(config.apiBaseUrl, seatId, {
          seatToken,
          turnToken: turn.turnToken,
          ...remoteAction.action,
        });
        await updateRuntimeState({
          remoteAgentRuntimeHealthy: true,
          ready: config.autoReady,
          lastRunAt: new Date().toISOString(),
          lastRunLatencyMs: remoteAction.latencyMs,
          lastPlanSource: 'remote-agent',
          lastFailureReason: null,
          lastMatchId: turn.matchId,
          lastPhase: turn.phase,
          lastActionType: remoteAction.action.actionType,
        }, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const runtimeHealthy = !isRuntimeTransportFailure(error) && !message.includes('timed out');
        await updateRuntimeState({
          remoteAgentRuntimeHealthy: runtimeHealthy,
          ready: runtimeHealthy && config.autoReady,
          lastRunAt: new Date().toISOString(),
          lastRunLatencyMs: null,
          lastPlanSource: message.includes('timed out') ? 'timeout' : 'invalid-remote-response',
          lastFailureReason: message,
          lastMatchId: turn.matchId,
          lastPhase: turn.phase,
          lastActionType: null,
        }, true);
        await logger.warn('remote_blocking remote agent action failed; retrying the same turn window.', {
          matchId: turn.matchId,
          phase: turn.phase,
          message,
        });
        await sleep(config.turnPollMs);
      }
    }
  } finally {
    stopped = true;
    await heartbeatLoop.catch(() => undefined);
  }
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveRunnerPaths(args.values.get('config') ?? process.env.WOLFDEN_CONFIG_PATH);
  await ensureHostStateDir(paths);
  const logger = createLogger(paths.logPath);
  const referenceBundle = await loadReferenceBundle();
  const loadedConfig = await loadSkillConfig(paths.configPath);
  const config = loadedConfig ? {
    ...loadedConfig,
    ...(process.env.WOLFDEN_AGENT_PLATFORM_API_BASE_URL ? { apiBaseUrl: process.env.WOLFDEN_AGENT_PLATFORM_API_BASE_URL } : {}),
    ...(process.env.WOLFDEN_API_BASE_URL ? { apiBaseUrl: process.env.WOLFDEN_API_BASE_URL } : {}),
    ...(process.env.WOLFDEN_AGENT_PLATFORM_SITE_URL ? { siteUrl: process.env.WOLFDEN_AGENT_PLATFORM_SITE_URL } : {}),
    ...(process.env.WOLFDEN_AGENT_NAME ? { agentName: process.env.WOLFDEN_AGENT_NAME } : {}),
    ...(process.env.WOLFDEN_AGENT_RUNTIME_ID ? { runtimeAgentId: process.env.WOLFDEN_AGENT_RUNTIME_ID } : {}),
    ...(process.env.WOLFDEN_AGENT_THINKING ? { runtimeThinking: process.env.WOLFDEN_AGENT_THINKING } : {}),
    ...(process.env.WOLFDEN_AGENT_TIMEOUT_SECONDS ? { runtimeTimeoutSeconds: Number(process.env.WOLFDEN_AGENT_TIMEOUT_SECONDS) } : {}),
  } : null;

  if (!config) {
    throw new Error(`Runner config not found: ${paths.configPath}`);
  }

  config.platformPollMs = getNumberEnv('WOLFDEN_PLATFORM_POLL_MS', DEFAULT_PLATFORM_POLL_MS);
  config.turnPollMs = getNumberEnv('WOLFDEN_TURN_POLL_MS', DEFAULT_TURN_POLL_MS);
  config.featureFlags = {
    ...DEFAULT_FEATURE_FLAGS,
    ...config.featureFlags,
  };
  if (!Array.isArray(config.allowedMatchModes) || config.allowedMatchModes.length === 0) {
    config.allowedMatchModes = [...DEFAULT_ALLOWED_MATCH_MODES];
  }
  config.apiBaseUrl = normalizeBaseUrl(config.apiBaseUrl);
  config.agentName = config.agentName || DEFAULT_AGENT_NAME;
  config.runtimeAgentId = config.runtimeAgentId || DEFAULT_AGENT_RUNTIME_ID;
  config.runtimeThinking = config.runtimeThinking || DEFAULT_AGENT_THINKING;

  const runtimeStateRef = {
    current: await saveRuntimeState(paths.runtimeStatePath, await loadRuntimeState(paths.runtimeStatePath)),
  };

  await logger.info('Loaded WolfDen agent-player runner config.', {
    configPath: paths.configPath,
    apiBaseUrl: config.apiBaseUrl,
    repoUrl: config.repoUrl,
    siteUrl: config.siteUrl,
    allowedMatchModes: config.allowedMatchModes,
    runtimeAgentId: config.runtimeAgentId,
    runtimeThinking: config.runtimeThinking,
  });

  const session = await restorePersistedPlatformSession(config, paths, logger, false)
    ?? await registerPlatformSession(config, paths, logger, false);
  const capabilities = await getCapabilities(config.apiBaseUrl);
  const a2aState = {
    invitations: new Map(),
    tasks: new Map(),
  };

  async function updateRuntimeState(patch, syncReady = false) {
    runtimeStateRef.current = await saveRuntimeState(paths.runtimeStatePath, {
      ...runtimeStateRef.current,
      ...patch,
    });
    if (syncReady) {
      await heartbeatPlatformSession(
        config.apiBaseUrl,
        session.sessionToken,
        runtimeStateRef.current.ready,
      );
    }
    return runtimeStateRef.current;
  }

  async function refreshRuntimeHealth() {
    const health = await checkRemoteAgentRuntimeHealth(config);
    await updateRuntimeState({
      remoteAgentRuntimeHealthy: health.healthy,
      ready: health.healthy && config.autoReady,
      lastHealthcheckAt: new Date().toISOString(),
      lastHealthcheckError: health.healthy ? null : health.detail,
      lastRunLatencyMs: health.latencyMs,
      lastPlanSource: health.healthy ? runtimeStateRef.current.lastPlanSource : 'timeout',
    }, true);

    if (!health.healthy) {
      await logger.warn('remote agent runtime healthcheck failed; the player will stay unready.', {
        detail: health.detail,
      });
    } else {
      await logger.info('remote agent runtime healthcheck succeeded.', {
        latencyMs: health.latencyMs,
      });
    }

    return health;
  }

  await updatePlatformPreferences(
    config.apiBaseUrl,
    session.player.remoteAgentParticipantId,
    buildPlatformPreferences(session.player.preferences, config),
  );
  await logger.info('Updated WolfDen platform preferences for the bound remote agent player.', {
    remoteAgentParticipantId: session.player.remoteAgentParticipantId,
    allowedMatchModes: config.allowedMatchModes,
    capabilities,
  });

  await refreshRuntimeHealth();

  createA2ASessionSubscription({
    apiBaseUrl: config.apiBaseUrl,
    sessionToken: session.sessionToken,
    participantId: session.player.remoteAgentParticipantId,
    logger,
    onInvitation(invitation) {
      if (invitation?.status === 'pending' && invitation.inviteId) {
        a2aState.invitations.set(invitation.inviteId, invitation);
      }
    },
    onInvitationCancelled(inviteId) {
      if (inviteId) {
        a2aState.invitations.delete(inviteId);
      }
    },
    onTaskOpen(task) {
      if (task?.matchId) {
        a2aState.tasks.set(task.matchId, task);
      }
    },
    onTaskCancel(message) {
      if (message?.matchId) {
        a2aState.tasks.delete(message.matchId);
      }
    },
  });

  let sessionExpired = false;
  let currentInvitationId = null;
  let lastHealthcheckAttemptAt = 0;
  const runPlatformHeartbeat = async () => {
    while (true) {
      try {
        await heartbeatPlatformSession(
          config.apiBaseUrl,
          session.sessionToken,
          runtimeStateRef.current.ready,
        );
      } catch (error) {
        if (error instanceof HttpError && error.statusCode === 401) {
          sessionExpired = true;
          await clearSession(paths.sessionPath);
          await logger.error('WolfDen platform session expired. Local session cache was cleared.');
          return;
        }

        await logger.warn('Platform heartbeat failed.', {
          message: error instanceof Error ? error.message : String(error),
        });
      }

      await sleep(session.heartbeatIntervalMs ?? DEFAULT_PLATFORM_HEARTBEAT_INTERVAL_MS);
    }
  };

  void runPlatformHeartbeat();

  while (true) {
    if (sessionExpired) {
      throw new Error('WolfDen session expired after startup. Restart the same skill instance; only use a fresh bind code when you intentionally released this installation.');
    }

    if (
      !runtimeStateRef.current.remoteAgentRuntimeHealthy
      && Date.now() - lastHealthcheckAttemptAt >= 10_000
    ) {
      lastHealthcheckAttemptAt = Date.now();
      await refreshRuntimeHealth();
    }

    let invitations;
    try {
      invitations = await requestJson(config.apiBaseUrl, `/api/remote-agents/providers/${PLATFORM_PROVIDER_PATH}/invitations`, {
        headers: { [PLATFORM_SESSION_HEADER]: session.sessionToken },
      });
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 401) {
        await clearSession(paths.sessionPath);
        throw new Error('WolfDen session expired while polling invitations. Local session cache was cleared.');
      }
      throw error;
    }

    const pendingInvitation = invitations.find((item) => item.status === 'pending')
      ?? [...a2aState.invitations.values()].find((item) => item.status === 'pending')
      ?? null;
    if (!pendingInvitation || currentInvitationId) {
      await sleep(config.platformPollMs);
      continue;
    }

    if (!runtimeStateRef.current.ready) {
      await sleep(config.platformPollMs);
      continue;
    }

    currentInvitationId = pendingInvitation.inviteId;
    const accept = config.autoAccept && config.allowedMatchModes.includes(pendingInvitation.matchMode);
    await logger.info('Resolving invitation.', {
      inviteId: pendingInvitation.inviteId,
      roomId: pendingInvitation.roomId,
      accept,
      matchMode: pendingInvitation.matchMode,
    });

    try {
      const resolved = await requestJson(
        config.apiBaseUrl,
        `/api/remote-agents/invitations/${pendingInvitation.inviteId}/respond?${PLATFORM_PROVIDER_QUERY}`,
        {
          method: 'POST',
          body: {
            sessionToken: session.sessionToken,
            accept,
          },
        },
      );

      if (accept && resolved.seatToken) {
        await playAcceptedInvitation(
          config,
          pendingInvitation,
          resolved.seatToken,
          session.heartbeatIntervalMs ?? DEFAULT_PLATFORM_HEARTBEAT_INTERVAL_MS,
          referenceBundle,
          capabilities,
          session.sessionToken,
          session.player.remoteAgentParticipantId,
          logger,
          updateRuntimeState,
          resolved.executionMode ?? 'remote_blocking',
          a2aState,
        );
      }
    } finally {
      a2aState.invitations.delete(pendingInvitation.inviteId);
      currentInvitationId = null;
    }

    await sleep(config.platformPollMs);
  }
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }

  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  await main();
}
