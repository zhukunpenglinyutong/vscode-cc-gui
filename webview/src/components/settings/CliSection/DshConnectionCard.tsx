import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openBrowser } from '../../../utils/bridge';
import styles from './style.module.less';

/**
 * DSH host connection card (Settings → CLI).
 *
 * Talks to the Java DshHostHandler:
 *   sendToJava('get_dsh_status')  → window.updateDshStatus(json)
 *   sendToJava('start_dsh_host')  → window.updateDshStatus(json)
 *   sendToJava('stop_dsh_host')   → window.updateDshStatus(json)
 *   sendToJava('save_dsh_settings:<json>') → persists {autoStart} etc.
 *
 * DSH (DeepSeek Harness) runs as one persistent local `dsh web` host; the
 * plugin adopts an already-running host and never kills adopted processes.
 */

interface DshStatusPayload {
  success?: boolean;
  installed?: boolean;
  version?: string | null;
  bin?: string;
  origin?: string;
  hostRunning?: boolean;
  ownership?: 'spawned' | 'adopted' | null;
  error?: string;
  describe?: {
    version?: string;
    provider?: string;
    model?: string;
    attachedSessions?: number;
  };
  settings?: {
    bin?: string;
    host?: string;
    port?: number;
    autoStart?: boolean;
  };
}

const DSH_STATUS_TIMEOUT_MS = 30_000;

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  }
};

const parsePayload = (dataOrStr: string | DshStatusPayload): DshStatusPayload | null => {
  if (typeof dataOrStr !== 'string') {
    return dataOrStr && typeof dataOrStr === 'object' ? dataOrStr : null;
  }
  try {
    return JSON.parse(dataOrStr) as DshStatusPayload;
  } catch {
    return null;
  }
};

const DshConnectionCard = () => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<DshStatusPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const request = useCallback(
    (command: 'get_dsh_status' | 'start_dsh_host' | 'stop_dsh_host') => {
      clearPendingTimeout();
      setBusy(true);
      sendToJava(command);
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        setBusy(false);
      }, DSH_STATUS_TIMEOUT_MS);
    },
    [clearPendingTimeout],
  );

  useEffect(() => {
    const previous = window.updateDshStatus;
    window.updateDshStatus = (dataOrStr) => {
      clearPendingTimeout();
      const parsed = parsePayload(dataOrStr);
      if (parsed) {
        setStatus(parsed);
      }
      setBusy(false);
      previous?.(dataOrStr as string);
    };
    request('get_dsh_status');
    return () => {
      window.updateDshStatus = previous;
      clearPendingTimeout();
    };
  }, [request, clearPendingTimeout]);

  const toggleAutoStart = useCallback(
    (next: boolean) => {
      sendToJava(`save_dsh_settings:${JSON.stringify({ autoStart: next })}`);
      setStatus((prev) =>
        prev ? { ...prev, settings: { ...prev.settings, autoStart: next } } : prev,
      );
    },
    [],
  );

  const installed = status?.installed === true;
  const running = status?.hostRunning === true;
  const origin = status?.origin || '';
  const ownership = status?.ownership;

  let stateKey: 'checking' | 'notInstalled' | 'notRunning' | 'connected';
  if (busy && !status) {
    stateKey = 'checking';
  } else if (status && installed === false) {
    stateKey = 'notInstalled';
  } else if (running) {
    stateKey = 'connected';
  } else if (status) {
    stateKey = 'notRunning';
  } else {
    stateKey = 'checking';
  }

  const stateBadgeClass =
    stateKey === 'connected' ? styles.ok : stateKey === 'checking' ? '' : styles.missing;

  return (
    <div className={`${styles.cliCard} ${styles.dshCard}`}>
      <div className={styles.cliMain}>
        <div className={styles.cliIcon}>
          <span className="codicon codicon-server-process" aria-hidden="true" />
        </div>
        <span className={styles.cliName}>{t('settings.cli.dsh.cardTitle')}</span>
        {status?.version && <span className={styles.versionBadge}>v{status.version}</span>}
        <span className={styles.cliMeta} title={status?.error || origin}>
          {stateKey === 'connected' && origin
            ? `${origin} · ${status?.describe?.provider ?? ''}/${status?.describe?.model ?? ''}`
            : status?.error || t('settings.cli.dsh.hint')}
        </span>
      </div>

      <div className={styles.cliActions}>
        <span className={`${styles.statusBadge} ${stateBadgeClass}`}>
          {busy && <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />}
          {t(`settings.cli.dsh.state.${stateKey}`)}
          {stateKey === 'connected' && ownership === 'adopted' && (
            <span title={t('settings.cli.dsh.adoptedHint')}> · {t('settings.cli.dsh.adopted')}</span>
          )}
        </span>

        <div className={styles.actionButtons}>
          {stateKey === 'connected' && origin && (
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => openBrowser(origin)}
              title={t('settings.cli.dsh.openWebUi')}
              aria-label={t('settings.cli.dsh.openWebUi')}
            >
              <span className="codicon codicon-globe" />
            </button>
          )}
          {(stateKey === 'notRunning' || stateKey === 'notInstalled') && installed !== false && (
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={busy}
              onClick={() => request('start_dsh_host')}
            >
              <span className="codicon codicon-play" aria-hidden="true" />
              {t('settings.cli.dsh.startHost')}
            </button>
          )}
          {stateKey === 'connected' && ownership === 'spawned' && (
            <button
              type="button"
              className={styles.ghostBtn}
              disabled={busy}
              onClick={() => request('stop_dsh_host')}
              title={t('settings.cli.dsh.stopHost')}
            >
              <span className="codicon codicon-debug-stop" aria-hidden="true" />
              {t('settings.cli.dsh.stopHostShort')}
            </button>
          )}
        </div>

        <label
          className={styles.dshAutoStart}
          title={status ? undefined : t('settings.cli.dsh.state.checking')}
        >
          <input
            type="checkbox"
            checked={status?.settings?.autoStart !== false}
            disabled={!status}
            onChange={(e) => toggleAutoStart(e.target.checked)}
          />
          <span>{t('settings.cli.dsh.autoStart')}</span>
        </label>
      </div>
    </div>
  );
};

export default DshConnectionCard;
