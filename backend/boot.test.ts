import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Seam: the backend process itself.
 *
 * Seam 1 (HTTP against the assembled application) cannot observe this, because the behaviour under
 * test is a refusal to reach the point where there is anything to make a request to. An adopter
 * pointing this at their own database is the most likely person to misconfigure it, and the
 * failure has to read as configuration rather than as a bug in their code.
 */

const backendDir = path.dirname(fileURLToPath(import.meta.url));

const bootWith = (env: Record<string, string>): Promise<{ code: number | null; output: string }> =>
  new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'index.ts'], {
      cwd: backendDir,
      // A port nothing else uses, so a regression that DOES start the server cannot collide with
      // a real backend and look like a pass.
      env: { ...process.env, PORT: '6098', ...env }
    });

    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => resolve({ code, output }));
  });

describe('refusing to start on bad configuration', () => {
  it('explains that no connection string is configured, and exits non-zero', async () => {
    const { code, output } = await bootWith({ DATABASE_URI: '', DATABASE_TYPE: 'postgres' });

    expect(code).not.toBe(0);
    expect(output).toContain('DATABASE_URI');
    // The message must name the fix, not just the fault.
    expect(output.toLowerCase()).toContain('.env');
    // A raw stack trace is not a readable message.
    expect(output).not.toContain('at createConfiguredPersister');
    expect(output).not.toContain('Server is running');
  }, 60000);

  it('names the supported databases when the type is not one of them', async () => {
    const { code, output } = await bootWith({
      DATABASE_URI: 'postgres://u:p@h:5432/d',
      DATABASE_TYPE: 'cassandra'
    });

    expect(code).not.toBe(0);
    expect(output).toContain('cassandra');
    for (const supported of ['postgres', 'mongodb', 'mysql', 'mssql']) {
      expect(output).toContain(supported);
    }
    expect(output).not.toContain('Server is running');
  }, 60000);
});
