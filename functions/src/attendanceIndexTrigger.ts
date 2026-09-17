/**
 * Firestore trigger that keeps `teams/{teamId}/attendanceIndex/{memberId}`
 * in sync with writes to `sessions/{sessionId}/attendance/{memberId}`, so
 * the Dart client can read a player's whole attendance history through one
 * document per player instead of one Firestore listener per session (see
 * `attendanceIndex.ts` for the rationale and doc shape).
 *
 * The handler is factored out as the exported, emulator-testable
 * {@link handleAttendanceIndexWrite}; the deployed `attendanceIndexSync`
 * trigger is a thin adapter that unpacks the event and calls it, following
 * the same split as `compatTrigger.ts`.
 *
 * Idempotency: each delivery reads the index document, sets or removes one
 * `sessionId` key in its `statuses` map, and writes the whole `statuses`
 * object back inside a transaction (so a concurrent write to a *different*
 * session's key is never lost to a last-writer-wins race). Redelivering the
 * same event reproduces the same end state, so `retry: true` is safe.
 *
 * Note: `statuses` is written as a plain nested object, not a dotted
 * `"statuses.<sessionId>"` field-path key, because `DocumentReference.set()`
 * with `{ merge: true }` treats a dotted *string* key literally (as one
 * field literally named `"statuses.<sessionId>"`) rather than as a nested
 * path — only `.update()` interprets dotted keys as paths, and only on a
 * document guaranteed to already exist. Reading the current map and writing
 * it back whole sidesteps that pitfall entirely.
 *
 * No write loop: this trigger only ever writes to
 * `teams/*\/attendanceIndex/*`, never back to `sessions/*\/attendance/*`, so
 * it cannot re-trigger itself.
 */
import { FieldValue, Firestore, getFirestore } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { attendanceIndexDocRef, normalizeAttendanceStatusValue } from './attendanceIndex';
import { ATTENDANCE_INDEX_SUBCOLLECTION, FUNCTIONS_REGION, SESSIONS_COLLECTION, TEAMS_COLLECTION } from './config';

export type AttendanceIndexOutcome =
  | 'noop' // Neither before nor after existed.
  | 'sessionMissing' // The parent session no longer exists; nothing to index against.
  | 'set' // The member's status for this session was written/updated in the index.
  | 'cleared'; // The attendance record was deleted; the session's entry was removed from the index.

export interface AttendanceIndexEventInput {
  sessionId: string;
  memberId: string;
  /** Raw `sessions/{sessionId}/attendance/{memberId}` body post-write, or `null` if deleted. */
  rawAfter: Record<string, unknown> | null;
}

/**
 * The whole trigger body as a plain, injectable function so it can be
 * exercised directly against the Firestore emulator without deploying the
 * Cloud Function.
 */
export async function handleAttendanceIndexWrite(
  db: Firestore,
  input: AttendanceIndexEventInput,
): Promise<AttendanceIndexOutcome> {
  const { sessionId, memberId, rawAfter } = input;

  const sessionSnap = await db.collection(SESSIONS_COLLECTION).doc(sessionId).get();
  if (!sessionSnap.exists) {
    // The session was deleted (possibly concurrently with this attendance
    // write, e.g. `deleteSessions`/`deleteSession` in the Dart repository,
    // which delete every attendance doc before the session itself). There is
    // no teamId to index against; the rebuild endpoint prunes any stale
    // index entry left behind.
    logger.debug('attendanceIndexSync: parent session missing; skipping', { sessionId, memberId });
    return 'sessionMissing';
  }
  const teamId = sessionSnap.data()?.teamId;
  if (typeof teamId !== 'string' || teamId.length === 0) {
    logger.warn('attendanceIndexSync: session has no teamId; skipping', { sessionId, memberId });
    return 'sessionMissing';
  }

  const indexRef = attendanceIndexDocRef(db, teamId, memberId);
  const newStatus = rawAfter === null ? null : normalizeAttendanceStatusValue(rawAfter.status);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(indexRef);
    const statuses: Record<string, string> = { ...(snap.exists ? snap.data()?.statuses : undefined) };
    if (newStatus === null) {
      delete statuses[sessionId];
    } else {
      statuses[sessionId] = newStatus;
    }
    tx.set(indexRef, { memberId, teamId, statuses, updatedAt: FieldValue.serverTimestamp() });
  });

  return newStatus === null ? 'cleared' : 'set';
}

export const attendanceIndexSync = onDocumentWritten(
  { document: `${SESSIONS_COLLECTION}/{sessionId}/attendance/{memberId}`, region: FUNCTIONS_REGION, retry: true },
  async (event) => {
    const afterSnap = event.data?.after;
    const rawAfter = afterSnap?.exists ? afterSnap.data() ?? {} : null;

    await handleAttendanceIndexWrite(getFirestore(), {
      sessionId: event.params.sessionId,
      memberId: event.params.memberId,
      rawAfter,
    });
  },
);

/**
 * Cleans up `teams/{teamId}/attendanceIndex/*` when a session itself is
 * deleted, so a deleted session's status never lingers in a player's history.
 *
 * Why this is needed: `deleteSession`/`deleteSessions` in
 * `lib/src/repositories/session_repository.dart` delete every attendance doc
 * and the session doc in the *same* atomic `batch.commit()`. By the time
 * `handleAttendanceIndexWrite` runs for each deleted attendance doc, the
 * session is therefore *always* already gone — `sessionMissing` there is a
 * deterministic outcome of every session deletion, not an occasional race —
 * so that path alone can never remove the now-dangling `sessionId` entry.
 * This trigger, keyed on the session document instead, has the `teamId` it
 * needs (from the deleted document's own `before` data) without depending on
 * timing relative to the attendance-doc deletions at all.
 *
 * Cost/consistency note: this reads every member's current index doc for the
 * team (bounded by roster size, not session count) and only rewrites the ones
 * that actually contain the deleted session's key, via `.update()` with a
 * dotted field path — which, on a document guaranteed to already exist (we
 * just read it), correctly targets only that one nested key, leaving the
 * rest of the `statuses` map (including any change written concurrently by
 * {@link handleAttendanceIndexWrite} for a *different* session) untouched.
 */
export async function handleSessionDeleteCleanup(
  db: Firestore,
  input: { sessionId: string; teamId: string },
): Promise<{ membersCleaned: number }> {
  const { sessionId, teamId } = input;
  const indexSnap = await db.collection(TEAMS_COLLECTION).doc(teamId).collection(ATTENDANCE_INDEX_SUBCOLLECTION).get();
  const affected = indexSnap.docs.filter((doc) => {
    const statuses = doc.data().statuses;
    return statuses !== null && typeof statuses === 'object' && sessionId in statuses;
  });
  if (affected.length === 0) {
    return { membersCleaned: 0 };
  }

  const batch = db.batch();
  for (const doc of affected) {
    batch.update(doc.ref, {
      [`statuses.${sessionId}`]: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();

  logger.info('attendanceIndexSessionCleanup: pruned deleted session from index', {
    sessionId,
    teamId,
    membersCleaned: affected.length,
  });
  return { membersCleaned: affected.length };
}

export const attendanceIndexSessionCleanup = onDocumentWritten(
  { document: `${SESSIONS_COLLECTION}/{sessionId}`, region: FUNCTIONS_REGION, retry: true },
  async (event) => {
    const beforeSnap = event.data?.before;
    const afterSnap = event.data?.after;
    const wasDeleted = (beforeSnap?.exists ?? false) && !(afterSnap?.exists ?? false);
    if (!wasDeleted) {
      return;
    }
    const teamId = beforeSnap?.data()?.teamId;
    if (typeof teamId !== 'string' || teamId.length === 0) {
      logger.warn('attendanceIndexSessionCleanup: deleted session had no teamId; skipping', {
        sessionId: event.params.sessionId,
      });
      return;
    }
    await handleSessionDeleteCleanup(getFirestore(), { sessionId: event.params.sessionId, teamId });
  },
);
