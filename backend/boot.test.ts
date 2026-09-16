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
const tsx = path.join(backendDir, 'node_modules', '.bin', 'tsx');

interface Boot {
  code: number | null;
  output: string;
  /** True if it was still running when we gave up — a refusal to start should never be. */
  stillRunning: boolean;
}

const bootWith = (env: Record<string, string>): Promise<Boot> =>
  new Promise((resolve) => {
    const child = spawn(tsx, ['index.ts'], {
      cwd: backendDir,
      // A port nothing else uses, so this cannot bind over a real backend someone is running.
      env: { ...process.env, PORT: '6098', ...env }
    });

    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));

    // Without this, a regression that DOES start the server leaves the promise pending until the
    // suite times out, and leaks a listening process. Kill it and report that it was still up.
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, output, stillRunning: true });
    }, 20000);

    child.on('close', (code) => {
      clearTimeout(deadline);
      resolve({ code, output, stillRunning: false });
    });
  });

describe('refusing to start on bad configuration', () => {
  it('explains that no connection string is configured, and exits non-zero', async () => {
    const { code, output, stillRunning } = await bootWith({
      DATABASE_URI: '',
      DATABASE_TYPE: 'postgres'
    });

    expect(stillRunning).toBe(false);
    expect(code).not.toBe(0);
    expect(output).toContain('DATABASE_URI');
    // The message must name the fix, not just the fault.
    expect(output.toLowerCase()).toContain('.env');
    // A raw stack trace is not a readable message. Assert on the shape of one rather than on any
    // particular frame, so renaming a function cannot quietly make this vacuous.
    expect(output).not.toMatch(/^\s+at .+/m);
  }, 40000);

  it('names the supported databases when the type is not one of them', async () => {
    const { code, output, stillRunning } = await bootWith({
      DATABASE_URI: 'postgres://u:p@h:5432/d',
      DATABASE_TYPE: 'cassandra'
    });

    expect(stillRunning).toBe(false);
    expect(code).not.toBe(0);
    expect(output).toContain('cassandra');
    for (const supported of ['postgres', 'mongodb', 'mysql', 'mssql']) {
      expect(output).toContain(supported);
    }
    expect(output).not.toMatch(/^\s+at .+/m);
  }, 40000);
});
