import process from 'node:process';
import {
  DEFAULT_CAPABILITIES,
  PLATFORM_PROVIDER_QUERY,
  createLogger,
  loadProcessRecord,
  loadRuntimeState,
  loadSession,
  loadSkillConfig,
  normalizePlatformPlayer,
  parseArgs,
  requestJson,
  resolveRunnerPaths,
} from './common.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveRunnerPaths(args.values.get('config') ?? process.env.WOLFDEN_CONFIG_PATH);
  const logger = createLogger(paths.logPath);
  const config = await loadSkillConfig(paths.configPath);
  const session = await loadSession(paths.sessionPath);
  const processRecord = await loadProcessRecord(paths.processPath);
  const runtimeState = await loadRuntimeState(paths.runtimeStatePath);

  let capabilities = { ...DEFAULT_CAPABILITIES };
  let remoteProfile = null;
  let remotePlayer = null;

  if (config) {
    try {
      capabilities = await requestJson(config.apiBaseUrl, `/api/remote-agents/capabilities?${PLATFORM_PROVIDER_QUERY}`);
    } catch (error) {
      await logger.warn('Status check could not load platform capabilities.', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (config && session) {
    try {
      remoteProfile = await requestJson(config.apiBaseUrl, `/api/remote-agents/profile?${PLATFORM_PROVIDER_QUERY}`);
      const players = Array.isArray(remoteProfile?.players)
        ? remoteProfile.players.map(normalizePlatformPlayer).filter(Boolean)
        : [];
      remotePlayer = players.find((player) => (
        player.remoteAgentParticipantId === session.remoteAgentParticipantId
        || player.agentName === session.agentName
      )) ?? null;
    } catch (error) {
      await logger.warn('Status check could not load the remote WolfDen profile.', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.log(JSON.stringify({
    configPath: paths.configPath,
    sessionPath: paths.sessionPath,
    processPath: paths.processPath,
    config,
    session,
    process: processRecord,
    runtimeState,
    capabilities,
    remotePlayer,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
