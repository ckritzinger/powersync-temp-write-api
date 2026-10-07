import { test, expect, type Browser, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mssqlDocument, mssqlDelete, mssqlQuery } from '../../scripts/mssql-source.mjs';
import { compose, cli } from '../../scripts/phase-three.mjs';
import { prepareBackend } from '../../scripts/prepare-backend.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function fixture(browser: Browser, batchSize = 1) {
  const runtime = await readFile(`${root}/.local/runtime.env`, 'utf8');
  expect(runtime).toMatch(/^DATABASE_TYPE=mssql$/m);
  expect(mssqlQuery("SELECT is_cdc_enabled FROM sys.databases WHERE name='test_system';")).toBe('1');
  const backend = `http://127.0.0.1:${/^BACKEND_PORT=(\d+)$/m.exec(runtime)?.[1] ?? '6061'}`;
  const cloud = JSON.parse(await readFile(`${root}/.local/cloud-target.json`, 'utf8')).instanceUrl;
  const manifest = JSON.parse(compose(['exec', '-T', 'backend', 'node', '-e',
    "process.stdout.write(require('node:fs').readFileSync('/app/source-manifest.json','utf8'))"], { stdio: 'pipe' }));
  const contexts = [await browser.newContext(), await browser.newContext()];
  const a = await contexts[0].newPage(), b = await contexts[1].newPage();
  const profile = `mssql-${randomUUID().slice(0, 8)}`;
  const ids = new Set<string>();
  async function open(page: Page, name: string) {
    await page.goto(`/?source=mssql&profile=${name}`);
    await page.locator('#backend').fill(backend); await page.locator('#cloud').fill(cloud);
    await page.locator('#batch-size').fill(String(batchSize));
    await page.locator('#open').click(); await expect(page.locator('#connect')).toBeEnabled();
    await expect(page.locator('#database-label')).toContainText('mssql');
  }
  async function connect(page: Page) {
    await page.locator('#connect').click();
    await expect(page.locator('#connection')).toHaveText('Connected');
    await expect(page.locator('#initial-sync')).toContainText('Completed');
  }
  await open(a, profile + '-a'); await open(b, profile + '-b');
  await connect(a); await connect(b);
  const row = (page: Page, id: string) => page.locator(`#widgets li[data-id="${id}"]`);
  async function actionIds() {
    const values = (await a.locator('#last-action').innerText()).match(/[a-f0-9]{8}-[a-f0-9-]{27}/g) ?? [];
    values.forEach(id => ids.add(id)); return values;
  }
  async function add(name: string) {
    const prior = await a.locator('#last-action').innerText();
    await a.locator('#name').fill(name); await a.locator('#add-button').click();
    await expect(a.locator('#last-action')).not.toHaveText(prior);
    await expect(a.locator('#last-action')).toContainText('Queued insert:');
    return (await actionIds())[0];
  }
  const document = mssqlDocument;
  async function converged(id: string, name: string, replicationTimeout = 30_000) {
    await expect(a.locator('#pending')).toHaveText('0');
    await expect.poll(() => document(id)?.name).toBe(name);
    await expect(row(b, id).locator('input')).toHaveValue(name, { timeout: replicationTimeout });
    await expect(b.locator('#pending')).toHaveText('0');
  }
  async function reload(pending: number) {
    await a.reload(); await a.locator('#open').click();
    await expect(a.locator('#pending')).toHaveText(String(pending));
  }
  const posted = () => a.waitForResponse(r => r.url() === `${backend}/api/data` && r.request().method() === 'POST');
  async function receipt(name: string, details: object) {
    await writeFile(`${root}/.local/mssql-${name}-result.json`, JSON.stringify({ status: 'passed', verifiedAt: new Date().toISOString(),
      source: 'mssql', backendProfile: manifest.profile, sourceSha256: manifest.sourceSha256, preparedSha256: manifest.preparedSha256, mssqlRecoveryFix: manifest.mssqlRecoveryFix, nativeCheckpointCDC: true,
      scope: 'Actual SQL Server CDC source, write API and real SDK clients on the existing PowerSync Cloud instance', ...details }, null, 2) + '\n', { mode: 0o600 });
  }
  async function cleanup() {
    await Promise.allSettled(contexts.map(context => context.close()));
    mssqlDelete([...ids]);
  }
  return { a, b, backend, profile, row, add, document, actionIds, converged, reload, connect, posted, receipt, cleanup };
}

test('SQL Server Cloud CRUD converges and an offline queue survives reload', async ({ browser }) => {
  const f = await fixture(browser);
  try {
    const id = await f.add('mssql cloud insert'); await f.converged(id, 'mssql cloud insert');
    await f.row(f.a, id).locator('input').fill('mssql renamed');
    await f.row(f.a, id).getByRole('button', { name: 'Rename' }).click();
    await f.converged(id, 'mssql renamed');
    await f.row(f.a, id).getByRole('button', { name: 'Delete' }).click();
    await expect(f.a.locator('#pending')).toHaveText('0');
    await expect.poll(() => f.document(id)).toBe(null); await expect(f.row(f.b, id)).toHaveCount(0);
    await f.a.locator('#disconnect').click();
    const offline = await f.add('mssql offline');
    await expect(f.a.locator('#pending')).toHaveText('1'); expect(f.document(offline)).toBe(null);
    await f.reload(1); await f.connect(f.a); await f.converged(offline, 'mssql offline');
    await f.receipt('cloud', { crud: true, offlinePendingAfterReload: 1, pendingAfterReconnect: 0, secondClientConverged: true });
  } finally { await f.cleanup(); }
});

for (const service of ['backend', 'mssql']) {
  test(`SQL Server source ${service} outage retains queued work across reload and recovery`, async ({ browser }) => {
    if (service === 'mssql') test.setTimeout(240_000);
    const f = await fixture(browser);
    try {
      // Warm the actual connection pool explicitly; this verifies recovery after
      // an established session. A database unavailable at startup is a separate case.
      const seed = await f.add(`mssql ${service} warmup`); await f.converged(seed, `mssql ${service} warmup`);
      compose(['stop', service], { stdio: 'pipe' });
      const failed = service === 'mssql' ? f.posted() : undefined;
      const id = await f.add(`mssql ${service} retained`);
      if (failed) expect((await (await failed).json()).results[0].status).toBe('retryable_error');
      else await expect(f.a.locator('#upload')).toContainText('Failed');
      await expect(f.a.locator('#pending')).toHaveText('1');
      await f.reload(1); await expect(f.row(f.b, id)).toHaveCount(0);
      const recoveryStarted = Date.now();
      compose(['up', '-d', '--wait', '--no-deps', service], { stdio: 'pipe' });
      await f.connect(f.a);
      // PowerSync's MSSQL limiter waits 30s normally, or 120s for refused/DNS
      // connections. Keep the API/source assertions at 30s; only Cloud recovery
      // convergence gets this allowance. No manual client B reconnect.
      const replicationTimeout = service === 'mssql' ? 150_000 : 30_000;
      try { await f.converged(id, `mssql ${service} retained`, replicationTimeout); }
      catch (error) {
        await writeFile(`${root}/.local/mssql-${service}-outage-cloud-status.json`, await cli(['status', '--output=json']), { mode: 0o600 });
        throw error;
      }
      await f.receipt(`${service}-outage`, { recoveryElapsedMs: Date.now() - recoveryStarted, replicationTimeoutMs: replicationTimeout, adapterState: 'established', pendingDuringOutage: 1, pendingAfterReload: 1, pendingAfterRecovery: 0, secondClientConverged: true });
    } finally {
      compose(['up', '-d', '--wait', 'mssql', 'backend', 'auth'], { stdio: 'pipe' });
      await f.cleanup();
    }
  });
}

test('SQL Server real SDK stop and skip batches preserve atomicity and unattempted writes', async ({ browser }) => {
  const f = await fixture(browser, 3);
  const observations = [];
  try {
    for (const mode of ['stop', 'skip']) {
      await f.a.locator('#disconnect').click();
      await writeFile(`${root}/.local/mssql-browser-batch.compose.json`, JSON.stringify({ services: { backend: { environment: { BATCH_ON_FATAL_ERROR: mode } } } }), { mode: 0o600 });
      compose(['-f', 'compose.yaml', '-f', 'compose.mssql.yaml', '-f', '.local/mssql-browser-batch.compose.json', 'up', '-d', '--wait', '--no-deps', 'backend'], { stdio: 'pipe' });
      const first = await f.add(`mssql ${mode} first`);
      await f.a.locator('#rollback').click(); await expect(f.a.locator('#last-action')).toContainText('Queued rollback:');
      const rejected = await f.actionIds(); const last = await f.add(`mssql ${mode} last`);
      await expect(f.a.locator('#pending')).toHaveText('4');
      const completed = f.posted(); await f.a.locator('#upload-once').click(); const response = await completed;
      expect(response.request().postDataJSON().transactions.map((t: any) => t.crud.map((op: any) => op.id))).toEqual([[first], rejected, [last]]);
      const results = (await response.json()).results;
      expect(results.map((r: any) => r.status)).toEqual(['success', 'fatal_error', mode === 'stop' ? 'not_attempted' : 'success']);
      expect(results[1].failed_operation.error_code).toBe('NOT_NULL_VIOLATION');
      expect(results[1].requires_client_handling).toBe(false);
      for (const id of rejected) expect(f.document(id)).toBe(null);
      const retained = mode === 'stop' ? 1 : 0;
      await expect(f.a.locator('#pending')).toHaveText(String(retained));
      expect(f.document(last)?.name ?? null).toBe(mode === 'skip' ? `mssql ${mode} last` : null);
      await expect(f.row(f.b, first).locator('input')).toHaveValue(`mssql ${mode} first`);
      for (const id of rejected) await expect(f.row(f.b, id)).toHaveCount(0);
      await f.reload(retained);
      const recovered = mode === 'stop' ? f.posted() : undefined;
      await f.connect(f.a);
      if (recovered) expect((await recovered).request().postDataJSON().transactions.map((t: any) => t.crud.map((op: any) => op.id))).toEqual([[last]]);
      await f.converged(last, `mssql ${mode} last`);
      for (const id of rejected) await expect(f.row(f.a, id)).toHaveCount(0);
      observations.push({ mode, statuses: results.map((r: any) => r.status), pendingAfterBatch: retained, pendingAfterReload: retained, pendingAfterRecovery: 0, rollbackDocuments: 0 });
    }
    await f.receipt('batch', { observations });
  } finally { compose(['up', '-d', '--wait', '--no-deps', 'backend'], { stdio: 'pipe' }); await f.cleanup(); }
});

test('SQL Server client-directed validation supports retain and explicit discard', async ({ browser }) => {
  const manifest = JSON.parse(await readFile(`${root}/.generated/backend/source-manifest.json`, 'utf8'));
  const prepare = (profile: string) => prepareBackend({ profile });
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    await prepare('client-directed'); compose(['up', '-d', '--build', '--force-recreate', '--wait', '--no-deps', 'backend'], { stdio: 'pipe' });
    const running = JSON.parse(compose(['exec', '-T', 'backend', 'node', '-e', "process.stdout.write(require('node:fs').readFileSync('/app/source-manifest.json','utf8'))"], { stdio: 'pipe' }));
    expect(running.profile).toBe('client-directed');
    expect(compose(['exec', '-T', 'backend', 'node', '-e', "process.stdout.write(require('node:fs').readFileSync('/app/src/fatal-error-handler.ts','utf8'))"], { stdio: 'pipe' })).toContain('NOT_NULL_VIOLATION');
    f = await fixture(browser, 3); await f.a.locator('#disconnect').click();
    await f.a.locator('#rollback').click(); await expect(f.a.locator('#last-action')).toContainText('Queued rollback:');
    const rejected = await f.actionIds(); const last = await f.add('mssql after decision');
    const completed = f.posted(); await f.a.locator('#upload-once').click(); const result = (await (await completed).json()).results;
    expect(result[0].failed_operation.error_code).toBe('NOT_NULL_VIOLATION'); expect(result[0].requires_client_handling).toBe(true);
    expect(result[1].status).toBe('not_attempted');
    await f.a.getByRole('button', { name: 'Keep queued' }).click();
    await f.reload(3); await expect(f.a.locator('#decisions')).toContainText('retained');
    expect(f.document(last)).toBe(null);
    await f.a.getByRole('button', { name: 'Discard transaction' }).click();
    await expect(f.a.locator('#pending')).toHaveText('1'); await f.reload(1);
    await expect(f.a.locator('#decisions')).toContainText('discarded');
    await f.connect(f.a); await f.converged(last, 'mssql after decision');
    for (const id of rejected) { expect(f.document(id)).toBe(null); await expect(f.row(f.a, id)).toHaveCount(0); await expect(f.row(f.b, id)).toHaveCount(0); }
    await f.receipt('decisions', { retainedPendingAfterReload: 3, pendingAfterDiscardReload: 1, pendingAfterRecovery: 0, rollbackDocuments: 0 });
  } finally {
    await prepare(manifest.profile); compose(['up', '-d', '--build', '--force-recreate', '--wait', '--no-deps', 'backend'], { stdio: 'pipe' });
    if (f) await f.cleanup();
  }
});
