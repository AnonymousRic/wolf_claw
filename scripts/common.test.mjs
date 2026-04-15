import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  loadProcessRecord,
  saveProcessRecord,
  stopRecordedProcess,
  waitForPlayerPresence,
  waitForPlayerReady,
} from './common.mjs';

function jsonResponse(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function createProfileServer(playerStatus = 'online') {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/api/openclaw/profile') {
      jsonResponse(response, 200, {
        players: [{
          openclawPlayerId: 'openclaw-test-player',
          agentName: 'runner-test',
          displayName: 'runner-test',
          status: playerStatus,
        }],
      });
      return;
    }

    jsonResponse(response, 404, { message: `${request.method} ${url.pathname} not implemented in common tests` });
  });

  return {
    async start() {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      return `http://127.0.0.1:${address.port}`;
    },
    async stop() {
      if (!server.listening) {
        return;
      }
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(undefined);
        });
      });
    },
  };
}

test('waitForPlayerReady does not treat online-only players as ready', async () => {
  const profileServer = createProfileServer('online');
  const baseUrl = await profileServer.start();

  try {
    const onlinePlayer = await waitForPlayerPresence(baseUrl, 'runner-test', 800);
    assert.equal(onlinePlayer.status, 'online');
    await assert.rejects(
      () => waitForPlayerReady(baseUrl, 'runner-test', 800),
      /last status: online/i,
    );
  } finally {
    await profileServer.stop();
  }
});

test('stopRecordedProcess clears stale process records', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'wolfden-common-stale-'));
  const processPath = path.join(tempDir, 'process.json');

  try {
    await saveProcessRecord(processPath, {
      sessionId: 'stale-session',
      pid: 999999,
      startedAt: new Date().toISOString(),
      configPath: path.join(tempDir, 'config.json'),
      mode: 'detached',
    });

    const result = await stopRecordedProcess(processPath);
    assert.equal(result.status, 'stale');
    assert.equal(await loadProcessRecord(processPath), null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('stopRecordedProcess stops a live process and clears the record', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'wolfden-common-live-'));
  const processPath = path.join(tempDir, 'process.json');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });

  try {
    await saveProcessRecord(processPath, {
      sessionId: 'live-session',
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
      configPath: path.join(tempDir, 'config.json'),
      mode: 'detached',
    });

    const result = await stopRecordedProcess(processPath);
    assert.equal(result.status, 'stopped');
    if (child.exitCode === null) {
      await once(child, 'exit');
    }
    assert.equal(await loadProcessRecord(processPath), null);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit').catch(() => undefined);
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
