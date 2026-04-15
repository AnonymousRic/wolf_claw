import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  createLogger,
  createSessionId,
  ensureHostStateDir,
  loadSkillConfig,
  normalizeSkillConfig,
  parseArgs,
  resolveRunnerPaths,
  saveProcessRecord,
  saveSkillConfig,
  waitForPlayerReady,
} from './common.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveRunnerPaths(args.values.get('config') ?? process.env.WOLFDEN_CONFIG_PATH);
  await ensureHostStateDir(paths);
  const logger = createLogger(paths.logPath);
  const existingConfig = await loadSkillConfig(paths.configPath);
  const config = normalizeSkillConfig({
    ...existingConfig,
    ...(process.env.OPENCLAW_SKILL_REPO_URL ? { repoUrl: process.env.OPENCLAW_SKILL_REPO_URL } : {}),
    ...(process.env.OPENCLAW_PLATFORM_SITE_URL ? { siteUrl: process.env.OPENCLAW_PLATFORM_SITE_URL } : {}),
    ...(process.env.OPENCLAW_PLATFORM_API_BASE_URL ? { apiBaseUrl: process.env.OPENCLAW_PLATFORM_API_BASE_URL } : {}),
    ...(process.env.WOLFDEN_API_BASE_URL ? { apiBaseUrl: process.env.WOLFDEN_API_BASE_URL } : {}),
    ...(process.env.WOLFDEN_BIND_CODE ? { bindCode: process.env.WOLFDEN_BIND_CODE } : {}),
    ...(process.env.WOLFDEN_AGENT_NAME ? { agentName: process.env.WOLFDEN_AGENT_NAME } : {}),
    ...(process.env.WOLFDEN_OPENCLAW_AGENT_ID ? { openclawAgentId: process.env.WOLFDEN_OPENCLAW_AGENT_ID } : {}),
    ...(process.env.WOLFDEN_OPENCLAW_THINKING ? { openclawThinking: process.env.WOLFDEN_OPENCLAW_THINKING } : {}),
    ...(process.env.WOLFDEN_OPENCLAW_TIMEOUT_SECONDS ? { openclawTimeoutSeconds: Number(process.env.WOLFDEN_OPENCLAW_TIMEOUT_SECONDS) } : {}),
    ...(process.env.WOLFDEN_ALLOWED_MATCH_MODES ? { allowedMatchModes: process.env.WOLFDEN_ALLOWED_MATCH_MODES } : {}),
    ...(process.env.WOLFDEN_AUTO_READY ? { autoReady: process.env.WOLFDEN_AUTO_READY !== 'false' && process.env.WOLFDEN_AUTO_READY !== '0' } : {}),
    ...(process.env.WOLFDEN_AUTO_ACCEPT ? { autoAccept: process.env.WOLFDEN_AUTO_ACCEPT !== 'false' && process.env.WOLFDEN_AUTO_ACCEPT !== '0' } : {}),
    ...(args.values.has('repo-url') ? { repoUrl: args.values.get('repo-url') } : {}),
    ...(args.values.has('site-url') ? { siteUrl: args.values.get('site-url') } : {}),
    ...(args.values.has('api-base-url') ? { apiBaseUrl: args.values.get('api-base-url') } : {}),
    ...(args.values.has('bind-code') ? { bindCode: args.values.get('bind-code') } : {}),
    ...(args.values.has('agent-name') ? { agentName: args.values.get('agent-name') } : {}),
    ...(args.values.has('openclaw-agent-id') ? { openclawAgentId: args.values.get('openclaw-agent-id') } : {}),
    ...(args.values.has('openclaw-thinking') ? { openclawThinking: args.values.get('openclaw-thinking') } : {}),
    ...(args.values.has('openclaw-timeout-seconds') ? { openclawTimeoutSeconds: Number(args.values.get('openclaw-timeout-seconds')) } : {}),
    ...(args.values.has('allowed-match-modes') ? { allowedMatchModes: args.values.get('allowed-match-modes') } : {}),
  });
  await saveSkillConfig(paths.configPath, config);

  const runnerPath = fileURLToPath(new URL('./runner.mjs', import.meta.url));
  const sessionId = createSessionId('runner');
  const baseSpawnOptions = {
    cwd: path.resolve(fileURLToPath(new URL('..', import.meta.url))),
    env: {
      ...process.env,
      WOLFDEN_CONFIG_PATH: paths.configPath,
    },
  };

  if (args.flags.has('foreground')) {
    const child = spawn(process.execPath, [runnerPath, '--config', paths.configPath], {
      ...baseSpawnOptions,
      stdio: 'inherit',
    });

    await saveProcessRecord(paths.processPath, {
      sessionId,
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
      configPath: paths.configPath,
      mode: 'foreground',
    });

    const forwardSignal = (signal) => {
      if (!child.killed) {
        child.kill(signal);
      }
    };
    process.on('SIGINT', () => forwardSignal('SIGINT'));
    process.on('SIGTERM', () => forwardSignal('SIGTERM'));

    waitForPlayerReady(config.apiBaseUrl, config.agentName)
      .then((player) => logger.info('Foreground install reached a ready player state.', {
        openclawPlayerId: player.openclawPlayerId,
      }))
      .catch((error) => logger.warn('Foreground install could not confirm a ready player within the expected window.', {
        message: error instanceof Error ? error.message : String(error),
      }));

    const [code, signal] = await once(child, 'exit');
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = typeof code === 'number' ? code : 0;
    return;
  }

  const child = spawn(process.execPath, [runnerPath, '--config', paths.configPath], {
    ...baseSpawnOptions,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  await saveProcessRecord(paths.processPath, {
    sessionId,
    pid: child.pid ?? null,
    startedAt: new Date().toISOString(),
    configPath: paths.configPath,
    mode: 'detached',
  });

  let ready = false;
  let playerId = null;
  try {
    const player = await waitForPlayerReady(config.apiBaseUrl, config.agentName);
    ready = true;
    playerId = player.openclawPlayerId;
  } catch (error) {
    await logger.warn('Background install finished without a confirmed ready player.', {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  console.log(JSON.stringify({
    configPath: paths.configPath,
    processPath: paths.processPath,
    runtimeStatePath: paths.runtimeStatePath,
    sessionId,
    pid: child.pid ?? null,
    ready,
    openclawPlayerId: playerId,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
