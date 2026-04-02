/**
 * File-system IPC primitives for permission communication with Java process.
 * Handles request/response file exchange for permissions, questions, and plan approval.
 */
import { writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ========== Debug logging ==========
export function debugLog(tag, message, data = null) {
  // suppressed in production
}

// ========== IPC directory and session config ==========
export const PERMISSION_DIR = process.env.CLAUDE_PERMISSION_DIR
  ? process.env.CLAUDE_PERMISSION_DIR
  : join(tmpdir(), 'claude-permission');

export const SESSION_ID = process.env.CLAUDE_SESSION_ID || 'default';

// Permission request timeout (5 minutes), kept in sync with Java-side PermissionHandler.PERMISSION_TIMEOUT_SECONDS
export const PERMISSION_TIMEOUT_MS = 300000;

debugLog('INIT', `Permission dir: ${PERMISSION_DIR}`);
debugLog('INIT', `Session ID: ${SESSION_ID}`);
debugLog('INIT', `tmpdir(): ${tmpdir()}`);
debugLog('INIT', `CLAUDE_PERMISSION_DIR env: ${process.env.CLAUDE_PERMISSION_DIR || 'NOT SET'}`);
debugLog('INIT', `CLAUDE_SESSION_ID env: ${process.env.CLAUDE_SESSION_ID || 'NOT SET'}`);

// Ensure the directory exists
try {
  mkdirSync(PERMISSION_DIR, { recursive: true });
  debugLog('INIT', 'Permission directory created/verified successfully');
} catch (e) {
  debugLog('INIT_ERROR', `Failed to create permission dir: ${e.message}`);
}

/**
 * Request AskUserQuestion answers via file system communication with Java process.
 * @param {Object} input - AskUserQuestion tool parameters (contains questions array)
 * @returns {Promise<Object|null>} - User answers object, returns null on failure
 */
export async function requestAskUserQuestionAnswers(input) {
  const requestStartTime = Date.now();
  debugLog('ASK_USER_QUESTION_START', 'Requesting answers for questions', { input });

  try {
    const requestId = `ask-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    debugLog('ASK_USER_QUESTION_ID', `Generated request ID: ${requestId}`);

    const requestFile = join(PERMISSION_DIR, `ask-user-question-${SESSION_ID}-${requestId}.json`);
    const responseFile = join(PERMISSION_DIR, `ask-user-question-response-${SESSION_ID}-${requestId}.json`);

    const requestData = {
      requestId,
      toolName: 'AskUserQuestion',
      questions: input.questions || [],
      timestamp: new Date().toISOString(),
      cwd: process.cwd()
    };

    debugLog('ASK_USER_QUESTION_FILE_WRITE', `Writing question request file`, { requestFile, responseFile });

    try {
      writeFileSync(requestFile, JSON.stringify(requestData, null, 2));
      debugLog('ASK_USER_QUESTION_FILE_WRITE_OK', `Question request file written successfully`);

      if (existsSync(requestFile)) {
        debugLog('ASK_USER_QUESTION_FILE_VERIFY', `Question request file exists after write`);
      } else {
        debugLog('ASK_USER_QUESTION_FILE_VERIFY_ERROR', `Question request file does NOT exist after write!`);
      }
    } catch (writeError) {
      debugLog('ASK_USER_QUESTION_FILE_WRITE_ERROR', `Failed to write question request file: ${writeError.message}`);
      return null;
    }

    const timeout = PERMISSION_TIMEOUT_MS;
    let pollCount = 0;
    const pollInterval = 100;

    debugLog('ASK_USER_QUESTION_WAIT_START', `Starting to wait for answers (timeout: ${timeout}ms)`);

    while (Date.now() - requestStartTime < timeout) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      pollCount++;

      if (pollCount % 50 === 0) {
        const elapsed = Date.now() - requestStartTime;
        debugLog('ASK_USER_QUESTION_WAITING', `Still waiting for answers`, { elapsed: `${elapsed}ms`, pollCount });
      }

      if (existsSync(responseFile)) {
        debugLog('ASK_USER_QUESTION_RESPONSE_FOUND', `Response file found!`);
        try {
          const responseContent = readFileSync(responseFile, 'utf-8');
          debugLog('ASK_USER_QUESTION_RESPONSE_CONTENT', `Raw response content: ${responseContent}`);

          const responseData = JSON.parse(responseContent);
          const answers = responseData.answers;
          debugLog('ASK_USER_QUESTION_RESPONSE_PARSED', `Parsed answers`, { answers, elapsed: `${Date.now() - requestStartTime}ms` });

          try {
            unlinkSync(responseFile);
            debugLog('ASK_USER_QUESTION_FILE_CLEANUP', `Response file deleted`);
          } catch (cleanupError) {
            debugLog('ASK_USER_QUESTION_FILE_CLEANUP_ERROR', `Failed to delete response file: ${cleanupError.message}`);
          }

          return answers;
        } catch (e) {
          debugLog('ASK_USER_QUESTION_RESPONSE_ERROR', `Error reading/parsing response: ${e.message}`);
          return null;
        }
      }
    }

    const elapsed = Date.now() - requestStartTime;
    debugLog('ASK_USER_QUESTION_TIMEOUT', `Timeout waiting for answers`, { elapsed: `${elapsed}ms`, timeout: `${timeout}ms` });
    return null;

  } catch (error) {
    debugLog('ASK_USER_QUESTION_FATAL_ERROR', `Unexpected error: ${error.message}`, { stack: error.stack });
    return null;
  }
}

/**
 * Request plan approval via file system communication with Java process.
 * @param {Object} input - ExitPlanMode tool parameters (contains allowedPrompts)
 * @returns {Promise<Object>} - { approved: boolean, targetMode: string, message?: string }
 */
export async function requestPlanApproval(input) {
  const requestStartTime = Date.now();
  debugLog('PLAN_APPROVAL_START', 'Requesting plan approval', { input });

  try {
    const requestId = `plan-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    debugLog('PLAN_APPROVAL_ID', `Generated request ID: ${requestId}`);

    const requestFile = join(PERMISSION_DIR, `plan-approval-${SESSION_ID}-${requestId}.json`);
    const responseFile = join(PERMISSION_DIR, `plan-approval-response-${SESSION_ID}-${requestId}.json`);

    const plan = typeof input?.plan === 'string' ? input.plan.substring(0, 100000) : '';
    const rawPrompts = Array.isArray(input?.allowedPrompts) ? input.allowedPrompts : [];
    const allowedPrompts = rawPrompts
      .filter(p => p && typeof p.tool === 'string' && typeof p.prompt === 'string')
      .map(p => ({ tool: String(p.tool), prompt: String(p.prompt) }));

    const requestData = {
      requestId,
      toolName: 'ExitPlanMode',
      plan,
      allowedPrompts,
      timestamp: new Date().toISOString(),
      cwd: process.cwd()
    };

    debugLog('PLAN_APPROVAL_FILE_WRITE', `Writing plan approval request file`, { requestFile, responseFile });

    try {
      writeFileSync(requestFile, JSON.stringify(requestData, null, 2));
      debugLog('PLAN_APPROVAL_FILE_WRITE_OK', `Plan approval request file written successfully`);

      if (existsSync(requestFile)) {
        debugLog('PLAN_APPROVAL_FILE_VERIFY', `Plan approval request file exists after write`);
      } else {
        debugLog('PLAN_APPROVAL_FILE_VERIFY_ERROR', `Plan approval request file does NOT exist after write!`);
      }
    } catch (writeError) {
      debugLog('PLAN_APPROVAL_FILE_WRITE_ERROR', `Failed to write plan approval request file: ${writeError.message}`);
      return { approved: false, message: 'Failed to write plan approval request' };
    }

    const timeout = PERMISSION_TIMEOUT_MS;
    let pollCount = 0;
    const pollInterval = 100;

    debugLog('PLAN_APPROVAL_WAIT_START', `Starting to wait for plan approval response (timeout: ${timeout}ms)`);

    while (Date.now() - requestStartTime < timeout) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      pollCount++;

      if (pollCount % 100 === 0) {
        const elapsed = Date.now() - requestStartTime;
        debugLog('PLAN_APPROVAL_WAITING', `Still waiting for plan approval`, { elapsed: `${elapsed}ms`, pollCount });
      }

      if (existsSync(responseFile)) {
        debugLog('PLAN_APPROVAL_RESPONSE_FOUND', `Response file found!`);
        try {
          const responseContent = readFileSync(responseFile, 'utf-8');
          debugLog('PLAN_APPROVAL_RESPONSE_CONTENT', `Raw response content: ${responseContent}`);

          const responseData = JSON.parse(responseContent);
          const approved = responseData.approved === true;
          const targetMode = responseData.targetMode || 'default';
          const message = responseData.message;

          debugLog('PLAN_APPROVAL_RESPONSE_PARSED', `Parsed response`, {
            approved,
            targetMode,
            elapsed: `${Date.now() - requestStartTime}ms`
          });

          try {
            unlinkSync(responseFile);
            debugLog('PLAN_APPROVAL_FILE_CLEANUP', `Response file deleted`);
          } catch (cleanupError) {
            debugLog('PLAN_APPROVAL_FILE_CLEANUP_ERROR', `Failed to delete response file: ${cleanupError.message}`);
          }

          return { approved, targetMode, message };
        } catch (e) {
          debugLog('PLAN_APPROVAL_RESPONSE_ERROR', `Error reading/parsing response: ${e.message}`);
          return { approved: false, message: 'Failed to parse plan approval response' };
        }
      }
    }

    const elapsed = Date.now() - requestStartTime;
    debugLog('PLAN_APPROVAL_TIMEOUT', `Timeout waiting for plan approval`, { elapsed: `${elapsed}ms`, timeout: `${timeout}ms` });
    return { approved: false, message: 'Plan approval timed out' };

  } catch (error) {
    debugLog('PLAN_APPROVAL_FATAL_ERROR', `Unexpected error: ${error.message}`, { stack: error.stack });
    return { approved: false, message: error.message };
  }
}

/**
 * Request permission via file system communication with Java process.
 * @param {string} toolName - Tool name
 * @param {Object} input - Tool parameters
 * @returns {Promise<boolean>} - Whether allowed
 */
export async function requestPermissionFromJava(toolName, input) {
  const requestStartTime = Date.now();
  debugLog('REQUEST_START', `Tool: ${toolName}`, { input });

  try {
    try {
      const existingFiles = readdirSync(PERMISSION_DIR);
      debugLog('DIR_CONTENTS', `Files in permission dir (before request)`, { files: existingFiles });
    } catch (e) {
      debugLog('DIR_ERROR', `Cannot read permission dir: ${e.message}`);
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
    debugLog('REQUEST_ID', `Generated request ID: ${requestId}`);

    const requestFile = join(PERMISSION_DIR, `request-${SESSION_ID}-${requestId}.json`);
    const responseFile = join(PERMISSION_DIR, `response-${SESSION_ID}-${requestId}.json`);

    const requestData = {
      requestId,
      toolName,
      inputs: input,
      timestamp: new Date().toISOString(),
      cwd: process.cwd()
    };

    debugLog('FILE_WRITE', `Writing request file`, { requestFile, responseFile });

    try {
      writeFileSync(requestFile, JSON.stringify(requestData, null, 2));
      debugLog('FILE_WRITE_OK', `Request file written successfully`);

      if (existsSync(requestFile)) {
        debugLog('FILE_VERIFY', `Request file exists after write`);
      } else {
        debugLog('FILE_VERIFY_ERROR', `Request file does NOT exist after write!`);
      }
    } catch (writeError) {
      debugLog('FILE_WRITE_ERROR', `Failed to write request file: ${writeError.message}`);
      return false;
    }

    const timeout = PERMISSION_TIMEOUT_MS;
    let pollCount = 0;
    const pollInterval = 100;

    debugLog('WAIT_START', `Starting to wait for response (timeout: ${timeout}ms)`);

    while (Date.now() - requestStartTime < timeout) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      pollCount++;

      if (pollCount % 50 === 0) {
        const elapsed = Date.now() - requestStartTime;
        debugLog('WAITING', `Still waiting for response`, { elapsed: `${elapsed}ms`, pollCount });

        const reqFileExists = existsSync(requestFile);
        const respFileExists = existsSync(responseFile);
        debugLog('FILE_STATUS', `File status check`, {
          requestFileExists: reqFileExists,
          responseFileExists: respFileExists
        });
      }

      if (existsSync(responseFile)) {
        debugLog('RESPONSE_FOUND', `Response file found!`);
        try {
          const responseContent = readFileSync(responseFile, 'utf-8');
          debugLog('RESPONSE_CONTENT', `Raw response content: ${responseContent}`);

          const responseData = JSON.parse(responseContent);
          const result = responseData.allow;
          debugLog('RESPONSE_PARSED', `Parsed response`, { allow: result, elapsed: `${Date.now() - requestStartTime}ms` });

          try {
            unlinkSync(responseFile);
            debugLog('FILE_CLEANUP', `Response file deleted`);
          } catch (cleanupError) {
            debugLog('FILE_CLEANUP_ERROR', `Failed to delete response file: ${cleanupError.message}`);
          }

          return result;
        } catch (e) {
          debugLog('RESPONSE_ERROR', `Error reading/parsing response: ${e.message}`);
          return false;
        }
      }
    }

    const elapsed = Date.now() - requestStartTime;
    debugLog('TIMEOUT', `Timeout waiting for response`, { elapsed: `${elapsed}ms`, timeout: `${timeout}ms` });

    const reqFileExists = existsSync(requestFile);
    const respFileExists = existsSync(responseFile);
    debugLog('TIMEOUT_FILE_STATUS', `File status at timeout`, {
      requestFileExists: reqFileExists,
      responseFileExists: respFileExists
    });

    return false;

  } catch (error) {
    debugLog('FATAL_ERROR', `Unexpected error in requestPermissionFromJava: ${error.message}`, { stack: error.stack });
    return false;
  }
}
