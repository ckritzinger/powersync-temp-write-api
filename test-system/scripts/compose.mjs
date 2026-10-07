import { compose } from './phase-three.mjs';
compose(process.argv.slice(2), { stdio: 'inherit' });
