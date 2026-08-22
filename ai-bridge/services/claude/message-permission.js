/**
 * Permission control for Claude message service.
 * Tool category definitions and PreToolUse hook implementation.
 */

import { canUseTool, requestPlanApproval } from '../../permission-handler.js';

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

// Tools auto-approved in acceptEdits mode (EDIT tools + safe file operations)
export const ACCEPT_EDITS_AUTO_APPROVE_TOOLS = new Set([
  ...EDIT_TOOLS,
  'MultiEdit',      // Batch edit operations
  'CreateDirectory',
  'MoveFile',
  'CopyFile',
  'Rename'
]);

// Tools allowed in plan mode:
// - All READ_ONLY tools
// - All AUTO_ALLOW_TOOLS
// - TodoWrite, AskUserQuestion, ExitPlanMode for planning workflow
// - Task/Agent for exploration agents
// - Edit/Write for plan file only (handled separately in hook)
export const PLAN_MODE_ALLOWED_TOOLS = new Set([
  ...READ_ONLY_TOOLS,
  ...AUTO_ALLOW_TOOLS,
  // Planning workflow tools
  'AskUserQuestion',  // Ask user for clarification
  'Task',             // Allow Task for exploration agents
  'Agent',            // Agent is an alias for Task
  'Skill',            // Allow skills during planning
]);

// Tools that require user interaction even in bypassPermissions mode
export const INTERACTIVE_TOOLS = new Set(['AskUserQuestion']);

// Plan file name (matches CLI convention)
export const PLAN_FILE_NAME = 'PLAN.md';

/**
 * Check if a file path is the plan file
 * @param {string} filePath - The file path to check
 * @param {string} cwd - Current working directory
 * @returns {boolean} - True if the path points to the plan file
 */
export function isPlanFilePath(filePath, cwd) {
  if (!filePath || typeof filePath !== 'string') return false;
  const workingDir = cwd || process.cwd();
  // Normalize paths for comparison
  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
  const normalizedCwd = workingDir.replace(/\\/g, '/').toLowerCase();
  // Check if the path ends with PLAN.md (in project root)
  if (normalizedPath.endsWith('/plan.md') || normalizedPath === 'plan.md') {
    // Verify it's in the project root
    if (normalizedPath.startsWith(normalizedCwd)) return true;
    if (!normalizedPath.includes('/')) return true; // Relative path like "PLAN.md"
  }
  return false;
}

export function shouldAutoApproveTool(permissionMode, toolName) {
  if (!toolName) return false;
  // Tools with checkPermissions returning "allow" are always auto-approved
  if (AUTO_ALLOW_TOOLS.has(toolName)) return true;
  // Interactive tools always need user input, never auto-approve
  if (INTERACTIVE_TOOLS.has(toolName)) return false;
  // bypassPermissions: auto-approve all tools except interactive ones
  if (permissionMode === 'bypassPermissions') return true;
  // acceptEdits: auto-approve EDIT tools + READ_ONLY tools
  if (permissionMode === 'acceptEdits') {
    return ACCEPT_EDITS_AUTO_APPROVE_TOOLS.has(toolName) || READ_ONLY_TOOLS.has(toolName);
  }
  // default mode: READ_ONLY tools require explicit permission confirmation
  return false;
}

/**
 * Create PreToolUse hook for permission control
 * @param {string} permissionMode - The permission mode (default, plan, acceptEdits, bypassPermissions, dontAsk)
 * @param {string} cwd - Working directory (for plan file detection)
 * @returns {Function} - PreToolUse hook function
 */
/**
 * Request permission via canUseTool with standardized error handling.
 * @returns {Promise<{decision: string, reason?: string, updatedInput?: object}>}
 */
async function requestToolPermission(toolName, toolInput, defaultDenyMessage) {
  try {
    const result = await canUseTool(toolName, toolInput);
    if (result?.behavior === 'allow') {
      return { decision: 'approve', updatedInput: result.updatedInput ?? toolInput };
    }
    return {
      decision: 'block',
      reason: result?.message || defaultDenyMessage
    };
  } catch (error) {
    console.error(`[PERM_DEBUG] ${toolName} permission error:`, error?.message);
    return {
      decision: 'block',
      reason: 'Permission check failed: ' + (error?.message || String(error))
    };
  }
}

/**
 * Handle tool permission checks in plan mode.
 */
async function handlePlanMode(toolName, toolInput, workingDirectory, setMode) {
  if (toolName === 'AskUserQuestion') {
    console.log('[PERM_DEBUG] AskUserQuestion called in plan mode, deferring to canUseTool...');
    return { decision: 'approve' };
  }

  if (toolName === 'ExitPlanMode') {
    console.log('[PERM_DEBUG] ExitPlanMode called in plan mode, requesting approval...');
    try {
      const result = await requestPlanApproval(toolInput);
      if (result?.approved) {
        const nextMode = result.targetMode || 'default';
        setMode(nextMode);
        console.log('[PERM_DEBUG] Plan approved, switching mode to:', nextMode);
        return {
          decision: 'approve',
          updatedInput: { ...toolInput, approved: true, targetMode: nextMode }
        };
      }
      console.log('[PERM_DEBUG] Plan rejected by user');
      return { decision: 'block', reason: result?.message || 'Plan was rejected by user' };
    } catch (error) {
      console.error('[PERM_DEBUG] Plan approval error:', error?.message);
      return { decision: 'block', reason: 'Plan approval failed: ' + (error?.message || String(error)) };
    }
  }

  if (toolName === 'Edit' || toolName === 'Write') {
    const filePath = toolInput?.file_path || toolInput?.path;
    if (isPlanFilePath(filePath, workingDirectory)) {
      console.log('[PERM_DEBUG] Allowing Edit/Write on plan file in plan mode:', filePath);
      return { decision: 'approve' };
    }
    console.log(`[PERM_DEBUG] ${toolName} on non-plan file in plan mode, requesting permission...`);
    return requestToolPermission(toolName, toolInput, `Cannot edit non-plan files in plan mode. Only ${PLAN_FILE_NAME} can be edited.`);
  }

  if (toolName === 'Bash') {
    console.log('[PERM_DEBUG] Bash called in plan mode, requesting permission...');
    return requestToolPermission(toolName, toolInput, 'Shell commands are not allowed in plan mode');
  }

  if (PLAN_MODE_ALLOWED_TOOLS.has(toolName)) {
    console.log('[PERM_DEBUG] Allowing read-only tool in plan mode:', toolName);
    return { decision: 'approve' };
  }

  if (toolName?.startsWith('mcp__')) {
    const writePatterns = ['write', 'edit', 'create', 'delete', 'update', 'execute', 'run'];
    const toolLower = toolName.toLowerCase();
    if (writePatterns.some(p => toolLower.includes(p))) {
      console.log('[PERM_DEBUG] Blocking write MCP tool in plan mode:', toolName);
      return { decision: 'block', reason: `MCP tool "${toolName}" writes to system, not allowed in plan mode` };
    }
    console.log('[PERM_DEBUG] Allowing MCP read tool in plan mode:', toolName);
    return { decision: 'approve' };
  }

  console.log('[PERM_DEBUG] Blocking tool in plan mode:', toolName);
  return {
    decision: 'block',
    reason: `Tool "${toolName}" is not allowed in plan mode. Only read-only tools and ${PLAN_FILE_NAME} edits are permitted. Use ExitPlanMode to exit plan mode.`
  };
}

/**
 * Handle tool permission checks in dontAsk mode.
 */
function handleDontAskMode(toolName) {
  if (READ_ONLY_TOOLS.has(toolName) || AUTO_ALLOW_TOOLS.has(toolName)) {
    console.log('[PERM_DEBUG] Allowing auto-approved tool in dontAsk mode:', toolName);
    return { decision: 'approve' };
  }
  if (toolName === 'AskUserQuestion') {
    return { decision: 'approve' };
  }
  console.log('[PERM_DEBUG] Denying tool in dontAsk mode (no prompt):', toolName);
  return {
    decision: 'block',
    reason: `Tool "${toolName}" requires permission but dontAsk mode prevents prompts. Pre-approve the tool or switch modes.`
  };
}

/**
 * Handle tool permission checks in default/acceptEdits/bypassPermissions modes.
 */
async function handleStandardMode(toolName, toolInput, currentPermissionMode) {
  if (toolName === 'AskUserQuestion') {
    console.log('[PERM_DEBUG] AskUserQuestion encountered in PreToolUse, deferring to canUseTool...');
    return { decision: 'approve' };
  }

  if (shouldAutoApproveTool(currentPermissionMode, toolName)) {
    console.log('[PERM_DEBUG] Auto-approve tool:', toolName, 'mode:', currentPermissionMode);
    return { decision: 'approve' };
  }

  console.log('[PERM_DEBUG] Calling canUseTool...');
  try {
    const result = await canUseTool(toolName, toolInput);
    console.log('[PERM_DEBUG] canUseTool returned:', result?.behavior);

    if (result?.behavior === 'allow') {
      if (result?.updatedInput !== undefined) {
        return { decision: 'approve', updatedInput: result.updatedInput };
      }
      return { decision: 'approve' };
    }
    if (result?.behavior === 'deny') {
      return { decision: 'block', reason: result?.message || 'Permission denied' };
    }
    return {};
  } catch (error) {
    console.error('[PERM_DEBUG] canUseTool error:', error?.message);
    return { decision: 'block', reason: 'Permission check failed: ' + (error?.message || String(error)) };
  }
}

export function createPreToolUseHook(permissionMode, cwd = null) {
  let currentPermissionMode = (!permissionMode || permissionMode === '') ? 'default' : permissionMode;
  const workingDirectory = cwd || process.cwd();
  const setMode = (mode) => { currentPermissionMode = mode; };

  return async (input) => {
    const toolName = input?.tool_name;
    const toolInput = input?.tool_input;
    console.log('[PERM_DEBUG] PreToolUse hook called:', toolName, 'mode:', currentPermissionMode);

    if (currentPermissionMode === 'plan') {
      return handlePlanMode(toolName, toolInput, workingDirectory, setMode);
    }
    if (currentPermissionMode === 'dontAsk') {
      return handleDontAskMode(toolName);
    }
    return handleStandardMode(toolName, toolInput, currentPermissionMode);
  };
}
