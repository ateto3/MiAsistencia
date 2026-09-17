import 'package:flutter/material.dart';

import '../models/attendance.dart';
import '../models/team_membership.dart';
import '../models/team_session.dart';
import '../theme/app_theme.dart';

enum PlayerAttendanceChartPeriod { weekly, monthly }

class PlayerAttendanceChartPoint {
  const PlayerAttendanceChartPoint({
    required this.label,
    required this.percentage,
    required this.sessionCount,
  });

  final String label;
  final int percentage;
  final int sessionCount;
}

/// Weekly (or monthly, once the history spans 90+ days) evolution of a
/// player's attendance participation. Renders nothing when there isn't
/// enough history to plot.
class PlayerAttendanceEvolutionChart extends StatelessWidget {
  const PlayerAttendanceEvolutionChart({
    required this.player,
    required this.completedSessions,
    required this.attendanceBySession,
    super.key,
  });

  final TeamRosterMember player;
  final List<TeamSession> completedSessions;
  final Map<String, Map<String, AttendanceRecord>> attendanceBySession;

  @override
  Widget build(BuildContext context) {
    final data = buildPlayerAttendanceChartData(
      player: player,
      completedSessions: completedSessions,
      attendanceBySession: attendanceBySession,
    );

    if (data.points.isEmpty) {
      return const SizedBox.shrink();
    }

    return _AttendanceChartSection(data: data);
  }
}

class _AttendanceChartData {
  const _AttendanceChartData({required this.period, required this.points});

  final PlayerAttendanceChartPeriod period;
  final List<PlayerAttendanceChartPoint> points;
}

class _AttendanceChartSection extends StatelessWidget {
  const _AttendanceChartSection({required this.data});

  final _AttendanceChartData data;

  @override
  Widget build(BuildContext context) {
    final title = data.period == PlayerAttendanceChartPeriod.weekly
        ? 'Evolución semanal'
        : 'Evolución mensual';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                title,
                style: Theme.of(
                  context,
                ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
            Text(
              'Participación',
              style: TextStyle(color: Colors.blueGrey.shade600, fontSize: 12),
            ),
          ],
        ),
        const SizedBox(height: 12),
        SizedBox(height: 190, child: _AttendanceBarChart(points: data.points)),
        const SizedBox(height: 6),
        Text(
          'Asistencia, retraso, solo físico o solo pista cuentan como '
          'participación. Faltas, lesiones y no convocado no puntúan.',
          style: TextStyle(
            color: Colors.blueGrey.shade600,
            fontSize: 11,
            height: 1.35,
          ),
        ),
      ],
    );
  }
}

class _AttendanceBarChart extends StatelessWidget {
  const _AttendanceBarChart({required this.points});

  final List<PlayerAttendanceChartPoint> points;

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      painter: _AttendanceBarChartPainter(
        points: points,
        barColor: AppTheme.primary,
        gridColor: Colors.blueGrey.shade100,
        textColor: Colors.blueGrey.shade700,
      ),
    );
  }
}

class _AttendanceBarChartPainter extends CustomPainter {
  _AttendanceBarChartPainter({
    required this.points,
    required this.barColor,
    required this.gridColor,
    required this.textColor,
  });

  final List<PlayerAttendanceChartPoint> points;
  final Color barColor;
  final Color gridColor;
  final Color textColor;

  @override
  void paint(Canvas canvas, Size size) {
    if (points.isEmpty || size.width <= 0 || size.height <= 0) {
      return;
    }

    const topPadding = 20.0;
    const bottomPadding = 28.0;
    const leftPadding = 28.0;
    const rightPadding = 8.0;

    final chartWidth = size.width - leftPadding - rightPadding;
    final chartHeight = size.height - topPadding - bottomPadding;

    if (chartWidth <= 0 || chartHeight <= 0) {
      return;
    }

    final gridPaint = Paint()
      ..color = gridColor
      ..strokeWidth = 1;

    final textPainter = TextPainter(textDirection: TextDirection.ltr);

    for (final percentage in [0, 25, 50, 75, 100]) {
      final y = topPadding + chartHeight - chartHeight * percentage / 100;

      canvas.drawLine(
        Offset(leftPadding, y),
        Offset(size.width - rightPadding, y),
        gridPaint,
      );

      textPainter.text = TextSpan(
        text: '$percentage%',
        style: TextStyle(color: textColor, fontSize: 10),
      );
      textPainter.layout();
      textPainter.paint(canvas, Offset(0, y - textPainter.height / 2));
    }

    final slotWidth = chartWidth / points.length;
    final barWidth = (slotWidth * 0.62).clamp(8.0, 36.0);

    final barPaint = Paint()..color = barColor;

    for (var index = 0; index < points.length; index++) {
      final point = points[index];
      final barHeight = chartHeight * point.percentage / 100;
      final x = leftPadding + index * slotWidth + (slotWidth - barWidth) / 2;
      final top = topPadding + chartHeight - barHeight;

      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH(x, top, barWidth, barHeight),
          const Radius.circular(6),
        ),
        barPaint,
      );

      textPainter.text = TextSpan(
        text: '${point.percentage}%',
        style: TextStyle(
          color: textColor,
          fontSize: 10,
          fontWeight: FontWeight.w700,
        ),
      );
      textPainter.layout();

      final percentageX = x + (barWidth - textPainter.width) / 2;

      textPainter.paint(
        canvas,
        Offset(percentageX, top - textPainter.height - 3),
      );

      textPainter.text = TextSpan(
        text: point.label,
        style: TextStyle(color: textColor, fontSize: 10),
      );
      textPainter.layout();

      final labelX = x + (barWidth - textPainter.width) / 2;

      textPainter.paint(canvas, Offset(labelX, topPadding + chartHeight + 8));
    }
  }

  @override
  bool shouldRepaint(covariant _AttendanceBarChartPainter oldDelegate) {
    return oldDelegate.points != points ||
        oldDelegate.barColor != barColor ||
        oldDelegate.gridColor != gridColor ||
        oldDelegate.textColor != textColor;
  }
}

_AttendanceChartData buildPlayerAttendanceChartData({
  required TeamRosterMember player,
  required Iterable<TeamSession> completedSessions,
  required Map<String, Map<String, AttendanceRecord>> attendanceBySession,
}) {
  final sessions =
      completedSessions
          .where(
            (session) => !isPresumedAbsentAt(
              member: player,
              sessionTime: session.startTime,
            ),
          )
          .where((session) {
            final status = resolveAttendanceStatus(
              user: player,
              explicitRecord: attendanceBySession[session.id]?[player.id],
              sessionTime: session.startTime,
            );

            return status != AttendanceStatus.notApplicable;
          })
          .toList()
        ..sort((left, right) => left.startTime.compareTo(right.startTime));

  if (sessions.isEmpty) {
    return const _AttendanceChartData(
      period: PlayerAttendanceChartPeriod.weekly,
      points: [],
    );
  }

  final firstDate = sessions.first.startTime;
  final lastDate = sessions.last.startTime;

  final useMonthly = lastDate.difference(firstDate) >= const Duration(days: 90);

  final period = useMonthly
      ? PlayerAttendanceChartPeriod.monthly
      : PlayerAttendanceChartPeriod.weekly;

  final buckets = <DateTime, List<double>>{};

  for (final session in sessions) {
    final key = period == PlayerAttendanceChartPeriod.weekly
        ? _startOfWeek(session.startTime)
        : _startOfMonth(session.startTime);

    final status = resolveAttendanceStatus(
      user: player,
      explicitRecord: attendanceBySession[session.id]?[player.id],
      sessionTime: session.startTime,
    );

    buckets
        .putIfAbsent(key, () => [])
        .add(participationForAttendanceChart(status));
  }

  final sortedKeys = buckets.keys.toList()..sort();

  final points = <PlayerAttendanceChartPoint>[];

  for (var index = 0; index < sortedKeys.length; index++) {
    final key = sortedKeys[index];
    final values = buckets[key]!;

    final percentage =
        (values.reduce((sum, value) => sum + value) / values.length * 100)
            .round();

    points.add(
      PlayerAttendanceChartPoint(
        label: period == PlayerAttendanceChartPeriod.weekly
            ? 'S${index + 1}'
            : _monthLabel(key),
        percentage: percentage,
        sessionCount: values.length,
      ),
    );
  }

  return _AttendanceChartData(period: period, points: points);
}

double participationForAttendanceChart(AttendanceStatus status) {
  return status.countsForAttendancePercentage ? 1.0 : 0.0;
}

DateTime _startOfWeek(DateTime value) {
  final date = DateTime(value.year, value.month, value.day);

  return date.subtract(Duration(days: date.weekday - DateTime.monday));
}

DateTime _startOfMonth(DateTime value) {
  return DateTime(value.year, value.month);
}

String _monthLabel(DateTime value) {
  const months = [
    'ene',
    'feb',
    'mar',
    'abr',
    'may',
    'jun',
    'jul',
    'ago',
    'sep',
    'oct',
    'nov',
    'dic',
  ];

  return months[value.month - 1];
}
