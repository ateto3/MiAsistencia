/**
 * Pure/impure orchestration for (re)building
 * `teams/{teamId}/attendanceIndex/{memberId}` from the current
 * `sessions/*\/attendance/*` data. Split out from `attendanceIndexRebuild.ts`
 * (the `onRequest` HTTP wrapper) the same way `migrationRunner.ts` is split
 * from `httpMigration.ts`: importing `firebase-functions/v2/https` pulls in
 * `firebase-admin/auth` (via `jose`/`jwks-rsa`), which ships ESM that Jest's
 * default transform cannot parse — so any module under test must avoid that
 * import chain.
 *
 * Two uses of the endpoint this backs:
 *  - One-off backfill after the `attendanceIndexSync` trigger is deployed,
 *    to populate the index for attendance written before the trigger
 *    existed.
 *  - An on-demand repair tool if the index is ever suspected to have
 *    drifted from the source `attendance` subcollections (the trigger is
 *    idempotent and retried, so drift should not happen in practice, but
 *    this endpoint is the safety net rather than a scheduled job).
 *
 * Each team's rebuild overwrites every member's index document with exactly
 * the explicit statuses found in that team's sessions right now, and deletes
 * any index document for a member with no explicit statuses left — so,
 * unlike the trigger's incremental merge, a full `apply` run also prunes any
 * stale entry.
 *
 * Concurrency: reading every session's attendance subcollection (the loop
 * below) can take seconds for a large team, so the computed `statusesByMember`
 * can already be stale relative to `attendanceIndexSync` by the time this
 * writes it. Writes are therefore per-document, each guarded by a Firestore
 * precondition on the index doc's `updateTime` (captured as close to the
 * write phase as this function gets) — so a delivery that lands on a
 * member's doc after that read is detected and that member's write is
 * skipped (counted, not silently lost) rather than clobbering newer data
 * with this rebuild's older view. A brand-new member's first-ever write uses
 * `.create()` for the same reason: it fails instead of overwriting a doc the
 * trigger created in the meantime.
 */
import { FieldPath, FieldValue, Firestore } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import { attendanceIndexDocRef, normalizeAttendanceStatusValue } from './attendanceIndex';
import {
  ATTENDANCE_INDEX_SUBCOLLECTION,
  ATTENDANCE_SUBCOLLECTION,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  SESSIONS_COLLECTION,
  TEAMS_COLLECTION,
} from './config';

export type AttendanceIndexRebuildMode = 'dryRun' | 'apply';

export interface AttendanceIndexRebuildRequest {
  mode: AttendanceIndexRebuildMode;
  pageSize?: number;
  /** Team document id to resume after (exclusive). Omit to start from the beginning. */
  cursor?: string | null;
}

export interface AttendanceIndexRebuildCounts {
  teamsProcessed: number;
  sessionsRead: number;
  membersWritten: number;
  membersPruned: number;
  /**
   * Members (and stale-prune candidates) whose index doc changed
   * concurrently (most likely a live `attendanceIndexSync` delivery) between
   * this rebuild's read and write phases, so the write was skipped rather
   * than clobbering newer data. Re-running the rebuild (or simply letting
   * the trigger keep doing its job) resolves these on their own; a non-zero
   * count here is informational, not an error.
   */
  membersSkippedConcurrentUpdate: number;
}

export interface AttendanceIndexRebuildResponse {
  mode: AttendanceIndexRebuildMode;
  pageSize: number;
  startCursor: string | null;
  nextCursor: string | null;
  done: boolean;
  counts: AttendanceIndexRebuildCounts;
  durationMs: number;
}

export function clampRebuildPageSize(pageSize?: number): number {
  if (typeof pageSize !== 'number' || !Number.isFinite(pageSize) || pageSize <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(pageSize), MAX_PAGE_SIZE);
}

interface TeamPageResult {
  teamIds: string[];
  nextCursor: string | null;
  done: boolean;
}

async function fetchTeamPage(db: Firestore, pageSize: number, cursor: string | null): Promise<TeamPageResult> {
  let query = db.collection(TEAMS_COLLECTION).orderBy(FieldPath.documentId()).limit(pageSize + 1) as FirebaseFirestore.Query;
  if (cursor) {
    query = query.startAfter(cursor);
  }
  const snap = await query.get();
  const docs = snap.docs;
  if (docs.length > pageSize) {
    const pageDocs = docs.slice(0, pageSize);
    const last = pageDocs[pageDocs.length - 1];
    return { teamIds: pageDocs.map((doc) => doc.id), nextCursor: last ? last.id : null, done: false };
  }
  return { teamIds: docs.map((doc) => doc.id), nextCursor: null, done: true };
}

/**
 * Rebuilds one team's attendance index from its current sessions/attendance
 * data. Returns the counts for that team; performs no writes in `dryRun`.
 */
export async function rebuildTeamAttendanceIndex(
  db: Firestore,
  teamId: string,
  mode: AttendanceIndexRebuildMode,
): Promise<{ sessionsRead: number; membersWritten: number; membersPruned: number; membersSkippedConcurrentUpdate: number }> {
  const sessionsSnap = await db.collection(SESSIONS_COLLECTION).where('teamId', '==', teamId).get();

  const statusesByMember = new Map<string, Record<string, string>>();
  for (const sessionDoc of sessionsSnap.docs) {
    const attendanceSnap = await sessionDoc.ref.collection(ATTENDANCE_SUBCOLLECTION).get();
    for (const attendanceDoc of attendanceSnap.docs) {
      const memberId = attendanceDoc.id;
      const status = normalizeAttendanceStatusValue(attendanceDoc.data()?.status);
      const existing = statusesByMember.get(memberId) ?? {};
      existing[sessionDoc.id] = status;
      statusesByMember.set(memberId, existing);
    }
  }

  // Read as close to the write phase as this function gets: every doc's
  // `updateTime` here becomes the precondition for that doc's write below,
  // so a delivery landing after this exact read (not after the session
  // reads above, which is the real, larger race window) is what gets caught.
  const existingIndexSnap = await db.collection(TEAMS_COLLECTION).doc(teamId).collection(ATTENDANCE_INDEX_SUBCOLLECTION).get();
  const existingById = new Map(existingIndexSnap.docs.map((doc) => [doc.id, doc]));
  const staleMemberIds = existingIndexSnap.docs.map((doc) => doc.id).filter((memberId) => !statusesByMember.has(memberId));

  // `dryRun` performs no writes, so membersWritten there is a preview of
  // what apply would attempt — not a count of successful writes.
  let membersWritten = mode === 'dryRun' ? statusesByMember.size : 0;
  let membersSkippedConcurrentUpdate = 0;

  if (mode === 'apply') {
    const writeMember = async (memberId: string, statuses: Record<string, string>) => {
      const ref = attendanceIndexDocRef(db, teamId, memberId);
      const existingDoc = existingById.get(memberId);
      const payload = { memberId, teamId, statuses, updatedAt: FieldValue.serverTimestamp() };
      try {
        if (existingDoc) {
          await ref.update(payload, { lastUpdateTime: existingDoc.updateTime });
        } else {
          await ref.create(payload);
        }
        membersWritten++;
      } catch (err) {
        // FAILED_PRECONDITION (updateTime moved) or ALREADY_EXISTS (a
        // concurrent first write raced our .create()): a fresher write is
        // already in place, so leave it rather than overwrite it with this
        // rebuild's now-stale view. Not an error — see the counts doc comment.
        logger.debug('attendanceIndexRebuild: skipped member with a concurrent update', {
          teamId,
          memberId,
          error: err instanceof Error ? err.message : String(err),
        });
        membersSkippedConcurrentUpdate++;
      }
    };

    const pruneMember = async (memberId: string) => {
      const existingDoc = existingById.get(memberId);
      if (!existingDoc) {
        return;
      }
      try {
        await attendanceIndexDocRef(db, teamId, memberId).delete({ lastUpdateTime: existingDoc.updateTime });
      } catch (err) {
        logger.debug('attendanceIndexRebuild: skipped stale-member prune with a concurrent update', {
          teamId,
          memberId,
          error: err instanceof Error ? err.message : String(err),
        });
        membersSkippedConcurrentUpdate++;
      }
    };

    await Promise.all([
      ...[...statusesByMember.entries()].map(([memberId, statuses]) => writeMember(memberId, statuses)),
      ...staleMemberIds.map((memberId) => pruneMember(memberId)),
    ]);
  }

  return {
    sessionsRead: sessionsSnap.docs.length,
    membersWritten,
    membersPruned: staleMemberIds.length,
    membersSkippedConcurrentUpdate,
  };
}

export async function runAttendanceIndexRebuildPage(
  db: Firestore,
  request: AttendanceIndexRebuildRequest,
): Promise<AttendanceIndexRebuildResponse> {
  const start = Date.now();
  const pageSize = clampRebuildPageSize(request.pageSize);
  const cursor = request.cursor ?? null;

  const { teamIds, nextCursor, done } = await fetchTeamPage(db, pageSize, cursor);

  const counts: AttendanceIndexRebuildCounts = {
    teamsProcessed: 0,
    sessionsRead: 0,
    membersWritten: 0,
    membersPruned: 0,
    membersSkippedConcurrentUpdate: 0,
  };

  for (const teamId of teamIds) {
    const teamResult = await rebuildTeamAttendanceIndex(db, teamId, request.mode);
    counts.teamsProcessed++;
    counts.sessionsRead += teamResult.sessionsRead;
    counts.membersWritten += teamResult.membersWritten;
    counts.membersPruned += teamResult.membersPruned;
    counts.membersSkippedConcurrentUpdate += teamResult.membersSkippedConcurrentUpdate;
  }

  return {
    mode: request.mode,
    pageSize,
    startCursor: cursor,
    nextCursor,
    done,
    counts,
    durationMs: Date.now() - start,
  };
}
