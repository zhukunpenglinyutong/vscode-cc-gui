import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { NodeDetector } from '../../nodeDetector';
import { isLikelyNodeExecutable } from '../../nodeDetectorUtils';
import { LanguageConfigPayload, resolveLanguageConfig } from '../../language';
import { StateStore } from './StateStore';
import {
  MIN_NODE_MAJOR_VERSION,
  formatNodeRequirementError,
  isNodeVersionSupported,
  readNodeVersion,
} from '../../nodeRequirements';
const DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS = 300;
const MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS = 30;
const MAX_PERMISSION_DIALOG_TIMEOUT_SECONDS = 3600;

/** Frontend stream stall watchdog (seconds of no streaming activity). */
const DEFAULT_STREAM_STALL_TIMEOUT_SECONDS = 180;
/** Allow 1s for local testing; no practical upper cap for now. */
const MIN_STREAM_STALL_TIMEOUT_SECONDS = 1;
const MAX_STREAM_STALL_TIMEOUT_SECONDS = 86400;
const LEGACY_STREAM_STALL_TIMEOUT_MINUTES_KEY = 'ccg.stream_stall_timeout_minutes';

type FontMode = 'followEditor' | 'customFile';
type FontConfig = {
  mode: FontMode;
  effectiveMode: FontMode;
  customFontPath?: string;
  fontFamily: string;
  displayName?: string;
  fontSize: number;
  lineSpacing: number;
  fallbackFonts?: string[];
  fontUrl?: string;
  fontBase64?: string;
  fontFormat?: 'truetype' | 'opentype';
  warningCode?: 'fontUnavailable';
  warning?: string;
};

export class SettingsStore {
  private readonly state: StateStore;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.state = new StateStore(context);
  }

  getStreamingEnabled(): boolean {
    return this.parseBooleanState('streaming_enabled', true, 'streamingEnabled');
  }

  setStreamingEnabled(content: string): Thenable<void> {
    return this.setJsonOrRaw('streaming_enabled', content, 'streamingEnabled');
  }

  getSendShortcut(): 'enter' | 'cmdEnter' {
    const raw = this.parseJsonState<string>('send_shortcut', 'enter', 'sendShortcut');
    const normalized = String(raw).toLowerCase();
    return normalized === 'cmdenter' || normalized === 'cmd_enter' || normalized === 'cmdEnter'.toLowerCase()
      ? 'cmdEnter'
      : 'enter';
  }

  setSendShortcut(content: string): Thenable<void> {
    return this.setJsonOrRaw('send_shortcut', content, 'sendShortcut');
  }

  getAutoOpenFileEnabled(): boolean {
    return this.parseBooleanState('auto_open_file', false, 'autoOpenFileEnabled');
  }

  setAutoOpenFileEnabled(content: string): Thenable<void> {
    return this.setJsonOrRaw('auto_open_file', content, 'autoOpenFileEnabled');
  }

  getThinkingEnabled(): boolean {
    return this.parseBooleanState('thinking_enabled', false, 'thinkingEnabled');
  }

  setThinkingEnabled(content: string): Thenable<void> {
    return this.setJsonOrRaw('thinking_enabled', content, 'thinkingEnabled');
  }

  getPermissionMode(): string {
    return this.state.getString('ccg.permission_mode', 'default');
  }

  setPermissionMode(content: string): Thenable<void> {
    return this.state.updateString('ccg.permission_mode', this.extractJsonField(content, 'mode') ?? content);
  }

  getAskUserQuestionNotificationEnabled(): boolean {
    return this.state.get<boolean>('ccg.ask_user_question_notification_enabled', false);
  }

  setAskUserQuestionNotificationEnabled(content: string): Thenable<void> {
    const parsed = this.parseJson<Record<string, unknown> | undefined>(content, undefined);
    let enabled = false;
    if (typeof parsed?.askUserQuestionNotificationEnabled === 'boolean') {
      enabled = parsed.askUserQuestionNotificationEnabled;
    } else if (typeof parsed?.enabled === 'boolean') {
      enabled = parsed.enabled;
    } else {
      enabled = content === 'true' || content === '1';
    }
    return this.state.update('ccg.ask_user_question_notification_enabled', enabled);
  }

  /** Opt-in: show VS Code notification when an AI task completes (default false). */
  getTaskCompletionNotificationEnabled(): boolean {
    return this.state.get<boolean>('ccg.task_completion_notification_enabled', false);
  }

  setTaskCompletionNotificationEnabled(content: string): Thenable<void> {
    const parsed = this.parseJson<Record<string, unknown> | undefined>(content, undefined);
    let enabled = false;
    if (typeof parsed?.taskCompletionNotificationEnabled === 'boolean') {
      enabled = parsed.taskCompletionNotificationEnabled;
    } else if (typeof parsed?.enabled === 'boolean') {
      enabled = parsed.enabled;
    } else {
      enabled = content === 'true' || content === '1';
    }
    return this.state.update('ccg.task_completion_notification_enabled', enabled);
  }

  getCodexSandboxMode(): 'workspace-write' | 'danger-full-access' {
    const mode = this.state.getString('ccg.codex_sandbox_mode', 'workspace-write');
    return mode === 'danger-full-access' ? 'danger-full-access' : 'workspace-write';
  }

  setCodexSandboxMode(content: string): Thenable<void> {
    const mode = this.extractJsonField(content, 'sandboxMode') ?? content;
    return this.state.updateString(
      'ccg.codex_sandbox_mode',
      mode === 'danger-full-access' ? 'danger-full-access' : 'workspace-write',
    );
  }

  getReasoningEffort(): string {
    return this.state.getString('ccg.reasoning_effort', '');
  }

  setReasoningEffort(content: string): Thenable<void> {
    return this.state.updateString('ccg.reasoning_effort', this.extractJsonField(content, 'reasoningEffort') ?? content);
  }

  getCodexFastMode(): string {
    return this.state.getString('ccg.codex_fast_mode', '');
  }

  setCodexFastMode(content: string): Thenable<void> {
    return this.state.updateString('ccg.codex_fast_mode', this.extractJsonField(content, 'codexFastMode') ?? content);
  }

  getNodePathPayload(): {
    path: string;
    version: string | null;
    minVersion: number;
    valid: boolean;
    error?: string;
  } {
    const configured = (vscode.workspace.getConfiguration('ccGui').get<string>('nodePath') ?? '').trim();
    const configuredNode =
      configured && fs.existsSync(configured) && isLikelyNodeExecutable(configured) ? configured : '';
    const runtimePath = NodeDetector.find(this.context) ?? '';
    const nodePath = configuredNode || runtimePath;
    const version = nodePath ? readNodeVersion(nodePath) : null;
    const valid = !!nodePath && isNodeVersionSupported(version);
    const error = valid ? undefined : formatNodeRequirementError(nodePath || undefined, version);
    return {
      path: nodePath,
      version,
      minVersion: MIN_NODE_MAJOR_VERSION,
      valid,
      error,
    };
  }

  async setNodePath(content: string): Promise<ReturnType<SettingsStore['getNodePathPayload']>> {
    const parsedPath = this.extractJsonField(content, 'path') ?? content;
    const nodePath = parsedPath.trim();
    await vscode.workspace
      .getConfiguration('ccGui')
      .update('nodePath', nodePath, vscode.ConfigurationTarget.Global);
    return this.getNodePathPayload();
  }

  getWorkingDirectoryPayload(workspacePath: string): { customWorkingDir: string; effectiveWorkingDir: string; workspacePath: string } {
    const customWorkingDir = this.state.getString('ccg.working_directory', '');
    return {
      customWorkingDir,
      effectiveWorkingDir: customWorkingDir || workspacePath,
      workspacePath,
    };
  }

  setWorkingDirectory(content: string): Thenable<void> {
    const dir = this.extractJsonField(content, 'customWorkingDir') ?? this.extractJsonField(content, 'path') ?? content;
    return this.state.updateString('ccg.working_directory', dir.trim());
  }

  getEditorFontConfig(): { fontFamily: string; fontSize: number; lineSpacing: number } {
    const editorConfig = vscode.workspace.getConfiguration('editor');
    return {
      fontFamily: editorConfig.get<string>('fontFamily') ?? '',
      fontSize: editorConfig.get<number>('fontSize') ?? 14,
      lineSpacing: editorConfig.get<number>('lineHeight') ?? 0,
    };
  }

  getUiFontConfig(): FontConfig {
    return this.getResolvedFontConfig('ccg.ui_font_config', { appendSansFallback: true });
  }

  async setUiFontConfig(content: string): Promise<FontConfig> {
    await this.setFontConfig('ccg.ui_font_config', content);
    return this.getUiFontConfig();
  }

  getCodeFontConfig(): FontConfig {
    return this.getResolvedFontConfig('ccg.code_font_config', { appendSansFallback: false });
  }

  async setCodeFontConfig(content: string): Promise<FontConfig> {
    await this.setFontConfig('ccg.code_font_config', content);
    return this.getCodeFontConfig();
  }

  getIdeTheme(): { isDark: boolean; kind: number } {
    const kind = vscode.window.activeColorTheme.kind;
    return {
      isDark: kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast,
      kind,
    };
  }

  getCommitPrompt(): string {
    return this.state.getString('ccg.commit_prompt', '');
  }

  setCommitPrompt(content: string): Thenable<void> {
    const prompt = this.extractJsonField(content, 'prompt') ?? this.extractJsonField(content, 'commitPrompt') ?? content;
    return this.state.updateString('ccg.commit_prompt', prompt);
  }

  getCommitAiConfig(): any {
    return this.resolveAiFeatureConfig(this.state.get<any>('ccg.commit_ai_config', {}), 'codex');
  }

  setCommitAiConfig(content: string): Thenable<void> {
    return this.state.update('ccg.commit_ai_config', this.parseJson(content, {}));
  }

  getPromptEnhancerConfig(): any {
    return this.resolveAiFeatureConfig(this.state.get<any>('ccg.prompt_enhancer_config', {}), 'claude');
  }

  setPromptEnhancerConfig(content: string): Thenable<void> {
    return this.state.update('ccg.prompt_enhancer_config', this.parseJson(content, {}));
  }

  getProjectCommitPrompt(workspacePath: string): string {
    const map = this.state.get<Record<string, string>>('ccg.project_commit_prompt', {});
    return map[workspacePath] ?? '';
  }

  async setProjectCommitPrompt(content: string, workspacePath: string): Promise<void> {
    const prompt = this.extractJsonField(content, 'prompt') ?? this.extractJsonField(content, 'commitPrompt') ?? content;
    const map = this.state.get<Record<string, string>>('ccg.project_commit_prompt', {});
    map[workspacePath || '__NO_WORKSPACE__'] = prompt;
    await this.state.update('ccg.project_commit_prompt', map);
  }

  getSoundConfig(): any {
    return this.state.get<any>('ccg.soundConfig', {
      enabled: false,
      onlyWhenUnfocused: false,
      selectedSound: 'default',
      customSoundPath: '',
    });
  }

  async patchSoundConfig(patch: Record<string, unknown>): Promise<any> {
    const cfg = { ...this.getSoundConfig(), ...patch };
    await this.state.update('ccg.soundConfig', cfg);
    return cfg;
  }

  getInputHistory(): string[] {
    return this.state.get<string[]>('ccg.input_history', []);
  }

  async recordInputHistory(content: string): Promise<string[]> {
    const text = this.extractJsonField(content, 'text') ?? content;
    const trimmed = text.trim();
    if (!trimmed) return this.getInputHistory();
    const next = [trimmed, ...this.getInputHistory().filter((item) => item !== trimmed)].slice(0, 100);
    await this.state.update('ccg.input_history', next);
    return next;
  }

  async deleteInputHistoryItem(content: string): Promise<string[]> {
    const item = this.extractJsonField(content, 'text') ?? this.extractJsonField(content, 'item') ?? content;
    const next = this.getInputHistory().filter((entry) => entry !== item);
    await this.state.update('ccg.input_history', next);
    return next;
  }

  async clearInputHistory(): Promise<void> {
    await this.state.update('ccg.input_history', []);
  }

  getUserLanguage(): { language: string; manuallySet: boolean } {
    const language = this.state.getString('ccg.user_language', '');
    return { language, manuallySet: !!language };
  }

  /**
   * Effective UI language for the webview:
   * - manual override when the user picked a language in settings
   * - otherwise follow VS Code display language (vscode.env.language)
   * - unknown locales fall back to Simplified Chinese
   */
  resolveLanguageConfig(): LanguageConfigPayload {
    const { language } = this.getUserLanguage();
    return resolveLanguageConfig(language, vscode.env.language);
  }

  setUserLanguage(content: string): Thenable<void> {
    const language = this.extractJsonField(content, 'language') ?? content;
    return this.state.updateString('ccg.user_language', language);
  }

  clearUserLanguage(): Thenable<void> {
    return this.state.update('ccg.user_language', undefined);
  }

  getClaudeCliPath(): string {
    return this.state.getString('ccg.claude_cli_path', '');
  }

  setClaudeCliPath(content: string): Thenable<void> {
    const cliPath = this.extractJsonField(content, 'path') ?? content;
    return this.state.updateString('ccg.claude_cli_path', cliPath.trim());
  }

  getPermissionDialogTimeoutSeconds(): number {
    return this.clampPermissionDialogTimeoutSeconds(this.state.get<number>('ccg.permission_dialog_timeout_seconds', DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS));
  }

  setPermissionDialogTimeoutSeconds(content: string): Thenable<void> {
    const parsed = this.parseJson<Record<string, unknown>>(content, {});
    const seconds = this.clampPermissionDialogTimeoutSeconds(parsed.permissionDialogTimeoutSeconds);
    return this.state.update('ccg.permission_dialog_timeout_seconds', seconds);
  }

  getStreamStallTimeoutSeconds(): number {
    const storedSeconds = this.state.get<number | undefined>('ccg.stream_stall_timeout_seconds', undefined);
    if (storedSeconds !== undefined && storedSeconds !== null) {
      return this.clampStreamStallTimeoutSeconds(storedSeconds);
    }
    // One-time migration from the short-lived minutes-based key.
    const legacyMinutes = this.state.get<number | undefined>(LEGACY_STREAM_STALL_TIMEOUT_MINUTES_KEY, undefined);
    if (legacyMinutes !== undefined && legacyMinutes !== null && Number.isFinite(legacyMinutes)) {
      return this.clampStreamStallTimeoutSeconds(Number(legacyMinutes) * 60);
    }
    return DEFAULT_STREAM_STALL_TIMEOUT_SECONDS;
  }

  setStreamStallTimeoutSeconds(content: string): Thenable<void> {
    const parsed = this.parseJson<Record<string, unknown>>(content, {});
    // Prefer seconds; migrate legacy minutes field if present.
    const raw = parsed.streamStallTimeoutSeconds !== undefined && parsed.streamStallTimeoutSeconds !== null
      ? parsed.streamStallTimeoutSeconds
      : (parsed.streamStallTimeoutMinutes !== undefined && parsed.streamStallTimeoutMinutes !== null
        ? Number(parsed.streamStallTimeoutMinutes) * 60
        : undefined);
    const seconds = this.clampStreamStallTimeoutSeconds(raw);
    return this.state.update('ccg.stream_stall_timeout_seconds', seconds);
  }

  getCommitGenerationEnabled(): boolean {
    return this.state.get<boolean>('ccg.commit_generation_enabled', true);
  }

  setCommitGenerationEnabled(content: string): Thenable<void> {
    return this.state.update('ccg.commit_generation_enabled', this.extractBooleanField(content, 'commitGenerationEnabled', true));
  }

  getAiTitleGenerationEnabled(): boolean {
    return this.state.get<boolean>('ccg.ai_title_generation_enabled', true);
  }

  setAiTitleGenerationEnabled(content: string): Thenable<void> {
    return this.state.update('ccg.ai_title_generation_enabled', this.extractBooleanField(content, 'aiTitleGenerationEnabled', true));
  }

  getStatusBarWidgetEnabled(): boolean {
    return this.state.get<boolean>('ccg.status_bar_widget_enabled', true);
  }

  setStatusBarWidgetEnabled(content: string): Thenable<void> {
    return this.state.update('ccg.status_bar_widget_enabled', this.extractBooleanField(content, 'statusBarWidgetEnabled', true));
  }

  /** VS Code setting `ccGui.enableDebugLog` (default false). */
  getEnableDebugLog(): boolean {
    return vscode.workspace.getConfiguration('ccGui').get<boolean>('enableDebugLog') === true;
  }

  setEnableDebugLog(content: string): Thenable<void> {
    const enabled = this.extractBooleanField(content, 'enableDebugLog', false);
    return vscode.workspace
      .getConfiguration('ccGui')
      .update('enableDebugLog', enabled, vscode.ConfigurationTarget.Global);
  }

  private parseBooleanState(key: string, defaultValue: boolean, jsonField: string): boolean {
    const raw = this.state.getString(`ccg.${key}`, String(defaultValue));
    const parsed = this.parseJson(raw, undefined);
    if (typeof parsed === 'object' && parsed && jsonField in parsed) {
      return Boolean((parsed as Record<string, unknown>)[jsonField]);
    }
    if (typeof parsed === 'boolean') return parsed;
    return raw === 'true';
  }

  private parseJsonState<T>(key: string, defaultValue: T, jsonField: string): T {
    const raw = this.state.getString(`ccg.${key}`, String(defaultValue));
    const parsed = this.parseJson(raw, undefined);
    if (typeof parsed === 'object' && parsed && jsonField in parsed) {
      return (parsed as Record<string, T>)[jsonField];
    }
    return (parsed as T) ?? (raw as T) ?? defaultValue;
  }

  private setJsonOrRaw(key: string, content: string, jsonField: string): Thenable<void> {
    const value = this.extractJsonField(content, jsonField) ?? content;
    return this.state.updateString(`ccg.${key}`, String(value));
  }

  private extractJsonField(content: string, field: string): string | undefined {
    const parsed = this.parseJson<Record<string, unknown> | undefined>(content, undefined);
    const value = parsed?.[field];
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean' || typeof value === 'number') return String(value);
    return undefined;
  }

  private extractBooleanField(content: string, field: string, defaultValue: boolean): boolean {
    const parsed = this.parseJson<Record<string, unknown> | undefined>(content, undefined);
    const value = parsed?.[field];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value === 'true';
    return defaultValue;
  }

  private parseJson<T>(content: string, fallback: T): T {
    try {
      return JSON.parse(content) as T;
    } catch {
      return fallback;
    }
  }

  private clampPermissionDialogTimeoutSeconds(value: unknown): number {
    const parsed = typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
    if (!Number.isFinite(parsed)) return DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS;
    return Math.max(MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS, Math.min(MAX_PERMISSION_DIALOG_TIMEOUT_SECONDS, Math.trunc(parsed)));
  }

  private clampStreamStallTimeoutSeconds(value: unknown): number {
    const parsed = typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
    if (!Number.isFinite(parsed)) return DEFAULT_STREAM_STALL_TIMEOUT_SECONDS;
    return Math.max(
      MIN_STREAM_STALL_TIMEOUT_SECONDS,
      Math.min(MAX_STREAM_STALL_TIMEOUT_SECONDS, Math.trunc(parsed)),
    );
  }

  private getResolvedFontConfig(key: string, options: { appendSansFallback: boolean }): FontConfig {
    const stored = this.state.get<Partial<FontConfig>>(key, { mode: 'followEditor' });
    const editor = this.getEditorFontConfig();
    const mode: FontMode = stored.mode === 'customFile' ? 'customFile' : 'followEditor';
    const fallbackFonts = options.appendSansFallback
      ? ['Inter', 'system-ui', 'sans-serif']
      : ['Consolas', 'monospace'];

    if (mode === 'customFile' && stored.customFontPath) {
      const file = this.readFontFile(stored.customFontPath);
      if (file) {
        return {
          mode,
          effectiveMode: 'customFile',
          customFontPath: stored.customFontPath,
          fontFamily: path.basename(stored.customFontPath, path.extname(stored.customFontPath)),
          displayName: path.basename(stored.customFontPath),
          fontSize: editor.fontSize,
          lineSpacing: editor.lineSpacing,
          fallbackFonts,
          fontBase64: file.base64,
          fontFormat: file.format,
        };
      }
      return {
        mode,
        effectiveMode: 'followEditor',
        customFontPath: stored.customFontPath,
        fontFamily: editor.fontFamily || (options.appendSansFallback ? 'Inter' : 'Consolas'),
        fontSize: editor.fontSize,
        lineSpacing: editor.lineSpacing,
        fallbackFonts,
        warningCode: 'fontUnavailable',
        warning: 'Custom font file is not available',
      };
    }

    return {
      mode: 'followEditor',
      effectiveMode: 'followEditor',
      fontFamily: editor.fontFamily || (options.appendSansFallback ? 'Inter' : 'Consolas'),
      fontSize: editor.fontSize,
      lineSpacing: editor.lineSpacing,
      fallbackFonts,
    };
  }

  private async setFontConfig(key: string, content: string): Promise<void> {
    const parsed = this.parseJson<Partial<FontConfig>>(content, {});
    const mode: FontMode = parsed.mode === 'customFile' ? 'customFile' : 'followEditor';
    const customFontPath = typeof parsed.customFontPath === 'string' ? parsed.customFontPath.trim() : '';
    await this.state.update(key, mode === 'customFile'
      ? { mode, customFontPath }
      : { mode: 'followEditor' });
  }

  private readFontFile(fontPath: string): { base64: string; format: 'truetype' | 'opentype' } | null {
    try {
      if (!fontPath || !fs.existsSync(fontPath) || !fs.statSync(fontPath).isFile()) return null;
      const ext = path.extname(fontPath).toLowerCase();
      if (!['.ttf', '.otf'].includes(ext)) return null;
      return {
        base64: fs.readFileSync(fontPath).toString('base64'),
        format: ext === '.otf' ? 'opentype' : 'truetype',
      };
    } catch {
      return null;
    }
  }

  private resolveAiFeatureConfig(raw: any, defaultProvider: 'claude' | 'codex'): any {
    const models = {
      claude: raw?.models?.claude || 'claude-sonnet-4-6',
      codex: raw?.models?.codex || 'gpt-5.5',
    };
    const availability = {
      claude: true,
      codex: true,
    };
    const requestedProvider = raw?.provider === 'claude' || raw?.provider === 'codex' ? raw.provider : null;
    const effectiveProvider = requestedProvider || defaultProvider;
    return {
      provider: requestedProvider,
      effectiveProvider,
      resolutionSource: requestedProvider ? 'manual' : 'auto',
      models,
      availability,
    };
  }
}

export function dirnameOrWorkspace(filePath: string, workspacePath: string): string {
  return filePath ? path.dirname(filePath) : workspacePath;
}
