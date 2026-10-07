import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
function source(sql: string) {
  return execFileSync('docker', ['compose', '--env-file', '.local/runtime.env', 'exec', '-T', 'postgres',
    'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-U', 'test_admin', '-d', 'test_system', '-c', sql],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function uuid(id: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(id)) throw new Error('Expected generated UUID');
  return `'${id}'`;
}

test('two actual Cloud clients converge on CRUD and an offline write survives reload and reconnect', async ({ browser }) => {
  const runtime = await readFile(`${root}/.local/runtime.env`, 'utf8');
  const port = /^BACKEND_PORT=(\d+)$/m.exec(runtime)?.[1] ?? '6061';
  const backend = `http://127.0.0.1:${port}`;
  const target = JSON.parse(await readFile(`${root}/.local/cloud-target.json`, 'utf8'));
  const cloud: string = target.instanceUrl;
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const a = await contextA.newPage();
  const b = await contextB.newPage();
  const suffix = randomUUID().slice(0, 8);
  const ids = new Set<string>();
  async function open(page: Page, profile: string) {
    await page.goto(`http://127.0.0.1:5174/?source=postgres&profile=${profile}`);
    await page.locator('#backend').fill(backend);
    await page.locator('#cloud').fill(cloud);
    await page.getByRole('button', { name: 'Open local database' }).click();
    await expect(page.locator('#error')).toBeEmpty();
    await expect(page.locator('#connect')).toBeEnabled();
  }
  async function connect(page: Page) {
    await page.getByRole('button', { name: 'Connect to Cloud' }).click();
    await expect(page.locator('#connection')).toHaveText('Connected');
    await expect(page.locator('#initial-sync')).toContainText('Completed');
    await expect(page.locator('#sync-error')).toHaveText('None');
  }
  const row = (page: Page, id: string) => page.locator(`#widgets li[data-id="${id}"]`);
  async function add(name: string) {
    await a.locator('#name').fill(name);
    await a.getByRole('button', { name: 'Add widget', exact: true }).click();
    await expect(a.locator('#last-action')).toContainText('Queued insert:');
    const id = (await a.locator('#last-action').innerText()).match(/[a-f0-9]{8}-[a-f0-9-]{27}/)?.[0];
    if (!id) throw new Error('Missing queued widget ID');
    ids.add(id);
    return id;
  }
  try {
    await open(a, `cloud-a-${suffix}`);
    await open(b, `cloud-b-${suffix}`);
    await connect(a);
    await connect(b);
    const id = await add('cloud browser insert');
    await expect(a.locator('#pending')).toHaveText('0');
    await expect.poll(() => source(`SELECT name FROM public.widgets WHERE id=${uuid(id)}`)).toBe('cloud browser insert');
    await expect(row(b, id).locator('input')).toHaveValue('cloud browser insert');
    await row(a, id).locator('input').fill('cloud browser rename');
    await row(a, id).getByRole('button', { name: 'Rename' }).click();
    await expect(a.locator('#pending')).toHaveText('0');
    await expect.poll(() => source(`SELECT name FROM public.widgets WHERE id=${uuid(id)}`)).toBe('cloud browser rename');
    await expect(row(b, id).locator('input')).toHaveValue('cloud browser rename');
    await row(a, id).getByRole('button', { name: 'Delete' }).click();
    await expect(a.locator('#pending')).toHaveText('0');
    await expect.poll(() => source(`SELECT count(*) FROM public.widgets WHERE id=${uuid(id)}`)).toBe('0');
    await expect(row(b, id)).toHaveCount(0);
    await expect(row(a, id)).toHaveCount(0);

    await a.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(a.locator('#connection')).toHaveText('Disconnected');
    await a.route(`${backend}/**`, route => route.abort());
    await a.route(`${cloud}/**`, route => route.abort());
    const offline = await add('cloud browser offline');
    await expect(a.locator('#pending')).toHaveText('1');
    expect(source(`SELECT count(*) FROM public.widgets WHERE id=${uuid(offline)}`)).toBe('0');
    await expect(row(b, offline)).toHaveCount(0);
    await a.reload();
    await a.getByRole('button', { name: 'Open local database' }).click();
    await expect(a.locator('#pending')).toHaveText('1');
    await expect(row(a, offline).locator('input')).toHaveValue('cloud browser offline');
    await a.unroute(`${backend}/**`);
    await a.unroute(`${cloud}/**`);
    await connect(a);
    await expect(a.locator('#pending')).toHaveText('0');
    await expect.poll(() => source(`SELECT name FROM public.widgets WHERE id=${uuid(offline)}`)).toBe('cloud browser offline');
    await expect(row(b, offline).locator('input')).toHaveValue('cloud browser offline');
    await expect(row(a, offline).locator('input')).toHaveValue('cloud browser offline');
    await expect(b.locator('#pending')).toHaveText('0');
    await row(a, offline).getByRole('button', { name: 'Delete' }).click();
    await expect(a.locator('#pending')).toHaveText('0');
    await expect(row(b, offline)).toHaveCount(0);
    await expect.poll(() => source(`SELECT count(*) FROM public.widgets WHERE id=${uuid(offline)}`)).toBe('0');
    await writeFile(`${root}/.local/phase-four-cloud-result.json`, JSON.stringify({
      verifiedAt: new Date().toISOString(), status: 'passed',
      scope: 'Two independent Chromium contexts, real SDK queues, actual write API/Postgres and PowerSync Cloud',
      checks: ['initial-sync', 'cross-user-shared-stream', 'insert-convergence', 'update-convergence', 'delete-convergence',
        'offline-write-not-in-source', 'offline-reload-persistence', 'automatic-reconnect-upload', 'empty-pending-queues'],
      testRowsDeleted: true
    }, null, 2) + '\n', { mode: 0o600 });
  } finally {
    await Promise.all([contextA.close(), contextB.close()]);
    if (ids.size) source(`DELETE FROM public.widgets WHERE id IN (${[...ids].map(uuid).join(',')})`);
  }
});
