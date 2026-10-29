import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JS module deployed without a build step
import { BadMessage, handle } from '../ops/budget-guard/guard.js';

const push = (payload: unknown, budgetId = 'budget-1') => ({
  message: { data: Buffer.from(JSON.stringify(payload)).toString('base64'), attributes: { budgetId } },
});
const config = { threshold: 400, currency: 'TWD', budgetId: 'budget-1', dryRun: false };
const makeDeps = (enabled = true) => ({
  isBillingEnabled: vi.fn(async () => enabled),
  disableBilling: vi.fn(async () => ({})),
  canDisableBilling: vi.fn(async () => true),
});

describe('budget guard', () => {
  it('leaves billing alone under the threshold', async () => {
    const deps = makeDeps();
    const result = await handle(push({ costAmount: 399.99, currencyCode: 'TWD' }), config, deps);
    expect(result.action).toBe('none');
    expect(deps.disableBilling).not.toHaveBeenCalled();
  });

  it('disables billing once actual cost reaches the threshold', async () => {
    const deps = makeDeps();
    const result = await handle(push({ costAmount: 400, currencyCode: 'TWD' }), config, deps);
    expect(result.action).toBe('billing-disabled');
    expect(deps.disableBilling).toHaveBeenCalledOnce();
  });

  it('does not call disable again when billing is already off', async () => {
    const deps = makeDeps(false);
    const result = await handle(push({ costAmount: 900, currencyCode: 'TWD' }), config, deps);
    expect(result.action).toBe('already-disabled');
    expect(deps.disableBilling).not.toHaveBeenCalled();
  });

  it('only checks permission in dry-run mode', async () => {
    const deps = makeDeps();
    const result = await handle(push({ costAmount: 450, currencyCode: 'TWD' }), { ...config, dryRun: true }, deps);
    expect(result).toMatchObject({ action: 'dry-run', canDisable: true });
    expect(deps.disableBilling).not.toHaveBeenCalled();
  });

  it('ignores other budgets and other currencies', async () => {
    const deps = makeDeps();
    expect((await handle(push({ costAmount: 900, currencyCode: 'TWD' }, 'other'), config, deps)).decision).toBe('ignore:other-budget');
    expect((await handle(push({ costAmount: 900, currencyCode: 'USD' }), config, deps)).decision).toBe('ignore:currency-mismatch');
    expect(deps.disableBilling).not.toHaveBeenCalled();
  });

  it('rejects malformed messages', async () => {
    await expect(handle({ message: {} }, config, makeDeps())).rejects.toBeInstanceOf(BadMessage);
    await expect(handle(push({ costAmount: '400' }), config, makeDeps())).rejects.toBeInstanceOf(BadMessage);
  });
});
