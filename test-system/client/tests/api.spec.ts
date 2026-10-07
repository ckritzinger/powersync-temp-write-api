import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
function source(sql: string) {
  return execFileSync('docker', ['compose', '--env-file', '.local/runtime.env', 'exec', '-T', 'postgres',
    'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-U', 'test_admin', '-d', 'test_system', '-c', sql],
    { cwd: root, encoding: 'utf8' }).trim();
}
function uuid(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Expected generated UUID.');
  return `'${id}'`;
}

test('browser connector CRUD and fatal rollback reach real source Postgres', async ({ page }) => {
  const runtime = await readFile(`${root}/.local/runtime.env`, 'utf8');
  const port = /^BACKEND_PORT=(\d+)$/m.exec(runtime)?.[1] ?? '6061';
  const ids = new Set<string>();
  await page.goto('/?source=postgres&profile=api-verification');
  await page.locator('#backend').fill(`http://127.0.0.1:${port}`);
  await page.locator('#cloud').fill('');
  await page.getByRole('button', { name: 'Open local database' }).click();
  await expect(page.locator('#pending')).toHaveText('0');
  async function upload() {
    await page.getByRole('button', { name: 'Upload once (API only)' }).click();
    await expect(page.locator('#error')).toBeEmpty();
    await expect(page.locator('#pending')).toHaveText('0');
  }
  async function actionIds() {
    const value = await page.locator('#last-action').innerText();
    const found = value.match(/[a-f0-9]{8}-[a-f0-9-]{27}/g) ?? [];
    for (const id of found) ids.add(id);
    return found;
  }
  try {
    await page.locator('#name').fill('browser API insert');
    await page.getByRole('button', { name: 'Add widget', exact: true }).click();
    await expect(page.locator('#pending')).toHaveText('1');
    const [id] = await actionIds();
    await upload();
    expect(source(`SELECT name FROM public.widgets WHERE id=${uuid(id)}`)).toBe('browser API insert');
    const row = page.locator(`#widgets li[data-id="${id}"]`);
    await row.locator('input').fill('browser API rename');
    await row.getByRole('button', { name: 'Rename' }).click();
    await expect(page.locator('#pending')).toHaveText('1');
    await upload();
    expect(source(`SELECT name FROM public.widgets WHERE id=${uuid(id)}`)).toBe('browser API rename');
    await row.getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('#pending')).toHaveText('1');
    await upload();
    expect(source(`SELECT count(*) FROM public.widgets WHERE id=${uuid(id)}`)).toBe('0');
    await page.getByRole('button', { name: 'Add two widgets atomically' }).click();
    await expect(page.locator('#pending')).toHaveText('2');
    const pair = await actionIds();
    await upload();
    expect(source(`SELECT count(*) FROM public.widgets WHERE id IN (${pair.map(uuid).join(',')})`)).toBe('2');
    await page.getByRole('button', { name: 'Queue valid + invalid transaction' }).click();
    await expect(page.locator('#pending')).toHaveText('2');
    const rollback = await actionIds();
    await upload();
    expect(source(`SELECT count(*) FROM public.widgets WHERE id IN (${rollback.map(uuid).join(',')})`)).toBe('0');
  } finally {
    if (ids.size) source(`DELETE FROM public.widgets WHERE id IN (${[...ids].map(uuid).join(',')})`);
  }
});
