import { test, expect, type Page } from '@playwright/test';

async function open(page: Page, profile = 'a') {
  await page.goto(`/?source=postgres&profile=${profile}`);
  await page.locator('#backend').fill('http://127.0.0.1:6061');
  await page.locator('#cloud').fill('');
  await page.getByRole('button', { name: 'Open local database' }).click();
  await expect(page.locator('#pending')).toHaveText('0');
  await expect(page.locator('#error')).toBeEmpty();
}
async function add(page: Page, name: string) {
  await page.locator('#name').fill(name);
  await page.getByRole('button', { name: 'Add widget', exact: true }).click();
  await expect.poll(() => page.locator('#widgets input').evaluateAll(inputs =>
    inputs.map(input => (input as HTMLInputElement).value))).toContain(name);
}

test('real SQLite CRUD survives offline reload and profiles stay isolated', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await open(page);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await add(page, '<script>unsafe text</script>');
  await expect(page.locator('#pending')).toHaveText('1');
  // Keep the local app server reachable while auth/write/sync services are offline.
  await page.route('http://127.0.0.1:6061/**', route => route.abort());
  await page.reload();
  await page.getByRole('button', { name: 'Open local database' }).click();
  await expect(page.locator('#pending')).toHaveText('1');
  await expect(page.locator('#widgets input')).toHaveValue('<script>unsafe text</script>');
  await page.locator('#widgets input').fill('renamed offline');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.locator('#pending')).toHaveText('2');
  const other = await context.newPage();
  await open(other, 'b');
  await expect(other.locator('#widgets li')).toHaveCount(0);
  await expect(page.locator('#widgets li')).toHaveCount(1);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('#pending')).toHaveText('3');
  await expect(page.locator('#widgets li')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('client-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath('client-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('existing connector preserves atomic batches and completes backend fatal results', async ({ page }) => {
  const batches: any[] = [];
  await page.route('http://127.0.0.1:6061/api/auth/token?*', route => route.fulfill({ json: { token: 'fixture-token' } }));
  await page.route('http://127.0.0.1:6061/api/data', async route => {
    const batch = route.request().postDataJSON();
    batches.push(batch);
    const invalid = batch.transactions[0].crud.some((op: any) => op.op_data?.name == null);
    await route.fulfill({ json: { results: [invalid ? {
      status: 'fatal_error', requires_client_handling: false,
      failed_operation: { error_code: 'NOT_NULL_VIOLATION', operation_index: 1 }
    } : { status: 'success' }] } });
  });
  await open(page);
  await page.getByRole('button', { name: 'Add two widgets atomically' }).click();
  await expect(page.locator('#pending')).toHaveText('2');
  await page.getByRole('button', { name: 'Upload once (API only)' }).click();
  await expect(page.locator('#pending')).toHaveText('0');
  expect(batches[0].transactions).toHaveLength(1);
  expect(batches[0].transactions[0].crud).toHaveLength(2);
  await page.getByRole('button', { name: 'Queue valid + invalid transaction' }).click();
  await expect(page.locator('#pending')).toHaveText('2');
  await page.getByRole('button', { name: 'Upload once (API only)' }).click();
  await expect(page.locator('#pending')).toHaveText('0');
  expect(batches[1].transactions[0].crud).toHaveLength(2);
  // SQLite/SDK omits the NULL field from INSERT op_data; source still defaults it to NULL.
  expect(batches[1].transactions[0].crud[1].op_data.name == null).toBe(true);
  await expect(page.locator('#error')).toBeEmpty();
});

test('retryable and auth failures retain queued work; fresh credentials recover', async ({ page }) => {
  let authCalls = 0;
  let attempt = 0;
  let user = '';
  await page.route('http://127.0.0.1:6061/api/auth/token?*', route => {
    authCalls++;
    user = new URL(route.request().url()).searchParams.get('user_id')!;
    return route.fulfill({ json: { token: `fixture-${authCalls}` } });
  });
  await page.route('http://127.0.0.1:6061/api/data', route => {
    attempt++;
    if (attempt === 1) return route.fulfill({ json: { results: [{ status: 'retryable_error', message: 'temporary fixture failure' }] } });
    if (attempt === 2) return route.fulfill({ status: 401, json: { message: 'expired fixture token' } });
    return route.fulfill({ json: { results: [{ status: 'success' }] } });
  });
  await page.goto('/?source=postgres&profile=retry');
  await page.locator('#user').fill('manual & encoded user');
  await page.locator('#backend').fill('http://127.0.0.1:6061');
  await page.locator('#cloud').fill('');
  await page.getByRole('button', { name: 'Open local database' }).click();
  await expect(page.locator('#pending')).toHaveText('0');
  await add(page, 'queued retry');
  await page.getByRole('button', { name: 'Upload once (API only)' }).click();
  await expect(page.locator('#error')).toHaveText('temporary fixture failure');
  await expect(page.locator('#pending')).toHaveText('1');
  await page.getByRole('button', { name: 'Upload once (API only)' }).click();
  await expect(page.locator('#error')).toContainText('Authentication failed (401)');
  await expect(page.locator('#pending')).toHaveText('1');
  await page.getByRole('button', { name: 'Upload once (API only)' }).click();
  await expect(page.locator('#pending')).toHaveText('0');
  expect(authCalls).toBe(2);
  expect(user).toBe('manual & encoded user');
  await page.reload();
  await page.locator('#user').fill('another identity');
  await page.getByRole('button', { name: 'Open local database' }).click();
  await expect(page.locator('#error')).toContainText('already belongs to another demo identity');
});

test('not-attempted and client-directed fixture results retain the real queue', async ({ page }) => {
  let attempt = 0;
  await page.route('http://127.0.0.1:6061/api/auth/token?*', route => route.fulfill({ json: { token: 'fixture-token' } }));
  await page.route('http://127.0.0.1:6061/api/data', route => {
    attempt++;
    return route.fulfill({ json: { results: [attempt === 1 ? { status: 'not_attempted' } : {
      status: 'fatal_error', requires_client_handling: attempt === 2,
      failed_operation: { error_code: 'NOT_NULL_VIOLATION', operation_index: 1 }
    }] } });
  });
  await open(page);
  await page.getByRole('button', { name: 'Add two widgets atomically' }).click();
  await expect(page.locator('#pending')).toHaveText('2');
  await page.getByRole('button', { name: 'Upload once (API only)' }).click();
  await expect(page.locator('#upload')).toContainText('Upload attempt returned');
  await expect(page.locator('#pending')).toHaveText('2');
  await page.getByRole('button', { name: 'Upload once (API only)' }).click();
  await expect(page.locator('#error')).toHaveText('Fatal transaction retained for client handling');
  await expect(page.locator('#pending')).toHaveText('2');
  await page.getByRole('button', { name: 'Upload once (API only)' }).click();
  await expect(page.locator('#pending')).toHaveText('0');
  await expect(page.locator('#upload')).toContainText('Rejected by backend');
  await expect(page.locator('#rejection-count')).toHaveText('1');
  await expect(page.locator('#rejections')).toContainText('NOT_NULL_VIOLATION');
  // A later rejected edit of the same row is a distinct transaction, not a duplicate notice.
  await page.locator('#widgets input').first().fill('another rejected edit');
  await page.locator('#widgets li').first().getByRole('button', { name: 'Rename' }).click();
  await page.getByRole('button', { name: 'Upload once (API only)' }).click();
  await expect(page.locator('#pending')).toHaveText('0');
  await expect(page.locator('#rejection-count')).toHaveText('2');
  await page.reload();
  await page.getByRole('button', { name: 'Open local database' }).click();
  await expect(page.locator('#rejection-count')).toHaveText('2');
});

test('explicit discard intent survives a failed upload and reload without completing later work', async ({ page }) => {
  let failNext = false;
  await page.route('http://127.0.0.1:6061/api/auth/token?*', route => route.fulfill({ json: { token: 'fixture-token' } }));
  await page.route('http://127.0.0.1:6061/api/data', route => {
    if (failNext) { failNext = false; return route.abort('failed'); }
    const invalid = route.request().postDataJSON().transactions[0].crud.some((op: any) => op.op_data?.name == null);
    return route.fulfill({ json: { results: [invalid ? {
      status: 'fatal_error', requires_client_handling: true,
      failed_operation: { error_code: 'NOT_NULL_VIOLATION', operation_index: 1 }
    } : { status: 'success' }] } });
  });
  await open(page, 'discard-intent');
  await page.locator('#rollback').click();
  await add(page, 'later work');
  await expect(page.locator('#pending')).toHaveText('3');
  await page.locator('#upload-once').click();
  await expect(page.locator('#decisions li')).toHaveCount(1);
  await expect(page.locator('#pending')).toHaveText('3');
  failNext = true;
  await page.getByRole('button', { name: 'Discard transaction' }).click();
  await expect.poll(() => failNext).toBe(false);
  await expect(page.locator('#upload-once')).toBeEnabled();
  await expect(page.locator('#upload')).toContainText('Failed');
  await expect(page.locator('#pending')).toHaveText('3');
  await expect(page.locator('#decisions')).toContainText('discard-requested');
  await page.reload();
  await page.getByRole('button', { name: 'Open local database' }).click();
  await expect(page.locator('#pending')).toHaveText('3');
  await expect(page.locator('#decisions')).toContainText('discard-requested');
  await page.locator('#upload-once').click();
  await expect(page.locator('#pending')).toHaveText('1');
  await expect(page.locator('#decisions')).toContainText('discarded');
  await expect(page.locator('#decisions li')).toHaveCount(1);
  await page.locator('#upload-once').click();
  await expect(page.locator('#pending')).toHaveText('0');
});

for (const source of ['mongodb', 'mysql', 'mssql']) test(`Postgres and ${source} with the same profile preserve separate pending queues`, async ({ page, context }) => {
  await open(page, 'source-isolation');
  await add(page, 'postgres pending');
  await expect(page.locator('#pending')).toHaveText('1');
  const mongo = await context.newPage();
  await mongo.goto(`/?source=${source}&profile=source-isolation`);
  await mongo.locator('#backend').fill('http://127.0.0.1:6061');
  await mongo.locator('#cloud').fill('');
  await mongo.locator('#open').click();
  await expect(mongo.locator('#pending')).toHaveText('0');
  await expect(mongo.locator('#widgets li')).toHaveCount(0);
  await add(mongo, `${source} pending`);
  await expect(mongo.locator('#pending')).toHaveText('1');
  await page.reload(); await page.locator('#open').click();
  await expect(page.locator('#pending')).toHaveText('1');
  await expect(page.locator('#widgets input')).toHaveValue('postgres pending');
  await mongo.reload(); await mongo.locator('#open').click();
  await expect(mongo.locator('#pending')).toHaveText('1');
  await expect(mongo.locator('#widgets input')).toHaveValue(`${source} pending`);
});
