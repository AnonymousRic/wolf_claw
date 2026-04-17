// Legacy legality-first heuristics kept only for debugging and emergency comparison.
// The production OpenClaw skill path now goes through openclaw-agent.mjs and
// `openclaw gateway call agent --expect-final --json` instead of using this file.

function hashText(input) {
  let hash = 0;
  for (const char of String(input ?? '')) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

function deterministicFloat(seed) {
  return (hashText(seed) % 10_000) / 10_000;
}

function sheriffRunFloat(seed) {
  let value = hashText(seed) ^ 0x9e3779b9;
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  value ^= value >>> 16;
  return (value >>> 0) / 0x1_0000_0000;
}

function deterministicChoice(items, seed) {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }
  return items[hashText(seed) % items.length] ?? null;
}

function noteValue(notes, prefix) {
  return (notes ?? []).find((note) => String(note).startsWith(`${prefix}:`))?.slice(prefix.length + 1) ?? null;
}

function parseCsvNote(value) {
  return value && value !== 'none' ? value.split(',').filter(Boolean) : [];
}

function seatIndex(context, playerId) {
  const index = context.seatOrder.indexOf(playerId);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function sortBySeat(context, playerIds) {
  return Array.from(new Set(playerIds)).sort((left, right) => {
    const delta = seatIndex(context, left) - seatIndex(context, right);
    return delta !== 0 ? delta : String(left).localeCompare(String(right));
  });
}

function chooseFixedFakeClaimWerewolf(context) {
  if (context.role !== 'werewolf') {
    return null;
  }
  return deterministicChoice(
    sortBySeat(context, [...context.allies, context.playerId]),
    `${context.matchId}:fake-claim-wolf`,
  );
}

function shouldRunForSheriff(context) {
  if (context.role === 'seer') {
    return true;
  }
  if (context.role === 'werewolf') {
    return chooseFixedFakeClaimWerewolf(context) === context.playerId;
  }
  return sheriffRunFloat(`${context.matchId}:sheriff-run:${context.playerId}`) < 0.5;
}

function getPassAction(context) {
  return context.legalActions.find((action) => action.actionType === 'pass') ?? null;
}

function getPrimaryAction(context) {
  return context.legalActions.find((action) => action.actionType !== 'pass')
    ?? getPassAction(context)
    ?? context.legalActions[0]
    ?? null;
}

function buildTargetPool(context, action) {
  return action.allowedTargetIds.filter((targetPlayerId) => (
    context.role !== 'werewolf' || !context.allies.includes(targetPlayerId)
  ));
}

function scoreTarget(context, targetPlayerId, actionType) {
  let score = 0;
  const recentEvents = Array.isArray(context.visibleHistory) ? context.visibleHistory.slice(-12) : [];
  const targetSeatLabel = `${(seatIndex(context, targetPlayerId) ?? 99) + 1}号`;

  recentEvents.forEach((event, index) => {
    const recencyWeight = recentEvents.length - index;
    if (event.actorPlayerId === targetPlayerId) {
      score += actionType === 'werewolf_kill' ? recencyWeight * 1.1 : recencyWeight * 0.8;
    }
    if (event?.payload?.targetPlayerId === targetPlayerId) {
      score += recencyWeight * 0.55;
    }
    if (event?.payload?.sheriffPlayerId === targetPlayerId) {
      score += recencyWeight * 0.7;
    }
    if (String(event.publicText ?? '').includes(targetSeatLabel)) {
      score += recencyWeight * 0.16;
    }
  });

  if (context.sheriffPlayerId === targetPlayerId) {
    score += actionType === 'werewolf_kill' ? 6 : 1.4;
  }
  score += deterministicFloat(`${context.matchId}:${context.phase}:${context.playerId}:${actionType}:${targetPlayerId}`);
  return score;
}

function chooseScoredTarget(context, action) {
  const pool = buildTargetPool(context, action);
  return pool
    .slice()
    .sort((left, right) => (
      scoreTarget(context, right, action.actionType) - scoreTarget(context, left, action.actionType)
      || seatIndex(context, left) - seatIndex(context, right)
    ))[0] ?? null;
}

function buildSpeech(role, phase, targetPlayerId) {
  if (phase === 'night_werewolf') {
    return targetPlayerId
      ? `我先把刀口压在${targetPlayerId}，等队友统一。`
      : '我先给出稳定刀口，等队友统一。';
  }
  if (phase.endsWith('vote')) {
    return '我会结合发言、警徽和票型给出本轮投票。';
  }
  if (phase === 'sheriff_nominate') {
    return role === 'seer'
      ? '这轮我选择上警，争取掌握警徽节奏。'
      : '我会按当前身份策略决定是否上警。';
  }
  if (phase === 'night_seer') {
    return '我会优先查验当前最值得关注的存活玩家。';
  }
  if (phase === 'night_witch') {
    return '我会按夜间信息决定是否动药。';
  }
  if (phase === 'hunter_shot') {
    return '我会优先处理对局面影响最大的目标。';
  }
  return '我会继续结合公开信息推进当前回合判断。';
}

function chooseAction(context) {
  const passAction = getPassAction(context);
  const primaryAction = getPrimaryAction(context);
  if (!primaryAction) {
    return { actionType: 'pass' };
  }

  if (primaryAction.actionType === 'sheriff_run') {
    if (shouldRunForSheriff(context)) {
      return {
        actionType: primaryAction.actionType,
        targetPlayerId: primaryAction.allowedTargetIds[0] ?? null,
      };
    }
    return { actionType: passAction?.actionType ?? 'pass' };
  }

  if (primaryAction.actionType === 'sheriff_direction') {
    return {
      actionType: primaryAction.actionType,
      targetPlayerId: context.role === 'werewolf' ? 'left' : 'right',
    };
  }

  if (primaryAction.actionType === 'sheriff_call_vote') {
    const targetPlayerId = chooseScoredTarget(context, primaryAction);
    return targetPlayerId
      ? { actionType: primaryAction.actionType, targetPlayerIds: [targetPlayerId], targetPlayerId }
      : { actionType: passAction?.actionType ?? 'pass' };
  }

  if (primaryAction.actionType === 'witch_poison') {
    return { actionType: passAction?.actionType ?? 'pass' };
  }

  if (primaryAction.actionType === 'witch_save') {
    return {
      actionType: primaryAction.actionType,
      targetPlayerId: primaryAction.allowedTargetIds[0] ?? null,
    };
  }

  if (['seer_check', 'vote', 'werewolf_kill', 'hunter_shot'].includes(primaryAction.actionType)) {
    const targetPlayerId = chooseScoredTarget(context, primaryAction)
      ?? deterministicChoice(primaryAction.allowedTargetIds, `${context.matchId}:${context.playerId}:${primaryAction.actionType}`);
    return targetPlayerId
      ? { actionType: primaryAction.actionType, targetPlayerId }
      : { actionType: passAction?.actionType ?? 'pass' };
  }

  if (primaryAction.allowedTargetIds.length === 0) {
    return { actionType: primaryAction.actionType };
  }

  return {
    actionType: primaryAction.actionType,
    targetPlayerId: primaryAction.allowedTargetIds[0] ?? null,
  };
}

function inferSeatOrderFromIds(playerIds) {
  return Array.from(new Set(playerIds))
    .sort((left, right) => {
      const leftSeat = Number(String(left).split('-').at(-1));
      const rightSeat = Number(String(right).split('-').at(-1));
      if (Number.isFinite(leftSeat) && Number.isFinite(rightSeat)) {
        return leftSeat - rightSeat;
      }
      return String(left).localeCompare(String(right));
    });
}

function buildDecisionContextFromRequest(request) {
  const privateNotes = request.privateNotes ?? [];
  const role = noteValue(privateNotes, 'role') ?? request.privateState?.role ?? 'villager';
  const sheriffPlayerId = noteValue(privateNotes, 'sheriff');
  const seatOrderNote = noteValue(privateNotes, 'seat_order');

  return {
    matchId: request.matchId,
    playerId: request.playerId,
    phase: request.phase,
    legalActions: request.legalActions ?? [],
    visibleHistory: request.visibleHistory ?? [],
    role,
    allies: parseCsvNote(noteValue(privateNotes, 'allies')).length > 0
      ? parseCsvNote(noteValue(privateNotes, 'allies'))
      : (request.privateState?.allies ?? []).map((ally) => ally.playerId),
    sheriffPlayerId: sheriffPlayerId && sheriffPlayerId !== 'none'
      ? sheriffPlayerId
      : request.publicContext?.scoreboard?.sheriffPlayerId ?? null,
    sheriffCallPlayerIds: parseCsvNote(noteValue(privateNotes, 'sheriff_call')),
    seatOrder: seatOrderNote
      ? seatOrderNote.split(',').filter(Boolean)
      : inferSeatOrderFromIds([
          request.playerId,
          ...(request.legalActions ?? []).flatMap((action) => action.allowedTargetIds ?? []),
          ...(request.visibleHistory ?? []).flatMap((event) => [event.actorPlayerId].filter(Boolean)),
        ]),
  };
}

function toSpeechPlan(
  text,
  maxSpeechChars = 602,
  maxSpeechSegments = 3,
  maxSpeechSegmentChars = 200,
) {
  const normalized = String(text ?? '').trim();
  if (!normalized) {
    return null;
  }

  const segments = normalized
    .split(/\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .flatMap((segment) => {
      const wrapped = [];
      for (let index = 0; index < segment.length; index += maxSpeechSegmentChars) {
        wrapped.push(segment.slice(index, index + maxSpeechSegmentChars));
      }
      return wrapped;
    })
    .slice(0, maxSpeechSegments);
  const finalSegments = [];
  let totalChars = 0;

  for (const segment of (segments.length > 0 ? segments : [normalized.slice(0, maxSpeechSegmentChars)])) {
    if (finalSegments.length >= maxSpeechSegments) {
      break;
    }
    const separatorChars = totalChars > 0 ? 1 : 0;
    const remainingChars = maxSpeechChars - totalChars - separatorChars;
    if (remainingChars <= 0) {
      break;
    }
    const chunk = segment.slice(0, Math.min(maxSpeechSegmentChars, remainingChars));
    if (!chunk) {
      break;
    }
    finalSegments.push(chunk);
    totalChars += separatorChars + chunk.length;
  }

  const fullText = finalSegments.join('\n');

  return {
    segments: finalSegments,
    charCount: fullText.length,
  };
}

function buildFallbackDecision(request) {
  const context = buildDecisionContextFromRequest(request);
  const choice = chooseAction(context);
  const primaryAction = getPrimaryAction(context);
  const requiresSpeech = Boolean(primaryAction?.minTextLength > 0 || choice.actionType === 'speech');
  return {
    actionType: choice.actionType,
    targetPlayerId: choice.targetPlayerId ?? null,
    targetPlayerIds: choice.targetPlayerIds ?? null,
    speech: requiresSpeech ? toSpeechPlan(buildSpeech(context.role, context.phase, choice.targetPlayerId)) : undefined,
  };
}

function normalizeBaselineDecision(decision, request) {
  if (!decision || typeof decision !== 'object') {
    return buildFallbackDecision(request);
  }

  const primaryAction = (request.legalActions ?? []).find((action) => action.actionType === decision.actionType)
    ?? (request.legalActions ?? []).find((action) => action.actionType !== 'pass')
    ?? request.legalActions?.[0]
    ?? null;
  const speech = decision.speech?.segments?.length
    ? {
        segments: decision.speech.segments.slice(0, request.decisionContext?.responseSchema?.maxSpeechSegments ?? 3),
        charCount: decision.speech.charCount,
      }
    : undefined;

  return {
    actionType: primaryAction?.actionType ?? decision.actionType ?? 'pass',
    targetPlayerId: decision.targetPlayerId ?? null,
    targetPlayerIds: decision.targetPlayerIds ?? null,
    speech,
  };
}

export function buildMirrorPlanPayload(planRequest) {
  const baselineDecision = normalizeBaselineDecision(
    planRequest?.decisionContext?.baselineDecision,
    planRequest?.decisionContext?.decisionRequest ?? planRequest,
  );
  const fallbackDecision = buildFallbackDecision(planRequest?.decisionContext?.decisionRequest ?? planRequest);
  const finalDecision = baselineDecision.actionType ? baselineDecision : fallbackDecision;

  return {
    requestId: planRequest.requestId,
    fingerprint: planRequest.fingerprint,
    clientActionId: `wolfden-plan-${Date.now()}`,
    actionType: finalDecision.actionType,
    ...(finalDecision.targetPlayerIds?.length
      ? { targetPlayerIds: finalDecision.targetPlayerIds }
      : finalDecision.targetPlayerId
        ? { targetPlayerId: finalDecision.targetPlayerId }
        : {}),
    ...(finalDecision.speech ? { speech: finalDecision.speech } : {}),
  };
}

export function buildSeatAction(turn) {
  const synthesizedRequest = {
    matchId: turn.matchId,
    playerId: turn.playerId,
    phase: turn.phase,
    legalActions: turn.legalActions ?? [],
    visibleHistory: turn.events ?? [],
    privateState: turn.privateState ?? null,
    publicContext: null,
  };
  const decision = buildFallbackDecision(synthesizedRequest);

  return {
    clientActionId: `wolfden-seat-${Date.now()}`,
    actionType: decision.actionType,
    ...(decision.targetPlayerIds?.length
      ? { targetPlayerIds: decision.targetPlayerIds }
      : decision.targetPlayerId
        ? { targetPlayerId: decision.targetPlayerId }
        : {}),
    ...(decision.speech ? { text: decision.speech.segments.join('\n') } : {}),
  };
}
