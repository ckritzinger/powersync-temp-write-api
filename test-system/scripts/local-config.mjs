import { readFile, writeFile } from 'node:fs/promises';

export const local = new URL('../.local/', import.meta.url);
export function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error('Local env files must contain unquoted KEY=value lines.');
    return [match[1], match[2]];
  }));
}
export async function readEnv(name) {
  return parseEnv(await readFile(new URL(name, local), 'utf8'));
}
export async function createLocal(name, text) {
  try {
    await writeFile(new URL(name, local), text, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return false;
  }
}
