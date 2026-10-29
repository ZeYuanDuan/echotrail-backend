import { createServer } from 'node:http';
import { BadMessage, handle } from './guard.js';

const projectId = process.env.PROJECT_ID;
const threshold = Number(process.env.THRESHOLD);
if (!projectId || !Number.isFinite(threshold) || threshold <= 0) throw new Error('PROJECT_ID and THRESHOLD are required');

const config = {
  threshold,
  currency: process.env.CURRENCY ?? 'TWD',
  budgetId: process.env.BUDGET_ID || undefined,
  dryRun: process.env.DRY_RUN === 'true',
};

const accessToken = async () => {
  const res = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
    headers: { 'Metadata-Flavor': 'Google' },
  });
  if (!res.ok) throw new Error(`metadata token HTTP ${res.status}`);
  return (await res.json()).access_token;
};

const google = async (url, init = {}) => {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url} HTTP ${res.status}: ${body.error?.status ?? ''}`);
  return body;
};

const billingInfoUrl = `https://cloudbilling.googleapis.com/v1/projects/${projectId}/billingInfo`;
const deps = {
  isBillingEnabled: async () => (await google(billingInfoUrl)).billingEnabled === true,
  disableBilling: () => google(billingInfoUrl, { method: 'PUT', body: JSON.stringify({ billingAccountName: '' }) }),
  canDisableBilling: async () => {
    const permission = 'resourcemanager.projects.deleteBillingAssignment';
    const result = await google(`https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:testIamPermissions`, {
      method: 'POST', body: JSON.stringify({ permissions: [permission] }),
    });
    return (result.permissions ?? []).includes(permission);
  },
};

const log = (severity, message, fields = {}) => console.log(JSON.stringify({ severity, message, ...fields }));

createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const result = await handle(JSON.parse(raw), config, deps);
    log(result.action === 'none' ? 'INFO' : 'WARNING', 'budget notification handled', result);
    res.writeHead(204).end();
  } catch (error) {
    // 格式錯誤的訊息重送也不會成功，直接確認收下；其他錯誤回 500 讓 Pub/Sub 重試。
    const bad = error instanceof BadMessage || error instanceof SyntaxError;
    log('ERROR', 'budget notification failed', { error: String(error), willRetry: !bad });
    res.writeHead(bad ? 204 : 500).end();
  }
}).listen(Number(process.env.PORT ?? 8080));
