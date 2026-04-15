import { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './style.module.less';
import { AVAILABLE_PROVIDERS } from '../ChatInputBox/types';
import { ProviderModelIcon } from '../shared/ProviderModelIcon';

interface BlinkingLogoProps {
  provider: string;
  /** Current model ID, used to show vendor-specific icon */
  modelId?: string;
  onProviderChange?: (providerId: string) => void;
}

export const BlinkingLogo = ({ provider, modelId, onProviderChange }: BlinkingLogoProps) => {
  const { t } = useTranslation();
  const [displayProvider, setDisplayProvider] = useState(provider);
  const [displayModelId, setDisplayModelId] = useState(modelId);
  const [animationState, setAnimationState] = useState<'idle' | 'closing' | 'opening'>('idle');

  // Dropdown state
  const [isOpen, setIsOpen] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (provider !== displayProvider || modelId !== displayModelId) {
      if (animationState === 'idle') {
        setAnimationState('closing');
      } else if (animationState === 'opening') {
         setAnimationState('closing');
      }
    }
  }, [provider, modelId, displayProvider, displayModelId, animationState]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    if (animationState === 'closing') {
      timer = setTimeout(() => {
        setDisplayProvider(provider);
        setDisplayModelId(modelId);
        setAnimationState('opening');
      }, 200);
    } else if (animationState === 'opening') {
      timer = setTimeout(() => {
        setAnimationState('idle');
      }, 200);
    }

    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [animationState, provider, modelId]);

  // Click outside handler
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleToggle = (e: React.MouseEvent) => {
    if (onProviderChange) {
       e.stopPropagation();
       setIsOpen(!isOpen);
    }
  };

  const showToastMessage = (message: string) => {
    setToastMessage(message);
    setShowToast(true);
    setTimeout(() => {
      setShowToast(false);
    }, 1500);
  };

  const handleSelect = (providerId: string) => {
    const provider = AVAILABLE_PROVIDERS.find(p => p.id === providerId);
    if (!provider) return;

    if (!provider.enabled) {
      showToastMessage(t('settings.provider.featureComingSoon'));
      setIsOpen(false);
      return;
    }

    if (onProviderChange) {
      onProviderChange(providerId);
    }
    setIsOpen(false);
  };

  const getProviderLabel = (providerId: string) => {
    return t(`providers.${providerId}.label`);
  };

  return (
    <div style={{ position: 'relative', display: 'inline-flex', flexDirection: 'column', alignItems: 'center' }}>
      <div
        ref={containerRef}
        className={`${styles.container} ${styles[animationState]}`}
        onClick={handleToggle}
        style={{ cursor: onProviderChange ? 'pointer' : 'default' }}
      >
        <ProviderModelIcon
          providerId={displayProvider}
          modelId={displayModelId}
          size={displayProvider === 'codex' ? 64 : 58}
          colored
        />
      </div>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="selector-dropdown"
          style={{
            position: 'absolute',
            top: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            marginTop: '8px',
            zIndex: 10000,
          }}
        >
          {AVAILABLE_PROVIDERS.map((p) => (
            <div
              key={p.id}
              className={`selector-option ${p.id === provider ? 'selected' : ''} ${!p.enabled ? 'disabled' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                handleSelect(p.id);
              }}
              style={{
                opacity: p.enabled ? 1 : 0.5,
                cursor: p.enabled ? 'pointer' : 'not-allowed',
              }}
            >
              <ProviderModelIcon providerId={p.id} size={16} colored />
              <span>{getProviderLabel(p.id)}</span>
              {p.id === provider && (
                <span className="codicon codicon-check check-mark" />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Toast notification */}
      {showToast && (
        <div className="selector-toast">
          {toastMessage}
        </div>
      )}
    </div>
  );
};
