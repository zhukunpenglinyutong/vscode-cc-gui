import * as vscode from 'vscode';
import { BridgeContext, BridgeHandler, BridgeMessage } from '../types';
import { SettingsStore } from '../services/SettingsStore';
import { callWindowFunction, parseJson, postJson, postRaw } from './helpers';

export class SettingsHandler implements BridgeHandler {
  readonly supportedEvents = [
    'set_provider',
    'set_model',
    'set_reasoning_effort',
    'set_codex_fast_mode',
    'get_node_path',
    'set_node_path',
    'get_claude_cli_path',
    'set_claude_cli_path',
    'get_working_directory',
    'set_working_directory',
    'get_editor_font_config',
    'get_ui_font_config',
    'set_ui_font_config',
    'browse_ui_font_file',
    'get_code_font_config',
    'set_code_font_config',
    'browse_code_font_file',
    'get_streaming_enabled',
    'set_streaming_enabled',
    'get_codex_sandbox_mode',
    'set_codex_sandbox_mode',
    'get_send_shortcut',
    'set_send_shortcut',
    'get_auto_open_file_enabled',
    'set_auto_open_file_enabled',
    'get_thinking_enabled',
    'set_thinking_enabled',
    'get_mode',
    'set_mode',
    'get_commit_prompt',
    'set_commit_prompt',
    'get_commit_ai_config',
    'set_commit_ai_config',
    'get_prompt_enhancer_config',
    'set_prompt_enhancer_config',
    'get_project_commit_prompt',
    'set_project_commit_prompt',
    'get_input_history',
    'record_input_history',
    'delete_input_history_item',
    'clear_input_history',
    'get_sound_notification_config',
    'set_sound_notification_config',
    'set_sound_notification_enabled',
    'set_sound_only_when_unfocused',
    'set_selected_sound',
    'set_custom_sound_path',
    'test_sound',
    'browse_sound_file',
    'get_user_language',
    'set_user_language',
    'clear_user_language',
    'get_ide_theme',
    'get_permission_dialog_timeout',
    'set_permission_dialog_timeout',
    'get_stream_stall_timeout',
    'set_stream_stall_timeout',
    'get_commit_generation_enabled',
    'set_commit_generation_enabled',
    'get_status_bar_widget_enabled',
    'set_status_bar_widget_enabled',
    'get_enable_debug_log',
    'set_enable_debug_log',
    'get_ai_title_generation_enabled',
    'set_ai_title_generation_enabled',
    'get_ask_user_question_notification_enabled',
    'set_ask_user_question_notification_enabled',
    'get_task_completion_notification_enabled',
    'set_task_completion_notification_enabled',
  ] as const;

  private readonly store: SettingsStore;

  constructor(private readonly context: BridgeContext, store?: SettingsStore) {
    this.store = store ?? new SettingsStore(context.extensionContext);
  }

  async handle({ event, content, webview }: BridgeMessage): Promise<boolean> {
    switch (event) {
      case 'set_provider': {
        const provider = content.trim();
        if (
          provider === 'claude' ||
          provider === 'codex' ||
          provider === 'grok' ||
          provider === 'kimi' ||
          provider === 'opencode' ||
          provider === 'pi'
        ) {
          this.context.callbacks.setActiveProvider(provider);
        }
        return true;
      }
      case 'set_model':
        this.context.callbacks.setSelectedModel(content || '');
        return true;
      case 'set_reasoning_effort':
        await this.store.setReasoningEffort(content);
        return true;
      case 'set_codex_fast_mode':
        await this.store.setCodexFastMode(content);
        return true;

      case 'get_node_path':
        callWindowFunction(webview, 'updateNodePath', this.store.getNodePathPayload());
        return true;
      case 'set_node_path': {
        // Persist first, then restart daemon so the new binary is actually used.
        // Without restart, the old Node process keeps handling chat (settings-only warning).
        // Do NOT toast/alert here: Environment tab already shows the red "unsupported" card.
        const payload = await this.store.setNodePath(content);
        callWindowFunction(webview, 'updateNodePath', payload);
        this.context.callbacks.restartBridgeDaemon();
        return true;
      }

      case 'get_claude_cli_path':
        callWindowFunction(webview, 'updateClaudeCliPath', { path: this.store.getClaudeCliPath() });
        return true;
      case 'set_claude_cli_path':
        await this.store.setClaudeCliPath(content);
        callWindowFunction(webview, 'updateClaudeCliPath', { path: this.store.getClaudeCliPath(), saved: true });
        // CLI path is read by the daemon; restart so override takes effect.
        this.context.callbacks.restartBridgeDaemon();
        return true;

      case 'get_working_directory':
        callWindowFunction(webview, 'updateWorkingDirectory', this.store.getWorkingDirectoryPayload(this.context.getWorkspacePath()));
        return true;
      case 'set_working_directory':
        await this.store.setWorkingDirectory(content);
        callWindowFunction(webview, 'updateWorkingDirectory', this.store.getWorkingDirectoryPayload(this.context.getWorkspacePath()));
        callWindowFunction(webview, 'showSuccess', 'Working directory saved');
        return true;

      case 'get_editor_font_config':
        callWindowFunction(webview, 'onEditorFontConfigReceived', this.store.getEditorFontConfig());
        return true;
      case 'get_ui_font_config':
        callWindowFunction(webview, 'onUiFontConfigReceived', this.store.getUiFontConfig());
        return true;
      case 'set_ui_font_config':
        callWindowFunction(webview, 'onUiFontConfigReceived', await this.store.setUiFontConfig(content));
        return true;
      case 'get_code_font_config':
        callWindowFunction(webview, 'onCodeFontConfigReceived', this.store.getCodeFontConfig());
        return true;
      case 'set_code_font_config':
        callWindowFunction(webview, 'onCodeFontConfigReceived', await this.store.setCodeFontConfig(content));
        return true;
      case 'browse_ui_font_file':
      case 'browse_code_font_file':
        await this.pickFontFile(webview, event === 'browse_ui_font_file' ? 'onBrowseUiFontFileResult' : 'onBrowseCodeFontFileResult');
        return true;

      case 'get_streaming_enabled':
        postJson(webview, 'update_streaming_enabled', { streamingEnabled: this.store.getStreamingEnabled() });
        return true;
      case 'set_streaming_enabled':
        await this.store.setStreamingEnabled(content);
        postJson(webview, 'update_streaming_enabled', { streamingEnabled: this.store.getStreamingEnabled() });
        return true;

      case 'get_codex_sandbox_mode':
        callWindowFunction(webview, 'updateCodexSandboxMode', { sandboxMode: this.store.getCodexSandboxMode() });
        return true;
      case 'set_codex_sandbox_mode':
        await this.store.setCodexSandboxMode(content);
        callWindowFunction(webview, 'updateCodexSandboxMode', { sandboxMode: this.store.getCodexSandboxMode() });
        return true;

      case 'get_send_shortcut':
        postJson(webview, 'update_send_shortcut', { sendShortcut: this.store.getSendShortcut() });
        return true;
      case 'set_send_shortcut':
        await this.store.setSendShortcut(content);
        postJson(webview, 'update_send_shortcut', { sendShortcut: this.store.getSendShortcut() });
        return true;

      case 'get_auto_open_file_enabled':
        {
          const autoOpenFileEnabled = this.store.getAutoOpenFileEnabled();
          postJson(webview, 'update_auto_open_file_enabled', { autoOpenFileEnabled });
          // Startup / remount: if the setting is already on, push after the gate opens.
          if (autoOpenFileEnabled) {
            this.context.callbacks.getActiveFile(webview);
          }
        }
        return true;
      case 'set_auto_open_file_enabled':
        await this.store.setAutoOpenFileEnabled(content);
        {
          const autoOpenFileEnabled = this.store.getAutoOpenFileEnabled();
          postJson(webview, 'update_auto_open_file_enabled', { autoOpenFileEnabled });
          // Re-sync current editor file when the user turns the feature back on.
          if (autoOpenFileEnabled) {
            this.context.callbacks.getActiveFile(webview);
          }
        }
        return true;

      case 'get_thinking_enabled':
        postJson(webview, 'update_thinking_enabled', this.store.getThinkingEnabled());
        return true;
      case 'set_thinking_enabled':
        await this.store.setThinkingEnabled(content);
        postJson(webview, 'update_thinking_enabled', this.store.getThinkingEnabled());
        return true;

      case 'get_ask_user_question_notification_enabled':
        postJson(webview, 'update_ask_user_question_notification_enabled', {
          askUserQuestionNotificationEnabled: this.store.getAskUserQuestionNotificationEnabled(),
        });
        return true;
      case 'set_ask_user_question_notification_enabled':
        await this.store.setAskUserQuestionNotificationEnabled(content);
        postJson(webview, 'update_ask_user_question_notification_enabled', {
          askUserQuestionNotificationEnabled: this.store.getAskUserQuestionNotificationEnabled(),
        });
        return true;

      case 'get_task_completion_notification_enabled':
        postJson(webview, 'update_task_completion_notification_enabled', {
          taskCompletionNotificationEnabled: this.store.getTaskCompletionNotificationEnabled(),
        });
        return true;
      case 'set_task_completion_notification_enabled':
        await this.store.setTaskCompletionNotificationEnabled(content);
        postJson(webview, 'update_task_completion_notification_enabled', {
          taskCompletionNotificationEnabled: this.store.getTaskCompletionNotificationEnabled(),
        });
        return true;

      case 'get_mode':
        postRaw(webview, 'mode_received', this.store.getPermissionMode());
        return true;
      case 'set_mode':
        await this.store.setPermissionMode(content);
        postRaw(webview, 'mode_received', this.store.getPermissionMode());
        // Hot-swap on the live Claude runtime so the next tool call in the
        // current turn honors the new mode (v0.4.6 parity).
        this.context.callbacks.pushPermissionModeLive(this.store.getPermissionMode());
        return true;

      case 'get_commit_prompt':
        callWindowFunction(webview, 'updateCommitPrompt', { commitPrompt: this.store.getCommitPrompt() });
        return true;
      case 'set_commit_prompt':
        await this.store.setCommitPrompt(content);
        callWindowFunction(webview, 'updateCommitPrompt', { commitPrompt: this.store.getCommitPrompt(), saved: true });
        return true;

      case 'get_commit_ai_config':
        callWindowFunction(webview, 'updateCommitAiConfig', this.store.getCommitAiConfig());
        return true;
      case 'set_commit_ai_config':
        await this.store.setCommitAiConfig(content);
        callWindowFunction(webview, 'updateCommitAiConfig', this.store.getCommitAiConfig());
        return true;

      case 'get_prompt_enhancer_config':
        callWindowFunction(webview, 'updatePromptEnhancerConfig', this.store.getPromptEnhancerConfig());
        return true;
      case 'set_prompt_enhancer_config':
        await this.store.setPromptEnhancerConfig(content);
        callWindowFunction(webview, 'updatePromptEnhancerConfig', this.store.getPromptEnhancerConfig());
        return true;

      case 'get_project_commit_prompt':
        callWindowFunction(webview, 'updateProjectCommitPrompt', { commitPrompt: this.store.getProjectCommitPrompt(this.context.getWorkspacePath()) });
        return true;
      case 'set_project_commit_prompt':
        await this.store.setProjectCommitPrompt(content, this.context.getWorkspacePath());
        callWindowFunction(webview, 'updateProjectCommitPrompt', {
          commitPrompt: this.store.getProjectCommitPrompt(this.context.getWorkspacePath()),
          saved: true,
        });
        return true;

      case 'get_input_history':
        callWindowFunction(webview, 'updateInputHistory', this.store.getInputHistory());
        return true;
      case 'record_input_history':
        callWindowFunction(webview, 'updateInputHistory', await this.store.recordInputHistory(content));
        return true;
      case 'delete_input_history_item':
        callWindowFunction(webview, 'updateInputHistory', await this.store.deleteInputHistoryItem(content));
        return true;
      case 'clear_input_history':
        await this.store.clearInputHistory();
        callWindowFunction(webview, 'updateInputHistory', []);
        return true;

      case 'get_sound_notification_config':
        postJson(webview, 'update_sound_notification_config', this.store.getSoundConfig());
        return true;
      case 'set_sound_notification_config':
        postJson(webview, 'update_sound_notification_config', await this.store.patchSoundConfig(parseJson<Record<string, unknown>>(content, {})));
        return true;
      case 'set_sound_notification_enabled':
        postJson(webview, 'update_sound_notification_config', await this.store.patchSoundConfig({ enabled: parseJson<any>(content, {}).enabled ?? content === 'true' }));
        return true;
      case 'set_sound_only_when_unfocused':
        postJson(webview, 'update_sound_notification_config', await this.store.patchSoundConfig({ onlyWhenUnfocused: parseJson<any>(content, {}).onlyWhenUnfocused ?? content === 'true' }));
        return true;
      case 'set_selected_sound':
        postJson(webview, 'update_sound_notification_config', await this.store.patchSoundConfig({ selectedSound: parseJson<any>(content, {}).soundId ?? content }));
        return true;
      case 'set_custom_sound_path':
        postJson(webview, 'update_sound_notification_config', await this.store.patchSoundConfig({ customSoundPath: parseJson<any>(content, {}).path ?? content }));
        return true;
      case 'test_sound':
        this.context.callbacks.playSound(content);
        return true;
      case 'browse_sound_file':
        await this.pickSoundFile(webview);
        return true;

      case 'get_user_language':
        // Push the resolved language (manual override or VS Code locale) so the webview can apply it.
        callWindowFunction(webview, 'applyIdeaLanguageConfig', this.store.resolveLanguageConfig());
        return true;
      case 'set_user_language':
        await this.store.setUserLanguage(content);
        callWindowFunction(webview, 'applyIdeaLanguageConfig', this.store.resolveLanguageConfig());
        return true;
      case 'clear_user_language':
        await this.store.clearUserLanguage();
        // After clearing, fall back to VS Code display language (not empty → English).
        callWindowFunction(webview, 'applyIdeaLanguageConfig', this.store.resolveLanguageConfig());
        return true;

      case 'get_ide_theme':
        callWindowFunction(webview, 'onIdeThemeReceived', this.store.getIdeTheme());
        return true;

      case 'get_permission_dialog_timeout':
        callWindowFunction(webview, 'updatePermissionDialogTimeout', {
          permissionDialogTimeoutSeconds: this.store.getPermissionDialogTimeoutSeconds(),
        });
        return true;
      case 'set_permission_dialog_timeout':
        await this.store.setPermissionDialogTimeoutSeconds(content);
        callWindowFunction(webview, 'updatePermissionDialogTimeout', {
          permissionDialogTimeoutSeconds: this.store.getPermissionDialogTimeoutSeconds(),
        });
        return true;

      case 'get_stream_stall_timeout':
        callWindowFunction(webview, 'updateStreamStallTimeout', {
          streamStallTimeoutSeconds: this.store.getStreamStallTimeoutSeconds(),
        });
        return true;
      case 'set_stream_stall_timeout':
        await this.store.setStreamStallTimeoutSeconds(content);
        callWindowFunction(webview, 'updateStreamStallTimeout', {
          streamStallTimeoutSeconds: this.store.getStreamStallTimeoutSeconds(),
        });
        return true;

      case 'get_commit_generation_enabled':
        callWindowFunction(webview, 'updateCommitGenerationEnabled', {
          commitGenerationEnabled: this.store.getCommitGenerationEnabled(),
        });
        return true;
      case 'set_commit_generation_enabled':
        await this.store.setCommitGenerationEnabled(content);
        callWindowFunction(webview, 'updateCommitGenerationEnabled', {
          commitGenerationEnabled: this.store.getCommitGenerationEnabled(),
        });
        return true;

      case 'get_status_bar_widget_enabled':
        callWindowFunction(webview, 'updateStatusBarWidgetEnabled', {
          statusBarWidgetEnabled: this.store.getStatusBarWidgetEnabled(),
        });
        return true;
      case 'set_status_bar_widget_enabled':
        await this.store.setStatusBarWidgetEnabled(content);
        this.context.callbacks.updateStatusBarWidgetEnabled(this.store.getStatusBarWidgetEnabled());
        callWindowFunction(webview, 'updateStatusBarWidgetEnabled', {
          statusBarWidgetEnabled: this.store.getStatusBarWidgetEnabled(),
        });
        return true;

      case 'get_enable_debug_log':
        callWindowFunction(webview, 'updateEnableDebugLog', {
          enableDebugLog: this.store.getEnableDebugLog(),
        });
        return true;
      case 'set_enable_debug_log':
        await this.store.setEnableDebugLog(content);
        // BridgeServer also reacts via onDidChangeConfiguration → _applyDebugLogSetting.
        callWindowFunction(webview, 'updateEnableDebugLog', {
          enableDebugLog: this.store.getEnableDebugLog(),
        });
        return true;

      case 'get_ai_title_generation_enabled':
        callWindowFunction(webview, 'updateAiTitleGenerationEnabled', {
          aiTitleGenerationEnabled: this.store.getAiTitleGenerationEnabled(),
        });
        return true;
      case 'set_ai_title_generation_enabled':
        await this.store.setAiTitleGenerationEnabled(content);
        callWindowFunction(webview, 'updateAiTitleGenerationEnabled', {
          aiTitleGenerationEnabled: this.store.getAiTitleGenerationEnabled(),
        });
        return true;

      default:
        return false;
    }
  }

  private async pickSoundFile(webview: vscode.Webview): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { Audio: ['mp3', 'wav', 'ogg', 'aiff', 'm4a'] },
      title: 'Select Sound File',
    });
    if (uris?.[0]) {
      webview.postMessage({
        type: 'js_eval',
        content: `window.__onBrowseSoundResult && window.__onBrowseSoundResult(${JSON.stringify(uris[0].fsPath)})`,
      });
    }
  }

  private async pickFontFile(webview: vscode.Webview, callbackName: string): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { Fonts: ['ttf', 'otf', 'woff', 'woff2'] },
      title: 'Select Font File',
    });
    if (uris?.[0]) {
      callWindowFunction(webview, callbackName, { path: uris[0].fsPath });
    }
  }
}
