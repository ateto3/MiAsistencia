/**
 * Emulator-backed integration coverage for the attendance index trigger's
 * actual handler ({@link handleAttendanceIndexWrite}) — the exact function
 * the deployed `attendanceIndexSync` trigger invokes. Exercises create,
 * update, delete, a missing parent session, and duplicate delivery against
 * real Firestore.
 *
 * Requires the Firestore emulator (see functions/README.md). When
 * FIRESTORE_EMULATOR_HOST is not set the whole suite is skipped, so a plain
 * `npm install && npm test` still passes.
 *
 * Uses its own project id so it never shares emulator data with the other
 * emulator suites (Jest runs test files in parallel workers).
 */
import { initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { attendanceIndexDocRef } from '../src/attendanceIndex';
import { handleAttendanceIndexWrite, handleSessionDeleteCleanup } from '../src/attendanceIndexTrigger';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const describeIfEmulator = emulatorHost ? describe : describe.skip;

// Shared across both describe blocks below (attendanceIndexSync and
// handleSessionDeleteCleanup): the Admin SDK's default app, and the
// Firestore instance it hands out, can each only be initialized/terminated
// once per Jest worker process — so `initializeApp`/`db.terminate()` live in
// a single top-level beforeAll/afterAll rather than per-describe.
let sharedDb: Firestore;

if (emulatorHost) {
  beforeAll(() => {
    initializeApp({ projectId: 'demo-attendance-index-trigger' });
    sharedDb = getFirestore();
  });

  afterAll(async () => {
    await sharedDb.terminate();
  });
}

describeIfEmulator('attendanceIndexSync handler (Firestore emulator)', () => {
  let db: Firestore;

  beforeAll(() => {
    db = sharedDb;
  });

  async function deleteCollection(name: string) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((doc) => doc.ref.delete()));
  }

  /** `teams/{teamId}` documents are never written directly (only their
   * `attendanceIndex` subcollection is), so clearing them requires a
   * collection-group query rather than `deleteCollection('teams')`. */
  async function deleteAttendanceIndexes() {
    const snap = await db.collectionGroup('attendanceIndex').get();
    await Promise.all(snap.docs.map((doc) => doc.ref.delete()));
  }

  beforeEach(async () => {
    await deleteCollection('sessions');
    await deleteAttendanceIndexes();
    await db.collection('sessions').doc('session-1').set({ teamId: 'team-1' });
  });

  afterAll(async () => {
    await deleteCollection('sessions');
    await deleteAttendanceIndexes();
  }, 30000);

  it('sets the status in the index on create', async () => {
    const outcome = await handleAttendanceIndexWrite(db, {
      sessionId: 'session-1',
      memberId: 'member-1',
      rawAfter: { status: 'late' },
    });

    expect(outcome).toBe('set');
    const doc = await attendanceIndexDocRef(db, 'team-1', 'member-1').get();
    expect(doc.data()?.statuses).toEqual({ 'session-1': 'late' });
    expect(doc.data()?.teamId).toBe('team-1');
    expect(doc.data()?.memberId).toBe('member-1');
  });

  it('defaults an unrecognized status to "attending", mirroring AttendanceStatus.fromFirestore', async () => {
    await handleAttendanceIndexWrite(db, {
      sessionId: 'session-1',
      memberId: 'member-1',
      rawAfter: { status: 'not_a_real_status' },
    });

    const doc = await attendanceIndexDocRef(db, 'team-1', 'member-1').get();
    expect(doc.data()?.statuses).toEqual({ 'session-1': 'attending' });
  });

  it('updates the status in place on a status change', async () => {
    await handleAttendanceIndexWrite(db, {
      sessionId: 'session-1',
      memberId: 'member-1',
      rawAfter: { status: 'late' },
    });
    const outcome = await handleAttendanceIndexWrite(db, {
      sessionId: 'session-1',
      memberId: 'member-1',
      rawAfter: { status: 'absent' },
    });

    expect(outcome).toBe('set');
    const doc = await attendanceIndexDocRef(db, 'team-1', 'member-1').get();
    expect(doc.data()?.statuses).toEqual({ 'session-1': 'absent' });
  });

  it('preserves other sessions when one is updated', async () => {
    await db.collection('sessions').doc('session-2').set({ teamId: 'team-1' });
    await handleAttendanceIndexWrite(db, {
      sessionId: 'session-1',
      memberId: 'member-1',
      rawAfter: { status: 'late' },
    });
    await handleAttendanceIndexWrite(db, {
      sessionId: 'session-2',
      memberId: 'member-1',
      rawAfter: { status: 'injured' },
    });

    const doc = await attendanceIndexDocRef(db, 'team-1', 'member-1').get();
    expect(doc.data()?.statuses).toEqual({ 'session-1': 'late', 'session-2': 'injured' });
  });

  it('removes only the affected session key on delete, leaving the rest of the map intact', async () => {
    await db.collection('sessions').doc('session-2').set({ teamId: 'team-1' });
    await handleAttendanceIndexWrite(db, {
      sessionId: 'session-1',
      memberId: 'member-1',
      rawAfter: { status: 'late' },
    });
    await handleAttendanceIndexWrite(db, {
      sessionId: 'session-2',
      memberId: 'member-1',
      rawAfter: { status: 'injured' },
    });

    const outcome = await handleAttendanceIndexWrite(db, {
      sessionId: 'session-1',
      memberId: 'member-1',
      rawAfter: null,
    });

    expect(outcome).toBe('cleared');
    const doc = await attendanceIndexDocRef(db, 'team-1', 'member-1').get();
    expect(doc.data()?.statuses).toEqual({ 'session-2': 'injured' });
  });

  it('no-ops without throwing when the parent session no longer exists', async () => {
    const outcome = await handleAttendanceIndexWrite(db, {
      sessionId: 'session-does-not-exist',
      memberId: 'member-1',
      rawAfter: { status: 'late' },
    });

    expect(outcome).toBe('sessionMissing');
  });

  it('is idempotent under duplicate delivery: redelivering the same create yields the same state', async () => {
    await handleAttendanceIndexWrite(db, {
      sessionId: 'session-1',
      memberId: 'member-1',
      rawAfter: { status: 'late' },
    });
    const outcome = await handleAttendanceIndexWrite(db, {
      sessionId: 'session-1',
      memberId: 'member-1',
      rawAfter: { status: 'late' },
    });

    expect(outcome).toBe('set');
    const doc = await attendanceIndexDocRef(db, 'team-1', 'member-1').get();
    expect(doc.data()?.statuses).toEqual({ 'session-1': 'late' });
  });
});

// handleSessionDeleteCleanup shares this file's describe block (rather than
// its own, with a second initializeApp) because both run in the same Jest
// worker process for this file, and the Admin SDK's default app can only be
// initialized once per process.
describeIfEmulator('handleSessionDeleteCleanup (Firestore emulator)', () => {
  let db: Firestore;

  beforeAll(() => {
    db = sharedDb;
  });

  async function deleteCollection(name: string) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((doc) => doc.ref.delete()));
  }

  async function deleteAttendanceIndexes() {
    const snap = await db.collectionGroup('attendanceIndex').get();
    await Promise.all(snap.docs.map((doc) => doc.ref.delete()));
  }

  beforeEach(async () => {
    await deleteCollection('sessions');
    await deleteAttendanceIndexes();
  });

  afterAll(async () => {
    await deleteCollection('sessions');
    await deleteAttendanceIndexes();
  }, 30000);

  it('removes only the deleted session\'s key from every affected member, leaving other sessions intact', async () => {
    await attendanceIndexDocRef(db, 'team-1', 'member-1').set({
      memberId: 'member-1',
      teamId: 'team-1',
      statuses: { 'session-1': 'late', 'session-2': 'injured' },
    });
    await attendanceIndexDocRef(db, 'team-1', 'member-2').set({
      memberId: 'member-2',
      teamId: 'team-1',
      statuses: { 'session-1': 'absent' },
    });

    const result = await handleSessionDeleteCleanup(db, { sessionId: 'session-1', teamId: 'team-1' });

    expect(result.membersCleaned).toBe(2);
    const member1 = await attendanceIndexDocRef(db, 'team-1', 'member-1').get();
    expect(member1.data()?.statuses).toEqual({ 'session-2': 'injured' });
    const member2 = await attendanceIndexDocRef(db, 'team-1', 'member-2').get();
    expect(member2.data()?.statuses).toEqual({});
  });

  it('does not touch members who never had the deleted session indexed', async () => {
    await attendanceIndexDocRef(db, 'team-1', 'member-1').set({
      memberId: 'member-1',
      teamId: 'team-1',
      statuses: { 'session-2': 'injured' },
    });

    const result = await handleSessionDeleteCleanup(db, { sessionId: 'session-1', teamId: 'team-1' });

    expect(result.membersCleaned).toBe(0);
    const member1 = await attendanceIndexDocRef(db, 'team-1', 'member-1').get();
    expect(member1.data()?.statuses).toEqual({ 'session-2': 'injured' });
  });

  it('does not affect a different team\'s index even if it has the same sessionId key', async () => {
    await attendanceIndexDocRef(db, 'team-1', 'member-1').set({
      memberId: 'member-1',
      teamId: 'team-1',
      statuses: { 'session-1': 'late' },
    });
    await attendanceIndexDocRef(db, 'team-2', 'member-9').set({
      memberId: 'member-9',
      teamId: 'team-2',
      statuses: { 'session-1': 'attending' },
    });

    await handleSessionDeleteCleanup(db, { sessionId: 'session-1', teamId: 'team-1' });

    const otherTeamMember = await attendanceIndexDocRef(db, 'team-2', 'member-9').get();
    expect(otherTeamMember.data()?.statuses).toEqual({ 'session-1': 'attending' });
  });

  it('is a no-op when the team has no attendanceIndex documents at all', async () => {
    const result = await handleSessionDeleteCleanup(db, { sessionId: 'session-1', teamId: 'team-empty' });
    expect(result.membersCleaned).toBe(0);
  });

  it('is idempotent: running cleanup twice for the same session is safe', async () => {
    await attendanceIndexDocRef(db, 'team-1', 'member-1').set({
      memberId: 'member-1',
      teamId: 'team-1',
      statuses: { 'session-1': 'late' },
    });

    await handleSessionDeleteCleanup(db, { sessionId: 'session-1', teamId: 'team-1' });
    const second = await handleSessionDeleteCleanup(db, { sessionId: 'session-1', teamId: 'team-1' });

    expect(second.membersCleaned).toBe(0);
  });
});
