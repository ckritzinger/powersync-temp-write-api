import express, { type Request, type Response } from 'express';
import { SignJWT, importJWK, type JWK, type KeyLike } from 'jose';
import config from '../../config.js';
import { generateKeyPair } from '../utils/generate-key.js';
const router = express.Router();

interface TokenResponse {
  token: string;
  powersync_url: string;
}

interface JwksResponse {
  keys: JWK[];
}

interface ImportedKeys {
  privateKey: { alg: string; kid: string; key: KeyLike } | null;
  publicKey: JWK | null;
}

const keys: ImportedKeys = {
  privateKey: null,
  publicKey: null
};

async function ensureKeys(): Promise<void> {
  // Keys are loaded already
  if (keys.privateKey) {
    return;
  }

  const { powersync } = config;
  const base64Keys: { private: string | undefined; public: string | undefined } = {
    private: powersync.privateKey,
    public: powersync.publicKey
  };

  if (!base64Keys.private) {
    // Key is not present in ENV
    console.warn(
      `Private key has not been supplied in process.env.POWERSYNC_PRIVATE_KEY. A temporary key pair will be generated.`
    );
    const generated = await generateKeyPair();
    base64Keys.private = generated.privateBase64;
    base64Keys.public = generated.publicBase64;
  }

  const decodedPrivateKey = Buffer.from(base64Keys.private, 'base64');
  const powerSyncPrivateKey = JSON.parse(new TextDecoder().decode(decodedPrivateKey));
  keys.privateKey = {
    alg: powerSyncPrivateKey.alg,
    kid: powerSyncPrivateKey.kid,
    key: (await importJWK(powerSyncPrivateKey)) as KeyLike
  };

  const decodedPublicKey = Buffer.from(base64Keys.public!, 'base64');
  keys.publicKey = JSON.parse(new TextDecoder().decode(decodedPublicKey));
}

/**
 * Get the JWT token that PowerSync will use to authenticate the user
 * Provide an optional user_id in the url params query string to use as the subject of the token
 * If no id is provided, "UserID" is used as the subject
 */
router.get(
  '/token',
  async (req: Request<{}, TokenResponse, never, { user_id?: string }>, res: Response<TokenResponse>) => {
    const user_id = req.query.user_id ?? 'UserID ';

    const token = await generateToken(user_id, {});
    res.send({
      token,
      powersync_url: config.powersync.url!
    });
  }
);

/**
 * This is the JWKS endpoint PowerSync uses to handle authentication
 */
router.get('/keys', async (_req: Request, res: Response<JwksResponse>) => {
  await ensureKeys();
  res.send({
    keys: [{ ...keys.publicKey! }]
  });
});

/**
 * The public JWK this backend signs tokens with, used by the demo PowerSyncVerifier to verify write requests.
 */
export async function getPublicJwk(): Promise<JWK> {
  await ensureKeys();
  return keys.publicKey!;
}

export { router as authRouter };

const generateToken = async (user_id: string, payload: Record<string, unknown>): Promise<string> => {
  await ensureKeys();
  const powerSyncKey = keys.privateKey!;
  const token = await new SignJWT(payload)
    .setProtectedHeader({
      alg: powerSyncKey.alg,
      kid: powerSyncKey.kid
    })
    .setSubject(user_id)
    .setIssuedAt()
    .setIssuer(config.powersync.jwtIssuer!)
    .setAudience(config.powersync.url!)
    // Long-lived tokens should only be used for development purposes.
    // Powersync won't authenticate tokens that expire on or after 60 minutes.
    // See: https://docs.powersync.com/installation/authentication-setup/custom
    .setExpirationTime('60m')
    .sign(powerSyncKey.key);

  return token;
};
