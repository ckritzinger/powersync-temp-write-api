/**
 * Verifies a bearer token and returns a normalized identity.
 *
 * Provider differences (key source, `aud` vs `azp`, claim names, RS256/HS256)
 * stay inside each implementation. Nothing downstream couples to a
 * provider's claim shape.
 */
export interface TokenVerifier {
  /** Resolves the verified identity, or throws if the token is invalid. */
  verify(token: string): Promise<AuthContext>;
}

export interface AuthContext {
  /** The verified subject (user id) from the token, used instead of any identity from the request body. */
  sub: string;
  claims: Record<string, unknown>;
}

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth after successful verification. */
      auth?: AuthContext;
    }
  }
}
