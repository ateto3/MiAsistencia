/**
 * Emulator-backed integration coverage for `runAttendanceIndexRebuildPage`
 * (the handler behind the `attendanceIndexRebuild` HTTP endpoint, minus the
 * token check / HTTP wiring, which are exercised directly in
 * `auth.test.ts`). Covers dryRun making no writes, apply reproducing the
 * index from `sessions/*\/attendance/*`, idempotent re-apply, and pruning a
 * stale index entry for a member whose attendance record was deleted.
 *
 * Requires the Firestore emulator (see functions/README.md). When
 * FIRESTORE_EMULATOR_HOST is not set the whole suite is skipped, so a plain
 * `npm install && npm test` still passes.
 */
import { initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { attendanceIndexDocRef } from '../src/attendanceIndex';
import { runAttendanceIndexRebuildPage } from '../src/attendanceIndexRebuildRunner';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const describeIfEmulator = emulatorHost ? describe : describe.skip;

describeIfEmulator('attendanceIndexRebuild handler (Firestore emulator)', () => {
  let db: Firestore;

  beforeAll(() => {
    initializeApp({ projectId: 'demo-attendance-index-rebuild' });
    db = getFirestore();
  });

  async function deleteCollection(name: string) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((doc) => doc.ref.delete()));
  }

  async function deleteSubcollection(path: string) {
    const snap = await db.collection(path).get();
    await Promise.all(snap.docs.map((doc) => doc.ref.delete()));
  }

  /** Deleting `teams/{teamId}` does not cascade-delete its `attendanceIndex`
   * subcollection, so it must be cleared explicitly for real test isolation
   * (rather than relying on the last test happening to prune everything). */
  async function deleteAttendanceIndexes() {
    const snap = await db.collectionGroup('attendanceIndex').get();
    await Promise.all(snap.docs.map((doc) => doc.ref.delete()));
  }

  beforeEach(async () => {
    await deleteCollection('teams');
    await deleteCollection('sessions');
    await deleteAttendanceIndexes();

    await db.collection('teams').doc('team-1').set({ name: 'Team One', joinCode: 'team-1', createdBy: 'coach-1' });
    await db.collection('sessions').doc('session-1').set({ teamId: 'team-1' });
    await db.collection('sessions').doc('session-2').set({ teamId: 'team-1' });
    await db.collection('sessions').doc('session-1').collection('attendance').doc('player-1').set({ status: 'late' });
    await db.collection('sessions').doc('session-2').collection('attendance').doc('player-1').set({ status: 'absent' });
    await db.collection('sessions').doc('session-1').collection('attendance').doc('player-2').set({ status: 'attending' });
  });

  afterAll(async () => {
    await deleteCollection('teams');
    await deleteCollection('sessions');
    await deleteAttendanceIndexes();
    await db.terminate();
  }, 30000);

  it('dryRun computes counts without writing anything', async () => {
    const result = await runAttendanceIndexRebuildPage(db, { mode: 'dryRun', pageSize: 10 });

    expect(result.done).toBe(true);
    expect(result.counts).toEqual({
      teamsProcessed: 1,
      sessionsRead: 2,
      membersWritten: 2,
      membersPruned: 0,
      membersSkippedConcurrentUpdate: 0,
    });

    const player1 = await attendanceIndexDocRef(db, 'team-1', 'player-1').get();
    expect(player1.exists).toBe(false);
  });

  it('apply reproduces the index from the source attendance subcollections', async () => {
    const result = await runAttendanceIndexRebuildPage(db, { mode: 'apply', pageSize: 10 });

    expect(result.counts).toEqual({
      teamsProcessed: 1,
      sessionsRead: 2,
      membersWritten: 2,
      membersPruned: 0,
      membersSkippedConcurrentUpdate: 0,
    });

    const player1 = await attendanceIndexDocRef(db, 'team-1', 'player-1').get();
    expect(player1.data()?.statuses).toEqual({ 'session-1': 'late', 'session-2': 'absent' });
    const player2 = await attendanceIndexDocRef(db, 'team-1', 'player-2').get();
    expect(player2.data()?.statuses).toEqual({ 'session-1': 'attending' });
  });

  it('a second apply run is a no-op that reproduces the same state', async () => {
    await runAttendanceIndexRebuildPage(db, { mode: 'apply', pageSize: 10 });
    const first = await attendanceIndexDocRef(db, 'team-1', 'player-1').get();

    const result = await runAttendanceIndexRebuildPage(db, { mode: 'apply', pageSize: 10 });
    const second = await attendanceIndexDocRef(db, 'team-1', 'player-1').get();

    expect(result.counts.membersWritten).toBe(2);
    expect(second.data()?.statuses).toEqual(first.data()?.statuses);
  });

  it('prunes a stale index entry for a member whose attendance record was deleted', async () => {
    await runAttendanceIndexRebuildPage(db, { mode: 'apply', pageSize: 10 });
    await deleteSubcollection('sessions/session-1/attendance');
    await deleteSubcollection('sessions/session-2/attendance');

    const result = await runAttendanceIndexRebuildPage(db, { mode: 'apply', pageSize: 10 });

    expect(result.counts).toEqual({
      teamsProcessed: 1,
      sessionsRead: 2,
      membersWritten: 0,
      membersPruned: 2,
      membersSkippedConcurrentUpdate: 0,
    });
    const player1 = await attendanceIndexDocRef(db, 'team-1', 'player-1').get();
    expect(player1.exists).toBe(false);
    const player2 = await attendanceIndexDocRef(db, 'team-1', 'player-2').get();
    expect(player2.exists).toBe(false);
  });

  it('a precondition-guarded write is rejected once the document has changed since it was read, protecting a concurrent update from being clobbered', async () => {
    // This is the mechanism rebuildTeamAttendanceIndex's per-member writes
    // rely on: capture updateTime, then only write if nothing else has
    // touched the document since. Simulates a concurrent attendanceIndexSync
    // delivery landing between a rebuild's read and its write.
    const ref = attendanceIndexDocRef(db, 'team-1', 'player-1');
    await ref.set({ memberId: 'player-1', teamId: 'team-1', statuses: { 'session-1': 'attending' } });
    const staleSnap = await ref.get();

    await ref.update({ statuses: { 'session-1': 'late' } });

    await expect(
      ref.update({ statuses: { 'session-1': 'attending' } }, { lastUpdateTime: staleSnap.updateTime }),
    ).rejects.toThrow();

    const finalDoc = await ref.get();
    expect(finalDoc.data()?.statuses).toEqual({ 'session-1': 'late' });
  });

  it('paginates across teams and resumes from the returned cursor', async () => {
    await db.collection('teams').doc('team-2').set({ name: 'Team Two', joinCode: 'team-2', createdBy: 'coach-2' });

    const firstPage = await runAttendanceIndexRebuildPage(db, { mode: 'dryRun', pageSize: 1 });
    expect(firstPage.done).toBe(false);
    expect(firstPage.counts.teamsProcessed).toBe(1);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await runAttendanceIndexRebuildPage(db, {
      mode: 'dryRun',
      pageSize: 1,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.done).toBe(true);
    expect(secondPage.counts.teamsProcessed).toBe(1);
  });
});
