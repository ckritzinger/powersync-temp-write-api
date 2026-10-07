import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
test.describe.configure({ mode: 'default' });
test.setTimeout(90_000);

function compose(args: string[]) {
  return execFileSync('docker', ['compose', '--env-file', '.local/runtime.env', ...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
}
function uuid(id: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(id)) throw new Error('Expected test UUID.');
  return `'${id}'`;
}
function source(sql: string) {
  return compose(['exec', '-T', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At',
    '-U', 'test_admin', '-d', 'test_system', '-c', sql]).trim();
}
test.beforeEach(async () => {
  const expected = JSON.parse(await readFile(`${root}/.generated/backend/source-manifest.json`, 'utf8'));
  const running = JSON.parse(compose(['exec', '-T', 'backend', 'node', '-e',
    "process.stdout.write(require('node:fs').readFileSync('/app/source-manifest.json','utf8'))"]));
  expect(running.profile, 'Rebuild/recreate the selected backend with pnpm run backend:up').toBe(expected.profile);
  expect(running.preparedSha256, 'Running backend must match prepared source').toBe(expected.preparedSha256);
});
async function open(page: Page, profile: string) {
  const runtime = await readFile(`${root}/.local/runtime.env`, 'utf8');
  const port = /^BACKEND_PORT=(\d+)$/m.exec(runtime)?.[1] ?? '6061';
  await page.goto(`/?source=postgres&profile=${profile}`);
  await page.locator('#backend').fill(`http://127.0.0.1:${port}`);
  await page.locator('#cloud').fill('');
  await page.getByRole('button', { name: 'Open local database' }).click();
  await expect(page.locator('#pending')).toHaveText('0');
}
async function add(page: Page, name: string, ids: Set<string>) {
  await page.locator('#name').fill(name);
  await page.getByRole('button', { name: 'Add widget', exact: true }).click();
  await expect(page.locator('#pending')).toHaveText('1');
  const action = await page.locator('#last-action').innerText();
  const id = action.match(/[a-f0-9]{8}-[a-f0-9-]{27}/)?.[0];
  if (!id) throw new Error('Expected fresh widget ID.');
  ids.add(id);
  return id;
}
async function upload(page: Page) {
  await page.getByRole('button', { name: 'Upload once (API only)' }).click();
}
async function settle(page: Page) {
  await expect(page.getByRole('button', { name: 'Upload once (API only)' })).toBeEnabled();
}
async function receipt(name: string, result: Record<string, unknown>) {
  const manifest = JSON.parse(compose(['exec', '-T', 'backend', 'node', '-e',
    "process.stdout.write(require('node:fs').readFileSync('/app/source-manifest.json','utf8'))"]));
  await mkdir(`${root}/.local/recovery-results`, { recursive: true, mode: 0o700 });
  const profile = manifest.profile ?? 'baseline';
  await writeFile(`${root}/.local/recovery-results/${name}-${profile}.json`, JSON.stringify({
    scope: 'Actual local API, SDK queue and source Postgres; no Cloud connection',
    backendProfile: profile, sourceSha256: manifest.sourceSha256,
    patchSha256: manifest.patchSha256, ...result
  }, null, 2) + '\n', { mode: 0o600 });
}
function cleanup(ids: Set<string>) {
  if (ids.size) source(`DELETE FROM public.widgets WHERE id IN (${[...ids].map(uuid).join(',')})`);
}

test('API outage retains a write across reload and recovers after restart', async ({ page }) => {
  const ids = new Set<string>();
  await open(page, 'recovery-api');
  try {
    const warm = await add(page, 'API recovery warmup', ids);
    await upload(page);
    await expect(page.locator('#pending')).toHaveText('0');
    expect(source(`SELECT count(*) FROM public.widgets WHERE id=${uuid(warm)}`)).toBe('1');
    compose(['stop', 'backend']);
    const id = await add(page, 'retained during API outage', ids);
    await upload(page);
    await settle(page);
    await expect(page.locator('#error')).not.toBeEmpty();
    await expect(page.locator('#pending')).toHaveText('1');
    await page.reload();
    await page.getByRole('button', { name: 'Open local database' }).click();
    await expect(page.locator('#pending')).toHaveText('1');
    compose(['up', '-d', '--wait', '--no-deps', 'backend']);
    await upload(page);
    await expect(page.locator('#pending')).toHaveText('0');
    expect(source(`SELECT name FROM public.widgets WHERE id=${uuid(id)}`)).toBe('retained during API outage');
    await receipt('api-outage', { status: 'passed', id, pendingDuringOutage: 1,
      pendingAfterReload: 1, pendingAfterRecovery: 0, sourceRowsAfterRecovery: 1 });
  } finally {
    compose(['up', '-d', '--wait', '--no-deps', 'backend']);
    cleanup(ids);
  }
});

test('database outage retains a write until Postgres recovers', async ({ page }) => {
  const ids = new Set<string>();
  await open(page, 'recovery-database');
  try {
    compose(['stop', 'postgres']);
    // Clear pooled connections so this exercises connection acquisition, not a stale query.
    compose(['restart', 'backend']);
    const backend = await page.locator('#backend').inputValue();
    await expect.poll(async () => {
      try { return (await page.request.get(backend)).status(); } catch { return 0; }
    }).toBe(200);
    const id = await add(page, 'retained during database outage', ids);
    const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/data') && response.request().method() === 'POST');
    await upload(page);
    const response = await responsePromise;
    const body = await response.json();
    await settle(page);
    const result = body.results?.[0];
    await expect(page.locator('#pending')).toHaveText(result?.status === 'fatal_error' && result?.requires_client_handling === false ? '0' : '1');
    const pendingDuringOutage = Number(await page.locator('#pending').innerText());
    if (pendingDuringOutage > 0) {
      await page.reload();
      await page.getByRole('button', { name: 'Open local database' }).click();
      await expect(page.locator('#pending')).toHaveText('1');
    }
    const pendingAfterReload = Number(await page.locator('#pending').innerText());
    compose(['up', '-d', '--wait', 'postgres']);
    compose(['up', '-d', '--wait', '--no-deps', 'backend']);
    if (pendingDuringOutage > 0) { await upload(page); await settle(page); }
    const sourceRowsAfterRecovery = Number(source(`SELECT count(*) FROM public.widgets WHERE id=${uuid(id)}`));
    const passed = result?.status === 'retryable_error' && pendingDuringOutage === 1 && sourceRowsAfterRecovery === 1;
    await receipt('database-outage', {
      status: passed ? 'passed' : 'failed', id, expected: 'retryable_error; queue retained; source row after recovery',
      httpStatus: response.status(), resultStatus: result?.status,
      errorCode: result?.failed_operation?.error_code,
      requiresClientHandling: result?.requires_client_handling,
      pendingDuringOutage, pendingAfterReload, sourceRowsAfterRecovery
    });
    expect(result?.status, 'Connection outage must remain retryable; see sanitized database-outage receipt').toBe('retryable_error');
    expect(pendingDuringOutage).toBe(1);
    expect(pendingAfterReload).toBe(1);
    expect(sourceRowsAfterRecovery).toBe(1);
  } finally {
    compose(['up', '-d', '--wait', 'postgres']);
    compose(['up', '-d', '--wait', '--no-deps', 'backend']);
    cleanup(ids);
  }
});

test('committed response loss retains the queue and replays safely for widgets', async ({ page }) => {
  const ids = new Set<string>();
  let lostResponse = false;
  await open(page, 'recovery-response-loss');
  try {
    const backend = await page.locator('#backend').inputValue();
    await page.route(`${backend}/api/data`, async route => {
      if (lostResponse) { await route.continue(); return; }
      // Forward the real authenticated request, then lose its response after source commit.
      const response = await route.fetch();
      const body = await response.json();
      expect(response.status()).toBe(200);
      expect(body.results[0].status).toBe('success');
      lostResponse = true;
      await route.abort('failed');
    });
    const id = await add(page, 'committed before response loss', ids);
    await upload(page);
    await settle(page);
    await expect(page.locator('#pending')).toHaveText('1');
    expect(source(`SELECT count(*) FROM public.widgets WHERE id=${uuid(id)}`)).toBe('1');
    await upload(page);
    await expect(page.locator('#pending')).toHaveText('0');
    expect(source(`SELECT count(*) FROM public.widgets WHERE id=${uuid(id)} AND name='committed before response loss'`)).toBe('1');
    await receipt('response-loss', { status: 'passed', id, discardedCommittedResponse: lostResponse,
      pendingAfterLostResponse: 1, pendingAfterReplay: 0, sourceRowsAfterReplay: 1,
      limitation: 'Widget upsert state only; no exactly-once or arbitrary side-effect guarantee' });
  } finally { cleanup(ids); }
});
