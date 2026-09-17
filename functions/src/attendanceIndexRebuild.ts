/**
 * Protected HTTPS v2 endpoint wiring for `attendanceIndexRebuild`. The
 * actual paginated rebuild logic lives in `attendanceIndexRebuildRunner.ts`
 * (kept import-clean of `firebase-functions/v2/https` so it stays testable
 * under Jest — see that file's header comment).
 *
 * Protection model: same as `multiTeamMigration` in `httpMigration.ts` —
 * deployed as publicly invokable but every request must present the
 * `MIGRATION_TOKEN` secret via an `Authorization: Bearer <token>` (or
 * `X-Migration-Token`) header, checked with a constant-time comparison.
 */
import { getFirestore } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import { onRequest } from 'firebase-functions/v2/https';
import { extractBearerToken, tokensMatch } from './auth';
import { FUNCTIONS_REGION } from './config';
import { migrationToken } from './httpMigration';
import { runAttendanceIndexRebuildPage } from './attendanceIndexRebuildRunner';

/**
 * `attendanceIndexRebuild` HTTP endpoint.
 *
 * Request body (JSON):
 * ```jsonc
 * {
 *   "mode": "dryRun" | "apply",
 *   "pageSize": 20,      // optional, default 100, max 500 (teams per page)
 *   "cursor": "abc123"   // optional team id to resume after; omit to start over
 * }
 * ```
 */
export const attendanceIndexRebuild = onRequest(
  {
    region: FUNCTIONS_REGION,
    // Reuses the same MIGRATION_TOKEN secret as multiTeamMigration; see
    // httpMigration.ts for how to set/rotate it.
    secrets: [migrationToken],
    invoker: 'public',
    cors: false,
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed', message: 'This endpoint only accepts POST.' });
      return;
    }

    const providedToken =
      extractBearerToken(req.get('authorization')) ?? (req.get('x-migration-token') || null);
    if (!tokensMatch(providedToken, migrationToken.value())) {
      logger.warn('attendanceIndexRebuild: rejected request (missing/invalid token)', {
        hasHeader: providedToken !== null,
      });
      res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid migration token.' });
      return;
    }

    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const mode = body.mode;
    if (mode !== 'dryRun' && mode !== 'apply') {
      res.status(400).json({ error: 'invalid_mode', message: 'body.mode must be one of "dryRun", "apply".' });
      return;
    }
    const pageSize = typeof body.pageSize === 'number' ? body.pageSize : undefined;
    const cursor = typeof body.cursor === 'string' && body.cursor.length > 0 ? body.cursor : null;

    try {
      const result = await runAttendanceIndexRebuildPage(getFirestore(), { mode, pageSize, cursor });
      res.status(200).json(result);
    } catch (err) {
      logger.error('attendanceIndexRebuild: unhandled error while processing page', err);
      res.status(500).json({
        error: 'internal_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
);
