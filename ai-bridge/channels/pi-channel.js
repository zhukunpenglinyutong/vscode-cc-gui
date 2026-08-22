/**
 * PI channel command handler – keeps PI-specific logic separated.
 * PI has no official SDK; this channel shells out to the local CLI.
 */
import { sendMessage as piSendMessage } from '../services/pi/message-service.js';
import { listModels as piListModels } from '../services/pi/models-service.js';
import { applyOpenedFilesToCliMessage } from '../services/cli-opened-files.js';

/**
 * Execute a PI command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 */
export async function handlePiCommand(command, args, stdinData) {
  switch (command) {
    case 'send': {
      if (stdinData && stdinData.message !== undefined) {
        const {
          message,
          sessionId,
          cwd,
          model,
          reasoningEffort,
          openedFiles,
        } = stdinData;
        await piSendMessage(
          applyOpenedFilesToCliMessage(message, openedFiles || null),
          sessionId || '',
          cwd || '',
          model || '',
          reasoningEffort || ''
        );
      } else {
        await piSendMessage(args[0], args[1], args[2], args[3], args[4]);
      }
      break;
    }

    case 'listModels':
      piListModels();
      break;

    default:
      throw new Error(`Unknown PI command: ${command}`);
  }
}

export function getPiCommandList() {
  return ['send', 'listModels'];
}
