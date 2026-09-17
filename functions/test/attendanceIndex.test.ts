import { attendanceIndexDocRef, isAttendanceStatusValue, normalizeAttendanceStatusValue } from '../src/attendanceIndex';

describe('isAttendanceStatusValue', () => {
  it('accepts every known status value', () => {
    expect(isAttendanceStatusValue('attending')).toBe(true);
    expect(isAttendanceStatusValue('injured')).toBe(true);
    expect(isAttendanceStatusValue('court_only')).toBe(true);
    expect(isAttendanceStatusValue('gym_only')).toBe(true);
    expect(isAttendanceStatusValue('late')).toBe(true);
    expect(isAttendanceStatusValue('absent')).toBe(true);
    expect(isAttendanceStatusValue('late_unannounced')).toBe(true);
    expect(isAttendanceStatusValue('absent_unannounced')).toBe(true);
    expect(isAttendanceStatusValue('absent_late_notice')).toBe(true);
    expect(isAttendanceStatusValue('no_convocado')).toBe(true);
  });

  it('rejects unknown values, non-strings, null and undefined', () => {
    expect(isAttendanceStatusValue('not_a_status')).toBe(false);
    expect(isAttendanceStatusValue('notApplicable')).toBe(false);
    expect(isAttendanceStatusValue(42)).toBe(false);
    expect(isAttendanceStatusValue(null)).toBe(false);
    expect(isAttendanceStatusValue(undefined)).toBe(false);
  });
});

describe('normalizeAttendanceStatusValue', () => {
  it('passes through a recognized value unchanged', () => {
    expect(normalizeAttendanceStatusValue('late')).toBe('late');
    expect(normalizeAttendanceStatusValue('absent_unannounced')).toBe('absent_unannounced');
  });

  it('defaults unrecognized/missing values to "attending", mirroring AttendanceStatus.fromFirestore', () => {
    expect(normalizeAttendanceStatusValue(undefined)).toBe('attending');
    expect(normalizeAttendanceStatusValue(null)).toBe('attending');
    expect(normalizeAttendanceStatusValue('garbage')).toBe('attending');
  });
});

describe('attendanceIndexDocRef', () => {
  it('points at teams/{teamId}/attendanceIndex/{memberId}', () => {
    const db = {
      collection: jest.fn().mockReturnThis(),
      doc: jest.fn().mockReturnThis(),
    } as unknown as FirebaseFirestore.Firestore;

    attendanceIndexDocRef(db, 'team-1', 'member-1');

    expect(db.collection).toHaveBeenNthCalledWith(1, 'teams');
    expect(db.doc).toHaveBeenNthCalledWith(1, 'team-1');
    expect(db.collection).toHaveBeenNthCalledWith(2, 'attendanceIndex');
    expect(db.doc).toHaveBeenNthCalledWith(2, 'member-1');
  });
});
