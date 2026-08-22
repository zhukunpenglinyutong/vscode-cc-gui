import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import * as vscode from 'vscode';
import {
  buildRememberedApproval,
  sameRememberedApproval,
  type RememberedApproval,
} from '../../permissionApprovalUtils';

const REMEMBERED_TOOL_APPROVALS_KEY = 'ccg.remembered_tool_approvals';
const STALE_PERMISSION_REQUEST_MAX_AGE_MS = 10 * 60 * 1000;

type ToolPermissionRequest = {
  requestId: string;
  toolName: string;
  inputs: Record<string, unknown>;
  cwd?: string;
  bridgeRequestId?: string;
};

export class PermissionIpcService implements vscode.Disposable {
  private watcher?: fs.FSWatcher;
  private scanInterval?: ReturnType<typeof setInterval>;
  private readonly awaitingUser = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly pendingRequests = new Map<string, ToolPermissionRequest>();
  private readonly rememberedApprovals: RememberedApproval[] = [];
  private readonly log: vscode.OutputChannel;
  private readonly getWebview: () => vscode.Webview | undefined;
  /** Map daemon/bridge request id → owning webview (multi-window routing). */
  private readonly getWebviewForBridgeRequestId?: (bridgeRequestId: string) => vscode.Webview | undefined;
  /** Number of live CC GUI webviews (tabs/sidebars). Used to avoid cross-tab fallback. */
  private readonly getKnownWebviewCount?: () => number;
  private readonly globalState?: vscode.Memento;

  constructor(
    log: vscode.OutputChannel,
    getWebview: () => vscode.Webview | undefined,
    globalState?: vscode.Memento,
    getWebviewForBridgeRequestId?: (bridgeRequestId: string) => vscode.Webview | undefined,
    getKnownWebviewCount?: () => number,
  ) {
    this.log = log;
    this.getWebview = getWebview;
    this.globalState = globalState;
    this.getWebviewForBridgeRequestId = getWebviewForBridgeRequestId;
    this.getKnownWebviewCount = getKnownWebviewCount;
  }

  /**
   * Resolve which webview should show a permission / ask / plan dialog.
   *
   * Multi-window rule: when a bridgeRequestId is present, ONLY that turn's
   * webview may show the dialog. Falling back to the "last active" webview
   * causes cross-talk (串台) — dialogs from tab A pop on tab B / every page.
   * If the mapping is not ready yet, return undefined so the scanner defers.
   *
   * When bridgeRequestId is missing: only fall back to the last active webview
   * if a single webview is open. With multiple tabs, defer to avoid 串台.
   */
  private resolveTargetWebview(bridgeRequestId?: string | null): vscode.Webview | undefined {
    if (bridgeRequestId && this.getWebviewForBridgeRequestId) {
      const owned = this.getWebviewForBridgeRequestId(String(bridgeRequestId));
      if (owned) {
        return owned;
      }
      this.log.appendLine(
        `[BRIDGE] No webview mapped for bridgeRequestId=${bridgeRequestId}; deferring dialog (no cross-tab fallback)`,
      );
      return undefined;
    }

    const knownCount = this.getKnownWebviewCount?.() ?? 0;
    if (knownCount > 1) {
      this.log.appendLine(
        `[BRIDGE] Permission dialog missing bridgeRequestId with ${knownCount} webviews; deferring (no cross-tab fallback)`,
      );
      return undefined;
    }
    return this.getWebview();
  }

  start(): void {
    if (this.watcher) {
      return;
    }
    const dir = this.permissionIpcDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      this.log.appendLine(`[BRIDGE] Could not create permission dir: ${error}`);
    }

    const scan = () => {
      void this.scanToolPermissionRequestFiles(dir);
    };

    try {
      this.watcher = fs.watch(dir, () => {
        scan();
      });
      scan();
    } catch (error) {
      this.log.appendLine(`[BRIDGE] Permission dir watch failed: ${error}`);
    }

    // fs.watch is unreliable on some platforms; poll so we never miss a request file.
    this.scanInterval = setInterval(scan, 2000);
  }

  dispose(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = undefined;
    }
    this.awaitingUser.clear();
    this.completed.clear();
    this.pendingRequests.clear();
    try {
      this.watcher?.close();
    } catch {
      // Ignore watcher cleanup failures.
    }
    this.watcher = undefined;
  }

  handlePermissionDecision(content: string): void {
    try {
      const decision = JSON.parse(content) as {
        channelId?: string;
        allow?: boolean;
        remember?: boolean;
      };
      const requestId = decision.channelId;
      if (!requestId || typeof requestId !== 'string') {
        return;
      }

      this.awaitingUser.delete(requestId);
      this.completed.add(requestId);
      const sessionId = this.sessionIdForPermissionIpc();
      const dir = this.permissionIpcDir();
      fs.mkdirSync(dir, { recursive: true });
      const responseFile = path.join(dir, `response-${sessionId}-${requestId}.json`);
      const allow = decision.allow === true;
      fs.writeFileSync(responseFile, JSON.stringify({ allow }), 'utf8');
      const request = this.pendingRequests.get(requestId) ?? this.readRequestRecord(requestId);
      if (allow && decision.remember === true) {
        this.rememberApprovalForRequest(requestId, request);
      }
      this.deleteFileQuietly(path.join(dir, `request-${sessionId}-${requestId}.json`), 'answered permission request');
      this.pendingRequests.delete(requestId);
      this.log.appendLine(`[BRIDGE] permission_decision -> ${path.basename(responseFile)} allow=${allow} remember=${decision.remember === true}`);
    } catch (error) {
      this.log.appendLine(`[BRIDGE] permission_decision failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  handleAskUserQuestionResponse(content: string): void {
    try {
      const response = JSON.parse(content) as { requestId?: string; answers?: Record<string, unknown> };
      const requestId = response.requestId;
      if (!requestId || typeof requestId !== 'string') {
        return;
      }

      this.awaitingUser.delete(requestId);
      this.completed.add(requestId);
      const sessionId = this.sessionIdForPermissionIpc();
      const dir = this.permissionIpcDir();
      fs.mkdirSync(dir, { recursive: true });
      const responseFile = path.join(dir, `ask-user-question-response-${sessionId}-${requestId}.json`);
      fs.writeFileSync(responseFile, JSON.stringify({ answers: response.answers ?? {} }), 'utf8');
      // Delete the original request file so a later re-scan (after a webview reload
      // clears the in-memory `completed` set) does not re-open an already-answered
      // dialog. Without this the request lingers on disk forever and re-pops on
      // every re-entry.
      const requestFile = path.join(dir, `ask-user-question-${sessionId}-${requestId}.json`);
      this.deleteFileQuietly(requestFile, 'answered ask-user-question request');
      this.log.appendLine(`[BRIDGE] ask_user_question_response -> ${path.basename(responseFile)}`);
    } catch (error) {
      this.log.appendLine(`[BRIDGE] ask_user_question_response failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  handlePlanApprovalResponse(content: string): void {
    try {
      const response = JSON.parse(content) as { requestId?: string; approved?: boolean; targetMode?: string; message?: string };
      const requestId = response.requestId;
      if (!requestId || typeof requestId !== 'string') {
        return;
      }

      this.awaitingUser.delete(requestId);
      this.completed.add(requestId);
      const sessionId = this.sessionIdForPermissionIpc();
      const dir = this.permissionIpcDir();
      fs.mkdirSync(dir, { recursive: true });
      const responseFile = path.join(dir, `plan-approval-response-${sessionId}-${requestId}.json`);
      fs.writeFileSync(responseFile, JSON.stringify({
        approved: response.approved === true,
        targetMode: response.targetMode || 'default',
        message: response.message,
      }), 'utf8');
      // Delete the original request file so a later re-scan (after the in-memory
      // `completed` set is cleared on webview reload) does not re-open the dialog.
      const requestFile = path.join(dir, `plan-approval-${sessionId}-${requestId}.json`);
      this.deleteFileQuietly(requestFile, 'answered plan-approval request');
      this.log.appendLine(`[BRIDGE] plan_approval_response -> ${path.basename(responseFile)} approved=${response.approved === true}`);
    } catch (error) {
      this.log.appendLine(`[BRIDGE] plan_approval_response failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Must match ai-bridge/permission-ipc.js defaults. */
  private permissionIpcDir(): string {
    return process.env.CLAUDE_PERMISSION_DIR
      ? process.env.CLAUDE_PERMISSION_DIR
      : path.join(tmpdir(), 'claude-permission');
  }

  private sessionIdForPermissionIpc(): string {
    return process.env.CLAUDE_SESSION_ID || 'default';
  }

  private scanToolPermissionRequestFiles(dir: string): void {
    const sessionId = this.sessionIdForPermissionIpc();
    const prefix = `request-${sessionId}-`;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const name of entries) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) {
        continue;
      }
      const filePath = path.join(dir, name);
      const data = this.readJsonFile<{
        requestId?: string;
        toolName?: string;
        inputs?: Record<string, unknown>;
        cwd?: string;
        bridgeRequestId?: string;
      }>(filePath);
      const requestId = data?.requestId;
      if (!requestId || typeof requestId !== 'string' || !data?.toolName) {
        continue;
      }
      if (this.isStaleRequestFile(path.join(dir, name))) {
        this.completed.add(requestId);
        this.pendingRequests.delete(requestId);
        this.deleteFileQuietly(filePath, 'stale permission request');
        continue;
      }
      if (this.completed.has(requestId) || this.awaitingUser.has(requestId)) {
        continue;
      }
      const request = this.buildRequestRecord(data);
      const responseName = `response-${sessionId}-${requestId}.json`;
      if (entries.includes(responseName)) {
        this.completed.add(requestId);
        this.pendingRequests.delete(requestId);
        this.deleteFileQuietly(filePath, 'answered permission request');
        continue;
      }
      this.pendingRequests.set(requestId, request);
      if (this.isRememberedApproval(request.toolName, request.inputs, request.cwd)) {
        this.completed.add(requestId);
        this.pendingRequests.delete(requestId);
        try {
          const responseFile = path.join(dir, `response-${sessionId}-${requestId}.json`);
          fs.writeFileSync(responseFile, JSON.stringify({ allow: true }), 'utf8');
          this.deleteFileQuietly(filePath, 'remembered permission request');
          this.log.appendLine(`[BRIDGE] auto-allowed remembered permission for ${data.toolName} (${requestId})`);
        } catch (error) {
          this.log.appendLine(`[BRIDGE] auto-allow remembered permission failed: ${error}`);
        }
        continue;
      }

      const webview = this.resolveTargetWebview(data.bridgeRequestId);
      if (!webview) {
        // No panel ready yet — retry on next scan without marking awaitingUser.
        this.pendingRequests.delete(requestId);
        this.log.appendLine(
          `[BRIDGE] defer showPermissionDialog for ${data.toolName} (${requestId}) bridgeRequestId=${data.bridgeRequestId ?? '(none)'} (no webview)`,
        );
        continue;
      }

      this.awaitingUser.add(requestId);
      try {
        this.postDialogRequest(webview, 'showPermissionDialog', '__pendingPermissionDialogRequests', {
          channelId: requestId,
          toolName: data.toolName,
          inputs: data.inputs ?? {},
          cwd: data.cwd ?? '',
        });
      } catch (error) {
        this.awaitingUser.delete(requestId);
        this.pendingRequests.delete(requestId);
        this.log.appendLine(`[BRIDGE] showPermissionDialog postMessage failed: ${error}`);
        continue;
      }
      this.log.appendLine(
        `[BRIDGE] showPermissionDialog for ${data.toolName} (${requestId}) bridgeRequestId=${data.bridgeRequestId ?? '(none)'}`,
      );
    }

    this.scanAskUserQuestionRequestFiles(dir, entries, sessionId);
    this.scanPlanApprovalRequestFiles(dir, entries, sessionId);
  }

  private scanAskUserQuestionRequestFiles(dir: string, entries: string[], sessionId: string): void {
    const prefix = `ask-user-question-${sessionId}-`;
    for (const name of entries) {
      if (!name.startsWith(prefix) || !name.endsWith('.json') || name.startsWith(`ask-user-question-response-${sessionId}-`)) {
        continue;
      }
      const data = this.readJsonFile<{
        requestId?: string;
        toolName?: string;
        questions?: unknown[];
        bridgeRequestId?: string;
      }>(path.join(dir, name));
      const requestId = data?.requestId;
      if (!requestId || typeof requestId !== 'string') {
        continue;
      }
      if (this.completed.has(requestId) || this.awaitingUser.has(requestId)) {
        continue;
      }
      // Disk-durable guard: if an answer file already exists next to the request,
      // this request was answered in a previous session — do not re-open it, and
      // clean up the orphaned request file. Survives the in-memory set being reset.
      const responseName = `ask-user-question-response-${sessionId}-${requestId}.json`;
      if (entries.includes(responseName)) {
        this.completed.add(requestId);
        this.deleteFileQuietly(path.join(dir, name), 'stale answered ask-user-question request');
        continue;
      }
      const webview = this.resolveTargetWebview(data?.bridgeRequestId);
      if (!webview) {
        this.log.appendLine(
          `[BRIDGE] defer showAskUserQuestionDialog (${requestId}) bridgeRequestId=${data?.bridgeRequestId ?? '(none)'} (no webview)`,
        );
        continue;
      }
      this.awaitingUser.add(requestId);
      this.postDialogRequest(webview, 'showAskUserQuestionDialog', '__pendingAskUserQuestionDialogRequests', {
        requestId,
        toolName: data?.toolName ?? 'AskUserQuestion',
        questions: data?.questions ?? [],
      });
      this.log.appendLine(
        `[BRIDGE] showAskUserQuestionDialog (${requestId}) bridgeRequestId=${data?.bridgeRequestId ?? '(none)'}`,
      );
      // v0.4.7: optional OS notification when AskUserQuestion appears (opt-in).
      this.maybeNotifyAskUserQuestion(data?.toolName ?? 'AskUserQuestion');
    }
  }

  private maybeNotifyAskUserQuestion(toolName: string): void {
    try {
      const enabled = this.globalState?.get<boolean>('ccg.ask_user_question_notification_enabled', false) === true;
      if (!enabled) return;
      void vscode.window.showInformationMessage(
        `AI is waiting for your answer (${toolName})`,
      );
    } catch (error) {
      this.log.appendLine(`[BRIDGE] askUserQuestion notification failed: ${error}`);
    }
  }

  private scanPlanApprovalRequestFiles(dir: string, entries: string[], sessionId: string): void {
    const prefix = `plan-approval-${sessionId}-`;
    for (const name of entries) {
      if (!name.startsWith(prefix) || !name.endsWith('.json') || name.startsWith(`plan-approval-response-${sessionId}-`)) {
        continue;
      }
      const data = this.readJsonFile<{
        requestId?: string;
        toolName?: string;
        plan?: string;
        allowedPrompts?: unknown[];
        timestamp?: string;
        bridgeRequestId?: string;
      }>(path.join(dir, name));
      const requestId = data?.requestId;
      if (!requestId || typeof requestId !== 'string') {
        continue;
      }
      if (this.completed.has(requestId) || this.awaitingUser.has(requestId)) {
        continue;
      }
      // Disk-durable guard: skip and clean up requests already answered in a
      // previous session (their response file survives the in-memory set reset).
      const responseName = `plan-approval-response-${sessionId}-${requestId}.json`;
      if (entries.includes(responseName)) {
        this.completed.add(requestId);
        this.deleteFileQuietly(path.join(dir, name), 'stale answered plan-approval request');
        continue;
      }
      const webview = this.resolveTargetWebview(data?.bridgeRequestId);
      if (!webview) {
        this.log.appendLine(
          `[BRIDGE] defer showPlanApprovalDialog (${requestId}) bridgeRequestId=${data?.bridgeRequestId ?? '(none)'} (no webview)`,
        );
        continue;
      }
      this.awaitingUser.add(requestId);
      this.postDialogRequest(webview, 'showPlanApprovalDialog', '__pendingPlanApprovalDialogRequests', {
        requestId,
        toolName: data?.toolName ?? 'ExitPlanMode',
        plan: data?.plan ?? '',
        allowedPrompts: data?.allowedPrompts ?? [],
        timestamp: data?.timestamp,
      });
      this.log.appendLine(
        `[BRIDGE] showPlanApprovalDialog (${requestId}) bridgeRequestId=${data?.bridgeRequestId ?? '(none)'}`,
      );
    }
  }

  private readJsonFile<T>(filePath: string): T | null {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!raw.trim()) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private rememberApprovalForRequest(requestId: string, request?: ToolPermissionRequest): void {
    if (!this.globalState) {
      return;
    }
    const resolvedRequest = request ?? this.readRequestRecord(requestId);
    if (!resolvedRequest?.toolName) {
      this.log.appendLine(`[BRIDGE] remember approval skipped: request file missing for ${requestId}`);
      return;
    }

    const nextApproval = buildRememberedApproval(
      resolvedRequest.toolName,
      resolvedRequest.inputs ?? {},
      resolvedRequest.cwd,
    );
    const existing = this.readRememberedApprovals();
    const deduped = existing.filter((item) => !sameRememberedApproval(item, nextApproval));
    deduped.push(nextApproval);
    this.rememberedApprovals.length = 0;
    this.rememberedApprovals.push(...deduped);
    void this.globalState.update(REMEMBERED_TOOL_APPROVALS_KEY, deduped);
    this.log.appendLine(`[BRIDGE] remembered permission for ${resolvedRequest.toolName} (${requestId})`);
  }

  private readRememberedApprovals(): RememberedApproval[] {
    if (!this.globalState) {
      return this.rememberedApprovals.slice();
    }
    const raw = this.globalState.get<RememberedApproval[]>(REMEMBERED_TOOL_APPROVALS_KEY, []);
    const persisted = Array.isArray(raw) ? raw.filter((item) => item && typeof item.toolName === 'string') : [];
    if (this.rememberedApprovals.length === 0) {
      return persisted;
    }
    return persisted.concat(
      this.rememberedApprovals.filter((item) => !persisted.some((existing) => sameRememberedApproval(existing, item))),
    );
  }

  private isRememberedApproval(toolName: string, inputs: Record<string, unknown>, cwd?: string): boolean {
    const candidate = buildRememberedApproval(toolName, inputs, cwd);
    return this.readRememberedApprovals().some((item) => sameRememberedApproval(item, candidate));
  }

  private isStaleRequestFile(filePath: string): boolean {
    try {
      const stats = fs.statSync(filePath);
      return (Date.now() - stats.mtimeMs) > STALE_PERMISSION_REQUEST_MAX_AGE_MS;
    } catch {
      return false;
    }
  }

  private deleteFileQuietly(filePath: string, label: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this.log.appendLine(`[BRIDGE] deleted ${label}: ${path.basename(filePath)}`);
      }
    } catch (error) {
      this.log.appendLine(`[BRIDGE] failed deleting ${label}: ${error}`);
    }
  }

  private readRequestRecord(requestId: string): ToolPermissionRequest | undefined {
    const requestFile = path.join(this.permissionIpcDir(), `request-${this.sessionIdForPermissionIpc()}-${requestId}.json`);
    const data = this.readJsonFile<{ requestId?: string; toolName?: string; inputs?: Record<string, unknown>; cwd?: string }>(requestFile);
    if (!data?.toolName) {
      return undefined;
    }
    return this.buildRequestRecord(data);
  }

  private buildRequestRecord(data: {
    requestId?: string;
    toolName?: string;
    inputs?: Record<string, unknown>;
    cwd?: string;
    bridgeRequestId?: string;
  }): ToolPermissionRequest {
    return {
      requestId: data.requestId ?? '',
      toolName: data.toolName ?? '',
      inputs: data.inputs ?? {},
      cwd: typeof data.cwd === 'string' ? data.cwd.trim() : '',
      bridgeRequestId: typeof data.bridgeRequestId === 'string' ? data.bridgeRequestId : undefined,
    };
  }

  private postDialogRequest(
    webview: vscode.Webview,
    functionName: string,
    pendingQueueName: string,
    payload: unknown,
  ): void {
    const stringArg = JSON.stringify(JSON.stringify(payload));
    const evalContent = [
      'try{',
      'var _d=',
      stringArg,
      ';',
      `if (typeof window.${functionName}==='function'){window.${functionName}(_d);}`,
      'else{',
      `var a=window.${pendingQueueName}=window.${pendingQueueName}||[];`,
      'a.push(_d);',
      '};',
      `}catch(e){console.error('[BRIDGE] ${functionName}',e);}`,
    ].join('');
    webview.postMessage({ type: 'js_eval', content: evalContent });
  }
}
