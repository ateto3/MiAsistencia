/**
 * Pure helpers for the per-player attendance status mirror
 * (`teams/{teamId}/attendanceIndex/{memberId}`).
 *
 * The Dart client resolves a player's whole season history through one
 * listener per session (`sessions/{sessionId}/attendance/{memberId}`), which
 * does not scale to 100-200 sessions/year. This mirror keeps, per player, a
 * `{ sessionId: status }` map of every *explicit* attendance record, so the
 * client can read one small document per player instead. Only `status` is
 * mirrored: every stat/chart/CSV builder that consumes attendance history
 * reads nothing else from an `AttendanceRecord` (see
 * `lib/src/models/attendance.dart`, `lib/src/models/player_motivation.dart`,
 * `lib/src/widgets/player_attendance_chart.dart`,
 * `lib/src/utils/attendance_csv.dart`).
 *
 * Kept in sync with the `AttendanceStatus.firestoreValue`/`fromFirestore`
 * mapping in `lib/src/models/attendance.dart`.
 */
import { Firestore } from 'firebase-admin/firestore';
import { ATTENDANCE_INDEX_SUBCOLLECTION, TEAMS_COLLECTION } from './config';

/**
 * Every value `AttendanceStatus.firestoreValue` can produce. `notApplicable`
 * is deliberately absent: the Dart enum throws rather than storing it, so it
 * can never appear in a real attendance document.
 */
export const ATTENDANCE_STATUS_VALUES = [
  'attending',
  'injured',
  'court_only',
  'gym_only',
  'late',
  'absent',
  'late_unannounced',
  'absent_unannounced',
  'absent_late_notice',
  'no_convocado',
] as const;

export type AttendanceStatusValue = (typeof ATTENDANCE_STATUS_VALUES)[number];

const ATTENDANCE_STATUS_SET: ReadonlySet<string> = new Set(ATTENDANCE_STATUS_VALUES);

export function isAttendanceStatusValue(value: unknown): value is AttendanceStatusValue {
  return typeof value === 'string' && ATTENDANCE_STATUS_SET.has(value);
}

/**
 * Mirrors `AttendanceStatus.fromFirestore` in `lib/src/models/attendance.dart`:
 * an unrecognized/missing status defaults to `attending` rather than being
 * dropped, so the index stays a faithful mirror of what the client would
 * resolve if it read the raw document itself.
 */
export function normalizeAttendanceStatusValue(value: unknown): AttendanceStatusValue {
  return isAttendanceStatusValue(value) ? value : 'attending';
}

export function attendanceIndexDocRef(db: Firestore, teamId: string, memberId: string) {
  return db.collection(TEAMS_COLLECTION).doc(teamId).collection(ATTENDANCE_INDEX_SUBCOLLECTION).doc(memberId);
}
