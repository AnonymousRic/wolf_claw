import process from 'node:process';
import {
  DEFAULT_CAPABILITIES,
  createLogger,
  loadProcessRecord,
  loadRuntimeState,
  loadSession,
  loadSkillConfig,
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
      capabilities = await requestJson(config.apiBaseUrl, '/api/openclaw/capabilities');
    } catch (error) {
      await logger.warn('Status check could not load platform capabilities.', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (config && session) {
    try {
      remoteProfile = await requestJson(config.apiBaseUrl, '/api/openclaw/profile');
      remotePlayer = remoteProfile?.players?.find((player) => (
        player.openclawPlayerId === session.openclawPlayerId
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
