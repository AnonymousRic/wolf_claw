import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PACKAGE_VERSION = '0.1.0';
const ROLE_FALLBACK = 'villager';
const DEFAULT_WOLFDEN_API_BASE_URL = 'https://wolfden-lyart.vercel.app';
const DEFAULT_PLATFORM_HEARTBEAT_INTERVAL_MS = 15_000;
const STATE_SCHEMA_VERSION = 1;
const DEFAULT_STATE_PATH = path.join(
  homedir(),
  '.wolfden',
  'openclaw-platform-player',
  'state.json',
);

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/$/, '');
}

function getBaseUrl() {
  return normalizeBaseUrl(process.env.WOLFDEN_API_BASE_URL ?? DEFAULT_WOLFDEN_API_BASE_URL);
}

function getStatePath() {
  const configuredPath = process.env.WOLFDEN_STATE_PATH;
  return configuredPath ? path.resolve(configuredPath) : DEFAULT_STATE_PATH;
}

function getBoolEnv(name, fallback) {
  const value = process.env[name];
  if (value == null) {
    return fallback;
  }
  return value.toLowerCase() !== 'false';
}

function getNumberEnv(name, fallback) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isObject(value) {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

class HttpError extends Error {
  constructor(message, statusCode, bodyText) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.bodyText = bodyText;
  }
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  const text = await response.text().catch(() => '');
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message = typeof data === 'object' && data && typeof data.message === 'string'
      ? data.message
      : text || `Request failed with ${response.status}`;
    throw new HttpError(message, response.status, text);
  }

  return data;
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

function normalizePersistedState(raw) {
  if (!isObject(raw)) {
    return null;
  }

  if (raw.schemaVersion !== STATE_SCHEMA_VERSION) {
    return null;
  }

  if (!isNonEmptyString(raw.baseUrl) || !isNonEmptyString(raw.openclawPlayerId) || !isNonEmptyString(raw.sessionToken)) {
    return null;
  }

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    openclawPlayerId: raw.openclawPlayerId,
    sessionToken: raw.sessionToken,
    agentName: isNonEmptyString(raw.agentName) ? raw.agentName : 'wolfden-openclaw-agent',
    savedAt: isNonEmptyString(raw.savedAt) ? raw.savedAt : new Date().toISOString(),
  };
}

async function clearPersistedState(statePath) {
  await rm(statePath, { force: true });
}

async function loadPersistedState(statePath) {
  try {
    const raw = JSON.parse(await readFile(statePath, 'utf8'));
    const normalized = normalizePersistedState(raw);
    if (!normalized) {
      console.warn(`[state] invalid state file, clearing ${statePath}`);
      await clearPersistedState(statePath);
      return null;
    }
    return normalized;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }

    console.warn(`[state] failed to read ${statePath}, clearing it`);
    await clearPersistedState(statePath);
    return null;
  }
}

async function savePersistedState(statePath, input) {
  const persistedState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    openclawPlayerId: input.openclawPlayerId,
    sessionToken: input.sessionToken,
    agentName: input.agentName,
    savedAt: new Date().toISOString(),
  };

  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(persistedState, null, 2)}\n`, 'utf8');
  return persistedState;
}

async function loadKnowledgePackage() {
  const manifest = await readJsonResource('./knowledge/manifest.json');

  const coreDocuments = await Promise.all(
    manifest.coreFiles.map(async (path) => ({
      path,
      content: await readTextResource(`./knowledge/${path}`),
    })),
  );

  const roleDocuments = Object.fromEntries(await Promise.all(
    Object.entries(manifest.roleFiles).map(async ([role, path]) => [
      role,
      {
        path,
        content: await readTextResource(`./knowledge/${path}`),
      },
    ]),
  ));

  const phaseDocuments = Object.fromEntries(await Promise.all(
    Object.entries(manifest.phaseFiles).map(async ([phase, path]) => [
      phase,
      {
        path,
        content: await readTextResource(`./knowledge/${path}`),
      },
    ]),
  ));

  const playbooks = await Promise.all(
    manifest.playbooks.map(async (path) => ({
      path,
      content: await readTextResource(`./knowledge/${path}`),
    })),
  );

  return {
    manifest,
    coreDocuments,
    roleDocuments,
    phaseDocuments,
    playbooks,
  };
}

function resolvePhaseKnowledgeKey(phase) {
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
    return 'last_words';
  }
  if (phase === 'finished') {
    return 'result';
  }
  return 'day';
}

function buildSpeech(turn) {
  if (!turn || !Array.isArray(turn.legalActions)) {
    return 'Continue with the current legal action.';
  }

  if (turn.phase === 'sheriff_speech') {
    return 'I will keep this round stable first, then adjust after more public information appears.';
  }

  if (turn.phase === 'day_speech' || turn.phase === 'day_pk_speech' || turn.phase === 'last_words') {
    return 'Current information is still limited. I will keep observing speech order, vote flow, and sheriff direction.';
  }

  return 'Proceed with the current legal action and keep the platform loop stable.';
}

function buildMinimalAction(turn) {
  const action = turn.legalActions.find((item) => item.actionType !== 'pass') ?? turn.legalActions[0];
  if (!action) {
    throw new Error(`No legal actions available for turn ${turn.turnId}.`);
  }

  const payload = {
    clientActionId: `wolfden-skill-${Date.now()}`,
    actionType: action.actionType,
  };

  if (action.allowedTargetIds.length > 0) {
    if (action.maxTargetCount > 1) {
      return {
        ...payload,
        targetPlayerIds: action.allowedTargetIds.slice(0, Math.max(1, action.minTargetCount)),
        ...(action.minTextLength > 0 ? { text: buildSpeech(turn) } : {}),
      };
    }

    return {
      ...payload,
      targetPlayerId: action.allowedTargetIds[0],
      ...(action.minTextLength > 0 ? { text: buildSpeech(turn) } : {}),
    };
  }

  return {
    ...payload,
    ...(action.minTextLength > 0 ? { text: buildSpeech(turn) } : {}),
  };
}

function summarizeKnowledge(library, turn) {
  const role = turn?.privateState?.role ?? ROLE_FALLBACK;
  const phaseKey = resolvePhaseKnowledgeKey(turn?.phase);
  const roleDoc = library.roleDocuments[role] ?? library.roleDocuments[ROLE_FALLBACK];
  const phaseDoc = library.phaseDocuments[phaseKey] ?? null;

  return {
    role,
    rolePath: roleDoc?.path ?? 'n/a',
    phasePath: phaseDoc?.path ?? 'n/a',
  };
}

async function heartbeatSeat(baseUrl, seatToken) {
  return requestJson(baseUrl, '/api/agents/heartbeat', {
    method: 'POST',
    body: { seatToken },
  });
}

async function getSeatTurn(baseUrl, seatId, seatToken) {
  return requestJson(baseUrl, `/api/agent-seats/${seatId}/turn`, {
    headers: { 'x-seat-token': seatToken },
  });
}

async function submitSeatAction(baseUrl, seatId, payload) {
  return requestJson(baseUrl, `/api/agent-seats/${seatId}/actions`, {
    method: 'POST',
    body: payload,
  });
}

async function updatePlatformPreferences(baseUrl, openclawPlayerId, preferences) {
  return requestJson(baseUrl, `/api/openclaw/players/${openclawPlayerId}/preferences`, {
    method: 'PATCH',
    body: preferences,
  });
}

function buildPlatformPreferences(playerPreferences, config) {
  return {
    ...playerPreferences,
    enabled: true,
    autoAcceptEnabled: config.autoAccept,
    allowedMatchModes: config.allowedMatchModes,
  };
}

async function restorePersistedPlatformSession(config) {
  const persistedState = await loadPersistedState(config.statePath);
  if (!persistedState) {
    return null;
  }

  if (persistedState.baseUrl !== config.baseUrl) {
    console.warn(
      `[state] ignoring saved session for ${persistedState.baseUrl}; current baseUrl is ${config.baseUrl}`,
    );
    return null;
  }

  try {
    const heartbeat = await requestJson(config.baseUrl, '/api/openclaw/agents/heartbeat', {
      method: 'POST',
      body: {
        sessionToken: persistedState.sessionToken,
        ready: config.autoReady,
      },
    });

    await savePersistedState(config.statePath, {
      baseUrl: config.baseUrl,
      openclawPlayerId: heartbeat.player.openclawPlayerId,
      sessionToken: persistedState.sessionToken,
      agentName: heartbeat.player.agentName ?? persistedState.agentName ?? config.agentName,
    });

    return {
      restored: true,
      sessionToken: persistedState.sessionToken,
      heartbeatIntervalMs: DEFAULT_PLATFORM_HEARTBEAT_INTERVAL_MS,
      player: heartbeat.player,
      invitations: heartbeat.invitations,
    };
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 401) {
      console.warn('[state] saved WolfDen session is invalid, clearing local state and falling back to bind code bootstrap.');
      await clearPersistedState(config.statePath);
      return null;
    }
    throw error;
  }
}

async function registerPlatformSession(config) {
  if (!config.bindCode) {
    throw new Error(
      'No saved WolfDen session was found. Generate a new bind code from the WolfDen profile page to initialize this installation again.',
    );
  }

  const registration = await requestJson(config.baseUrl, '/api/openclaw/agents/register', {
    method: 'POST',
    body: {
      bindCode: config.bindCode,
      agentName: config.agentName,
      displayName: config.agentName,
      autoReady: config.autoReady,
    },
  });

  await savePersistedState(config.statePath, {
    baseUrl: config.baseUrl,
    openclawPlayerId: registration.player.openclawPlayerId,
    sessionToken: registration.sessionToken,
    agentName: registration.player.agentName ?? config.agentName,
  });

  return {
    ...registration,
    restored: false,
  };
}

async function playAcceptedInvitation(config, invitation, seatToken, heartbeatIntervalMs, knowledgeLibrary) {
  const seatId = invitation.seatId;
  let stopped = false;

  const heartbeatLoop = (async () => {
    while (!stopped) {
      try {
        await heartbeatSeat(config.baseUrl, seatToken);
      } catch (error) {
        console.error('[seat-heartbeat]', error instanceof Error ? error.message : String(error));
      }
      await sleep(heartbeatIntervalMs);
    }
  })();

  console.log(`[seat] accepted room=${invitation.roomId} seat=${seatId} mode=${invitation.matchMode}`);

  try {
    await heartbeatSeat(config.baseUrl, seatToken);

    while (true) {
      const turn = await getSeatTurn(config.baseUrl, seatId, seatToken);

      if (turn.status === 'finished') {
        console.log(`[seat] finished match=${turn.matchId}`);
        break;
      }

      if (turn.status !== 'active') {
        await sleep(config.turnPollMs);
        continue;
      }

      const action = buildMinimalAction(turn);
      const knowledgeSummary = summarizeKnowledge(knowledgeLibrary, turn);
      console.log(
        `[turn] phase=${turn.phase} role=${knowledgeSummary.role} action=${action.actionType} roleDoc=${knowledgeSummary.rolePath} phaseDoc=${knowledgeSummary.phasePath}`,
      );

      try {
        await submitSeatAction(config.baseUrl, seatId, {
          seatToken,
          turnToken: turn.turnToken,
          ...action,
        });
      } catch (error) {
        if (error instanceof HttpError && error.statusCode === 409) {
          console.warn(`[turn] retry after conflict: ${error.message}`);
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
  const knowledgeLibrary = await loadKnowledgePackage();
  console.log(
    `[skill] package=${knowledgeLibrary.manifest.package} version=${PACKAGE_VERSION} core=${knowledgeLibrary.coreDocuments.length} roles=${Object.keys(knowledgeLibrary.roleDocuments).length} phases=${Object.keys(knowledgeLibrary.phaseDocuments).length}`,
  );

  const config = {
    baseUrl: getBaseUrl(),
    bindCode: process.env.WOLFDEN_BIND_CODE ?? null,
    statePath: getStatePath(),
    agentName: process.env.WOLFDEN_AGENT_NAME ?? 'wolfden-openclaw-agent',
    autoReady: getBoolEnv('WOLFDEN_AUTO_READY', true),
    autoAccept: getBoolEnv('WOLFDEN_AUTO_ACCEPT', true),
    allowedMatchModes: (process.env.WOLFDEN_ALLOWED_MATCH_MODES ?? 'human_mixed')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    platformPollMs: getNumberEnv('WOLFDEN_PLATFORM_POLL_MS', 1500),
    turnPollMs: getNumberEnv('WOLFDEN_TURN_POLL_MS', 600),
  };

  const session = await restorePersistedPlatformSession(config) ?? await registerPlatformSession(config);

  if (session.restored) {
    console.log(
      `[restore] baseUrl=${config.baseUrl} player=${session.player.openclawPlayerId} session=${session.sessionToken} state=${config.statePath}`,
    );
  } else {
    console.log(
      `[register] baseUrl=${config.baseUrl} player=${session.player.openclawPlayerId} session=${session.sessionToken} interval=${session.heartbeatIntervalMs} state=${config.statePath}`,
    );
  }

  const platformPreferences = buildPlatformPreferences(session.player.preferences, config);
  await updatePlatformPreferences(
    config.baseUrl,
    session.player.openclawPlayerId,
    platformPreferences,
  );
  console.log(
    `[preferences] enabled=${platformPreferences.enabled} autoAccept=${platformPreferences.autoAcceptEnabled} modes=${platformPreferences.allowedMatchModes.join(',')}`,
  );

  let currentInvitationId = null;
  let sessionExpired = false;
  const runPlatformHeartbeat = async () => {
    while (true) {
      try {
        const heartbeat = await requestJson(config.baseUrl, '/api/openclaw/agents/heartbeat', {
          method: 'POST',
          body: {
            sessionToken: session.sessionToken,
            ready: config.autoReady,
          },
        });

        if (!currentInvitationId && heartbeat.invitations.length > 0) {
          const pendingCount = heartbeat.invitations.filter((item) => item.status === 'pending').length;
          console.log(`[platform] pendingInvitations=${pendingCount}`);
        }
      } catch (error) {
        if (error instanceof HttpError && error.statusCode === 401) {
          sessionExpired = true;
          await clearPersistedState(config.statePath);
          console.error('[platform-heartbeat] WolfDen session expired. Local session cache was cleared.');
          return;
        }
        console.error('[platform-heartbeat]', error instanceof Error ? error.message : String(error));
      }

      await sleep(session.heartbeatIntervalMs ?? DEFAULT_PLATFORM_HEARTBEAT_INTERVAL_MS);
    }
  };

  void runPlatformHeartbeat();

  while (true) {
    if (sessionExpired) {
      throw new Error('WolfDen session expired after startup. Restart the existing skill installation; only generate a new bind code if you intentionally unbound this OpenClaw.');
    }

    let invitations;
    try {
      invitations = await requestJson(config.baseUrl, '/api/openclaw/agents/invitations', {
        headers: { 'x-openclaw-session': session.sessionToken },
      });
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 401) {
        await clearPersistedState(config.statePath);
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
    console.log(`[invite] ${accept ? 'accept' : 'decline'} room=${pendingInvitation.roomId} mode=${pendingInvitation.matchMode}`);

    try {
      const resolved = await requestJson(
        config.baseUrl,
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
          knowledgeLibrary,
        );
      }
    } finally {
      currentInvitationId = null;
    }

    await sleep(config.platformPollMs);
  }
}

await main();
