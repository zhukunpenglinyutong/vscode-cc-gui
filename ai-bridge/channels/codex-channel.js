/**
 * Codex channel command handler – keeps Codex specific logic separated.
 */
import { sendMessage as codexSendMessage } from '../services/codex/message-service.js';
import { getMcpServerTools as codexGetMcpServerTools } from '../services/codex/message-service.js';
import {
  listCodexMcpServers,
  addCodexMcpServer,
  removeCodexMcpServer,
  setCodexMcpServerEnabled
} from '../services/codex/codex-mcp-admin.js';

/**
 * Execute a Codex command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 */
export async function handleCodexCommand(command, args, stdinData) {
  switch (command) {
    case 'send': {
      if (stdinData && stdinData.message !== undefined) {
        const {
          message,
          threadId,
          cwd,
          permissionMode,
          model,
          baseUrl,
          apiKey,
          reasoningEffort,
          serviceTier,
          codexSandboxMode,
          sandboxMode,
          openedFiles,
          fileTags,
          agentPrompt,
          attachments,  // Image attachments (local_image format)
          streaming,    // UI streaming toggle (same field as Claude)
        } = stdinData;
        await codexSendMessage(
          message,
          threadId || '',
          cwd || '',
          permissionMode || '',
          model || '',
          baseUrl || '',
          apiKey || '',
          (reasoningEffort === 'max' ? 'xhigh' : (reasoningEffort || 'medium')),
          serviceTier || '',
          attachments || [],  // Pass attachments to message service
          openedFiles || null,
          fileTags || null,
          agentPrompt || null,
          codexSandboxMode || sandboxMode || null,
          streaming
        );
      } else {
        await codexSendMessage(args[0], args[1], args[2], args[3], args[4]);
      }
      break;
    }

    case 'getMcpServerTools': {
      const serverId = stdinData?.serverId || args[0] || null;
      const serverConfig = stdinData?.serverConfig || null;
      await codexGetMcpServerTools(serverId, serverConfig);
      break;
    }

    case 'mcpList':
      await listCodexMcpServers();
      break;

    case 'mcpAdd':
      await addCodexMcpServer(stdinData?.name || args[0], stdinData?.config || null);
      break;

    case 'mcpRemove':
      await removeCodexMcpServer(stdinData?.name || args[0]);
      break;

    case 'mcpSetEnabled':
      await setCodexMcpServerEnabled(stdinData?.name || args[0], stdinData?.enabled !== false);
      break;

    default:
      throw new Error(`Unknown Codex command: ${command}`);
  }
}

export function getCodexCommandList() {
  return ['send', 'getMcpServerTools', 'mcpList', 'mcpAdd', 'mcpRemove', 'mcpSetEnabled'];
}
