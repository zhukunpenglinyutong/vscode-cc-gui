import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ModelSelect } from './ModelSelect';
import { CLAUDE_MODELS, CODEX_MODELS } from '../types';
import type { ModelInfo } from '../types';
import { STORAGE_KEYS } from '../../../types/provider';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => options?.model ?? key,
  }),
}));

vi.mock('../../shared/ProviderModelIcon', () => ({
  ProviderModelIcon: ({
    providerId,
    modelId,
  }: {
    providerId?: string;
    modelId?: string;
  }) => (
    <span
      data-testid="model-icon"
      data-provider-id={providerId ?? ''}
      data-model-id={modelId ?? ''}
    />
  ),
}));

describe('ModelSelect', () => {
  const sonnetModel: ModelInfo = {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    description: 'Sonnet 4.6 · Use the default model',
  };

  beforeEach(() => {
    localStorage.clear();
  });

  it('rerender 后应读取最新的 Claude 模型映射', () => {
    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_MODEL_MAPPING,
      JSON.stringify({ sonnet: 'glm-4' }),
    );

    const { rerender } = render(
      <ModelSelect
        value={sonnetModel.id}
        onChange={vi.fn()}
        models={[sonnetModel]}
        currentProvider="claude"
      />,
    );

    expect(screen.getByRole('button').textContent).toContain('glm-4');

    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_MODEL_MAPPING,
      JSON.stringify({ sonnet: 'glm-5' }),
    );

    rerender(
      <ModelSelect
        value={sonnetModel.id}
        onChange={vi.fn()}
        models={[sonnetModel]}
        currentProvider="claude"
      />,
    );

    expect(screen.getByRole('button').textContent).toContain('glm-5');
  });

  it('closed trigger uses mapped model id for icon (e.g. DeepSeek, not Claude)', () => {
    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_MODEL_MAPPING,
      JSON.stringify({ sonnet: 'deepseek-v4-pro[1m]' }),
    );

    render(
      <ModelSelect
        value={sonnetModel.id}
        onChange={vi.fn()}
        models={[sonnetModel]}
        currentProvider="claude"
      />,
    );

    const triggerIcon = screen.getByRole('button').querySelector('[data-testid="model-icon"]');
    expect(triggerIcon).not.toBeNull();
    expect(triggerIcon?.getAttribute('data-provider-id')).toBe('claude');
    expect(triggerIcon?.getAttribute('data-model-id')).toBe('deepseek-v4-pro[1m]');
  });

  it('没有具体映射时应回退到全局 main 映射', () => {
    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_MODEL_MAPPING,
      JSON.stringify({ main: 'glm-4.7', fable: 'glm-5.2' }),
    );

    render(
      <ModelSelect
        value="claude-fable-5"
        onChange={vi.fn()}
        models={[
          sonnetModel,
          { id: 'claude-fable-5', label: 'Fable 5', description: 'Fable 5 · Most powerful · Mythos-class' },
        ]}
        currentProvider="claude"
      />,
    );

    expect(screen.getByRole('button').textContent).toContain('glm-5.2');
  });

  it('Claude 内置模型列表应按目标顺序展示最新模型，并移除旧可见项', () => {
    expect(CLAUDE_MODELS.map((model) => model.id)).toEqual([
      'claude-fable-5-2',
      'claude-fable-5-1',
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-sonnet-5-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ]);
    const ids = CLAUDE_MODELS.map((model) => model.id);
    expect(ids).not.toContain('claude-fable-5');
    expect(ids).not.toContain('claude-opus-4-8');
    expect(ids).not.toContain('claude-opus-4-7');
    expect(ids).not.toContain('claude-opus-4-6');
    expect(ids).not.toContain('claude-sonnet-4-6');
    expect(ids).not.toContain('claude-sonnet-4-7');
    expect(ids.some((id) => id.endsWith('[1m]'))).toBe(false);
  });

  it('Codex 内置模型列表应与目标设计一致', () => {
    expect(CODEX_MODELS.map((model) => model.id)).toEqual([
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-6.1-terra',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
    ]);
  });

  // Third-party catalogs expose models whose ids collide with the claude-*
  // mapping slots. Non-claude providers must render catalog labels verbatim.
  it('非 Claude 提供商应原样显示目录标签，不受 Claude 模型映射影响', () => {
    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_MODEL_MAPPING,
      JSON.stringify({ sonnet: 'glm-4' }),
    );

    render(
      <ModelSelect
        value={sonnetModel.id}
        onChange={vi.fn()}
        models={[sonnetModel]}
        currentProvider="opencode"
      />,
    );

    expect(screen.getByRole('button').textContent).toContain('Sonnet 4.6');
    expect(screen.getByRole('button').textContent).not.toContain('glm-4');
  });

  it('同一模型 ID 切换到非 Claude 提供商后不应沿用 Claude 映射标签', () => {
    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_MODEL_MAPPING,
      JSON.stringify({ sonnet: 'glm-4' }),
    );

    const { rerender } = render(
      <ModelSelect
        value={sonnetModel.id}
        onChange={vi.fn()}
        models={[sonnetModel]}
        currentProvider="claude"
      />,
    );
    expect(screen.getByRole('button').textContent).toContain('glm-4');

    rerender(
      <ModelSelect
        value={sonnetModel.id}
        onChange={vi.fn()}
        models={[sonnetModel]}
        currentProvider="opencode"
      />,
    );
    expect(screen.getByRole('button').textContent).toContain('Sonnet 4.6');
    expect(screen.getByRole('button').textContent).not.toContain('glm-4');
  });

  it('多提供商目录应按前缀分组并渲染分组标题', () => {
    const catalog: ModelInfo[] = [
      { id: 'auto', label: 'OMP Auto' },
      { id: 'fufei/kimi-k3', label: 'fufei/kimi-k3' },
      { id: 'kimi-code/k3', label: 'kimi-code/k3' },
      { id: 'kimi-code/k3-256k', label: 'kimi-code/k3-256k' },
    ];

    render(
      <ModelSelect
        value="auto"
        onChange={vi.fn()}
        models={catalog}
        currentProvider="omp"
      />,
    );
    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByTestId('model-group-other')).toBeTruthy();
    expect(screen.getByTestId('model-group-fufei')).toBeTruthy();
    expect(screen.getByTestId('model-group-kimi-code')).toBeTruthy();
    expect(screen.getByTestId('model-option-auto')).toBeTruthy();
    expect(screen.getByTestId('model-option-kimi-code/k3-256k')).toBeTruthy();
  });

  it('单一前缀目录不渲染分组标题', () => {
    const catalog: ModelInfo[] = [
      { id: 'auto', label: 'OMP Auto' },
      { id: 'deepseek/deepseek-flash', label: 'deepseek/deepseek-flash' },
      { id: 'deepseek/deepseek-v4-flash', label: 'deepseek/deepseek-v4-flash' },
    ];

    render(
      <ModelSelect
        value="auto"
        onChange={vi.fn()}
        models={catalog}
        currentProvider="omp"
      />,
    );
    fireEvent.click(screen.getByRole('button'));

    expect(screen.queryByTestId('model-group-other')).toBeNull();
    expect(screen.queryByTestId('model-group-deepseek')).toBeNull();
    expect(screen.getByTestId('model-option-deepseek/deepseek-flash')).toBeTruthy();
  });

  it('选中值不在列表中（如 OMP 角色）时触发器应显示原值而非回退到第一项', () => {
    render(
      <ModelSelect
        value="smol"
        onChange={vi.fn()}
        models={[{ id: 'auto', label: 'OMP Auto' }]}
        currentProvider="omp"
      />,
    );

    expect(screen.getByRole('button').textContent).toContain('smol');
    expect(screen.getByRole('button').textContent).not.toContain('OMP Auto');
  });
});
