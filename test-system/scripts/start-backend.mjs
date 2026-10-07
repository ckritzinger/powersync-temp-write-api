import { prepareBackend } from './prepare-backend.mjs';
import { readEnv } from './local-config.mjs';
import { sourceType } from './source-config.mjs';
import { compose } from './phase-three.mjs';
await prepareBackend();
const source = sourceType(await readEnv('runtime.env'));
compose(['up', '-d', '--wait', source], { stdio: 'inherit' });
compose(['up', '-d', '--build', '--force-recreate', '--wait', 'backend', 'auth'], { stdio: 'inherit' });
