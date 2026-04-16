import { useCallback, type RefObject } from 'react';
import type { TFunction } from 'i18next';
import { sendBridgeEvent } from '../utils/bridge';
import type { ClaudeContentBlock, ClaudeMessage } from '../types';
import type { Attachment, ChatInputBoxHandle, PermissionMode, SelectedAgent } from '../components/ChatInputBox/types';
import type { ViewMode } from './useModelProviderState';

export interface UseMessageSenderOptions {
  t: TFunction;
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  currentProvider: string;
  permissionMode: PermissionMode;
  selectedAgent: SelectedAgent | null;
  contextInfo?: { file: string; startLine?: number; endLine?: number } | null;
  streamingEnabled?: boolean;
  /** Current session ID — passed to daemon so messages reuse the same session */
  currentSessionId?: string | null;
  /** Tab ID used as runtimeSessionEpoch to isolate responses per tab */
  tabId?: string;
  /** Called before sending to capture the active tab as the bridge owner */
  acquireBridge?: () => string | undefined;
  sdkStatusLoaded: boolean;
  currentSdkInstalled: boolean;
  sentAttachmentsRef: RefObject<Map<string, Array<{ fileName: string; mediaType: string }>>>;
  chatInputRef: RefObject<ChatInputBoxHandle | null>;
  messagesContainerRef: RefObject<HTMLDivElement | null>;
  isUserAtBottomRef: RefObject<boolean>;
  userPausedRef: RefObject<boolean>;
  isStreamingRef: RefObject<boolean>;
  setMessages: React.Dispatch<React.SetStateAction<ClaudeMessage[]>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setLoadingStartTime: React.Dispatch<React.SetStateAction<number | null>>;
  setStreamingActive: React.Dispatch<React.SetStateAction<boolean>>;
  setSettingsInitialTab: React.Dispatch<React.SetStateAction<any>>;
  setCurrentView: React.Dispatch<React.SetStateAction<ViewMode>>;
  forceCreateNewSession: () => void;
}

/**
 * Handles message building, validation, and sending to the backend.
 */
export function useMessageSender({
  t,
  addToast,
  currentProvider,
  permissionMode,
  selectedAgent,
  contextInfo,
  streamingEnabled = true,
  currentSessionId,
  tabId,
  acquireBridge,
  sdkStatusLoaded,
  currentSdkInstalled,
  sentAttachmentsRef,
  chatInputRef,
  messagesContainerRef,
  isUserAtBottomRef,
  userPausedRef,
  isStreamingRef,
  setMessages,
  setLoading,
  setLoadingStartTime,
  setStreamingActive,
  setSettingsInitialTab,
  setCurrentView,
  forceCreateNewSession,
}: UseMessageSenderOptions) {
  /**
   * Set of commands that trigger new session creation (/new, /clear, /reset)
   */
  const NEW_SESSION_COMMANDS = new Set(['/new', '/clear', '/reset']);

  /**
   * Check if the input is a new session command
   */
  const checkNewSessionCommand = useCallback((text: string): boolean => {
    if (!text.startsWith('/')) return false;
    const command = text.split(/\s+/)[0].toLowerCase();
    if (NEW_SESSION_COMMANDS.has(command)) {
      forceCreateNewSession();
      return true;
    }
    return false;
  }, [forceCreateNewSession]);

  /**
   * Check for unimplemented slash commands
   */
  const checkUnimplementedCommand = useCallback((text: string): boolean => {
    if (!text.startsWith('/')) return false;

    const command = text.split(/\s+/)[0].toLowerCase();
    const unimplementedCommands = ['/plugin', '/plugins'];

    if (unimplementedCommands.includes(command)) {
      const userMessage: ClaudeMessage = {
        type: 'user',
        content: text,
        timestamp: new Date().toISOString(),
      };
      const assistantMessage: ClaudeMessage = {
        type: 'assistant',
        content: t('chat.commandNotImplemented', { command }),
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      return true;
    }
    return false;
  }, [t, setMessages]);

  /**
   * Build content blocks for the user message
   */
  const buildUserContentBlocks = useCallback((
    text: string,
    attachments: Attachment[] | undefined
  ): ClaudeContentBlock[] => {
    const blocks: ClaudeContentBlock[] = [];

    const hasImageAttachments = Array.isArray(attachments) &&
      attachments.some(att => att.mediaType?.startsWith('image/'));

    if (Array.isArray(attachments) && attachments.length > 0) {
      for (const att of attachments) {
        if (att.mediaType?.startsWith('image/')) {
          blocks.push({
            type: 'image',
            src: `data:${att.mediaType};base64,${att.data}`,
            mediaType: att.mediaType,
          });
        } else {
          blocks.push({
            type: 'attachment',
            fileName: att.fileName,
            mediaType: att.mediaType,
          });
        }
      }
    }

    // Filter placeholder text: skip if there are image attachments and text is placeholder
    const isPlaceholderText = text && text.trim().startsWith('[Uploaded ');

    if (text && !(hasImageAttachments && isPlaceholderText)) {
      blocks.push({ type: 'text', text });
    }

    return blocks;
  }, []);

  /**
   * Send message to backend
   */
  const sendMessageToBackend = useCallback((
    text: string,
    attachments: Attachment[] | undefined,
    agentInfo: { id: string; name: string; prompt?: string } | null,
    fileTagsInfo: { displayPath: string; absolutePath: string }[] | null,
    requestedPermissionMode: PermissionMode
  ) => {
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    const effectivePermissionMode: PermissionMode = currentProvider === 'codex' && requestedPermissionMode === 'plan'
      ? 'default'
      : requestedPermissionMode;

    // Build openedFiles from contextInfo (active file + selected lines)
    let openedFiles: any = null;
    if (contextInfo?.file) {
      const activePath = contextInfo.startLine !== undefined
        ? (contextInfo.startLine === contextInfo.endLine
            ? `${contextInfo.file}#L${contextInfo.startLine}`
            : `${contextInfo.file}#L${contextInfo.startLine}-${contextInfo.endLine ?? contextInfo.startLine}`)
        : contextInfo.file;
      openedFiles = {
        active: activePath,
        selection: contextInfo.startLine !== undefined ? {
          startLine: contextInfo.startLine,
          endLine: contextInfo.endLine ?? contextInfo.startLine,
        } : null,
        others: [],
      };
    }

    if (hasAttachments) {
      try {
        const payload = JSON.stringify({
          provider: currentProvider,
          text,
          sessionId: currentSessionId || undefined,
          attachments: (attachments || []).map(a => ({
            fileName: a.fileName,
            mediaType: a.mediaType,
            data: a.data,
          })),
          agent: agentInfo,
          fileTags: fileTagsInfo,
          openedFiles,
          streaming: streamingEnabled,
          runtimeSessionEpoch: tabId,
          permissionMode: effectivePermissionMode,
        });
        sendBridgeEvent('send_message_with_attachments', payload);
      } catch (error) {
        console.error('[Frontend] Failed to serialize attachments payload', error);
        const fallbackPayload = JSON.stringify({
          provider: currentProvider,
          text,
          sessionId: currentSessionId || undefined,
          agent: agentInfo,
          fileTags: fileTagsInfo,
          openedFiles,
          streaming: streamingEnabled,
          runtimeSessionEpoch: tabId,
          permissionMode: effectivePermissionMode,
        });
        sendBridgeEvent('send_message', fallbackPayload);
      }
    } else {
      const payload = JSON.stringify({
        provider: currentProvider,
        text,
        sessionId: currentSessionId || undefined,
        agent: agentInfo,
        fileTags: fileTagsInfo,
        openedFiles,
        streaming: streamingEnabled,
        runtimeSessionEpoch: tabId,
        permissionMode: effectivePermissionMode,
      });
      sendBridgeEvent('send_message', payload);
    }
  }, [currentProvider, contextInfo, streamingEnabled, currentSessionId, tabId]);

  /**
   * Execute message sending (from queue or directly)
   */
  const executeMessage = useCallback((content: string, attachments?: Attachment[]) => {
    const text = content.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

    if (!text && !hasAttachments) return;

    // Check SDK status
    if (!sdkStatusLoaded) {
      addToast(t('chat.sdkStatusLoading'), 'info');
      return;
    }
    if (!currentSdkInstalled) {
      addToast(
        t('chat.sdkNotInstalled', { provider: currentProvider === 'codex' ? 'Codex' : 'Claude Code' }) + ' ' + t('chat.goInstallSdk'),
        'warning'
      );
      setSettingsInitialTab('dependencies');
      setCurrentView('settings');
      return;
    }

    // Build user message content blocks
    const userContentBlocks = buildUserContentBlocks(text, attachments);
    if (userContentBlocks.length === 0) return;

    // Persist non-image attachment metadata
    const nonImageAttachments = Array.isArray(attachments)
      ? attachments.filter(a => !a.mediaType?.startsWith('image/'))
      : [];
    if (nonImageAttachments.length > 0) {
      const MAX_ATTACHMENT_CACHE_SIZE = 100;
      if (sentAttachmentsRef.current.size >= MAX_ATTACHMENT_CACHE_SIZE) {
        const firstKey = sentAttachmentsRef.current.keys().next().value;
        if (firstKey !== undefined) {
          sentAttachmentsRef.current.delete(firstKey);
        }
      }
      sentAttachmentsRef.current.set(text || '', nonImageAttachments.map(a => ({
        fileName: a.fileName,
        mediaType: a.mediaType,
      })));
    }

    // Create and add user message (optimistic update)
    const userMessage: ClaudeMessage = {
      type: 'user',
      content: text || '',
      timestamp: new Date().toISOString(),
      isOptimistic: true,
      raw: { message: { content: userContentBlocks } },
    };
    setMessages((prev) => [...prev, userMessage]);

    // Acquire bridge ownership before sending — ensures responses route to this tab
    acquireBridge?.();

    // Set loading state
    setLoading(true);
    setLoadingStartTime(Date.now());

    // Scroll to bottom
    userPausedRef.current = false;
    isUserAtBottomRef.current = true;
    requestAnimationFrame(() => {
      if (messagesContainerRef.current) {
        messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
      }
    });

    // Sync provider setting
    sendBridgeEvent('set_provider', currentProvider);

    // Build agent info
    const agentInfo = selectedAgent ? {
      id: selectedAgent.id,
      name: selectedAgent.name,
      prompt: selectedAgent.prompt,
    } : null;

    // Extract file tag info
    const fileTags = chatInputRef.current?.getFileTags() ?? [];
    const fileTagsInfo = fileTags.length > 0 ? fileTags.map(tag => ({
      displayPath: tag.displayPath,
      absolutePath: tag.absolutePath,
    })) : null;

    // Send message to backend
    sendMessageToBackend(text, attachments, agentInfo, fileTagsInfo, permissionMode);
  }, [
    sdkStatusLoaded,
    currentSdkInstalled,
    currentProvider,
    permissionMode,
    selectedAgent,
    buildUserContentBlocks,
    sendMessageToBackend,
    addToast,
    t,
  ]);

  /**
   * Handle message submission (from ChatInputBox)
   */
  const handleSubmit = useCallback((content: string, attachments?: Attachment[]) => {
    const text = content.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

    if (!text && !hasAttachments) return;

    // Check new session commands
    if (checkNewSessionCommand(text)) return;

    // Check for unimplemented commands
    if (checkUnimplementedCommand(text)) return;

    // Execute message
    executeMessage(content, attachments);
  }, [checkNewSessionCommand, checkUnimplementedCommand, executeMessage]);

  /**
   * Interrupt the current session
   */
  const interruptSession = useCallback(() => {
    setLoading(false);
    setLoadingStartTime(null);
    setStreamingActive(false);
    isStreamingRef.current = false;

    sendBridgeEvent('interrupt_session');
  }, []);

  return {
    handleSubmit,
    executeMessage,
    interruptSession,
  };
}
