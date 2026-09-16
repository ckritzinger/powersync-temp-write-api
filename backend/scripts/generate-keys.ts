import { generateKeyPair } from '../src/utils/generate-key.js';

/**
 * Prints a fresh signing keypair in the form .env expects.
 *
 * The pair committed to .env is public and known to everyone who has cloned this repo. Anything
 * beyond a demo needs its own.
 */
const { privateBase64, publicBase64 } = await generateKeyPair();

console.log(`POWERSYNC_PRIVATE_KEY=${privateBase64}`);
console.log(`POWERSYNC_PUBLIC_KEY=${publicBase64}`);
