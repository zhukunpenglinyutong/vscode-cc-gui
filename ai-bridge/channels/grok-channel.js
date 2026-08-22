/**
 * Grok channel command handler – keeps Grok-specific logic separated.
 * Grok has no official SDK; this channel shells out to the local CLI.
 */
import { sendMessage as grokSendMessage } from '../services/grok/message-service.js';
import { applyOpenedFilesToCliMessage } from '../services/cli-opened-files.js';

/**
 * Execute a Grok command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 */
export async function handleGrokCommand(command, args, stdinData) {
  switch (command) {
    case 'send': {
      if (stdinData && stdinData.message !== undefined) {
        const {
          message,
          sessionId,
          cwd,
          model,
          reasoningEffort,
          attachments,
          openedFiles,
        } = stdinData;
        await grokSendMessage(
          applyOpenedFilesToCliMessage(message, openedFiles || null),
          sessionId || '',
          cwd || '',
          model || '',
          reasoningEffort || 'medium',
          Array.isArray(attachments) ? attachments : [],
        );
      } else {
        await grokSendMessage(args[0], args[1], args[2], args[3], args[4], []);
      }
      break;
    }

    default:
      throw new Error(`Unknown Grok command: ${command}`);
  }
}

export function getGrokCommandList() {
  return ['send'];
}
