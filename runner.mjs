import { readFile } from 'node:fs/promises';
import process from 'node:process';

const PACKAGE_VERSION = '0.1.0';
const ROLE_FALLBACK = 'villager';
const DEFAULT_WOLFDEN_API_BASE_URL = 'https://wolfden-lyart.vercel.app';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/$/, '');
}

function getBaseUrl() {
  return normalizeBaseUrl(process.env.WOLFDEN_API_BASE_URL ?? DEFAULT_WOLFDEN_API_BASE_URL);
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
    bindCode: requireEnv('WOLFDEN_BIND_CODE'),
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

  const registration = await requestJson(config.baseUrl, '/api/openclaw/agents/register', {
    method: 'POST',
    body: {
      bindCode: config.bindCode,
      agentName: config.agentName,
      displayName: config.agentName,
      autoReady: config.autoReady,
    },
  });

  console.log(
    `[register] baseUrl=${config.baseUrl} player=${registration.player.openclawPlayerId} session=${registration.sessionToken} interval=${registration.heartbeatIntervalMs}`,
  );

  const platformPreferences = {
    ...registration.player.preferences,
    enabled: true,
    autoAcceptEnabled: config.autoAccept,
    allowedMatchModes: config.allowedMatchModes,
  };
  await updatePlatformPreferences(
    config.baseUrl,
    registration.player.openclawPlayerId,
    platformPreferences,
  );
  console.log(
    `[preferences] enabled=${platformPreferences.enabled} autoAccept=${platformPreferences.autoAcceptEnabled} modes=${platformPreferences.allowedMatchModes.join(',')}`,
  );

  let currentInvitationId = null;
  const runPlatformHeartbeat = async () => {
    while (true) {
      try {
        const heartbeat = await requestJson(config.baseUrl, '/api/openclaw/agents/heartbeat', {
          method: 'POST',
          body: {
            sessionToken: registration.sessionToken,
            ready: config.autoReady,
          },
        });

        if (!currentInvitationId && heartbeat.invitations.length > 0) {
          const pendingCount = heartbeat.invitations.filter((item) => item.status === 'pending').length;
          console.log(`[platform] pendingInvitations=${pendingCount}`);
        }
      } catch (error) {
        console.error('[platform-heartbeat]', error instanceof Error ? error.message : String(error));
      }

      await sleep(registration.heartbeatIntervalMs);
    }
  };

  void runPlatformHeartbeat();

  while (true) {
    const invitations = await requestJson(config.baseUrl, '/api/openclaw/agents/invitations', {
      headers: { 'x-openclaw-session': registration.sessionToken },
    });

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
            sessionToken: registration.sessionToken,
            accept,
          },
        },
      );

      if (accept && resolved.seatToken) {
        await playAcceptedInvitation(
          config,
          pendingInvitation,
          resolved.seatToken,
          registration.heartbeatIntervalMs,
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
