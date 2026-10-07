import { test, expect, type Browser, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
function compose(args: string[]) {
  return execFileSync('docker', ['compose', '--env-file', '.local/runtime.env', ...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
}
function quote(id: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(id)) throw new Error('Expected test UUID');
  return `'${id}'`;
}
function source(sql: string) {
  return compose(['exec', '-T', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At',
    '-U', 'test_admin', '-d', 'test_system', '-c', sql]).trim();
}
async function fixture(browser: Browser, batchSize = 1) {
  const runtime = await readFile(`${root}/.local/runtime.env`, 'utf8');
  const backend = `http://127.0.0.1:${/^BACKEND_PORT=(\d+)$/m.exec(runtime)?.[1] ?? '6061'}`;
  const direct = `http://127.0.0.1:${/^WRITE_API_PORT=(\d+)$/m.exec(runtime)?.[1] ?? '6062'}`;
  const contexts = [await browser.newContext(), await browser.newContext()];
  const a = await contexts[0].newPage(), b = await contexts[1].newPage();
  const suffix = randomUUID().slice(0, 8);
  const profileA = `live-recovery-a-${suffix}`;
  const ids = new Set<string>();
  const manifest = JSON.parse(compose(['exec', '-T', 'backend', 'node', '-e',
    "process.stdout.write(require('node:fs').readFileSync('/app/source-manifest.json','utf8'))"]));
  expect(manifest.recoveryFix ?? (manifest.profile === 'recovery' ? 'test-patch' : 'absent')).not.toBe('absent');
  const cloud = JSON.parse(await readFile(`${root}/.local/cloud-target.json`, 'utf8')).instanceUrl;
  async function open(page: Page, profile: string) {
    await page.goto(`http://127.0.0.1:5174/?source=postgres&profile=${profile}`);
    await page.locator('#backend').fill(backend);
    await page.locator('#cloud').fill(cloud);
    await page.locator('#batch-size').fill(String(batchSize));
    await page.getByRole('button', { name: 'Open local database' }).click();
    await expect(page.locator('#connect')).toBeEnabled();
  }
  async function connect(page: Page) {
    await page.locator('#connect').click();
    await expect(page.locator('#connection')).toHaveText('Connected');
    await expect(page.locator('#initial-sync')).toContainText('Completed');
  }
  await open(a, profileA); await open(b, `live-recovery-b-${suffix}`);
  await connect(a); await connect(b);
  const row = (page: Page, id: string) => page.locator(`#widgets li[data-id="${id}"]`);
  async function actionIds() {
    const found = (await a.locator('#last-action').innerText()).match(/[a-f0-9]{8}-[a-f0-9-]{27}/g) ?? [];
    found.forEach(id => ids.add(id));
    return found;
  }
  async function add(name: string) {
    await a.locator('#name').fill(name);
    await a.locator('#add-button').click();
    await expect(a.locator('#last-action')).toContainText('Queued insert:');
    const [id] = await actionIds();
    if (!id) throw new Error('Missing test ID');
    return id;
  }
  async function converged(id: string, name: string) {
    await expect(a.locator('#pending')).toHaveText('0');
    await expect.poll(() => source(`SELECT name FROM public.widgets WHERE id=${quote(id)}`)).toBe(name);
    await expect(row(b, id).locator('input')).toHaveValue(name);
    await expect(b.locator('#pending')).toHaveText('0');
  }
  async function reload() {
    await a.reload();
    await a.getByRole('button', { name: 'Open local database' }).click();
    await expect(a.locator('#pending')).toHaveText('1');
  }
  async function receipt(name: string, details: Record<string, unknown>) {
    await mkdir(`${root}/.local/live-recovery-results`, { recursive: true, mode: 0o700 });
    await writeFile(`${root}/.local/live-recovery-results/${name}.json`, JSON.stringify({
      verifiedAt: new Date().toISOString(), status: 'passed',
      scope: 'Real SDK queue, actual write API/Postgres, and two clients connected to PowerSync Cloud',
      backendProfile: manifest.profile, sourceSha256: manifest.sourceSha256,
      recoveryFix: manifest.recoveryFix ?? 'test-patch',
      preparedSha256: manifest.preparedSha256, ...details
    }, null, 2) + '\n', { mode: 0o600 });
  }
  async function cleanup() {
    // Restore service availability even after a failed assertion, without deleting data or keys.
    compose(['up', '-d', '--wait', 'postgres']);
    compose(['up', '-d', '--wait', '--no-deps', 'backend', 'auth']);
    await Promise.allSettled(contexts.map(context => context.close()));
    if (ids.size) source(`DELETE FROM public.widgets WHERE id IN (${[...ids].map(quote).join(',')})`);
  }
  return { a, b, backend, direct, ids, add, row, actionIds, connect, converged, reload, receipt, cleanup };
}

for (const service of ['backend', 'postgres']) {
  test(`${service} outage retains a live write across reload and converges after recovery`, async ({ browser }) => {
    const f = await fixture(browser);
    try {
      compose(['stop', service]);
      if (service === 'postgres') {
        compose(['restart', 'backend']);
        await expect.poll(async () => { try { return (await f.a.request.get(f.direct)).status(); } catch { return 0; } }).toBe(200);
      }
      const failed = service === 'postgres'
        ? f.a.waitForResponse(r => r.url() === `${f.backend}/api/data` && r.request().method() === 'POST')
        : undefined;
      const name = `retained during ${service} outage`;
      const id = await f.add(name);
      if (failed) expect((await (await failed).json()).results[0].status).toBe('retryable_error');
      else await expect(f.a.locator('#upload')).toContainText('Failed');
      await expect(f.a.locator('#pending')).toHaveText('1');
      await f.reload();
      await expect(f.row(f.a, id).locator('input')).toHaveValue(name);
      if (service === 'backend') expect(source(`SELECT count(*) FROM public.widgets WHERE id=${quote(id)}`)).toBe('0');
      await expect(f.row(f.b, id)).toHaveCount(0);
      compose(['up', '-d', '--wait', '--no-deps', service]);
      await f.connect(f.a);
      await f.converged(id, name);
      await f.receipt(`${service}-outage`, { pendingDuringOutage: 1, pendingAfterReload: 1,
        pendingAfterRecovery: 0, sourceRowsAfterRecovery: 1, secondClientConverged: true });
    } finally { await f.cleanup(); }
  });
}

test('public JWKS outage rejects a trusted token with a fresh verifier and the live queue recovers', async ({ browser }) => {
  const f = await fixture(browser);
  const body = { transactions: [{ crud: [] }] };
  try {
    const { token } = await (await f.a.request.get(`${f.backend}/api/auth/token?user_id=jwks-live`)).json();
    // Keep write requests reachable directly while the separate public key provider is down.
    await f.a.route(`${f.backend}/api/data`, async route => {
      const response = await route.fetch({ url: `${f.direct}/api/data` });
      await route.fulfill({ response });
    });
    compose(['stop', 'auth']);
    compose(['restart', 'backend']);
    await expect.poll(async () => { try { return (await f.a.request.get(f.direct)).status(); } catch { return 0; } }).toBe(200);
    const rejected = await f.a.request.post(`${f.direct}/api/data`, { data: body, headers: { authorization: `Bearer ${token}` } });
    expect(rejected.status()).toBe(401);
    const failed = f.a.waitForResponse(r => r.url() === `${f.backend}/api/data` && r.status() === 401);
    const id = await f.add('retained during public JWKS outage');
    await failed;
    await expect(f.a.locator('#pending')).toHaveText('1');
    await f.reload();
    expect(source(`SELECT count(*) FROM public.widgets WHERE id=${quote(id)}`)).toBe('0');
    await expect(f.row(f.b, id)).toHaveCount(0);
    compose(['up', '-d', '--wait', '--no-deps', 'auth']);
    compose(['restart', 'backend']);
    await expect.poll(async () => { try { return (await f.a.request.get(f.direct)).status(); } catch { return 0; } }).toBe(200);
    const accepted = await f.a.request.post(`${f.direct}/api/data`, { data: body, headers: { authorization: `Bearer ${token}` } });
    expect(accepted.status()).toBe(200);
    await f.a.unroute(`${f.backend}/api/data`);
    await f.connect(f.a);
    await f.converged(id, 'retained during public JWKS outage');
    await f.receipt('public-jwks-outage', { freshVerifier: true, inlineFallback: false,
      outageHttpStatus: 401, sameTokenRecoveryHttpStatus: 200, pendingAfterReload: 1,
      pendingAfterRecovery: 0, secondClientConverged: true,
      limitation: 'Backend fresh key fetch verified through public JWKS; Cloud key-cache eviction was not forced.' });
  } finally { await f.cleanup(); }
});

test('live fatal writes, atomic rollback, cross-user writes and committed-response replay', async ({ browser }) => {
  const f = await fixture(browser);
  let release: () => void = () => {};
  try {
    await f.a.locator('#pair').click();
    await expect(f.a.locator('#last-action')).toContainText('Queued pair:');
    const pair = await f.actionIds();
    expect(pair).toHaveLength(2);
    await f.converged(pair[0], 'transaction pair');
    await f.converged(pair[1], 'transaction second widget');
    await f.row(f.b, pair[0]).locator('input').fill('updated by second user');
    await f.row(f.b, pair[0]).getByRole('button', { name: 'Rename' }).click();
    await expect(f.row(f.a, pair[0]).locator('input')).toHaveValue('updated by second user');
    await expect(f.b.locator('#pending')).toHaveText('0');
    expect(source(`SELECT name FROM public.widgets WHERE id=${quote(pair[0])}`)).toBe('updated by second user');
    const optimistic: Record<string, number> = {};
    const rejectedIds: string[] = [];
    for (const action of ['rollback', 'invalid']) {
      const completed = f.a.waitForResponse(r => r.url() === `${f.backend}/api/data` && r.request().method() === 'POST');
      await f.a.locator(`#${action}`).click();
      await expect(f.a.locator('#last-action')).toContainText(`Queued ${action}:`);
      const ids = await f.actionIds();
      rejectedIds.push(...ids);
      const result = (await (await completed).json()).results[0];
      expect(result.status).toBe('fatal_error');
      expect(result.requires_client_handling).toBe(false);
      expect(result.failed_operation.error_code).toBe('NOT_NULL_VIOLATION');
      await expect(f.a.locator('#pending')).toHaveText('0');
      expect(source(`SELECT count(*) FROM public.widgets WHERE id IN (${ids.map(quote).join(',')})`)).toBe('0');
      for (const id of ids) await expect(f.row(f.b, id)).toHaveCount(0);
      optimistic[action] = (await Promise.all(ids.map(id => f.row(f.a, id).count()))).reduce((sum, count) => sum + count, 0);
      await expect(f.a.locator('#rejections')).toContainText('NOT_NULL_VIOLATION');
      for (const id of ids) await expect(f.a.locator('#rejections')).toContainText(id);
      await expect(f.a.locator('#upload')).toContainText('Rejected by backend');
      for (const id of ids) await expect(f.row(f.a, id)).toHaveCount(0);
    }
    let lost = false, attempts = 0;
    const replayGate = new Promise<void>(resolve => { release = resolve; });
    await f.a.route(`${f.backend}/api/data`, async route => {
      attempts++;
      if (lost) { await replayGate; await route.continue(); return; }
      const response = await route.fetch();
      expect((await response.json()).results[0].status).toBe('success');
      lost = true;
      await route.abort('failed');
    });
    const id = await f.add('committed before lost response');
    await expect.poll(() => lost).toBe(true);
    await expect(f.a.locator('#pending')).toHaveText('1');
    expect(source(`SELECT count(*) FROM public.widgets WHERE id=${quote(id)}`)).toBe('1');
    await expect(f.row(f.b, id).locator('input')).toHaveValue('committed before lost response');
    release();
    await f.converged(id, 'committed before lost response');
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(source(`SELECT count(*) FROM public.widgets WHERE id=${quote(id)}`)).toBe('1');
    // A successful subsequent write advances the normal write checkpoint. Do not enqueue
    // compensating deletes, which could affect rows another client subsequently creates.
    for (const rejectedId of rejectedIds) await expect(f.row(f.a, rejectedId)).toHaveCount(0);
    await expect(f.a.locator('#rejection-count')).toHaveText('2');
    await f.a.reload();
    await f.a.getByRole('button', { name: 'Open local database' }).click();
    await expect(f.a.locator('#rejection-count')).toHaveText('2');
    for (const rejectedId of rejectedIds) await expect(f.a.locator('#rejections')).toContainText(rejectedId);
    await f.connect(f.a);
    await expect(f.a.locator('#pending')).toHaveText('0');
    await f.receipt('fatal-rollback-replay', { atomicPairSynced: true, crossUserWriteAllowed: true,
      rollbackSourceRows: 0, invalidSourceRows: 0, backendFatalQueuesCompleted: true,
      optimisticLocalRowsObserved: optimistic, committedResponseDiscarded: true,
      rejectedRowsReconciledAfterWriteCheckpoint: true, rejectionHistorySurvivedReload: true,
      reconciliationWithoutSubsequentWrite: true,
      pendingAfterLostResponse: 1, replayAttempts: attempts, pendingAfterReplay: 0,
      sourceRowsAfterReplay: 1, secondClientConverged: true,
      limitation: 'Widget state only; no arbitrary side-effect or exactly-once guarantee.' });
  } finally { release(); await f.cleanup(); }
});

test('batch stop and skip preserve transaction outcomes and replicate only committed rows', async ({ browser }) => {
  const f = await fixture(browser);
  const observations = [];
  try {
    const { token } = await (await f.a.request.get(`${f.backend}/api/auth/token?user_id=live-batch`)).json();
    for (const mode of ['stop', 'skip']) {
      const override = '.local/live-batch.compose.json';
      await writeFile(`${root}/${override}`, JSON.stringify({ services: { backend: {
        environment: { BATCH_ON_FATAL_ERROR: mode }
      } } }), { mode: 0o600 });
      compose(['-f', 'compose.yaml', '-f', override, 'up', '-d', '--wait', '--no-deps', 'backend']);
      const ids = Array.from({ length: 4 }, () => randomUUID());
      ids.forEach(id => f.ids.add(id));
      const put = (id: string, name: string | null) => ({ op: 'PUT', table: 'widgets', id, op_data: { name } });
      const response = await f.a.request.post(`${f.backend}/api/data`, {
        headers: { authorization: `Bearer ${token}` }, data: { transactions: [
          { crud: [put(ids[0], `batch ${mode} first`)] },
          { crud: [put(ids[1], `batch ${mode} rollback`), put(ids[2], null)] },
          { crud: [put(ids[3], `batch ${mode} last`)] }
        ] }
      });
      expect(response.status()).toBe(200);
      const results = (await response.json()).results;
      const statuses = results.map((r: { status: string }) => r.status);
      expect(statuses).toEqual(['success', 'fatal_error', mode === 'stop' ? 'not_attempted' : 'success']);
      expect(results[1].failed_operation.operation_index).toBe(1);
      expect(source(`SELECT count(*) FROM public.widgets WHERE id IN (${ids.slice(1, 3).map(quote).join(',')})`)).toBe('0');
      await f.converged(ids[0], `batch ${mode} first`);
      if (mode === 'skip') await f.converged(ids[3], `batch ${mode} last`);
      else {
        expect(source(`SELECT count(*) FROM public.widgets WHERE id=${quote(ids[3])}`)).toBe('0');
        await expect(f.row(f.b, ids[3])).toHaveCount(0);
      }
      for (const id of ids.slice(1, 3)) await expect(f.row(f.b, id)).toHaveCount(0);
      observations.push({ mode, statuses, rolledBackRows: 0, replicatedRows: mode === 'skip' ? 2 : 1,
        clientAQueue: 0, clientBQueue: 0 });
    }
    await f.receipt('batch-stop-skip', { observations,
      limitation: 'Direct API batches plus actual Cloud visibility; the default connector uploads one transaction per request.' });
  } finally {
    compose(['up', '-d', '--wait', '--no-deps', 'backend']);
    await f.cleanup();
  }
});

test('real SDK batches retain not-attempted writes across reload and recover in stop and skip modes', async ({ browser }) => {
  const f = await fixture(browser, 3);
  const observations = [];
  try {
    for (const mode of ['stop', 'skip']) {
      await f.a.locator('#disconnect').click();
      await expect(f.a.locator('#connection')).toHaveText('Disconnected');
      const override = '.local/live-client-batch.compose.json';
      await writeFile(`${root}/${override}`, JSON.stringify({ services: { backend: {
        environment: { BATCH_ON_FATAL_ERROR: mode }
      } } }), { mode: 0o600 });
      compose(['-f', 'compose.yaml', '-f', override, 'up', '-d', '--wait', '--no-deps', 'backend']);

      const first = await f.add(`SDK batch ${mode} first`);
      await f.a.locator('#rollback').click();
      await expect(f.a.locator('#last-action')).toContainText('Queued rollback:');
      const rejected = await f.actionIds();
      expect(rejected).toHaveLength(2);
      const last = await f.add(`SDK batch ${mode} last`);
      await expect(f.a.locator('#pending')).toHaveText('4');
      const completed = f.a.waitForResponse(r => r.url() === `${f.backend}/api/data` && r.request().method() === 'POST');
      await f.a.locator('#upload-once').click();
      const response = await completed;
      expect(response.status()).toBe(200);
      const transactions = response.request().postDataJSON().transactions;
      expect(transactions.map((t: { crud: { id: string }[] }) => t.crud.map(op => op.id)))
        .toEqual([[first], rejected, [last]]);
      const results = (await response.json()).results;
      const statuses = results.map((r: { status: string }) => r.status);
      expect(statuses).toEqual(['success', 'fatal_error', mode === 'stop' ? 'not_attempted' : 'success']);
      expect(results[1].requires_client_handling).toBe(false);
      expect(results[1].failed_operation.operation_index).toBe(1);
      expect(results[1].failed_operation.error_code).toBe('NOT_NULL_VIOLATION');
      const retained = mode === 'stop' ? 1 : 0;
      await expect(f.a.locator('#pending')).toHaveText(String(retained));
      await expect(f.a.locator('#rejection-count')).toHaveText(mode === 'stop' ? '1' : '2');
      for (const id of rejected) await expect(f.a.locator('#rejections')).toContainText(id);
      expect(source(`SELECT name FROM public.widgets WHERE id=${quote(first)}`)).toBe(`SDK batch ${mode} first`);
      expect(source(`SELECT count(*) FROM public.widgets WHERE id IN (${rejected.map(quote).join(',')})`)).toBe('0');
      expect(source(`SELECT count(*) FROM public.widgets WHERE id=${quote(last)}`)).toBe(String(mode === 'skip' ? 1 : 0));
      await expect(f.row(f.b, first).locator('input')).toHaveValue(`SDK batch ${mode} first`);
      if (mode === 'stop') await expect(f.row(f.b, last)).toHaveCount(0);
      else await expect(f.row(f.b, last).locator('input')).toHaveValue(`SDK batch ${mode} last`);
      for (const id of rejected) await expect(f.row(f.b, id)).toHaveCount(0);

      // Reopen the actual persisted SDK queue. Capture its next upload to prove exactly
      // the unattempted transaction remains; completed prefix transactions must not replay.
      await f.a.reload();
      await expect(f.a.locator('#batch-size')).toHaveValue('3');
      await f.a.getByRole('button', { name: 'Open local database' }).click();
      await expect(f.a.locator('#pending')).toHaveText(String(retained));
      const resumed = mode === 'stop'
        ? f.a.waitForResponse(r => r.url() === `${f.backend}/api/data` && r.request().method() === 'POST')
        : undefined;
      await f.connect(f.a);
      if (resumed) {
        const recovered = await resumed;
        expect(recovered.request().postDataJSON().transactions.map((t: { crud: { id: string }[] }) => t.crud.map(op => op.id)))
          .toEqual([[last]]);
        expect((await recovered.json()).results.map((r: { status: string }) => r.status)).toEqual(['success']);
      }
      await f.converged(last, `SDK batch ${mode} last`);
      await f.converged(first, `SDK batch ${mode} first`);
      for (const id of rejected) await expect(f.row(f.a, id)).toHaveCount(0);
      await expect(f.a.locator('#rejection-count')).toHaveText(mode === 'stop' ? '1' : '2');
      observations.push({ mode, transactionOperationCounts: [1, 2, 1], statuses,
        pendingAfterBatch: retained, pendingAfterReload: retained, pendingAfterReconnect: 0,
        resumedTransactionCount: mode === 'stop' ? 1 : 0, completedPrefixNotReplayed: true,
        rolledBackRows: 0, finalSourceRows: 2, secondClientConverged: true,
        rejectedOptimisticRowsReconciled: true });
    }
    await f.receipt('client-batch-stop-skip', { observations,
      scope: 'Real SDK multi-transaction queue uploads, actual API/Postgres, reload persistence and two-client PowerSync Cloud convergence' });
  } finally {
    compose(['up', '-d', '--wait', '--no-deps', 'backend']);
    await f.cleanup();
  }
});

test('client-directed fatal decisions retain across reload and discard resumes later SDK uploads', async ({ browser }) => {
  const original = JSON.parse(await readFile(`${root}/.generated/backend/source-manifest.json`, 'utf8')).profile;
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  const prepare = (profile: string) => execFileSync(process.execPath,
    ['scripts/prepare-backend.mjs', '--profile', profile], { cwd: root, stdio: 'pipe', timeout: 60000 });
  try {
    prepare('client-directed');
    const override = '.local/client-directed.compose.json';
    await writeFile(`${root}/${override}`, JSON.stringify({ services: { backend: {
      environment: { BATCH_ON_FATAL_ERROR: 'skip' }
    } } }), { mode: 0o600 });
    compose(['-f', 'compose.yaml', '-f', override, 'up', '-d', '--build', '--wait', '--no-deps', 'backend']);
    f = await fixture(browser, 3);
    expect(JSON.parse(compose(['exec', '-T', 'backend', 'node', '-e',
      "process.stdout.write(require('node:fs').readFileSync('/app/source-manifest.json','utf8'))"])).profile).toBe('client-directed');
    await f.a.locator('#disconnect').click();
    await expect(f.a.locator('#connection')).toHaveText('Disconnected');
    const first = await f.add('decision first');
    await f.a.locator('#rollback').click();
    await expect(f.a.locator('#last-action')).toContainText('Queued rollback:');
    const rejected = await f.actionIds();
    const last = await f.add('decision later');
    await expect(f.a.locator('#pending')).toHaveText('4');
    const completed = f.a.waitForResponse(r => r.url() === `${f!.backend}/api/data` && r.request().method() === 'POST');
    await f.a.locator('#upload-once').click();
    const response = await completed;
    const results = (await response.json()).results;
    expect(results.map((r: { status: string }) => r.status)).toEqual(['success', 'fatal_error', 'not_attempted']);
    expect(results[1].requires_client_handling).toBe(true);
    expect(results[1].failed_operation.error_code).toBe('NOT_NULL_VIOLATION');
    await expect(f.a.locator('#pending')).toHaveText('3');
    await expect(f.a.locator('#decisions li')).toHaveCount(1);
    for (const id of rejected) await expect(f.a.locator('#decisions')).toContainText(id);
    await f.a.getByRole('button', { name: 'Keep queued' }).click();
    await expect(f.a.locator('#decisions')).toContainText('retained');
    await f.a.reload();
    await f.a.getByRole('button', { name: 'Open local database' }).click();
    await expect(f.a.locator('#pending')).toHaveText('3');
    await expect(f.a.locator('#decisions')).toContainText('retained');
    const retainedResponse = f.a.waitForResponse(r => r.url() === `${f!.backend}/api/data` && r.request().method() === 'POST');
    await f.a.locator('#upload-once').click();
    const retained = await retainedResponse;
    expect(retained.request().postDataJSON().transactions.map((t: { crud: { id: string }[] }) => t.crud.map(op => op.id)))
      .toEqual([rejected, [last]]);
    expect((await retained.json()).results.map((r: { status: string }) => r.status)).toEqual(['fatal_error', 'not_attempted']);
    await expect(f.a.locator('#pending')).toHaveText('3');
    await expect(f.a.locator('#decisions li')).toHaveCount(1);
    expect(source(`SELECT count(*) FROM public.widgets WHERE id IN (${[...rejected, last].map(quote).join(',')})`)).toBe('0');
    await expect(f.row(f.b, first).locator('input')).toHaveValue('decision first');
    for (const id of [...rejected, last]) await expect(f.row(f.b, id)).toHaveCount(0);

    const discardedResponse = f.a.waitForResponse(r => r.url() === `${f!.backend}/api/data` && r.request().method() === 'POST');
    await f.a.getByRole('button', { name: 'Discard transaction' }).click();
    const discarded = await discardedResponse;
    expect((await discarded.json()).results.map((r: { status: string }) => r.status)).toEqual(['fatal_error', 'not_attempted']);
    await expect(f.a.locator('#pending')).toHaveText('1');
    await expect(f.a.locator('#decisions')).toContainText('discarded');
    await expect(f.a.getByRole('button', { name: 'Discard transaction' })).toHaveCount(0);
    await f.a.reload();
    await f.a.getByRole('button', { name: 'Open local database' }).click();
    await expect(f.a.locator('#pending')).toHaveText('1');
    await expect(f.a.locator('#decisions')).toContainText('discarded');
    const resumedResponse = f.a.waitForResponse(r => r.url() === `${f!.backend}/api/data` && r.request().method() === 'POST');
    await f.connect(f.a);
    const resumed = await resumedResponse;
    expect(resumed.request().postDataJSON().transactions.map((t: { crud: { id: string }[] }) => t.crud.map(op => op.id)))
      .toEqual([[last]]);
    await f.converged(last, 'decision later');
    for (const id of rejected) await expect(f.row(f.a, id)).toHaveCount(0);
    expect(source(`SELECT count(*) FROM public.widgets WHERE id IN (${rejected.map(quote).join(',')})`)).toBe('0');
    await f.receipt('client-directed-decisions', { batchMode: 'skip', initialStatuses: ['success', 'fatal_error', 'not_attempted'],
      clientHandlingRequired: true, pendingAfterRetain: 3, pendingAfterRetainReload: 3,
      repeatedNoticeCount: 1, laterWriteBlocked: true, pendingAfterExplicitDiscard: 1,
      pendingAfterDiscardReload: 1, resumedTransactionCount: 1, pendingAfterReconnect: 0,
      rolledBackRows: 0, rejectedOptimisticRowsReconciled: true, secondClientConverged: true });
  } finally {
    // Always restore the original prepared profile and normal compose mode, even if the test fails.
    prepare(original);
    compose(['up', '-d', '--build', '--wait', '--no-deps', 'backend']);
    if (f) await f.cleanup();
  }
});
