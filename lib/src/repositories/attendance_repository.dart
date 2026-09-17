import 'package:cloud_firestore/cloud_firestore.dart';

import '../models/attendance.dart';

enum AttendanceWriteKind { set, delete }

/// Firestore security rules cap a batched write at 20 `get()`/`exists()`
/// calls in total. Each attendance write in a batch triggers a lookup of its
/// session (and, the first time, the roster membership), so batches must
/// stay well under that ceiling or Firestore rejects the whole batch with
/// `permission-denied`.
const int _maxAttendanceBatchSize = 10;

Iterable<List<T>> _chunked<T>(Iterable<T> items, int size) sync* {
  var chunk = <T>[];
  for (final item in items) {
    chunk.add(item);
    if (chunk.length == size) {
      yield chunk;
      chunk = [];
    }
  }
  if (chunk.isNotEmpty) {
    yield chunk;
  }
}

AttendanceWriteKind planAttendanceWrite({
  required AttendanceStatus status,
  required String note,
  required bool isBatch,
  AttendanceStatus defaultStatus = AttendanceStatus.attending,
}) {
  if (!isBatch && status == defaultStatus && note.trim().isEmpty) {
    return AttendanceWriteKind.delete;
  }
  return AttendanceWriteKind.set;
}

class AttendanceRepository {
  AttendanceRepository(this._firestore);

  final FirebaseFirestore _firestore;

  Stream<AttendanceRecord?> watchAttendance({
    required String sessionId,
    required String userId,
  }) {
    return _attendanceReference(sessionId, userId).snapshots().map(
      (snapshot) =>
          snapshot.exists ? AttendanceRecord.fromSnapshot(snapshot) : null,
    );
  }

  Stream<Map<String, AttendanceRecord>> watchSessionAttendance(
    String sessionId,
  ) {
    return _firestore
        .collection('sessions')
        .doc(sessionId)
        .collection('attendance')
        .snapshots()
        .map(
          (snapshot) => {
            for (final document in snapshot.docs)
              document.id: AttendanceRecord.fromSnapshot(document),
          },
        );
  }

  /// Watches every team member's explicit attendance history in one
  /// listener, via the server-maintained mirror at
  /// `teams/{teamId}/attendanceIndex/{memberId}` (kept in sync by the
  /// `attendanceIndexSync` Cloud Function). Returns the same
  /// `attendanceBySession` shape (outer key: sessionId, inner key: memberId)
  /// the stat/chart/CSV builders already take, so callers that previously
  /// opened one listener per session via `watchAttendanceForSessions` can
  /// switch to this without changing any downstream code.
  Stream<Map<String, Map<String, AttendanceRecord>>> watchTeamAttendanceIndex(
    String teamId,
  ) {
    return _firestore
        .collection('teams')
        .doc(teamId)
        .collection('attendanceIndex')
        .snapshots()
        .map(
          (snapshot) => buildAttendanceBySessionFromIndex({
            for (final document in snapshot.docs)
              document.id: document.data()['statuses'],
          }),
        );
  }

  Future<void> saveAttendance({
    required String sessionId,
    required String userId,
    required AttendanceStatus status,
    required String note,
    required String updatedBy,
    AttendanceStatus defaultStatus = AttendanceStatus.attending,
  }) async {
    final reference = _attendanceReference(sessionId, userId);
    if (planAttendanceWrite(
          status: status,
          note: note,
          isBatch: false,
          defaultStatus: defaultStatus,
        ) ==
        AttendanceWriteKind.delete) {
      await reference.delete();
      return;
    }
    await reference.set({
      'status': status.firestoreValue,
      'note': note.trim().isEmpty ? null : note.trim(),
      'updatedBy': updatedBy,
      'updatedAt': FieldValue.serverTimestamp(),
    });
  }

  Future<void> saveBatchAttendance({
    required Iterable<String> sessionIds,
    required String userId,
    required AttendanceStatus status,
    required String note,
  }) async {
    final trimmedNote = note.trim().isEmpty ? null : note.trim();
    for (final chunk in _chunked(sessionIds, _maxAttendanceBatchSize)) {
      final batch = _firestore.batch();
      for (final sessionId in chunk) {
        final reference = _attendanceReference(sessionId, userId);
        // An explicit value avoids deleting a missing implicit "Asiste"
        // record, which would make Firestore reject the entire batch.
        batch.set(reference, {
          'status': status.firestoreValue,
          'note': trimmedNote,
          'updatedBy': userId,
          'updatedAt': FieldValue.serverTimestamp(),
        });
      }
      await batch.commit();
    }
  }

  Future<void> saveRosterAttendance({
    required String sessionId,
    required Iterable<String> userIds,
    required AttendanceStatus status,
    required String note,
    required String updatedBy,
  }) async {
    final trimmedNote = note.trim().isEmpty ? null : note.trim();
    for (final chunk in _chunked(userIds, _maxAttendanceBatchSize)) {
      final batch = _firestore.batch();
      for (final userId in chunk) {
        batch.set(_attendanceReference(sessionId, userId), {
          'status': status.firestoreValue,
          'note': trimmedNote,
          'updatedBy': updatedBy,
          'updatedAt': FieldValue.serverTimestamp(),
        });
      }
      await batch.commit();
    }
  }

  DocumentReference<Map<String, dynamic>> _attendanceReference(
    String sessionId,
    String userId,
  ) {
    return _firestore
        .collection('sessions')
        .doc(sessionId)
        .collection('attendance')
        .doc(userId);
  }
}
