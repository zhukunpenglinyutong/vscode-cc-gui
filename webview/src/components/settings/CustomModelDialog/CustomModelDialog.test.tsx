import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CustomModelDialog from './index';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

describe('CustomModelDialog', () => {
  it('adds a custom model with optional pricing', () => {
    const onModelsChange = vi.fn();

    render(
      <CustomModelDialog
        isOpen
        models={[]}
        onModelsChange={onModelsChange}
        onClose={vi.fn()}
        initialAddMode
      />,
    );

    fireEvent.change(screen.getByLabelText('settings.codexProvider.dialog.modelIdPlaceholder'), {
      target: { value: 'vendor/custom-model' },
    });
    fireEvent.change(screen.getByLabelText('settings.codexProvider.dialog.modelLabelPlaceholder'), {
      target: { value: 'Custom Model' },
    });
    // Pricing is collapsed by default — expand it to enter rates.
    fireEvent.click(screen.getByRole('button', { name: /settings\.pluginModels\.pricing\.title/ }));
    fireEvent.change(screen.getByLabelText('settings.pluginModels.pricing.inputLabel'), {
      target: { value: '0.2' },
    });
    fireEvent.change(screen.getByLabelText('settings.pluginModels.pricing.outputLabel'), {
      target: { value: '0.8' },
    });
    fireEvent.change(screen.getByLabelText('settings.pluginModels.pricing.cacheReadLabel'), {
      target: { value: '0.02' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'common.add' }));

    expect(onModelsChange).toHaveBeenCalledWith([
      {
        id: 'vendor/custom-model',
        label: 'Custom Model',
        description: undefined,
        pricing: {
          inputCostPer1M: 0.2,
          outputCostPer1M: 0.8,
          cacheReadCostPer1M: 0.02,
        },
      },
    ]);
  });

  it('blocks saving when a pricing field is negative', () => {
    const onModelsChange = vi.fn();

    render(
      <CustomModelDialog
        isOpen
        models={[]}
        onModelsChange={onModelsChange}
        onClose={vi.fn()}
        initialAddMode
      />,
    );

    fireEvent.change(screen.getByLabelText('settings.codexProvider.dialog.modelIdPlaceholder'), {
      target: { value: 'vendor/custom-model' },
    });
    // Pricing is collapsed by default — expand it to enter the invalid value.
    fireEvent.click(screen.getByRole('button', { name: /settings\.pluginModels\.pricing\.title/ }));
    fireEvent.change(screen.getByLabelText('settings.pluginModels.pricing.inputLabel'), {
      target: { value: '-1' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'common.add' }));

    expect(onModelsChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Pricing must be a non-negative number');
  });

  it('keeps the optional pricing section collapsed by default and expands on click', () => {
    render(
      <CustomModelDialog
        isOpen
        models={[]}
        onModelsChange={vi.fn()}
        onClose={vi.fn()}
        initialAddMode
      />,
    );

    const toggle = screen.getByRole('button', { name: /settings\.pluginModels\.pricing\.title/ });
    // Pricing inputs are hidden until the section is expanded.
    expect(screen.queryByLabelText('settings.pluginModels.pricing.inputLabel')).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByLabelText('settings.pluginModels.pricing.inputLabel')).toBeTruthy();

    // Collapsing again hides the inputs.
    fireEvent.click(toggle);
    expect(screen.queryByLabelText('settings.pluginModels.pricing.inputLabel')).toBeNull();
  });

  it('edits pricing only for Claude models configured by the active provider', () => {
    const onModelsChange = vi.fn();
    const onConfiguredModelPricingChange = vi.fn();

    render(
      <CustomModelDialog
        isOpen
        models={[{
          id: 'user/custom-model',
          label: 'User Custom Model',
        }]}
        configuredModels={[{
          id: 'deepseek-v4-pro[1m]',
          label: 'deepseek-v4-pro[1m]',
        }]}
        onModelsChange={onModelsChange}
        onConfiguredModelPricingChange={onConfiguredModelPricingChange}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('deepseek-v4-pro[1m]')).toBeTruthy();
    expect(screen.getByText('settings.pluginModels.pricing.defaultPricing')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', {
      name: 'settings.pluginModels.editPricing deepseek-v4-pro[1m]',
    }));

    expect((screen.getByLabelText('settings.codexProvider.dialog.modelIdPlaceholder') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('settings.codexProvider.dialog.modelLabelPlaceholder') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('settings.codexProvider.dialog.modelDescPlaceholder') as HTMLInputElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('settings.pluginModels.pricing.inputLabel'), {
      target: { value: '0.2' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    expect(onModelsChange).not.toHaveBeenCalled();
    expect(onConfiguredModelPricingChange).toHaveBeenCalledWith('deepseek-v4-pro[1m]', {
      inputCostPer1M: 0.2,
    });
  });
});
