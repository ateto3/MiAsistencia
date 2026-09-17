import 'package:flutter_test/flutter_test.dart';
import 'package:mi_asistencia/src/models/attendance.dart';

void main() {
  group('buildAttendanceBySessionFromIndex', () {
    test('transposes memberId -> {sessionId: status} into sessionId -> {memberId: record}', () {
      final result = buildAttendanceBySessionFromIndex({
        'player-1': {'session-a': 'late', 'session-b': 'absent'},
        'player-2': {'session-a': 'attending'},
      });

      expect(result.keys, containsAll(['session-a', 'session-b']));
      expect(result['session-a']!['player-1']!.status, AttendanceStatus.late);
      expect(result['session-a']!['player-2']!.status, AttendanceStatus.attending);
      expect(result['session-b']!['player-1']!.status, AttendanceStatus.absent);
      expect(result['session-b']!.containsKey('player-2'), isFalse);
    });

    test('skips a member whose statuses field is not a map, without affecting other members', () {
      final result = buildAttendanceBySessionFromIndex({
        'player-corrupt': 'not-a-map',
        'player-ok': {'session-a': 'late'},
      });

      expect(result['session-a']!.containsKey('player-corrupt'), isFalse);
      expect(result['session-a']!['player-ok']!.status, AttendanceStatus.late);
    });

    test('skips a member whose statuses field is null', () {
      final result = buildAttendanceBySessionFromIndex({
        'player-null': null,
        'player-ok': {'session-a': 'attending'},
      });

      expect(result.values.every((byMember) => !byMember.containsKey('player-null')), isTrue);
      expect(result['session-a']!['player-ok']!.status, AttendanceStatus.attending);
    });

    test('skips a non-string session key within an otherwise valid map', () {
      final result = buildAttendanceBySessionFromIndex({
        'player-1': {'session-a': 'late', 7: 'absent'},
      });

      expect(result.keys, ['session-a']);
    });

    test('falls back to attending for an unrecognized status value', () {
      final result = buildAttendanceBySessionFromIndex({
        'player-1': {'session-a': 'not_a_real_status'},
      });

      expect(result['session-a']!['player-1']!.status, AttendanceStatus.attending);
    });

    test('returns an empty map for empty input', () {
      expect(buildAttendanceBySessionFromIndex(const {}), isEmpty);
    });
  });
}
