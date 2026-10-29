// 預算停機邏輯：收到 Cloud Billing 預算通知後，實際支出達門檻就解除專案的帳單綁定。

export class BadMessage extends Error {}

export function parseNotification(body) {
  const data = body?.message?.data;
  if (typeof data !== 'string') throw new BadMessage('missing message.data');
  let payload;
  try { payload = JSON.parse(Buffer.from(data, 'base64').toString('utf8')); }
  catch { throw new BadMessage('message.data is not base64 JSON'); }
  if (typeof payload.costAmount !== 'number' || typeof payload.currencyCode !== 'string') {
    throw new BadMessage('notification lacks costAmount/currencyCode');
  }
  return { ...payload, budgetId: body.message.attributes?.budgetId };
}

export function decide(notification, { threshold, currency, budgetId }) {
  if (budgetId && notification.budgetId !== budgetId) return 'ignore:other-budget';
  if (notification.currencyCode !== currency) return 'ignore:currency-mismatch';
  return notification.costAmount >= threshold ? 'disable' : 'ignore:under-threshold';
}

export async function handle(body, config, deps) {
  const notification = parseNotification(body);
  const decision = decide(notification, config);
  const context = { decision, costAmount: notification.costAmount, threshold: config.threshold, currency: notification.currencyCode };
  if (decision !== 'disable') return { ...context, action: 'none' };
  if (config.dryRun) return { ...context, action: 'dry-run', canDisable: await deps.canDisableBilling() };
  if (!(await deps.isBillingEnabled())) return { ...context, action: 'already-disabled' };
  await deps.disableBilling();
  return { ...context, action: 'billing-disabled' };
}
