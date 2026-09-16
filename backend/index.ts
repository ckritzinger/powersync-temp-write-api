import app from './app.js';
import config from './config.js';
import { getPersister } from './src/persistance/persister.js';
import { ConfigurationError } from './src/errors.js';

const PORT = process.env.PORT || config.port;

// Resolving the persister is lazy so that importing the app needs no database. Do it here, before
// listening, so a misconfigured database still fails at boot rather than on the first write.
try {
  await getPersister();
} catch (error) {
  if (error instanceof ConfigurationError) {
    // An adopter pointing this at their own database is the most likely person to land here, and
    // a stack trace reads like a bug in their code rather than a setting they have not filled in.
    console.error(`\nCannot start.\n\n${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

app.listen(PORT, () => {
  console.log(`Server is running @ http://127.0.0.1:${PORT}`);
});
