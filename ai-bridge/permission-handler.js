/**
 * Permission Handler — thin coordinator.
 * Provides the `canUseTool` callback for Claude SDK.
 *
 * IPC primitives: ./permission-ipc.js
 * Path safety:    ./permission-safety.js
 */

import {
  debugLog,
  requestAskUserQuestionAnswers,
  requestPermissionFromJava,
  requestPlanApproval,
} from './permission-ipc.js';
import { rewriteToolInputPaths, isDangerousPath } from './permission-safety.js';

// ========== Tool categories for permission control ==========

// READ_ONLY tools: auto-allowed in plan mode and acceptEdits mode (no side effects);
// in default mode, require explicit user permission confirmation
export const READ_ONLY_TOOLS = new Set([
  'Glob',           // Find files by pattern
  'Grep',           // Search file contents
  'Read',           // Read files/images/PDFs
  'WebFetch',       // Fetch URL content
  'WebSearch',      // Search the web
  'TodoWrite',      // Manage task checklist
  'TaskStop',       // Stop background task
  'TaskOutput',     // Read task output
  'ListMcpResourcesTool',   // List MCP resources
  'ReadMcpResourceTool',    // Read MCP resource
  'ExitPlanMode',   // Exit plan mode (triggers approval dialog)
]);

// AUTO_ALLOW_TOOLS: Tools that are always allowed without prompting
export const AUTO_ALLOW_TOOLS = new Set([
  'ToolSearch',       // Search/select deferred tools
  'StructuredOutput', // Return structured JSON output
  'EnterPlanMode',    // Enter planning mode
  'EnterWorktree',    // Create isolated git worktree
  'TaskCreate',       // Create a task in task list
  'TaskGet',          // Get a task by ID
  'TaskUpdate',       // Update a task
  'TaskList',         // List all tasks
  'CronCreate',       // Schedule a recurring prompt
  'CronDelete',       // Cancel a scheduled cron job
  'CronList',         // List active cron jobs
]);

// EDIT tools: auto-allowed in acceptEdits mode
export const EDIT_TOOLS = new Set([
  'Edit',           // Modify file contents
  'Write',          // Create/overwrite files
  'NotebookEdit',   // Edit Jupyter notebook cells
]);

// EXECUTION tools: always require permission (except bypassPermissions mode)
export const EXECUTION_TOOLS = new Set([
  'Bash',           // Execute shell commands
]);

// Re-export IPC functions for consumers that import from permission-handler
export { requestPlanApproval, requestPermissionFromJava };

/**
 * canUseTool callback function.
 * Used by Claude SDK.
 * Signature: (toolName: string, input: ToolInput, options: { signal: AbortSignal; suggestions?: PermissionUpdate[] }) => Promise<PermissionResult>
 * SDK expected return format: { behavior: 'allow' | 'deny', updatedInput?: object, message?: string }
 */
export async function canUseTool(toolName, input, options = {}) {
  const callStartTime = Date.now();
  console.log('[PERM_DEBUG][CAN_USE_TOOL] ========== CALLED ==========');
  console.log('[PERM_DEBUG][CAN_USE_TOOL] toolName:', toolName);
  console.log('[PERM_DEBUG][CAN_USE_TOOL] input:', JSON.stringify(input));
  console.log('[PERM_DEBUG][CAN_USE_TOOL] options:', options ? 'present' : 'undefined');
  debugLog('CAN_USE_TOOL', `Called with tool: ${toolName}`, { input });

  // Special handling for the AskUserQuestion tool
  if (toolName === 'AskUserQuestion') {
    debugLog('ASK_USER_QUESTION', 'Handling AskUserQuestion tool', { input });

    const answers = await requestAskUserQuestionAnswers(input);
    const elapsed = Date.now() - callStartTime;

    if (answers !== null) {
      debugLog('ASK_USER_QUESTION_SUCCESS', 'User provided answers', { answers, elapsed: `${elapsed}ms` });
      return {
        behavior: 'allow',
        updatedInput: {
          questions: input.questions || [],
          answers: answers
        }
      };
    } else {
      debugLog('ASK_USER_QUESTION_FAILED', 'Failed to get answers from user', { elapsed: `${elapsed}ms` });
      return {
        behavior: 'deny',
        message: 'User did not provide answers'
      };
    }
  }

  // Rewrite paths like /tmp to the project root directory
  const rewriteResult = rewriteToolInputPaths(toolName, input);
  if (rewriteResult.changed) {
    debugLog('PATH_REWRITE', `Paths were rewritten for tool: ${toolName}`, { input });
  }

  // Deny if no tool name is provided
  if (!toolName) {
    debugLog('ERROR', 'No tool name provided, denying');
    return {
      behavior: 'deny',
      message: 'Tool name is required'
    };
  }

  // Check for dangerous paths before allowing
  const filePath = input.file_path || input.path;
  if (filePath && isDangerousPath(filePath)) {
    debugLog('SECURITY', `Dangerous path detected, denying`, { path: filePath });
    return {
      behavior: 'deny',
      message: `Access to ${filePath} is not allowed for security reasons`
    };
  }

  // AUTO_ALLOW_TOOLS can always be auto-allowed (no side effects, no permission needed)
  if (AUTO_ALLOW_TOOLS.has(toolName)) {
    debugLog('AUTO_ALLOW', `Auto-allowing tool: ${toolName}`);
    return {
      behavior: 'allow',
      updatedInput: input
    };
  }

  // All other tools require explicit permission
  debugLog('PERMISSION_NEEDED', `Tool ${toolName} requires permission, calling requestPermissionFromJava`);
  const allowed = await requestPermissionFromJava(toolName, input);
  const elapsed = Date.now() - callStartTime;

  if (allowed) {
    debugLog('PERMISSION_GRANTED', `User allowed ${toolName}`, { elapsed: `${elapsed}ms` });
    return {
      behavior: 'allow',
      updatedInput: input
    };
  } else {
    debugLog('PERMISSION_DENIED', `User denied ${toolName}`, { elapsed: `${elapsed}ms` });
    return {
      behavior: 'deny',
      message: `User denied permission for ${toolName} tool`
    };
  }
}
