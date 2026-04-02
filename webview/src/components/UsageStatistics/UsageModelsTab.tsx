import { useTranslation } from 'react-i18next';
import type { ModelUsage } from '../../types/usage';

interface ModelsTabProps {
  models: ModelUsage[];
  formatCost: (cost: number) => string;
  formatNumber: (num: number) => string;
}

export const UsageModelsTab = ({ models, formatCost, formatNumber }: ModelsTabProps) => {
  const { t } = useTranslation();

  return (
    <div className="models-tab">
      <h4>{t('usage.byModel')}</h4>
      <div className="models-list">
        {models.map((model) => (
          <div key={model.model} className="model-item">
            <div className="model-header">
              <span className="model-name">{model.model}</span>
              <span className="model-cost">{formatCost(model.totalCost)}</span>
            </div>
            <div className="model-details">
              <div className="model-detail-item">
                <span className="model-detail-label">{t('usage.sessionCount')}:</span>
                <span className="model-detail-value">{model.sessionCount}</span>
              </div>
              <div className="model-detail-item">
                <span className="model-detail-label">{t('usage.totalTokens')}:</span>
                <span className="model-detail-value">{formatNumber(model.totalTokens)}</span>
              </div>
              <div className="model-detail-item">
                <span className="model-detail-label">{t('usage.input')}:</span>
                <span className="model-detail-value">{formatNumber(model.inputTokens)}</span>
              </div>
              <div className="model-detail-item">
                <span className="model-detail-label">{t('usage.output')}:</span>
                <span className="model-detail-value">{formatNumber(model.outputTokens)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
