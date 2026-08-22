import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';

import { BackIcon } from '../Icons';

export interface ChatHeaderProps {
  currentView: 'chat' | 'history' | 'settings';
  sessionTitle: string;
  t: TFunction;
  onBack: () => void;
  onNewSession: () => void;
  onNewTab: () => void;
  onHistory: () => void;
  onSettings: () => void;
  /**
   * Opens the in-conversation search panel. Only rendered when provided.
   * Wired up by App.tsx via UIStateContext.setSearchOpen.
   */
  onOpenSearch?: () => void;
  onTitleChange?: (newTitle: string) => void;
  titleEditable?: boolean;
  /**
   * True while a previous "live" session exists to return to after browsing
   * history (see useSessionManagement.returnToLiveSession). Renders a back
   * affordance on the chat view itself, since the normal history back-button
   * only appears while currentView === 'history'.
   */
  canReturnToLiveSession?: boolean;
  onReturnToLiveSession?: () => void;
}

export function ChatHeader({
  currentView,
  sessionTitle,
  t,
  onBack,
  onNewSession,
  onNewTab,
  onHistory,
  onSettings,
  onOpenSearch,
  onTitleChange,
  titleEditable = false,
  canReturnToLiveSession = false,
  onReturnToLiveSession,
}: ChatHeaderProps): React.ReactElement | null {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!titleEditable) {
      setEditing(false);
    }
  }, [titleEditable]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const startEditing = useCallback(() => {
    if (!titleEditable || !onTitleChange) return;
    setEditValue(sessionTitle);
    setEditing(true);
  }, [titleEditable, onTitleChange, sessionTitle]);

  const commitEdit = useCallback(() => {
    setEditing(false);
    const trimmed = editValue.trim().slice(0, 50);
    if (trimmed && trimmed !== sessionTitle && onTitleChange) {
      onTitleChange(trimmed);
    }
  }, [editValue, sessionTitle, onTitleChange]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  }, [commitEdit, cancelEdit]);

  const handleBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    // If focus moves to save/cancel button inside edit container, let that button handle it
    const editContainer = e.currentTarget.closest('.session-title-edit-mode');
    if (editContainer && editContainer.contains(e.relatedTarget as Node)) {
      return;
    }
    commitEdit();
  }, [commitEdit]);

  if (currentView === 'settings') {
    return null;
  }

  const showReturnToLive =
    currentView === 'chat' && canReturnToLiveSession && typeof onReturnToLiveSession === 'function';

  const renderSessionTitle = () => {
    if (editing) {
      return (
        <div className="session-title-edit-mode" onClick={(e) => e.stopPropagation()}>
          <input
            ref={inputRef}
            type="text"
            className="session-title-input"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            maxLength={50}
            spellCheck={false}
            aria-label="Session title"
          />
          <button className="session-title-save-btn" onClick={commitEdit} aria-label="Save title">
            <span className="codicon codicon-check" />
          </button>
          <button className="session-title-cancel-btn" onClick={cancelEdit} aria-label="Cancel editing">
            <span className="codicon codicon-close" />
          </button>
        </div>
      );
    }

    return (
      <div className="session-title-wrapper">
        <div className="session-title" title={sessionTitle}>
          {sessionTitle}
        </div>
        {titleEditable && (
          <button className="session-title-edit-btn" onClick={startEditing} aria-label="Edit session title">
            <span className="codicon codicon-edit" />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="header">
      <div className="header-left">
        {currentView === 'history' ? (
          <button className="back-button" onClick={onBack} data-tooltip={t('common.back')}>
            <BackIcon /> {t('common.back')}
          </button>
        ) : (
          <>
            {/* Keep the history-list title visible while browsing a history session;
                previously the "back to live" control replaced the title entirely. */}
            {showReturnToLive && (
              <button
                className="back-button"
                onClick={onReturnToLiveSession}
                data-tooltip={t('common.backToLiveSession', { defaultValue: 'Back to conversation' })}
              >
                <BackIcon /> {t('common.backToLiveSession', { defaultValue: 'Back to conversation' })}
              </button>
            )}
            {currentView === 'chat' && renderSessionTitle()}
          </>
        )}
      </div>
      <div className="header-right">
        {currentView === 'chat' && (
          <>
            {onOpenSearch && (
              <button
                className="icon-button"
                onClick={onOpenSearch}
                data-tooltip={t('chat.search.openTooltip', { defaultValue: 'Search in conversation' })}
                aria-label={t('chat.search.openTooltip', { defaultValue: 'Search in conversation' })}
              >
                <span className="codicon codicon-search" />
              </button>
            )}
            <button className="icon-button" onClick={onNewSession} data-tooltip={t('common.newSession')}>
              <span className="codicon codicon-plus" />
            </button>
            <button
              className="icon-button"
              onClick={onNewTab}
              data-tooltip={t('common.newTab')}
            >
              <span className="codicon codicon-split-horizontal" />
            </button>
            <button
              className="icon-button"
              onClick={onHistory}
              data-tooltip={t('common.history')}
            >
              <span className="codicon codicon-history" />
            </button>
            <button
              className="icon-button"
              onClick={onSettings}
              data-tooltip={t('common.settings')}
            >
              <span className="codicon codicon-settings-gear" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
