import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpError } from './common.mjs';
import {
  extractActionableCheckpointFromRoom,
  extractActionableCheckpointFromSnapshot,
  refreshMirrorAsyncPlan,
} from './runner.mjs';

function createLogger() {
  const entries = [];
  return {
    entries,
    async info(message, payload = null) {
      entries.push({ level: 'info', message, payload });
    },
    async warn(message, payload = null) {
      entries.push({ level: 'warn', message, payload });
    },
  };
}

function createPlanRequest(overrides = {}) {
  return {
    requestId: 'req-1',
    matchId: 'match-1',
    playerId: 'player-9',
    fingerprint: 'fingerprint-1',
    phase: 'day_speech',
    deadlineMs: 6_000,
    legalActions: [{
      actionType: 'speech',
      label: 'Speech',
      prompt: 'Say something',
      allowedTargetIds: [],
      minTargetCount: 0,
      maxTargetCount: 0,
      minTextLength: 1,
      maxTextLength: 180,
    }],
    privateState: {
      role: 'seer',
      allies: [],
      phaseHint: null,
      seerResult: null,
      seerHistory: [],
      witchNightTarget: null,
      hunterCanShoot: false,
      hunterBlockedReason: null,
      perspective: {
        mode: 'auto',
        title: 'title',
        description: 'description',
        currentActor: null,
        orderTrack: null,
        actionContext: null,
        roleContext: null,
        werewolfSummary: null,
      },
    },
    publicContext: {
      day: 1,
      turn: 2,
      roomId: 'room-1',
      roomDisplayName: 'room-1',
      matchMode: 'human_mixed',
      scoreboard: {
        aliveVillagers: 7,
        aliveWolves: 4,
        sheriffPlayerId: null,
      },
      tableState: {
        alivePlayers: [],
        deadPlayers: [],
        sheriffPlayerId: null,
        sheriffCandidates: [],
        speechOrder: [],
        currentSpeaker: 'player-9',
      },
      backgroundDigest: {
        matchId: 'match-1',
        phase: 'day_speech',
        day: 1,
        turn: 2,
        visibleEventCount: 0,
        recentPublicEvents: [],
      },
      historyDigest: {
        deathTimeline: [],
        sheriffTimeline: [],
        voteTimeline: [],
        speechTimeline: [],
      },
      telemetry: {
        lastPlanSource: null,
        lastRemoteDecisionAt: null,
        lastRemoteDecisionLatencyMs: null,
        remoteDecisionFailureReason: null,
        lastPlanRequestId: 'req-1',
        lastPlanFingerprint: 'fingerprint-1',
        lastPlanOutcome: 'exposed',
        lastPlanRejectReason: null,
        lastPlanDeadlineMs: 6_000,
        liveFallbackCount: 0,
        planCacheHits: 0,
        lastAsyncPlanLatencyMs: null,
        lastAdvanceLatencyMs: null,
        contextBuildMs: null,
        modelDecisionMs: null,
        submitPlanMs: null,
        endToEndDecisionMs: null,
        currentCheckpointId: 'ocplan:fingerprint-1',
        currentFingerprint: 'fingerprint-1',
        currentStatus: 'waiting_remote',
        checkpointStatus: 'waiting_remote',
        waitingOn: 'openclaw',
      },
    },
    decisionContext: {
      identity: {
        playerId: 'player-9',
        seatId: 9,
        role: 'seer',
        faction: 'villagers',
        isAlive: true,
        isSheriff: false,
        allies: [],
        abilityState: {
          hunterCanShoot: false,
          hunterBlockedReason: null,
          witchNightTargetPlayerId: null,
          latestSeerTargetPlayerId: null,
          latestSeerIsWerewolf: null,
          seerHistoryCount: 0,
        },
      },
      phase: {
        phase: 'day_speech',
        day: 1,
        turn: 2,
        phaseDeadlineAt: null,
        platformCeilingMs: 6_000,
        modelSoftTimeoutMs: 4_000,
        modelHardTimeoutMs: 6_000,
      },
      guidance: {
        rules: ['Only use legal actions'],
        tips: [],
        selfChecks: [],
      },
      knownFacts: {
        allies: [],
        latestSeerResult: null,
        seerHistory: [],
        witchNightTarget: null,
        hunterCanShoot: false,
        hunterBlockedReason: null,
        sheriffPlayerId: null,
      },
      decisionRequest: {
        matchId: 'match-1',
        playerId: 'player-9',
        phase: 'day_speech',
        visibleHistory: [],
        legalActions: [{
          actionType: 'speech',
          label: 'Speech',
          prompt: 'Say something',
          allowedTargetIds: [],
          minTargetCount: 0,
          maxTargetCount: 0,
          minTextLength: 1,
          maxTextLength: 180,
        }],
        privateNotes: ['role:seer'],
      },
      responseSchema: {
        maxSpeechChars: 180,
        maxSpeechSegments: 3,
        allowSpeechStreaming: true,
        targetMustBeLegal: true,
      },
      baselineDecision: {
        actionType: 'speech',
        targetPlayerId: null,
        targetPlayerIds: null,
        speech: {
          segments: ['baseline speech'],
          charCount: 15,
        },
      },
    },
    ...overrides,
  };
}

test('extractActionableCheckpoint helpers only expose actionable or waiting_remote checkpoints', () => {
  assert.equal(extractActionableCheckpointFromRoom({
    openclawSync: {
      checkpointId: 'cp-1',
      matchId: 'match-1',
      phase: 'day_speech',
      requiresDecision: true,
      fingerprint: 'fp-1',
      checkpointStatus: 'gated',
      waitingOn: 'phase_gate',
    },
  }), null);

  assert.deepEqual(extractActionableCheckpointFromRoom({
    openclawSync: {
      checkpointId: 'cp-2',
      matchId: 'match-2',
      phase: 'day_speech',
      requiresDecision: true,
      fingerprint: 'fp-2',
      checkpointStatus: 'actionable',
      waitingOn: 'openclaw',
    },
  }), {
    matchId: 'match-2',
    checkpointId: 'cp-2',
    fingerprint: 'fp-2',
    phase: 'day_speech',
  });

  assert.equal(extractActionableCheckpointFromSnapshot({
    matchId: 'match-3',
    openclawTelemetry: {
      currentCheckpointId: 'cp-3',
      currentFingerprint: 'fp-3',
      currentStatus: 'completed',
      checkpointStatus: 'completed',
      waitingOn: 'none',
    },
  }), null);

  assert.deepEqual(extractActionableCheckpointFromSnapshot({
    matchId: 'match-4',
    phase: 'night_seer',
    openclawTelemetry: {
      currentCheckpointId: 'cp-4',
      currentFingerprint: 'fp-4',
      currentStatus: 'waiting_remote',
      checkpointStatus: 'waiting_remote',
      waitingOn: 'openclaw',
    },
  }), {
    matchId: 'match-4',
    checkpointId: 'cp-4',
    fingerprint: 'fp-4',
    phase: 'night_seer',
  });
});

test('refreshMirrorAsyncPlan treats 409 gated responses as a backoff without runtime failure bookkeeping', async () => {
  let updateCalls = 0;
  let buildCalls = 0;
  let submitCalls = 0;

  const pollMs = await refreshMirrorAsyncPlan({
    config: {
      apiBaseUrl: 'http://localhost:3000',
      platformPollMs: 250,
      autoReady: true,
    },
    sessionToken: 'session-1',
    openclawPlayerId: 'openclaw-1',
    matchId: 'match-1',
    referenceBundle: {},
    planCache: new Map(),
    inFlightPlans: new Set(),
    latestCheckpoints: new Map(),
    logger: createLogger(),
    async updateRuntimeState() {
      updateCalls += 1;
    },
    deps: {
      async getMirrorPlanRequest() {
        throw new HttpError('gated', 409, '');
      },
      async buildMirrorPlanFromOpenclaw() {
        buildCalls += 1;
        return null;
      },
      async submitMirrorPlan() {
        submitCalls += 1;
        return null;
      },
    },
  });

  assert.ok(pollMs > 0);
  assert.equal(updateCalls, 0);
  assert.equal(buildCalls, 0);
  assert.equal(submitCalls, 0);
});

test('refreshMirrorAsyncPlan drops a stale in-flight checkpoint before submit when a newer checkpoint supersedes it', async () => {
  let updateCalls = 0;
  let submitCalls = 0;
  const latestCheckpoints = new Map();
  const logger = createLogger();

  await refreshMirrorAsyncPlan({
    config: {
      apiBaseUrl: 'http://localhost:3000',
      platformPollMs: 250,
      autoReady: true,
    },
    sessionToken: 'session-1',
    openclawPlayerId: 'openclaw-1',
    matchId: 'match-1',
    referenceBundle: {},
    planCache: new Map(),
    inFlightPlans: new Set(),
    latestCheckpoints,
    logger,
    async updateRuntimeState() {
      updateCalls += 1;
    },
    deps: {
      async getMirrorPlanRequest() {
        return createPlanRequest();
      },
      async buildMirrorPlanFromOpenclaw() {
        latestCheckpoints.set('match-1', {
          checkpointId: 'req-2',
          fingerprint: 'fingerprint-2',
        });
        return {
          latencyMs: 12,
          payload: {
            requestId: 'req-1',
            fingerprint: 'fingerprint-1',
            clientActionId: 'client-1',
            actionType: 'speech',
            speech: {
              segments: ['remote speech'],
              charCount: 'remote speech'.length,
            },
            reasoningSummary: 'superseded before submit',
          },
        };
      },
      async submitMirrorPlan() {
        submitCalls += 1;
        return {
          accepted: true,
          matchId: 'match-1',
          playerId: 'player-9',
          requestId: 'req-1',
          fingerprint: 'fingerprint-1',
        };
      },
    },
  });

  assert.equal(submitCalls, 0);
  assert.equal(updateCalls, 0);
  assert.ok(logger.entries.some((entry) => entry.message.includes('Discarded stale OpenClaw mirror_async plan')));
});

test('refreshMirrorAsyncPlan records request-level runtime metadata after a successful submit', async () => {
  const runtimeUpdates = [];

  await refreshMirrorAsyncPlan({
    config: {
      apiBaseUrl: 'http://localhost:3000',
      platformPollMs: 250,
      autoReady: true,
    },
    sessionToken: 'session-1',
    openclawPlayerId: 'openclaw-1',
    matchId: 'match-1',
    referenceBundle: {},
    planCache: new Map(),
    inFlightPlans: new Set(),
    latestCheckpoints: new Map(),
    logger: createLogger(),
    async updateRuntimeState(patch) {
      runtimeUpdates.push(patch);
    },
    deps: {
      async getMirrorPlanRequest() {
        return createPlanRequest();
      },
      async buildMirrorPlanFromOpenclaw() {
        return {
          latencyMs: 18,
          requestId: 'req-1',
          fingerprint: 'fingerprint-1',
          deadlineMs: 6_000,
          promptChars: 4321,
          timeoutSeconds: 5,
          payload: {
            requestId: 'req-1',
            fingerprint: 'fingerprint-1',
            clientActionId: 'client-1',
            actionType: 'speech',
            speech: {
              segments: ['remote speech'],
              charCount: 'remote speech'.length,
            },
            reasoningSummary: 'successful submit',
          },
        };
      },
      async submitMirrorPlan() {
        return {
          accepted: true,
          matchId: 'match-1',
          playerId: 'player-9',
          requestId: 'req-1',
          fingerprint: 'fingerprint-1',
        };
      },
    },
  });

  assert.equal(runtimeUpdates.length, 1);
  assert.equal(runtimeUpdates[0].lastRequestId, 'req-1');
  assert.equal(runtimeUpdates[0].lastFingerprint, 'fingerprint-1');
  assert.equal(runtimeUpdates[0].lastDeadlineMs, 6_000);
  assert.equal(runtimeUpdates[0].lastPromptChars, 4321);
  assert.equal(runtimeUpdates[0].lastTimeoutSeconds, 5);
  assert.equal(runtimeUpdates[0].lastActionType, 'speech');
});
