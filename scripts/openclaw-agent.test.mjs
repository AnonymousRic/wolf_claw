import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  __normalizeSpeechForTests,
  __resetOpenclawCompatCacheForTests,
  __trimMirrorPublicContextForTests,
  buildMirrorPlanFromOpenclaw,
  checkOpenclawRuntimeHealth,
} from './openclaw-agent.mjs';

const fixturePath = fileURLToPath(new URL('../../../../../../tests/fixtures/fake-openclaw.mjs', import.meta.url));

function withFakeOpenclawEnv(overrides, callback) {
  __resetOpenclawCompatCacheForTests();
  const previous = {
    WOLFDEN_OPENCLAW_BIN: process.env.WOLFDEN_OPENCLAW_BIN,
    WOLFDEN_OPENCLAW_BIN_ARGS: process.env.WOLFDEN_OPENCLAW_BIN_ARGS,
    WOLFDEN_FAKE_OPENCLAW_MODE: process.env.WOLFDEN_FAKE_OPENCLAW_MODE,
    WOLFDEN_FAKE_OPENCLAW_RESPONSE_SHAPE: process.env.WOLFDEN_FAKE_OPENCLAW_RESPONSE_SHAPE,
    WOLFDEN_FAKE_OPENCLAW_RECORD_PATH: process.env.WOLFDEN_FAKE_OPENCLAW_RECORD_PATH,
  };

  process.env.WOLFDEN_OPENCLAW_BIN = process.execPath;
  process.env.WOLFDEN_OPENCLAW_BIN_ARGS = JSON.stringify([fixturePath]);
  if ('WOLFDEN_FAKE_OPENCLAW_MODE' in overrides) {
    process.env.WOLFDEN_FAKE_OPENCLAW_MODE = overrides.WOLFDEN_FAKE_OPENCLAW_MODE;
  }
  if ('WOLFDEN_FAKE_OPENCLAW_RESPONSE_SHAPE' in overrides) {
    process.env.WOLFDEN_FAKE_OPENCLAW_RESPONSE_SHAPE = overrides.WOLFDEN_FAKE_OPENCLAW_RESPONSE_SHAPE;
  }
  if ('WOLFDEN_FAKE_OPENCLAW_RECORD_PATH' in overrides) {
    process.env.WOLFDEN_FAKE_OPENCLAW_RECORD_PATH = overrides.WOLFDEN_FAKE_OPENCLAW_RECORD_PATH;
  }

  return Promise.resolve()
    .then(callback)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value == null) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
}

function createPlanRequest() {
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
      maxTextLength: 602,
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
          maxTextLength: 602,
        }],
        privateNotes: ['role:seer'],
      },
      responseSchema: {
        maxSpeechChars: 602,
        maxSpeechSegmentChars: 200,
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
  };
}

const referenceBundle = {
  coreDocuments: [{ path: 'platform-contract.md', content: 'contract' }],
  roleDocuments: {
    seer: { path: 'roles/seer.md', content: 'seer reference' },
    villager: { path: 'roles/villager.md', content: 'villager reference' },
  },
  phaseDocuments: {
    day: { path: 'phases/day.md', content: 'day reference' },
  },
};

test('buildMirrorPlanFromOpenclaw converts a valid OpenClaw agent response into a plan payload', async () => {
  await withFakeOpenclawEnv({
    WOLFDEN_FAKE_OPENCLAW_MODE: 'success',
    WOLFDEN_FAKE_OPENCLAW_RESPONSE_SHAPE: 'result-payloads-text',
  }, async () => {
    const result = await buildMirrorPlanFromOpenclaw({
      config: {
        agentName: 'unit-openclaw',
        openclawAgentId: 'main',
        openclawThinking: 'medium',
        openclawTimeoutSeconds: 10,
      },
      openclawPlayerId: 'oc-player-1',
      planRequest: createPlanRequest(),
      referenceBundle,
    });

    assert.equal(result.payload.requestId, 'req-1');
    assert.equal(result.payload.fingerprint, 'fingerprint-1');
    assert.equal(result.payload.actionType, 'speech');
    assert.ok(result.payload.speech);
    assert.match(result.payload.speech.segments[0], /OpenClaw/);
    assert.ok(result.latencyMs >= 0);
    assert.equal(result.requestId, 'req-1');
    assert.equal(result.fingerprint, 'fingerprint-1');
    assert.equal(result.deadlineMs, 6_000);
    assert.ok(result.promptChars > 0);
    assert.ok(result.timeoutSeconds >= 5);
  });
});

test('speech-phase public context trimming keeps only the latest timeline entries', () => {
  const request = createPlanRequest();
  request.publicContext.historyDigest = {
    deathTimeline: Array.from({ length: 7 }, (_, index) => ({ seq: index + 1 })),
    sheriffTimeline: Array.from({ length: 6 }, (_, index) => ({ seq: index + 1 })),
    voteTimeline: Array.from({ length: 9 }, (_, index) => ({ seq: index + 1 })),
    speechTimeline: Array.from({ length: 12 }, (_, index) => ({ seq: index + 1 })),
  };

  const trimmed = __trimMirrorPublicContextForTests(request.publicContext, 'day_speech');
  assert.equal(trimmed.historyDigest.deathTimeline.length, 4);
  assert.equal(trimmed.historyDigest.sheriffTimeline.length, 4);
  assert.equal(trimmed.historyDigest.voteTimeline.length, 6);
  assert.equal(trimmed.historyDigest.speechTimeline.length, 8);
  assert.deepEqual(trimmed.historyDigest.speechTimeline.map((entry) => entry.seq), [5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(request.publicContext.historyDigest.speechTimeline.length, 12);
});

test('normalizeSpeech hard-wraps oversized segments and recomputes charCount', () => {
  const speech = __normalizeSpeechForTests(
    {
      speech: {
        segments: ['甲'.repeat(250)],
        charCount: 999,
      },
    },
    {
      actionType: 'speech',
      minTextLength: 1,
      maxTextLength: 602,
    },
    {
      maxSpeechChars: 602,
      maxSpeechSegmentChars: 200,
      maxSpeechSegments: 3,
    },
  );

  assert.deepEqual(speech.segments.map((segment) => segment.length), [200, 50]);
  assert.equal(speech.charCount, 251);
});

test('normalizeSpeech truncates to the joined total budget without violating segment caps', () => {
  const speech = __normalizeSpeechForTests(
    {
      text: '乙'.repeat(700),
    },
    {
      actionType: 'speech',
      minTextLength: 1,
      maxTextLength: 602,
    },
    {
      maxSpeechChars: 602,
      maxSpeechSegmentChars: 200,
      maxSpeechSegments: 3,
    },
  );

  assert.equal(speech.segments.length, 3);
  assert.deepEqual(speech.segments.map((segment) => segment.length), [200, 200, 200]);
  assert.equal(speech.charCount, 602);
});

test('buildMirrorPlanFromOpenclaw sends the modern OpenClaw request shape', async () => {
  await withFakeOpenclawEnv({
    WOLFDEN_FAKE_OPENCLAW_MODE: 'validate-request',
  }, async () => {
    const result = await buildMirrorPlanFromOpenclaw({
      config: {
        agentName: 'unit-openclaw',
        openclawAgentId: 'main',
        openclawThinking: 'medium',
        openclawTimeoutSeconds: 10,
      },
      openclawPlayerId: 'oc-player-1',
      planRequest: createPlanRequest(),
      referenceBundle,
    });

    assert.equal(result.payload.actionType, 'speech');
  });
});

test('buildMirrorPlanFromOpenclaw retries once without idempotencyKey when the CLI rejects it', async () => {
  await withFakeOpenclawEnv({
    WOLFDEN_FAKE_OPENCLAW_MODE: 'reject-idempotency-key',
  }, async () => {
    const result = await buildMirrorPlanFromOpenclaw({
      config: {
        agentName: 'unit-openclaw',
        openclawAgentId: 'main',
        openclawThinking: 'medium',
      },
      openclawPlayerId: 'oc-player-1',
      planRequest: createPlanRequest(),
      referenceBundle,
    });

    assert.equal(result.payload.actionType, 'speech');
  });
});

test('buildMirrorPlanFromOpenclaw caches the compat downgrade after the first idempotencyKey rejection', async () => {
  const recordDir = await mkdtemp(path.join(tmpdir(), 'wolfden-openclaw-agent-'));
  const recordPath = path.join(recordDir, 'requests.ndjson');

  await withFakeOpenclawEnv({
    WOLFDEN_FAKE_OPENCLAW_MODE: 'reject-idempotency-key',
    WOLFDEN_FAKE_OPENCLAW_RECORD_PATH: recordPath,
  }, async () => {
    await buildMirrorPlanFromOpenclaw({
      config: {
        agentName: 'unit-openclaw',
        openclawAgentId: 'main',
        openclawThinking: 'medium',
      },
      openclawPlayerId: 'oc-player-1',
      planRequest: createPlanRequest(),
      referenceBundle,
    });

    await buildMirrorPlanFromOpenclaw({
      config: {
        agentName: 'unit-openclaw',
        openclawAgentId: 'main',
        openclawThinking: 'medium',
      },
      openclawPlayerId: 'oc-player-1',
      planRequest: createPlanRequest(),
      referenceBundle,
    });
  });

  const records = (await readFile(recordPath, 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  assert.equal(records.length, 3);
  assert.equal(records.filter((record) => typeof record.params?.idempotencyKey === 'string').length, 1);
});

test('buildMirrorPlanFromOpenclaw retries once without agentId when the CLI rejects it', async () => {
  await withFakeOpenclawEnv({
    WOLFDEN_FAKE_OPENCLAW_MODE: 'reject-agent-id',
  }, async () => {
    const result = await buildMirrorPlanFromOpenclaw({
      config: {
        agentName: 'unit-openclaw',
        openclawAgentId: 'main',
        openclawThinking: 'medium',
      },
      openclawPlayerId: 'oc-player-1',
      planRequest: createPlanRequest(),
      referenceBundle,
    });

    assert.equal(result.payload.actionType, 'speech');
  });
});

test('buildMirrorPlanFromOpenclaw rejects invalid JSON from the OpenClaw CLI', async () => {
  await withFakeOpenclawEnv({
    WOLFDEN_FAKE_OPENCLAW_MODE: 'invalid-json',
  }, async () => {
    await assert.rejects(
      () => buildMirrorPlanFromOpenclaw({
        config: {
          agentName: 'unit-openclaw',
          openclawAgentId: 'main',
          openclawThinking: 'medium',
        },
        openclawPlayerId: 'oc-player-1',
        planRequest: createPlanRequest(),
        referenceBundle,
      }),
      /decision object/i,
    );
  });
});

test('buildMirrorPlanFromOpenclaw rejects illegal decisions from the OpenClaw CLI', async () => {
  await withFakeOpenclawEnv({
    WOLFDEN_FAKE_OPENCLAW_MODE: 'invalid-response',
  }, async () => {
    await assert.rejects(
      () => buildMirrorPlanFromOpenclaw({
        config: {
          agentName: 'unit-openclaw',
          openclawAgentId: 'main',
          openclawThinking: 'medium',
        },
        openclawPlayerId: 'oc-player-1',
        planRequest: createPlanRequest(),
        referenceBundle,
      }),
      /illegal actionType/i,
    );
  });
});

test('checkOpenclawRuntimeHealth unwraps wrapped healthcheck payloads', async () => {
  await withFakeOpenclawEnv({
    WOLFDEN_FAKE_OPENCLAW_MODE: 'success',
    WOLFDEN_FAKE_OPENCLAW_RESPONSE_SHAPE: 'result-payloads-text',
  }, async () => {
    const result = await checkOpenclawRuntimeHealth({
      agentName: 'unit-openclaw',
      openclawAgentId: 'main',
      openclawThinking: 'medium',
    });

    assert.equal(result.healthy, true);
    assert.match(result.detail, /reachable/i);
  });
});

test('checkOpenclawRuntimeHealth reports unhealthy when the agent loop payload is wrong', async () => {
  await withFakeOpenclawEnv({
    WOLFDEN_FAKE_OPENCLAW_MODE: 'health-fail',
  }, async () => {
    const result = await checkOpenclawRuntimeHealth({
      agentName: 'unit-openclaw',
      openclawAgentId: 'main',
      openclawThinking: 'medium',
    });

    assert.equal(result.healthy, false);
    assert.match(result.detail, /unexpected healthcheck payload/i);
  });
});
