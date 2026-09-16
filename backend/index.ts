import app from './app.js';
import config from './config.js';
import { getPersister } from './src/persistance/persister.js';

const PORT = process.env.PORT || config.port;

// Resolving the persister is lazy so that importing the app needs no database. Do it here, before
// listening, so a misconfigured database still fails at boot rather than on the first write.
await getPersister();

app.listen(PORT, () => {
  console.log(`Server is running @ http://127.0.0.1:${PORT}`);
});
