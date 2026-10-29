// Explicit, credential-safe Cloud AI acceptance. Reuses the same real
// Chrome + Switchboard E2E as local AI; never prints or persists provider keys.
// This test makes live provider requests and may incur usage charges.
if (process.env.SBX_TEST_CLOUD !== '1') {
  throw Error('Cloud E2E is opt-in: SBX_TEST_CLOUD=1 is required.');
}
for (const name of ['SBX_CLOUD_BASE_URL', 'SBX_CLOUD_MODEL', 'SBX_CLOUD_API_KEY']) {
  if (!process.env[name]) throw Error('Cloud E2E missing ' + name);
}
const base = new URL(process.env.SBX_CLOUD_BASE_URL);
if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
  throw Error('Cloud E2E requires an HTTPS provider URL without embedded credentials.');
}
// The shared harness reads legacy LOCAL names. These are process-only aliases,
// not local inference, and are never written to the machine or extension.
process.env.SBX_LOCAL_BASE_URL = base.href;
process.env.SBX_LOCAL_MODEL = process.env.SBX_CLOUD_MODEL;
process.env.SBX_LOCAL_API_KEY = process.env.SBX_CLOUD_API_KEY;
process.env.SBX_LOCAL_TIMEOUT_MS = process.env.SBX_CLOUD_TIMEOUT_MS || '45000';
await import('./test-browser-panel-real-ai-e2e.mjs');
