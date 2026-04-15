import { spawn } from 'node:child_process';
import process from 'node:process';
import {
  DEFAULT_OPENCLAW_AGENT_ID,
  DEFAULT_OPENCLAW_THINKING,
} from './common.mjs';

const OPENCLAW_MAX_SPEECH_CHARS = 180;
const OPENCLAW_MAX_SPEECH_SEGMENTS = 3;
const compatRejectedParamKeys = new Set();

export function __resetOpenclawCompatCacheForTests() {
  compatRejectedParamKeys.clear();
}

function compactText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

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

function trimReferenceContent(content, maxLength = 900) {
  const normalized = String(content ?? '').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 3)}...`;
}

function buildReferenceSummary(referenceBundle, role, phase) {
  const roleDocument = referenceBundle?.roleDocuments?.[role]
    ?? referenceBundle?.roleDocuments?.villager
    ?? null;
  const phaseDocument = referenceBundle?.phaseDocuments?.[resolvePhaseReferenceKey(phase)]
    ?? referenceBundle?.phaseDocuments?.day
    ?? null;

  return {
    core: Array.isArray(referenceBundle?.coreDocuments)
      ? referenceBundle.coreDocuments.map((document) => ({
          path: document.path,
          content: trimReferenceContent(document.content, 700),
        }))
      : [],
    role: roleDocument
      ? {
          path: roleDocument.path,
          content: trimReferenceContent(roleDocument.content),
        }
      : null,
    phase: phaseDocument
      ? {
          path: phaseDocument.path,
          content: trimReferenceContent(phaseDocument.content),
        }
      : null,
  };
}

function buildSharedPromptBody({ payload, role, phase }) {
  return [
    'You are operating exactly one WolfDen player seat through OpenClaw.',
    'Return exactly one JSON object and nothing else.',
    'Never output markdown, code fences, or explanatory prose outside the JSON object.',
    'Only choose an actionType that exists in legalActions.',
    'Only choose targets from allowedTargetIds, and satisfy min/max target counts.',
    'If the chosen legal action requires speech, include speech.segments and speech.charCount.',
    'If the chosen legal action does not require speech, omit speech.',
    'reasoningSummary must be short and should explain the role/phase logic behind the action.',
    `Current role: ${role || 'unknown'}. Current phase: ${phase || 'unknown'}.`,
    'Output schema:',
    '{"actionType":"string","targetPlayerId":"string|null","targetPlayerIds":["string"]|null,"speech":{"segments":["string"],"charCount":0},"reasoningSummary":"string"}',
    'Decision payload:',
    JSON.stringify(payload),
  ].join('\n');
}

function buildMirrorPrompt(planRequest, referenceBundle) {
  const payload = {
    matchId: planRequest.matchId,
    playerId: planRequest.playerId,
    phase: planRequest.phase,
    deadlineMs: planRequest.deadlineMs,
    legalActions: planRequest.legalActions,
    privateState: planRequest.privateState,
    publicContext: {
      matchId: planRequest.publicContext?.backgroundDigest?.matchId ?? planRequest.matchId,
      day: planRequest.publicContext?.day ?? null,
      turn: planRequest.publicContext?.turn ?? null,
      scoreboard: planRequest.publicContext?.scoreboard ?? null,
      tableState: planRequest.publicContext?.tableState ?? null,
      backgroundDigest: planRequest.publicContext?.backgroundDigest ?? null,
      historyDigest: planRequest.publicContext?.historyDigest ?? null,
    },
    decisionContext: planRequest.decisionContext,
    references: buildReferenceSummary(
      referenceBundle,
      planRequest.privateState?.role ?? planRequest.decisionContext?.identity?.role,
      planRequest.phase,
    ),
  };

  return buildSharedPromptBody({
    payload,
    role: planRequest.privateState?.role ?? planRequest.decisionContext?.identity?.role,
    phase: planRequest.phase,
  });
}

function buildSeatPrompt(turn, referenceBundle) {
  const payload = {
    matchId: turn.matchId,
    playerId: turn.playerId,
    phase: turn.phase,
    deadlineAt: turn.phaseDeadlineAt ?? null,
    legalActions: turn.legalActions ?? [],
    privateState: turn.privateState ?? null,
    visibleHistory: turn.events ?? [],
    objectiveText: turn.objectiveText ?? '',
    references: buildReferenceSummary(referenceBundle, turn.privateState?.role, turn.phase),
  };

  return buildSharedPromptBody({
    payload,
    role: turn.privateState?.role ?? 'unknown',
    phase: turn.phase,
  });
}

function parseExtraArgs(raw) {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed;
    }
  } catch {
    // Fall through to the whitespace split below for local debugging convenience.
  }

  return raw
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function resolveOpenclawCommand() {
  return {
    bin: process.env.WOLFDEN_OPENCLAW_BIN || 'openclaw',
    extraArgs: parseExtraArgs(process.env.WOLFDEN_OPENCLAW_BIN_ARGS),
  };
}

function resolveLocalTimeoutSeconds(config, deadlineMs, fallbackMs = 12_000) {
  const platformBudgetMs = Number.isFinite(deadlineMs) && deadlineMs > 0
    ? deadlineMs
    : fallbackMs;
  const configuredTimeoutMs = Number.isFinite(config?.openclawTimeoutSeconds) && config.openclawTimeoutSeconds > 0
    ? config.openclawTimeoutSeconds * 1000
    : Number.POSITIVE_INFINITY;
  const boundedMs = Math.max(2_000, Math.min(platformBudgetMs, configuredTimeoutMs, 30_000));
  return Math.max(2, Math.ceil(boundedMs / 1000));
}

function buildSessionKey(config, openclawPlayerId, matchId, playerId) {
  return `wolfden:${openclawPlayerId}:${matchId}:${playerId}`;
}

function buildHealthcheckSessionKey(config, agentName) {
  return `wolfden:health:${agentName || 'unknown-agent'}`;
}

function callOpenclawGateway(params, timeoutSeconds) {
  const command = resolveOpenclawCommand();
  const args = [
    ...command.extraArgs,
    'gateway',
    'call',
    'agent',
    '--params',
    JSON.stringify(params),
    '--expect-final',
    '--json',
  ];

  if (process.env.WOLFDEN_OPENCLAW_GATEWAY_URL) {
    args.push('--url', process.env.WOLFDEN_OPENCLAW_GATEWAY_URL);
  }
  if (process.env.WOLFDEN_OPENCLAW_GATEWAY_TOKEN) {
    args.push('--token', process.env.WOLFDEN_OPENCLAW_GATEWAY_TOKEN);
  }
  if (process.env.WOLFDEN_OPENCLAW_GATEWAY_PASSWORD) {
    args.push('--password', process.env.WOLFDEN_OPENCLAW_GATEWAY_PASSWORD);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command.bin, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, Math.max(2_000, timeoutSeconds * 1000 + 1000));

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error('OpenClaw agent run timed out.'));
        return;
      }
      if (code !== 0) {
        reject(new Error(`OpenClaw gateway call failed with exit code ${code}: ${stderr.trim() || stdout.trim() || 'no output'}`));
        return;
      }
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

function sanitizeIdempotencyPart(value, fallback = 'unknown') {
  const normalized = compactText(value ?? fallback).replace(/[^a-zA-Z0-9:_-]/g, '-');
  return normalized || fallback;
}

function buildIdempotencyKey(...parts) {
  return parts.map((part, index) => sanitizeIdempotencyPart(part, `part-${index + 1}`)).join(':');
}

function buildAgentParams({ config, prompt, sessionKey, idempotencyKey }) {
  const params = {
    message: prompt,
    sessionKey,
    deliver: false,
    thinking: config?.openclawThinking || DEFAULT_OPENCLAW_THINKING,
  };
  if (!compatRejectedParamKeys.has('agentId')) {
    params.agentId = config?.openclawAgentId || DEFAULT_OPENCLAW_AGENT_ID;
  }
  if (!compatRejectedParamKeys.has('idempotencyKey')) {
    params.idempotencyKey = idempotencyKey;
  }
  return params;
}

function resolveCompatDowngradeKeys(error) {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  const rejectedKeys = [];

  if (lowered.includes('idempotencykey') || lowered.includes('idempotency key')) {
    rejectedKeys.push('idempotencyKey');
  }
  if (lowered.includes('agentid') || lowered.includes('agent id')) {
    rejectedKeys.push('agentId');
  }

  return rejectedKeys;
}

async function callOpenclawGatewayWithCompat(params, timeoutSeconds) {
  try {
    return await callOpenclawGateway(params, timeoutSeconds);
  } catch (error) {
    const rejectedKeys = resolveCompatDowngradeKeys(error);
    if (!rejectedKeys.length) {
      throw error;
    }

    const downgradedParams = { ...params };
    for (const key of rejectedKeys) {
      compatRejectedParamKeys.add(key);
      delete downgradedParams[key];
    }
    return callOpenclawGateway(downgradedParams, timeoutSeconds);
  }
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractJsonObjectFromText(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) {
    return null;
  }

  const direct = tryParseJson(trimmed);
  if (direct) {
    return direct;
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    const fenced = tryParseJson(fenceMatch[1].trim());
    if (fenced) {
      return fenced;
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return tryParseJson(trimmed.slice(firstBrace, lastBrace + 1));
  }

  return null;
}

function findNestedObject(value, predicate, visited = new Set()) {
  if (value == null) {
    return null;
  }

  if (typeof value === 'string') {
    const parsed = extractJsonObjectFromText(value);
    return parsed ? findNestedObject(parsed, predicate, visited) : null;
  }

  if (typeof value !== 'object') {
    return null;
  }

  if (visited.has(value)) {
    return null;
  }
  visited.add(value);

  if (predicate(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findNestedObject(item, predicate, visited);
      if (match) {
        return match;
      }
    }
    return null;
  }

  for (const child of Object.values(value)) {
    const match = findNestedObject(child, predicate, visited);
    if (match) {
      return match;
    }
  }

  return null;
}

function parseOpenclawOutput(stdout, predicate) {
  const direct = extractJsonObjectFromText(stdout);
  if (direct) {
    return findNestedObject(direct, predicate);
  }

  const lines = String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = extractJsonObjectFromText(lines[index]);
    if (!parsed) {
      continue;
    }
    const match = findNestedObject(parsed, predicate);
    if (match) {
      return match;
    }
  }

  return null;
}

function normalizeSpeech(decision, legalAction) {
  const requiresSpeech = (legalAction?.minTextLength ?? 0) > 0 || legalAction?.actionType === 'speech';
  let segments = null;

  if (decision?.speech && typeof decision.speech === 'object' && Array.isArray(decision.speech.segments)) {
    segments = decision.speech.segments;
  } else if (typeof decision?.speech === 'string') {
    segments = decision.speech
      .split(/\n+/)
      .map((segment) => compactText(segment))
      .filter(Boolean);
  } else if (typeof decision?.text === 'string') {
    segments = decision.text
      .split(/\n+/)
      .map((segment) => compactText(segment))
      .filter(Boolean);
  }

  const normalizedSegments = segments
    ? segments
        .map((segment) => compactText(segment))
        .filter(Boolean)
        .slice(0, OPENCLAW_MAX_SPEECH_SEGMENTS)
    : [];
  const fullText = normalizedSegments.join('\n').slice(0, OPENCLAW_MAX_SPEECH_CHARS);

  if (!requiresSpeech && !fullText) {
    return null;
  }

  if (requiresSpeech && !fullText) {
    throw new Error('OpenClaw returned no speech for a speech-required action.');
  }

  if (fullText.length < (legalAction?.minTextLength ?? 0)) {
    throw new Error('OpenClaw returned speech shorter than the required minimum.');
  }

  if (fullText.length > (legalAction?.maxTextLength ?? OPENCLAW_MAX_SPEECH_CHARS)) {
    throw new Error('OpenClaw returned speech longer than the legal limit.');
  }

  return {
    segments: fullText.split('\n').filter(Boolean).slice(0, OPENCLAW_MAX_SPEECH_SEGMENTS),
    charCount: fullText.length,
  };
}

function normalizeTargets(decision, legalAction) {
  const targetIds = Array.from(new Set(
    Array.isArray(decision?.targetPlayerIds) && decision.targetPlayerIds.length > 0
      ? decision.targetPlayerIds
      : decision?.targetPlayerId
        ? [decision.targetPlayerId]
        : [],
  ));

  if (targetIds.length < (legalAction?.minTargetCount ?? 0)) {
    throw new Error('OpenClaw returned too few targets for the legal action.');
  }
  if (targetIds.length > (legalAction?.maxTargetCount ?? 1)) {
    throw new Error('OpenClaw returned too many targets for the legal action.');
  }
  if (!targetIds.every((targetId) => legalAction.allowedTargetIds.includes(targetId))) {
    throw new Error('OpenClaw returned an illegal target.');
  }

  if (targetIds.length === 0) {
    return {};
  }

  return legalAction.maxTargetCount > 1
    ? { targetPlayerIds: targetIds }
    : { targetPlayerId: targetIds[0] };
}

function normalizeDecision(decision, legalActions) {
  if (!decision || typeof decision !== 'object') {
    throw new Error('OpenClaw agent did not return a decision object.');
  }

  const legalAction = legalActions.find((action) => action.actionType === decision.actionType);
  if (!legalAction) {
    throw new Error(`OpenClaw returned an illegal actionType: ${decision.actionType ?? 'unknown'}`);
  }

  const normalized = {
    actionType: legalAction.actionType,
    ...normalizeTargets(decision, legalAction),
  };
  const speech = normalizeSpeech(decision, legalAction);
  if (speech) {
    normalized.speech = speech;
  }

  const reasoningSummary = compactText(
    decision.reasoningSummary
    ?? decision.reasoning
    ?? decision.summary
    ?? '',
  ).slice(0, 400);

  return {
    ...normalized,
    ...(reasoningSummary ? { reasoningSummary } : {}),
  };
}

async function runAgentPrompt({
  config,
  sessionKey,
  prompt,
  deadlineMs,
  idempotencyKey,
}) {
  const timeoutSeconds = resolveLocalTimeoutSeconds(config, deadlineMs);
  const params = buildAgentParams({
    config,
    prompt,
    sessionKey,
    idempotencyKey,
  });
  const startedAt = Date.now();
  const result = await callOpenclawGatewayWithCompat(params, timeoutSeconds);
  return {
    output: result.stdout,
    latencyMs: Date.now() - startedAt,
    timeoutSeconds,
  };
}

export async function checkOpenclawRuntimeHealth(config) {
  const timeoutSeconds = resolveLocalTimeoutSeconds(config, 8_000, 8_000);
  const sessionKey = buildHealthcheckSessionKey(config, config?.agentName);
  const params = buildAgentParams({
    config,
    prompt: 'Return exactly {"ok":true,"runtime":"openclaw-agent-loop"} and nothing else.',
    sessionKey,
    idempotencyKey: buildIdempotencyKey('wolfden-health', config?.agentName, Date.now()),
  });
  const startedAt = Date.now();

  try {
    const result = await callOpenclawGatewayWithCompat(params, timeoutSeconds);
    const payload = parseOpenclawOutput(result.stdout, (value) => value && value.ok === true);
    if (!payload || payload.ok !== true) {
      return {
        healthy: false,
        latencyMs: Date.now() - startedAt,
        detail: `OpenClaw agent loop returned an unexpected healthcheck payload: ${compactText(result.stdout).slice(0, 180) || 'empty output'}`,
      };
    }
    return {
      healthy: true,
      latencyMs: Date.now() - startedAt,
      detail: 'OpenClaw agent loop is reachable.',
    };
  } catch (error) {
    return {
      healthy: false,
      latencyMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function buildMirrorPlanFromOpenclaw({
  config,
  openclawPlayerId,
  planRequest,
  referenceBundle,
}) {
  const sessionKey = buildSessionKey(config, openclawPlayerId, planRequest.matchId, planRequest.playerId);
  const prompt = buildMirrorPrompt(planRequest, referenceBundle);
  const result = await runAgentPrompt({
    config,
    openclawPlayerId,
    sessionKey,
    prompt,
    deadlineMs: planRequest.deadlineMs ?? planRequest.decisionContext?.phase?.modelHardTimeoutMs ?? 12_000,
    idempotencyKey: buildIdempotencyKey('wolfden-plan', planRequest.requestId, planRequest.fingerprint),
  });
  const decision = normalizeDecision(
    parseOpenclawOutput(result.output, (value) => typeof value?.actionType === 'string'),
    planRequest.legalActions ?? [],
  );

  return {
    payload: {
      requestId: planRequest.requestId,
      fingerprint: planRequest.fingerprint,
      clientActionId: `wolfden-openclaw-${Date.now()}`,
      ...decision,
    },
    latencyMs: result.latencyMs,
  };
}

export async function buildSeatActionFromOpenclaw({
  config,
  openclawPlayerId,
  turn,
  referenceBundle,
}) {
  const sessionKey = buildSessionKey(config, openclawPlayerId, turn.matchId, turn.playerId);
  const prompt = buildSeatPrompt(turn, referenceBundle);
  const deadlineMs = turn.phaseDeadlineAt
    ? Math.max(0, new Date(turn.phaseDeadlineAt).getTime() - Date.now())
    : 12_000;
  const result = await runAgentPrompt({
    config,
    sessionKey,
    prompt,
    deadlineMs,
    idempotencyKey: buildIdempotencyKey('wolfden-seat', turn.turnToken ?? turn.matchId, turn.playerId, turn.phase),
  });
  const decision = normalizeDecision(
    parseOpenclawOutput(result.output, (value) => typeof value?.actionType === 'string'),
    turn.legalActions ?? [],
  );

  return {
    action: {
      clientActionId: `wolfden-seat-${Date.now()}`,
      actionType: decision.actionType,
      ...(decision.targetPlayerIds?.length
        ? { targetPlayerIds: decision.targetPlayerIds }
        : decision.targetPlayerId
          ? { targetPlayerId: decision.targetPlayerId }
          : {}),
      ...(decision.speech ? { text: decision.speech.segments.join('\n') } : {}),
    },
    latencyMs: result.latencyMs,
  };
}
