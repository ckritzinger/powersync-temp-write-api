import app from './app.js';
import config from './config.js';
import { getPersister } from './src/persistance/persister.js';
import { ConfigurationError } from './src/errors.js';
import { initializeVerifier } from './src/auth/verifier.js';
import { AuthConfigurationError } from './src/auth/verifier/index.js';

const PORT = process.env.PORT || config.port;

// Initialize dependencies inside the startup error boundary, before accepting any traffic.
try {
  void config.batchOnFatalError;
  await getPersister();
  await initializeVerifier();
} catch (error) {
  if (error instanceof ConfigurationError || error instanceof AuthConfigurationError) {
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
