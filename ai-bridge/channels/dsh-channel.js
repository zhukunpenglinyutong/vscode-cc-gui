/**
 * DSH channel command handler — DeepSeek Harness speaks Host RPC +
 * WebSocket mux against a persistent local `dsh web`; no per-turn CLI spawn.
 *
 * Connection settings arrive as explicit stdinData fields (dshBin / dshHost /
 * dshPort / dshAutoStart / dshPreset) passed by the extension, layered over
 * the DSH_* env defaults. Explicit params keep the long-lived daemon free of
 * per-request process.env mutations (which would serialize concurrent turns).
 */

import { sendMessage as dshSendMessage } from '../services/dsh/message-service.js';
import { listModels as dshListModels } from '../services/dsh/models-service.js';
import {
  deleteSessionCommand,
  listSessionsCommand,
  loadSessionCommand,
} from '../services/dsh/history-service.js';
import {
  collectDshStatus,
  ensureHost,
  runtimeSettingsFromEnv,
  stopSpawnedHost,
} from '../services/dsh/supervisor.js';

/**
 * Merge explicit request params over the env-derived defaults. Unset fields
 * fall back to DSH_* env vars and then to the built-in defaults.
 */
export function dshSettingsFromParams(stdinData) {
  const base = runtimeSettingsFromEnv();
  if (!stdinData || typeof stdinData !== 'object') {
    return base;
  }
  const bin = typeof stdinData.dshBin === 'string' ? stdinData.dshBin.trim() : '';
  const host = typeof stdinData.dshHost === 'string' ? stdinData.dshHost.trim() : '';
  const port = Number(stdinData.dshPort);
  return {
    binPath: bin || base.binPath,
    host: host || base.host,
    port: Number.isInteger(port) && port > 0 ? port : base.port,
    autoStart:
      typeof stdinData.dshAutoStart === 'boolean' ? stdinData.dshAutoStart : base.autoStart,
    dshPreset: base.dshPreset,
  };
}

/**
 * Execute a DSH command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 */
export async function handleDshCommand(command, args, stdinData) {
  switch (command) {
    case 'send': {
      if (stdinData && stdinData.message !== undefined) {
        await dshSendMessage({
          message: stdinData.message,
          sessionId: stdinData.sessionId || '',
          cwd: stdinData.cwd || '',
          model: stdinData.model || '',
          reasoningEffort: stdinData.reasoningEffort || '',
          attachments: stdinData.attachments || [],
          preset: stdinData.preset || stdinData.dshPreset || '',
          settings: dshSettingsFromParams(stdinData),
        });
      } else {
        await dshSendMessage({
          message: args[0],
          sessionId: args[1],
          cwd: args[2],
          model: args[3],
          reasoningEffort: args[4],
          attachments: [],
          preset: '',
        });
      }
      break;
    }

    case 'listModels':
      await dshListModels(dshSettingsFromParams(stdinData));
      break;

    case 'listSessions':
      await listSessionsCommand({
        cwd: (stdinData && stdinData.cwd) || process.cwd(),
        settings: dshSettingsFromParams(stdinData),
      });
      break;

    case 'loadSession':
      await loadSessionCommand({
        sessionId: (stdinData && stdinData.sessionId) || args[0] || '',
        settings: dshSettingsFromParams(stdinData),
      });
      break;

    case 'deleteSession':
      await deleteSessionCommand({
        sessionId: (stdinData && stdinData.sessionId) || args[0] || '',
        settings: dshSettingsFromParams(stdinData),
      });
      break;

    case 'status': {
      const status = await collectDshStatus(dshSettingsFromParams(stdinData));
      console.log(JSON.stringify(status));
      break;
    }

    case 'ensureHost': {
      try {
        const handle = await ensureHost(dshSettingsFromParams(stdinData));
        console.log(JSON.stringify({
          success: true,
          provider: 'dsh',
          origin: handle.origin,
          ownership: handle.ownership,
          describe: handle.describe,
        }));
      } catch (error) {
        console.log(JSON.stringify({ success: false, provider: 'dsh', error: error.message }));
      }
      break;
    }

    case 'stopHost': {
      const result = await stopSpawnedHost(dshSettingsFromParams(stdinData));
      console.log(JSON.stringify({ provider: 'dsh', ...result }));
      break;
    }

    default:
      throw new Error(`Unknown DSH command: ${command}`);
  }
}

export function getDshCommandList() {
  return [
    'send',
    'listModels',
    'listSessions',
    'loadSession',
    'deleteSession',
    'status',
    'ensureHost',
    'stopHost',
  ];
}
