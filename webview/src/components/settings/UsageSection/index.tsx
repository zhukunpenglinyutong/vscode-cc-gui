import { useTranslation } from 'react-i18next';
import { UsageDashboardSection } from '../../UsageStatistics/UsageDashboardSection';
import styles from './style.module.less';

const UsageSection = () => {
  const { t } = useTranslation();

  return (
    <div className={styles.configSection}>
      <h3 className={styles.sectionTitle}>{t('settings.usage')}</h3>
      <p className={styles.sectionDesc}>{t('settings.usageDesc')}</p>
      <UsageDashboardSection />
    </div>
  );
};

export default UsageSection;
