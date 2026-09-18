import type { CrudEntry } from '../types.js';
import type { AuthContext } from './types.js';

/**
 * Decides whether an authenticated caller may apply a transaction's writes at all.
 *
 * Called once per transaction, before any persistence, with the full ordered list of CRUD
 * operations it contains. `authorize` sees only what the client sent — table, op, id, op_data —
 * not the row currently in the database, because `Persister` has no read path. A check that needs
 * the existing row (e.g. "does this user already own this list?") has to happen inside that
 * database's persister, where a live connection/transaction actually exists.
 *
 * Return `false` to reject the transaction; it comes back to the client as a fatal error.
 */
export interface Authorizer {
  authorize(crud: CrudEntry[], auth: AuthContext): boolean | Promise<boolean>;
}

/**
 * INSERT YOUR OWN AUTHORIZATION CODE HERE.
 *
 * This does nothing. Every authenticated caller may write anything, to any table, to any row.
 * It exists so there is a real seam to replace (mirroring `verifier.ts` for authentication),
 * not because "allow everything" is a reasonable default to ship.
 */
export const authorizer: Authorizer = {
  async authorize(_crud, _auth) {
    console.error(
      'authorize(): no authorization is configured — every authenticated write is being allowed, ' +
        'no matter who sent it or what it touches. Replace backend/src/auth/authorizer.ts before ' +
        'this is anything but a demo. See docs/authorization.md.'
    );
    return true;
  }
};
