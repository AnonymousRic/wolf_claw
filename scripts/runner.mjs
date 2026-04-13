import { readFile } from 'node:fs/promises';
import process from 'node:process';
import {
  DEFAULT_AGENT_NAME,
  DEFAULT_ALLOWED_MATCH_MODES,
  DEFAULT_CAPABILITIES,
  DEFAULT_FEATURE_FLAGS,
  DEFAULT_PLATFORM_HEARTBEAT_INTERVAL_MS,
  DEFAULT_PLATFORM_POLL_MS,
  DEFAULT_TURN_POLL_MS,
  HttpError,
  clearBindCodeFromConfig,
  clearSession,
  createLogger,
  ensureHostStateDir,
  getNumberEnv,
  loadSession,
  loadSkillConfig,
  normalizeBaseUrl,
  parseArgs,
  requestJson,
  resolveRunnerPaths,
  saveSession,
  sleep,
} from './common.mjs';

const ROLE_FALLBACK = 'villager';

function resolvePhaseReferenceKey(phase) {
  if (!phase) {
    return 'day';
  }
  if (phase.startsWith('night')) {
    return 'night';
  }
  if (phase.startsWith('sheriff')) {
    return 'sheriff';
  }
  if (phase === 'last_words') {
    return 'last-words';
  }
  if (phase === 'finished') {
    return 'result';
  }
  return 'day';
}

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

function pickPrimaryLegalAction(legalActions) {
  return legalActions.find((action) => action.actionType !== 'pass') ?? legalActions[0] ?? null;
}

function buildMinimalSpeech(phase) {
  if (phase === 'sheriff_speech') {
    return 'I will keep the room stable first and update after more public information appears.';
  }
  if (phase === 'day_speech' || phase === 'day_pk_speech' || phase === 'last_words') {
    return 'Current information is still limited. I will keep observing speech order and vote flow.';
  }
  return 'Proceed with the current legal action and keep the platform loop stable.';
}

function summarizeReferenceSelection(referenceBundle, role, phase) {
  const roleDocument = referenceBundle.roleDocuments[role] ?? referenceBundle.roleDocuments[ROLE_FALLBACK] ?? null;
  const phaseDocument = referenceBundle.phaseDocuments[resolvePhaseReferenceKey(phase)] ?? null;

  return {
    rolePath: roleDocument?.path ?? 'roles/villager.md',
    phasePath: phaseDocument?.path ?? 'phases/day.md',
  };
}

function buildMinimalSeatAction(turn) {
  const action = pickPrimaryLegalAction(turn.legalActions);
  if (!action) {
    throw new Error(`No legal actions available for turn ${turn.turnId}.`);
  }

  const payload = {
    clientActionId: `wolfden-seat-${Date.now()}`,
    actionType: action.actionType,
  };

  if (action.allowedTargetIds.length > 0) {
    if (action.maxTargetCount > 1) {
      return {
        ...payload,
        targetPlayerIds: action.allowedTargetIds.slice(0, Math.max(1, action.minTargetCount || 0)),
        ...(action.minTextLength > 0 ? { text: buildMinimalSpeech(turn.phase) } : {}),
      };
    }

    return {
      ...payload,
      targetPlayerId: action.allowedTargetIds[0],
      ...(action.minTextLength > 0 ? { text: buildMinimalSpeech(turn.phase) } : {}),
    };
  }

  return {
    ...payload,
    ...(action.minTextLength > 0 ? { text: buildMinimalSpeech(turn.phase) } : {}),
  };
}

function buildMinimalMirrorPlan(planRequest, referenceBundle) {
  const action = pickPrimaryLegalAction(planRequest.legalActions);
  if (!action) {
    return null;
  }

  const { rolePath, phasePath } = summarizeReferenceSelection(
    referenceBundle,
    planRequest.privateState?.role ?? ROLE_FALLBACK,
    planRequest.phase,
  );
  const payload = {
    requestId: planRequest.requestId,
    fingerprint: planRequest.fingerprint,
    clientActionId: `wolfden-plan-${Date.now()}`,
    actionType: action.actionType,
    reasoningSummary: `Use the safest current legal action while WolfDen-specific werewolf strategy remains placeholder-only. roleRef=${rolePath} phaseRef=${phasePath}.`,
  };

  if (action.allowedTargetIds.length > 0) {
    if (action.maxTargetCount > 1) {
      return {
        ...payload,
        targetPlayerIds: action.allowedTargetIds.slice(0, Math.max(1, action.minTargetCount || 0)),
        ...(action.minTextLength > 0 ? { text: buildMinimalSpeech(planRequest.phase) } : {}),
      };
    }

    return {
      ...payload,
      targetPlayerId: action.allowedTargetIds[0],
      ...(action.minTextLength > 0 ? { text: buildMinimalSpeech(planRequest.phase) } : {}),
    };
  }

  return {
    ...payload,
    ...(action.minTextLength > 0 ? { text: buildMinimalSpeech(planRequest.phase) } : {}),
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

async function restorePersistedPlatformSession(config, paths, logger) {
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
    const heartbeat = await requestJson(config.apiBaseUrl, '/api/openclaw/agents/heartbeat', {
      method: 'POST',
      body: {
        sessionToken: persistedSession.sessionToken,
        ready: config.autoReady,
      },
    });

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

async function registerPlatformSession(config, paths, logger) {
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
      autoReady: config.autoReady,
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

async function refreshMirrorAsyncPlan({
  config,
  sessionToken,
  matchId,
  referenceBundle,
  planCache,
  logger,
}) {
  let planRequest;
  try {
    planRequest = await getMirrorPlanRequest(config.apiBaseUrl, matchId, sessionToken);
  } catch (error) {
    if (error instanceof HttpError && (error.statusCode === 404 || error.statusCode === 409)) {
      return;
    }
    throw error;
  }

  if (!planRequest || !Array.isArray(planRequest.legalActions) || planRequest.legalActions.length === 0) {
    return;
  }

  const cacheKey = `${matchId}:${planRequest.playerId}`;
  if (planCache.get(cacheKey) === planRequest.fingerprint) {
    return;
  }

  const payload = buildMinimalMirrorPlan(planRequest, referenceBundle);
  if (!payload) {
    return;
  }

  try {
    const submitted = await submitMirrorPlan(config.apiBaseUrl, matchId, sessionToken, payload);
    planCache.set(cacheKey, submitted.fingerprint);
    await logger.info('Submitted mirror_async plan.', {
      matchId,
      playerId: planRequest.playerId,
      phase: planRequest.phase,
      fingerprint: submitted.fingerprint,
    });
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 409) {
      planCache.delete(cacheKey);
      await logger.warn('Mirror_async plan became stale before submission completed.', {
        matchId,
        fingerprint: planRequest.fingerprint,
      });
      return;
    }
    throw error;
  }
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

async function playAcceptedInvitation(
  config,
  invitation,
  seatToken,
  heartbeatIntervalMs,
  referenceBundle,
  capabilities,
  sessionToken,
  logger,
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

        if (room.matchId) {
          try {
            await refreshMirrorAsyncPlan({
              config,
              sessionToken,
              matchId: room.matchId,
              referenceBundle,
              planCache,
              logger,
            });
          } catch (error) {
            await logger.warn('mirror_async remote planning failed. The server may fall back locally.', {
              matchId: room.matchId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }

        await sleep(config.platformPollMs);
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

      const action = buildMinimalSeatAction(turn);
      try {
        await submitSeatAction(config.apiBaseUrl, seatId, {
          seatToken,
          turnToken: turn.turnToken,
          ...action,
        });
      } catch (error) {
        if (error instanceof HttpError && error.statusCode === 409) {
          await logger.warn('Seat action conflicted with a stale turn token. Re-polling.');
          await sleep(config.turnPollMs);
          continue;
        }
        throw error;
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

  await logger.info('Loaded WolfDen platform-player runner config.', {
    configPath: paths.configPath,
    apiBaseUrl: config.apiBaseUrl,
    repoUrl: config.repoUrl,
    siteUrl: config.siteUrl,
    allowedMatchModes: config.allowedMatchModes,
  });

  const session = await restorePersistedPlatformSession(config, paths, logger)
    ?? await registerPlatformSession(config, paths, logger);
  const capabilities = await getCapabilities(config.apiBaseUrl);

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

  let sessionExpired = false;
  let currentInvitationId = null;
  const runPlatformHeartbeat = async () => {
    while (true) {
      try {
        await requestJson(config.apiBaseUrl, '/api/openclaw/agents/heartbeat', {
          method: 'POST',
          body: {
            sessionToken: session.sessionToken,
            ready: config.autoReady,
          },
        });
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
          logger,
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
