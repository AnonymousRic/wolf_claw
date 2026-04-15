import { readFile } from 'node:fs/promises';
import process from 'node:process';
import {
  DEFAULT_AGENT_NAME,
  DEFAULT_ALLOWED_MATCH_MODES,
  DEFAULT_CAPABILITIES,
  DEFAULT_FEATURE_FLAGS,
  DEFAULT_OPENCLAW_AGENT_ID,
  DEFAULT_OPENCLAW_THINKING,
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
  parseArgs,
  requestJson,
  resolveRunnerPaths,
  saveRuntimeState,
  saveSession,
  sleep,
} from './common.mjs';
import {
  buildMirrorPlanFromOpenclaw,
  buildSeatActionFromOpenclaw,
  checkOpenclawRuntimeHealth,
} from './openclaw-agent.mjs';

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

async function updatePlatformPreferences(apiBaseUrl, openclawPlayerId, preferences) {
  return requestJson(apiBaseUrl, `/api/openclaw/players/${openclawPlayerId}/preferences`, {
    method: 'PATCH',
    body: preferences,
  });
}

async function getCapabilities(apiBaseUrl) {
  try {
    return await requestJson(apiBaseUrl, '/api/openclaw/capabilities');
  } catch {
    return { ...DEFAULT_CAPABILITIES };
  }
}

async function getMirrorPlanRequest(apiBaseUrl, matchId, sessionToken) {
  return requestJson(apiBaseUrl, `/api/openclaw/matches/${matchId}/plan-request`, {
    headers: { 'x-openclaw-session': sessionToken },
  });
}

async function submitMirrorPlan(apiBaseUrl, matchId, sessionToken, payload) {
  return requestJson(apiBaseUrl, `/api/openclaw/matches/${matchId}/plan`, {
    method: 'POST',
    headers: { 'x-openclaw-session': sessionToken },
    body: payload,
  });
}

async function heartbeatPlatformSession(apiBaseUrl, sessionToken, ready) {
  return requestJson(apiBaseUrl, '/api/openclaw/agents/heartbeat', {
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

    await saveSession(paths.sessionPath, {
      apiBaseUrl: config.apiBaseUrl,
      openclawPlayerId: heartbeat.player.openclawPlayerId,
      sessionToken: persistedSession.sessionToken,
      agentName: heartbeat.player.agentName ?? persistedSession.agentName ?? config.agentName,
    });

    return {
      restored: true,
      sessionToken: persistedSession.sessionToken,
      heartbeatIntervalMs: DEFAULT_PLATFORM_HEARTBEAT_INTERVAL_MS,
      player: heartbeat.player,
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
      'No saved WolfDen session was found. Use a fresh bind code only when this OpenClaw installation has not been bound before or was intentionally released.',
    );
  }

  const registration = await requestJson(config.apiBaseUrl, '/api/openclaw/agents/register', {
    method: 'POST',
    body: {
      bindCode: config.bindCode,
      agentName: config.agentName,
      displayName: config.agentName,
      autoReady: ready,
    },
  });

  await saveSession(paths.sessionPath, {
    apiBaseUrl: config.apiBaseUrl,
    openclawPlayerId: registration.player.openclawPlayerId,
    sessionToken: registration.sessionToken,
    agentName: registration.player.agentName ?? config.agentName,
  });
  await clearBindCodeFromConfig(paths.configPath);
  await logger.info('Registered WolfDen platform session and cleared the one-time bind code from host config.', {
    openclawPlayerId: registration.player.openclawPlayerId,
  });

  return {
    ...registration,
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

async function refreshMirrorAsyncPlan({
  config,
  sessionToken,
  openclawPlayerId,
  matchId,
  referenceBundle,
  planCache,
  logger,
  updateRuntimeState,
}) {
  let planRequest;
  try {
    planRequest = await getMirrorPlanRequest(config.apiBaseUrl, matchId, sessionToken);
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
  if (planCache.get(cacheKey) === planRequest.fingerprint) {
    return nextPollMs;
  }

  const startedAt = Date.now();
  try {
    const remotePlan = await buildMirrorPlanFromOpenclaw({
      config,
      openclawPlayerId,
      planRequest,
      referenceBundle,
    });
    const submitted = await submitMirrorPlan(config.apiBaseUrl, matchId, sessionToken, remotePlan.payload);
    planCache.set(cacheKey, submitted.fingerprint);
    await updateRuntimeState({
      openclawRuntimeHealthy: true,
      ready: config.autoReady,
      lastRunAt: new Date().toISOString(),
      lastRunLatencyMs: remotePlan.latencyMs,
      lastPlanSource: 'remote-openclaw',
      lastFailureReason: null,
      lastMatchId: matchId,
      lastPhase: planRequest.phase,
      lastActionType: remotePlan.payload.actionType,
    }, true);
    await logger.info('Submitted remote OpenClaw mirror_async plan.', {
      matchId,
      playerId: planRequest.playerId,
      phase: planRequest.phase,
      fingerprint: submitted.fingerprint,
      openclawLatencyMs: remotePlan.latencyMs,
    });
  } catch (error) {
    planCache.delete(cacheKey);
    const message = error instanceof Error ? error.message : String(error);
    const lastPlanSource = message.includes('timed out') ? 'timeout' : 'invalid-remote-response';
    const runtimeHealthy = !isRuntimeTransportFailure(error) && lastPlanSource !== 'timeout';
    await updateRuntimeState({
      openclawRuntimeHealthy: runtimeHealthy,
      ready: runtimeHealthy && config.autoReady,
      lastRunAt: new Date().toISOString(),
      lastRunLatencyMs: Date.now() - startedAt,
      lastPlanSource,
      lastFailureReason: message,
      lastMatchId: matchId,
      lastPhase: planRequest.phase,
      lastActionType: null,
    }, true);
    await logger.warn('OpenClaw mirror_async planning failed. The server may fall back locally.', {
      matchId,
      phase: planRequest.phase,
      message,
    });
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
  openclawPlayerId,
  logger,
  updateRuntimeState,
  executionMode = 'remote_blocking',
) {
  const seatId = invitation.seatId;
  const planCache = new Map();
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
      while (true) {
        const room = await getRoom(config.apiBaseUrl, invitation.roomId);
        if (room.status === 'finished') {
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

        let pollMs = config.platformPollMs;
        if (room.matchId) {
          pollMs = await refreshMirrorAsyncPlan({
            config,
            sessionToken,
            openclawPlayerId,
            matchId: room.matchId,
            referenceBundle,
            planCache,
            logger,
            updateRuntimeState,
          });
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
        const remoteAction = await buildSeatActionFromOpenclaw({
          config,
          openclawPlayerId,
          turn,
          referenceBundle,
        });
        await submitSeatAction(config.apiBaseUrl, seatId, {
          seatToken,
          turnToken: turn.turnToken,
          ...remoteAction.action,
        });
        await updateRuntimeState({
          openclawRuntimeHealthy: true,
          ready: config.autoReady,
          lastRunAt: new Date().toISOString(),
          lastRunLatencyMs: remoteAction.latencyMs,
          lastPlanSource: 'remote-openclaw',
          lastFailureReason: null,
          lastMatchId: turn.matchId,
          lastPhase: turn.phase,
          lastActionType: remoteAction.action.actionType,
        }, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const runtimeHealthy = !isRuntimeTransportFailure(error) && !message.includes('timed out');
        await updateRuntimeState({
          openclawRuntimeHealthy: runtimeHealthy,
          ready: runtimeHealthy && config.autoReady,
          lastRunAt: new Date().toISOString(),
          lastRunLatencyMs: null,
          lastPlanSource: message.includes('timed out') ? 'timeout' : 'invalid-remote-response',
          lastFailureReason: message,
          lastMatchId: turn.matchId,
          lastPhase: turn.phase,
          lastActionType: null,
        }, true);
        await logger.warn('remote_blocking OpenClaw action failed; retrying the same turn window.', {
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveRunnerPaths(args.values.get('config') ?? process.env.WOLFDEN_CONFIG_PATH);
  await ensureHostStateDir(paths);
  const logger = createLogger(paths.logPath);
  const referenceBundle = await loadReferenceBundle();
  const loadedConfig = await loadSkillConfig(paths.configPath);
  const config = loadedConfig ? {
    ...loadedConfig,
    ...(process.env.OPENCLAW_PLATFORM_API_BASE_URL ? { apiBaseUrl: process.env.OPENCLAW_PLATFORM_API_BASE_URL } : {}),
    ...(process.env.WOLFDEN_API_BASE_URL ? { apiBaseUrl: process.env.WOLFDEN_API_BASE_URL } : {}),
    ...(process.env.OPENCLAW_PLATFORM_SITE_URL ? { siteUrl: process.env.OPENCLAW_PLATFORM_SITE_URL } : {}),
    ...(process.env.WOLFDEN_AGENT_NAME ? { agentName: process.env.WOLFDEN_AGENT_NAME } : {}),
    ...(process.env.WOLFDEN_OPENCLAW_AGENT_ID ? { openclawAgentId: process.env.WOLFDEN_OPENCLAW_AGENT_ID } : {}),
    ...(process.env.WOLFDEN_OPENCLAW_THINKING ? { openclawThinking: process.env.WOLFDEN_OPENCLAW_THINKING } : {}),
    ...(process.env.WOLFDEN_OPENCLAW_TIMEOUT_SECONDS ? { openclawTimeoutSeconds: Number(process.env.WOLFDEN_OPENCLAW_TIMEOUT_SECONDS) } : {}),
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
  config.openclawAgentId = config.openclawAgentId || DEFAULT_OPENCLAW_AGENT_ID;
  config.openclawThinking = config.openclawThinking || DEFAULT_OPENCLAW_THINKING;

  const runtimeStateRef = {
    current: await saveRuntimeState(paths.runtimeStatePath, await loadRuntimeState(paths.runtimeStatePath)),
  };

  await logger.info('Loaded WolfDen platform-player runner config.', {
    configPath: paths.configPath,
    apiBaseUrl: config.apiBaseUrl,
    repoUrl: config.repoUrl,
    siteUrl: config.siteUrl,
    allowedMatchModes: config.allowedMatchModes,
    openclawAgentId: config.openclawAgentId,
    openclawThinking: config.openclawThinking,
  });

  const session = await restorePersistedPlatformSession(config, paths, logger, false)
    ?? await registerPlatformSession(config, paths, logger, false);
  const capabilities = await getCapabilities(config.apiBaseUrl);

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
    const health = await checkOpenclawRuntimeHealth(config);
    await updateRuntimeState({
      openclawRuntimeHealthy: health.healthy,
      ready: health.healthy && config.autoReady,
      lastHealthcheckAt: new Date().toISOString(),
      lastHealthcheckError: health.healthy ? null : health.detail,
      lastRunLatencyMs: health.latencyMs,
      lastPlanSource: health.healthy ? runtimeStateRef.current.lastPlanSource : 'timeout',
    }, true);

    if (!health.healthy) {
      await logger.warn('OpenClaw runtime healthcheck failed; the player will stay unready.', {
        detail: health.detail,
      });
    } else {
      await logger.info('OpenClaw runtime healthcheck succeeded.', {
        latencyMs: health.latencyMs,
      });
    }

    return health;
  }

  await updatePlatformPreferences(
    config.apiBaseUrl,
    session.player.openclawPlayerId,
    buildPlatformPreferences(session.player.preferences, config),
  );
  await logger.info('Updated WolfDen platform preferences for the bound OpenClaw player.', {
    openclawPlayerId: session.player.openclawPlayerId,
    allowedMatchModes: config.allowedMatchModes,
    capabilities,
  });

  await refreshRuntimeHealth();

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
      !runtimeStateRef.current.openclawRuntimeHealthy
      && Date.now() - lastHealthcheckAttemptAt >= 10_000
    ) {
      lastHealthcheckAttemptAt = Date.now();
      await refreshRuntimeHealth();
    }

    let invitations;
    try {
      invitations = await requestJson(config.apiBaseUrl, '/api/openclaw/agents/invitations', {
        headers: { 'x-openclaw-session': session.sessionToken },
      });
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 401) {
        await clearSession(paths.sessionPath);
        throw new Error('WolfDen session expired while polling invitations. Local session cache was cleared.');
      }
      throw error;
    }

    const pendingInvitation = invitations.find((item) => item.status === 'pending');
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
        `/api/openclaw/invitations/${pendingInvitation.inviteId}/respond`,
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
          session.player.openclawPlayerId,
          logger,
          updateRuntimeState,
          resolved.executionMode ?? 'remote_blocking',
        );
      }
    } finally {
      currentInvitationId = null;
    }

    await sleep(config.platformPollMs);
  }
}

await main();
