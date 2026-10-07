import { column, PowerSyncDatabase, Schema, Table } from '@powersync/web';
import type { AbstractPowerSyncDatabase, PowerSyncBackendConnector, CrudTransaction } from '@powersync/web';
import { configureClient } from './config';
import './style.css';

declare const __TEST_SYSTEM_DEFAULTS__: { backendUrl: string; cloudUrl: string; source: string };
const schema = new Schema({ widgets: new Table({ name: column.text }) });
type Widget = { id: string; name: string | null };
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const text = (id: string, value: string) => { document.getElementById(id)!.textContent = value; };
const scopedProfile = (profile: string) => input('source').value === 'postgres' ? profile : `${input('source').value}:${profile}`;
const profileKey = (profile: string) => `powersync-test-system:${scopedProfile(profile)}:settings`;
const userKey = (profile: string) => `powersync-test-system:${scopedProfile(profile)}:user`;
let database: PowerSyncDatabase | undefined;
let connector: PowerSyncBackendConnector | undefined;
let wantsConnection = false;
let busy = false;
let refreshing = false;
let lastRows = '';
let lastUploadError = '';
type Rejection = { key: string; ids: string[]; code: string; at: string };
let rejections: Rejection[] = [];
let rejectionStorageKey = '';
type Decision = Rejection & { choice: 'pending' | 'retained' | 'discard-requested' | 'discarded' };
let decisions: Decision[] = [];
let decisionStorageKey = '';

function saveDecisions(next: Decision[]) {
  localStorage.setItem(decisionStorageKey, JSON.stringify(next));
  decisions = next;
  renderDecisions();
}

function renderDecisions() {
  const list = document.getElementById('decisions')!;
  list.replaceChildren();
  for (const decision of decisions) {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${decision.code} · ${decision.ids.join(', ')} · ${decision.choice}`;
    item.append(label);
    if (decision.choice === 'pending' || decision.choice === 'retained') {
      for (const choice of ['retained', 'discard-requested'] as const) {
        const control = document.createElement('button');
        control.textContent = choice === 'retained' ? 'Keep queued' : 'Discard transaction';
        control.disabled = busy;
        control.addEventListener('click', () => { void run(async () => {
          saveDecisions(decisions.map(entry => entry.key === decision.key ? { ...entry, choice } : entry));
          if (choice === 'discard-requested' && !wantsConnection) await connector!.uploadData(database!);
        }); });
        item.append(control);
      }
    }
    list.append(item);
  }
}

function renderRejections() {
  const list = document.getElementById('rejections')!;
  list.replaceChildren();
  for (const rejection of rejections) {
    const item = document.createElement('li');
    item.textContent = `${rejection.code} · ${rejection.ids.join(', ')} · ${rejection.at}`;
    list.append(item);
  }
  text('rejection-count', String(rejections.length));
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted token]')
    .slice(0, 350);
}

function settingsForProfile() {
  const profile = input('profile').value;
  const stored = JSON.parse(localStorage.getItem(profileKey(profile)) ?? 'null');
  input('user').value = localStorage.getItem(userKey(profile)) ?? `manual-${profile}`;
  input('backend').value = stored?.backendUrl ?? __TEST_SYSTEM_DEFAULTS__.backendUrl;
  input('cloud').value = stored?.cloudUrl ?? __TEST_SYSTEM_DEFAULTS__.cloudUrl;
  input('batch-size').value = String(stored?.batchSize ?? 1);
}

input('profile').value = new URL(location.href).searchParams.get('profile') ?? 'a';
input('source').value = new URL(location.href).searchParams.get('source') ?? __TEST_SYSTEM_DEFAULTS__.source;
settingsForProfile();
input('profile').addEventListener('change', settingsForProfile);
input('source').addEventListener('change', settingsForProfile);

function controls() {
  const ready = Boolean(database);
  for (const id of ['name', 'add-button', 'pair', 'invalid', 'rollback']) {
    (document.getElementById(id) as HTMLButtonElement | HTMLInputElement).disabled = !ready || busy;
  }
  button('connect').disabled = !ready || busy || wantsConnection || !input('cloud').value;
  button('disconnect').disabled = !ready || busy || !wantsConnection;
  button('upload-once').disabled = !ready || busy || wantsConnection;
  for (const element of document.querySelectorAll<HTMLButtonElement>('#widgets button')) element.disabled = busy;
  for (const element of document.querySelectorAll<HTMLButtonElement>('#decisions button')) element.disabled = busy;
}

async function run(action: () => Promise<void>) {
  if (busy) return;
  busy = true;
  text('error', '');
  controls();
  try { await action(); }
  catch (error) { text('error', safeError(error)); }
  finally { busy = false; controls(); await refresh(); }
}

function urlSetting(value: string, cloud = false) {
  if (!value && cloud) return '';
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use a base URL without credentials, path, query or fragment.');
  }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(localHttp && !cloud)) throw new Error('Use HTTPS, or loopback HTTP for the local backend.');
  if (cloud && url.hostname === 'test-system.invalid') throw new Error('Use the actual Cloud instance URL.');
  return url.origin;
}

document.getElementById('setup')!.addEventListener('submit', (event) => {
  event.preventDefault();
  void run(async () => {
    if (database) return;
    const profile = input('profile').value.trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(profile)) throw new Error('Profile must be 1–40 letters, digits, underscores or hyphens.');
    const user = input('user').value.trim();
    if (!user) throw new Error('Enter a demo user ID.');
    const priorUser = localStorage.getItem(userKey(profile));
    if (priorUser && priorUser !== user) throw new Error('This profile already belongs to another demo identity. Choose a new profile to preserve its queued writes.');
    const backendUrl = urlSetting(input('backend').value.trim());
    const cloudUrl = urlSetting(input('cloud').value.trim(), true);
    const source = input('source').value;
    if (!['postgres', 'mongodb', 'mysql', 'mssql'].includes(source)) throw new Error('Select Postgres, MongoDB, MySQL or SQL Server.');
    const batchSize = Number(input('batch-size').value);
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) throw new Error('Transactions per upload must be an integer from 1 to 50.');
    configureClient({ backendUrl, cloudUrl, userStorageKey: userKey(profile), source });
    localStorage.setItem(userKey(profile), user);
    localStorage.setItem(profileKey(profile), JSON.stringify({ backendUrl, cloudUrl, batchSize }));
    rejectionStorageKey = `powersync-test-system:${scopedProfile(profile)}:rejections`;
    decisionStorageKey = `powersync-test-system:${scopedProfile(profile)}:decisions`;
    decisions = JSON.parse(localStorage.getItem(decisionStorageKey) ?? '[]');
    renderDecisions();
    rejections = JSON.parse(localStorage.getItem(rejectionStorageKey) ?? '[]');
    renderRejections();
    const { PowersyncConnector } = await import('../../.generated/connector/PowersyncConnector');
    class ObservedConnector extends PowersyncConnector {
      protected override getBatchingConfig() {
        return { ...super.getBatchingConfig(), maxTransactions: batchSize };
      }
      private rejectedThisAttempt = false;
      protected override async onFatalTransaction(transaction: CrudTransaction, result: { failedOperation: { error_code: string } }): Promise<'retain' | 'complete'> {
        const key = JSON.stringify(transaction.crud.map(op => op.clientId));
        let decision = decisions.find(entry => entry.key === key);
        if (!decision) {
          decision = { key, ids: [...new Set(transaction.crud.map(op => op.id))],
            code: safeError(result.failedOperation.error_code), at: new Date().toISOString(), choice: 'pending' };
          saveDecisions([...decisions, decision]);
        }
        if (decision.choice === 'discard-requested' || decision.choice === 'discarded') {
          // A persisted explicit choice allows the existing connector to complete only this
          // failed transaction. Keeping the choice also covers reload before completion.
          saveDecisions(decisions.map(entry => entry.key === key ? { ...entry, choice: 'discarded' } : entry));
          this.rejectedThisAttempt = true;
          return 'complete';
        }
        return 'retain';
      }
      override async onBackendFatalTransaction(transaction: CrudTransaction, result: { failedOperation: { error_code: string } }) {
        this.rejectedThisAttempt = true;
        const ids = [...new Set(transaction.crud.map(op => op.id))];
        const key = JSON.stringify(transaction.crud.map(op => op.clientId));
        if (!rejections.some(entry => entry.key === key)) {
          const next = [...rejections, { key, ids, code: safeError(result.failedOperation.error_code), at: new Date().toISOString() }];
          // Persist before completing: a storage failure leaves the transaction queued for retry.
          localStorage.setItem(rejectionStorageKey, JSON.stringify(next));
          rejections = next;
          renderRejections();
        }
      }
      override async uploadData(db: AbstractPowerSyncDatabase) {
        this.rejectedThisAttempt = false;
        try {
          await super.uploadData(db);
          lastUploadError = '';
          text('upload', this.rejectedThisAttempt
            ? `Rejected by backend at ${new Date().toLocaleTimeString()}; recorded below`
            : `Upload attempt returned at ${new Date().toLocaleTimeString()} (inspect queue and source)`);
        } catch (error) {
          lastUploadError = safeError(error);
          text('upload', `Failed at ${new Date().toLocaleTimeString()}; pending work retained`);
          throw error;
        } finally { void refresh(); }
      }
    }
    const filename = `powersync-test-system-${source === 'postgres' ? '' : source + '-'}${profile}.sqlite`;
    const opened = new PowerSyncDatabase({ schema,
      database: { dbFilename: filename, enableMultiTabs: true }
    });
    try { await opened.init(); }
    catch (error) { await opened.close(); throw error; }
    database = opened;
    connector = new ObservedConnector();
    database.registerListener({ statusChanged: () => { void refresh(); } });
    input('backend').value = backendUrl;
    input('cloud').value = cloudUrl;
    for (const id of ['source', 'profile', 'user', 'backend', 'cloud', 'batch-size', 'open']) {
      (document.getElementById(id) as HTMLInputElement).disabled = true;
    }
    text('database-label', `Open: ${filename} · ${source} · user ${user}`);
  });
});

button('connect').addEventListener('click', () => { void run(async () => {
  wantsConnection = true;
  try { await database!.connect(connector!); }
  catch (error) { wantsConnection = false; throw error; }
}); });
button('disconnect').addEventListener('click', () => { void run(async () => {
  await database!.disconnect();
  wantsConnection = false;
}); });
button('upload-once').addEventListener('click', () => { void run(async () => {
  await connector!.uploadData(database!);
}); });

document.getElementById('add')!.addEventListener('submit', (event) => {
  event.preventDefault();
  void run(async () => {
    const name = input('name').value.trim();
    if (!name) throw new Error('Enter a widget name.');
    const id = crypto.randomUUID();
    await database!.execute('INSERT INTO widgets (id, name) VALUES (?, ?)', [id, name]);
    text('last-action', `Queued insert: ${id}`);
    input('name').value = '';
  });
});

async function transactionTest(mode: 'pair' | 'invalid' | 'rollback') {
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  await database!.writeTransaction(async (tx) => {
    if (mode !== 'invalid') await tx.execute('INSERT INTO widgets (id, name) VALUES (?, ?)', [ids[0], `transaction ${mode}`]);
    await tx.execute('INSERT INTO widgets (id, name) VALUES (?, ?)', [ids[1], mode === 'pair' ? 'transaction second widget' : null]);
  });
  text('last-action', `Queued ${mode}: ${(mode === 'invalid' ? [ids[1]] : ids).join(', ')}`);
}
for (const mode of ['pair', 'invalid', 'rollback'] as const) {
  button(mode).addEventListener('click', () => { void run(() => transactionTest(mode)); });
}

function renderWidgets(rows: Widget[]) {
  const list = document.getElementById('widgets')!;
  list.replaceChildren();
  text('empty', rows.length ? '' : 'No widgets in this local database.');
  for (const row of rows) {
    const item = document.createElement('li');
    item.dataset.id = row.id;
    const info = document.createElement('div');
    info.className = 'widget-info';
    const name = document.createElement('input');
    name.value = row.name ?? '';
    name.placeholder = row.name === null ? 'NULL name (invalid source write)' : '';
    name.setAttribute('aria-label', `Name for ${row.id}`);
    const id = document.createElement('code');
    id.textContent = row.id;
    info.append(name, id);
    const rename = document.createElement('button');
    rename.textContent = 'Rename';
    rename.addEventListener('click', () => { void run(async () => {
      if (!name.value.trim()) throw new Error('Enter a nonempty widget name.');
      await database!.execute('UPDATE widgets SET name = ? WHERE id = ?', [name.value.trim(), row.id]);
      text('last-action', `Queued rename: ${row.id}`);
    }); });
    const remove = document.createElement('button');
    remove.textContent = 'Delete';
    remove.addEventListener('click', () => { void run(async () => {
      await database!.execute('DELETE FROM widgets WHERE id = ?', [row.id]);
      text('last-action', `Queued delete: ${row.id}`);
    }); });
    item.append(info, rename, remove);
    list.append(item);
  }
  controls();
}

async function refresh() {
  if (!database || refreshing) return;
  refreshing = true;
  try {
    const [rows, queue] = await Promise.all([
      database.getAll<Widget>('SELECT id, name FROM widgets ORDER BY id'),
      database.getUploadQueueStats()
    ]);
    text('pending', String(queue.count));
    const status = database.currentStatus;
    text('connection', status.connected ? 'Connected' : status.connecting ? 'Connecting' : wantsConnection ? 'Waiting / retrying' : 'Disconnected');
    text('initial-sync', status.hasSynced ? `Completed${status.lastSyncedAt ? ` · ${status.lastSyncedAt.toLocaleTimeString()}` : ''}` : 'Not completed');
    text('sync-error', lastUploadError || (status.uploadError ? safeError(status.uploadError) : status.downloadError ? safeError(status.downloadError) : 'None'));
    const next = JSON.stringify(rows);
    if (next !== lastRows) { lastRows = next; renderWidgets(rows); }
  } catch (error) { text('error', safeError(error)); }
  finally { refreshing = false; }
}
setInterval(() => { void refresh(); }, 500);
