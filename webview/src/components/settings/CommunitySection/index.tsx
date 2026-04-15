import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ChangelogDialog from '../../ChangelogDialog';
import { CHANGELOG_DATA } from '../../../version/changelog';
import wxqImage from '../../../assets/images/wxq.png';
import styles from './style.module.less';

const GITHUB_URL = 'https://github.com/zhukunpenglinyutong/idea-claude-code-gui';

interface CommunitySectionProps {
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
}

const CommunitySection = ({ addToast }: CommunitySectionProps) => {
  const { t } = useTranslation();
  const [showChangelog, setShowChangelog] = useState(false);

  const handleCopyGitHub = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(GITHUB_URL);
      addToast(t('settings.githubCopied'), 'success');
    } catch {
      addToast(t('settings.githubCopyFailed'), 'error');
    }
  }, [addToast, t]);

  return (
    <div className={styles.configSection}>
      {/* Official community group */}
      <h3 className={styles.sectionTitle}>{t('settings.community')}</h3>
      <p className={styles.sectionDesc}>{t('settings.communityDesc')}</p>

      <div className={styles.qrcodeContainer}>
        <div className={styles.qrcodeWrapper}>
          <img
            src={wxqImage}
            alt={t('settings.communityQrAlt')}
            className={styles.qrcodeImage}
          />
          <p className={styles.qrcodeTip}>{t('settings.communityQrTip')}</p>
        </div>
      </div>

      {/* GitHub open source */}
      <div className={styles.githubSection}>
        <h3 className={styles.sectionTitle}>{t('settings.githubTitle')}</h3>
        <p className={styles.sectionDesc}>{t('settings.githubDesc')}</p>
        <button
          className={styles.githubBtn}
          onClick={handleCopyGitHub}
        >
          <span className="codicon codicon-github" />
          {t('settings.githubCopyBtn')}
        </button>
      </div>

      {/* Version history */}
      <div className={styles.versionHistorySection}>
        <h3 className={styles.sectionTitle}>{t('settings.versionHistory')}</h3>
        <p className={styles.sectionDesc}>{t('settings.versionHistoryDesc')}</p>
        <button
          className={styles.versionHistoryBtn}
          onClick={() => setShowChangelog(true)}
        >
          <span className="codicon codicon-history" />
          {t('settings.versionHistory')}
        </button>
      </div>

      <ChangelogDialog
        isOpen={showChangelog}
        onClose={() => setShowChangelog(false)}
        entries={CHANGELOG_DATA}
      />
    </div>
  );
};

export default CommunitySection;
