import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const CONFIG_SCHEMA_VERSION = 1;
export const SESSION_SCHEMA_VERSION = 2;
export const PROCESS_SCHEMA_VERSION = 1;
export const DEFAULT_REPO_URL = 'https://github.com/AnonymousRic/wolf_claw';
export const DEFAULT_SITE_URL = 'https://wolfden-lyart.vercel.app';
export const DEFAULT_API_BASE_URL = 'https://wolfden.huanliu.qzz.io';
export const DEFAULT_AGENT_NAME = 'wolfden-openclaw-agent';
export const DEFAULT_ALLOWED_MATCH_MODES = ['human_mixed', 'ai_arena'];
export const DEFAULT_FEATURE_FLAGS = {
  allowForumAutopost: false,
  allowForumLearning: false,
  allowKnowledgeSync: false,
};
export const DEFAULT_CAPABILITIES = {
  humanMixed: true,
  aiArena: true,
  forumAutopost: false,
  forumLearning: false,
  knowledgeSync: false,
};
export const DEFAULT_PLATFORM_POLL_MS = 1500;
export const DEFAULT_TURN_POLL_MS = 600;
export const DEFAULT_PLATFORM_HEARTBEAT_INTERVAL_MS = 15_000;
export const DEFAULT_HOST_STATE_DIR = path.join(
  homedir(),
  '.wolfden',
  'openclaw-platform-player',
);

export function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/$/, '');
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isObject(value) {
  return typeof value === 'object' && value !== null;
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function getBoolEnv(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') {
    return fallback;
  }
  return value !== 'false' && value !== '0';
}

export function getNumberEnv(name, fallback) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class HttpError extends Error {
  constructor(message, statusCode, bodyText) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.bodyText = bodyText;
  }
}

export async function requestJson(baseUrl, requestPath, options = {}) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${requestPath}`, {
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

export function parseArgs(argv) {
  const flags = new Set();
  const values = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags.add(key);
      continue;
    }

    values.set(key, next);
    index += 1;
  }

  return { flags, values };
}

export function resolveHostStateDir() {
  return process.env.WOLFDEN_HOST_STATE_DIR
    ? path.resolve(process.env.WOLFDEN_HOST_STATE_DIR)
    : DEFAULT_HOST_STATE_DIR;
}

export function resolveRunnerPaths(configPathArg) {
  const configPath = configPathArg
    ? path.resolve(configPathArg)
    : path.join(resolveHostStateDir(), 'config.json');
  const hostStateDir = path.dirname(configPath);

  return {
    hostStateDir,
    configPath,
    sessionPath: path.join(hostStateDir, 'session.json'),
    logPath: path.join(hostStateDir, 'runner.log'),
    processPath: path.join(hostStateDir, 'process.json'),
  };
}

export async function ensureHostStateDir(paths) {
  await mkdir(paths.hostStateDir, { recursive: true });
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function normalizeArrayStrings(value, fallback) {
  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
    return normalized.length ? normalized : fallback;
  }

  if (typeof value === 'string') {
    const normalized = value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    return normalized.length ? normalized : fallback;
  }

  return fallback;
}

function normalizeFeatureFlags(raw) {
  const source = isObject(raw) ? raw : {};
  return {
    allowForumAutopost: Boolean(source.allowForumAutopost),
    allowForumLearning: Boolean(source.allowForumLearning),
    allowKnowledgeSync: Boolean(source.allowKnowledgeSync),
  };
}

export function normalizeSkillConfig(raw) {
  const source = isObject(raw) ? raw : {};
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    repoUrl: isNonEmptyString(source.repoUrl) ? source.repoUrl.trim() : DEFAULT_REPO_URL,
    siteUrl: normalizeBaseUrl(source.siteUrl ?? DEFAULT_SITE_URL),
    apiBaseUrl: normalizeBaseUrl(source.apiBaseUrl ?? DEFAULT_API_BASE_URL),
    bindCode: isNonEmptyString(source.bindCode) ? source.bindCode.trim() : null,
    agentName: isNonEmptyString(source.agentName) ? source.agentName.trim() : DEFAULT_AGENT_NAME,
    allowedMatchModes: normalizeArrayStrings(source.allowedMatchModes, DEFAULT_ALLOWED_MATCH_MODES),
    autoReady: source.autoReady !== false,
    autoAccept: source.autoAccept !== false,
    featureFlags: normalizeFeatureFlags(source.featureFlags),
  };
}

export async function loadSkillConfig(configPath) {
  const raw = await readJsonFile(configPath);
  return raw ? normalizeSkillConfig(raw) : null;
}

export async function saveSkillConfig(configPath, config) {
  const normalized = normalizeSkillConfig(config);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

export async function clearBindCodeFromConfig(configPath) {
  const currentConfig = await loadSkillConfig(configPath);
  if (!currentConfig || currentConfig.bindCode === null) {
    return currentConfig;
  }

  return saveSkillConfig(configPath, {
    ...currentConfig,
    bindCode: null,
  });
}

export function normalizeSession(raw) {
  if (!isObject(raw)) {
    return null;
  }

  if (raw.schemaVersion !== SESSION_SCHEMA_VERSION) {
    return null;
  }

  if (
    !isNonEmptyString(raw.apiBaseUrl)
    || !isNonEmptyString(raw.openclawPlayerId)
    || !isNonEmptyString(raw.sessionToken)
  ) {
    return null;
  }

  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    apiBaseUrl: normalizeBaseUrl(raw.apiBaseUrl),
    openclawPlayerId: raw.openclawPlayerId,
    sessionToken: raw.sessionToken,
    agentName: isNonEmptyString(raw.agentName) ? raw.agentName : DEFAULT_AGENT_NAME,
    savedAt: isNonEmptyString(raw.savedAt) ? raw.savedAt : new Date().toISOString(),
  };
}

export async function loadSession(sessionPath) {
  const raw = await readJsonFile(sessionPath);
  const normalized = normalizeSession(raw);
  if (raw && !normalized) {
    await clearSession(sessionPath);
  }
  return normalized;
}

export async function saveSession(sessionPath, session) {
  const nextSession = normalizeSession({
    schemaVersion: SESSION_SCHEMA_VERSION,
    ...session,
    savedAt: new Date().toISOString(),
  });
  if (!nextSession) {
    throw new Error('Cannot save an invalid WolfDen session payload.');
  }
  await mkdir(path.dirname(sessionPath), { recursive: true });
  await writeFile(sessionPath, `${JSON.stringify(nextSession, null, 2)}\n`, 'utf8');
  return nextSession;
}

export async function clearSession(sessionPath) {
  await rm(sessionPath, { force: true });
}

export function normalizeProcessRecord(raw) {
  if (!isObject(raw)) {
    return null;
  }

  if (raw.schemaVersion !== PROCESS_SCHEMA_VERSION || !isNonEmptyString(raw.sessionId)) {
    return null;
  }

  return {
    schemaVersion: PROCESS_SCHEMA_VERSION,
    sessionId: raw.sessionId,
    pid: typeof raw.pid === 'number' ? raw.pid : null,
    startedAt: isNonEmptyString(raw.startedAt) ? raw.startedAt : null,
    configPath: isNonEmptyString(raw.configPath) ? raw.configPath : null,
    mode: isNonEmptyString(raw.mode) ? raw.mode : 'detached',
  };
}

export async function loadProcessRecord(processPath) {
  const raw = await readJsonFile(processPath);
  return normalizeProcessRecord(raw);
}

export async function saveProcessRecord(processPath, processRecord) {
  const nextRecord = normalizeProcessRecord({
    schemaVersion: PROCESS_SCHEMA_VERSION,
    ...processRecord,
  });
  if (!nextRecord) {
    throw new Error('Cannot save an invalid process record.');
  }
  await mkdir(path.dirname(processPath), { recursive: true });
  await writeFile(processPath, `${JSON.stringify(nextRecord, null, 2)}\n`, 'utf8');
  return nextRecord;
}

export function createSessionId(prefix = 'session') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createLogger(logPath) {
  async function write(level, message, payload) {
    const entry = `${new Date().toISOString()} [${level}] ${message}${payload ? ` ${JSON.stringify(payload)}` : ''}\n`;
    const printer = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    printer(entry.trimEnd());
    await appendFile(logPath, entry, 'utf8').catch(() => undefined);
  }

  return {
    info(message, payload) {
      return write('info', message, payload);
    },
    warn(message, payload) {
      return write('warn', message, payload);
    },
    error(message, payload) {
      return write('error', message, payload);
    },
  };
}

export async function waitForPlayerReady(baseUrl, agentName, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastProfile = null;

  while (Date.now() < deadline) {
    try {
      lastProfile = await requestJson(baseUrl, '/api/openclaw/profile');
      const readyPlayer = lastProfile?.players?.find((player) => (
        (player.agentName === agentName || player.displayName === agentName)
        && (player.status === 'ready' || player.status === 'online')
      ));
      if (readyPlayer) {
        return readyPlayer;
      }
    } catch {
      // Keep polling until the timeout.
    }

    await sleep(1000);
  }

  throw new Error(`Timed out waiting for OpenClaw player ${agentName} to become ready.`);
}
