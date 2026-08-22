import styles from './style.module.less';
import { useTranslation } from 'react-i18next';

export interface EnvironmentTabProps {
  nodePath: string;
  onNodePathChange: (path: string) => void;
  onSaveNodePath: (pathOverride?: string) => void;
  savingNodePath: boolean;
  nodeVersion?: string | null;
  minNodeVersion?: number;
  claudeCliPath?: string;
  onClaudeCliPathChange?: (path: string) => void;
  onSaveClaudeCliPath?: () => void;
  savingClaudeCliPath?: boolean;
  workingDirectory?: string;
  onWorkingDirectoryChange?: (dir: string) => void;
  onSaveWorkingDirectory?: () => void;
  savingWorkingDirectory?: boolean;
}

const EnvironmentTab = ({
  nodePath,
  onNodePathChange,
  onSaveNodePath,
  savingNodePath,
  nodeVersion,
  minNodeVersion = 20,
  claudeCliPath = '',
  onClaudeCliPathChange = () => {},
  onSaveClaudeCliPath = () => {},
  savingClaudeCliPath = false,
  workingDirectory = '',
  onWorkingDirectoryChange = () => {},
  onSaveWorkingDirectory = () => {},
  savingWorkingDirectory = false,
}: EnvironmentTabProps) => {
  const { t } = useTranslation();

  const parseMajorVersion = (version: string | null | undefined): number => {
    if (!version) return 0;
    const versionStr = version.startsWith('v') ? version.substring(1) : version;
    const dotIndex = versionStr.indexOf('.');
    if (dotIndex > 0) {
      return parseInt(versionStr.substring(0, dotIndex), 10) || 0;
    }
    return parseInt(versionStr, 10) || 0;
  };

  const majorVersion = parseMajorVersion(nodeVersion);
  const isVersionTooLow = Boolean(nodeVersion && majorVersion > 0 && majorVersion < minNodeVersion);
  const isMissing = !nodePath;
  const isBlocked = isVersionTooLow || isMissing;

  return (
    <div className={styles.tabContent}>
      {/* Node.js path configuration */}
      <div className={styles.nodePathSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-terminal" />
          <span className={styles.fieldLabel}>{t('settings.basic.nodePath.label')}</span>
          {nodeVersion && (
            <span
              className={`${styles.versionBadge} ${
                isVersionTooLow ? styles.versionBadgeError : styles.versionBadgeOk
              }`}
            >
              {nodeVersion}
            </span>
          )}
        </div>

        {isBlocked && (
          <div className={styles.nodeBlockCard}>
            <div className={styles.nodeBlockTitle}>
              <span className="codicon codicon-error" />
              {t('settings.basic.nodePath.blockTitle')}
            </div>
            <div className={styles.nodeBlockBody}>
              {isVersionTooLow ? (
                <>
                  <p>
                    {t('settings.basic.nodePath.versionTooLow', {
                      minVersion: minNodeVersion,
                      currentVersion: nodeVersion,
                    })}
                  </p>
                  <ul className={styles.nodeBlockMeta}>
                    <li>
                      {t('settings.basic.nodePath.currentVersionLabel')}: <code>{nodeVersion}</code>
                    </li>
                    <li>
                      {t('settings.basic.nodePath.minVersionLabel')}: <code>v{minNodeVersion}</code>
                    </li>
                    {nodePath && (
                      <li>
                        {t('settings.basic.nodePath.detectedPathLabel')}: <code>{nodePath}</code>
                      </li>
                    )}
                  </ul>
                </>
              ) : (
                <p>{t('settings.basic.nodePath.notFound', { minVersion: minNodeVersion })}</p>
              )}
              <p className={styles.nodeBlockSteps}>
                {t('settings.basic.nodePath.howToFix', { minVersion: minNodeVersion })}
              </p>
              <ol className={styles.nodeBlockStepsList}>
                <li>{t('settings.basic.nodePath.stepInstall', { minVersion: minNodeVersion })}</li>
                <li>
                  {t('settings.basic.nodePath.stepGetPath')}{' '}
                  <code>{t('settings.basic.nodePath.hintCommand')}</code>
                </li>
                <li>{t('settings.basic.nodePath.stepPaste')}</li>
              </ol>
            </div>
          </div>
        )}

        <div className={styles.nodePathInputWrapper}>
          <input
            type="text"
            className={styles.nodePathInput}
            placeholder={t('settings.basic.nodePath.placeholder')}
            value={nodePath}
            onChange={(e) => onNodePathChange(e.target.value)}
          />
          <button
            className={styles.saveBtn}
            onClick={() => onSaveNodePath()}
            disabled={savingNodePath}
          >
            {savingNodePath && (
              <span className="codicon codicon-loading codicon-modifier-spin" />
            )}
            {t('common.save')}
          </button>
        </div>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>
            {t('settings.basic.nodePath.hint', { minVersion: minNodeVersion })}{' '}
            <code>{t('settings.basic.nodePath.hintCommand')}</code>{' '}
            {t('settings.basic.nodePath.hintText', { minVersion: minNodeVersion })}
          </span>
        </small>
      </div>

      {/* Custom Claude CLI path */}
      <div className={styles.nodePathSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-rocket" />
          <span className={styles.fieldLabel}>{t('settings.basic.claudeCliPath.label')}</span>
        </div>
        <div className={styles.nodePathInputWrapper}>
          <input
            type="text"
            className={styles.nodePathInput}
            placeholder={t('settings.basic.claudeCliPath.placeholder')}
            value={claudeCliPath}
            onChange={(e) => onClaudeCliPathChange(e.target.value)}
          />
          <button
            className={styles.saveBtn}
            onClick={onSaveClaudeCliPath}
            disabled={savingClaudeCliPath}
          >
            {savingClaudeCliPath && (
              <span className="codicon codicon-loading codicon-modifier-spin" />
            )}
            {t('common.save')}
          </button>
        </div>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.basic.claudeCliPath.hint')}</span>
        </small>
      </div>

      {/* Working directory configuration */}
      <div className={styles.workingDirSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-folder" />
          <span className={styles.fieldLabel}>{t('settings.basic.workingDirectory.label')}</span>
        </div>
        <div className={styles.nodePathInputWrapper}>
          <input
            type="text"
            className={styles.nodePathInput}
            placeholder={t('settings.basic.workingDirectory.placeholder')}
            value={workingDirectory}
            onChange={(e) => onWorkingDirectoryChange(e.target.value)}
          />
          <button
            className={styles.saveBtn}
            onClick={onSaveWorkingDirectory}
            disabled={savingWorkingDirectory}
          >
            {savingWorkingDirectory && (
              <span className="codicon codicon-loading codicon-modifier-spin" />
            )}
            {t('common.save')}
          </button>
        </div>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.basic.workingDirectory.hint')}</span>
        </small>
      </div>
    </div>
  );
};

export default EnvironmentTab;
