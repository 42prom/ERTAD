import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/mobile_api_client.dart';
import '../../core/shell/shell_l10n.dart';
import '../../core/state/shell_providers.dart';
import '../../core/theme/ertad_theme.dart';
import '../../core/widgets/ertad_ui.dart';
import '../../models/poll.dart';

/// Displays live tallied results (or anonymity/pending notice) for a closed or participated decision.
class DecisionResultsCard extends ConsumerStatefulWidget {
  final Poll poll;
  final bool isClosed;

  const DecisionResultsCard({
    super.key,
    required this.poll,
    required this.isClosed,
  });

  @override
  ConsumerState<DecisionResultsCard> createState() =>
      _DecisionResultsCardState();
}

class _DecisionResultsCardState extends ConsumerState<DecisionResultsCard> {
  bool _loading = true;
  bool _suppressed = false;
  int _totalVotes = 0;
  List<Map<String, dynamic>> _rows = const [];

  @override
  void initState() {
    super.initState();
    _loadResults();
  }

  Future<void> _loadResults() async {
    final session = ref.read(shellSessionProvider);
    final orgId = session.activeOrgId;
    if (!session.isLiveConnected || orgId.isEmpty || orgId.startsWith('org-')) {
      if (mounted) setState(() => _loading = false);
      return;
    }
    try {
      final detail = await MobileApiClient().fetchDecisionDetail(
        organizationId: orgId,
        decisionId: widget.poll.id,
      );
      if (!mounted) return;
      final suppressed = detail['resultsSuppressed'] == true;
      final rawResults = detail['results'];
      final parsed = rawResults is List
          ? rawResults
                .whereType<Map>()
                .map((e) => Map<String, dynamic>.from(e))
                .toList(growable: false)
          : const <Map<String, dynamic>>[];
      final participation = (detail['participation'] as num?)?.toInt() ?? 0;
      final sumVotes = parsed.fold<int>(
        0,
        (acc, r) => acc + ((r['votes'] as num?)?.toInt() ?? 0),
      );
      setState(() {
        _suppressed = suppressed;
        _rows = parsed;
        _totalVotes = participation > 0 ? participation : sumVotes;
        _loading = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    if (_loading) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 8),
        child: LinearProgressIndicator(minHeight: 3),
      );
    }

    if (_suppressed) {
      return ErtadStateBanner(
        icon: Icons.visibility_off_outlined,
        tone: ErtadTone.neutral,
        message: shellTr(
          context,
          'decision_results_suppressed',
          fallback: 'Results are hidden to protect anonymity',
        ),
      );
    }

    if (_rows.isEmpty) {
      if (!widget.isClosed) {
        return ErtadStateBanner(
          icon: Icons.hourglass_top_rounded,
          tone: ErtadTone.primary,
          message: shellTr(
            context,
            'decision_results_pending',
            fallback: 'Results will be published after closing',
          ),
        );
      }
      return const SizedBox.shrink();
    }

    final maxVotes = _rows.fold<int>(
      0,
      (m, r) {
        final v = (r['votes'] as num?)?.toInt() ?? 0;
        return v > m ? v : m;
      },
    );

    return ErtadSurfaceCard(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.bar_chart_rounded, size: 18, color: p.primary),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  shellTr(
                    context,
                    'decision_results_title',
                    fallback: 'Results',
                  ),
                  style: Theme.of(context).textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              ErtadStatusPill(
                label:
                    '$_totalVotes ${shellTr(context, 'decision_votes_count', fallback: 'votes')}',
                tone: ErtadTone.primary,
              ),
            ],
          ),
          const SizedBox(height: 14),
          ..._rows.map((row) {
            final label = row['label']?.toString() ?? '';
            final votes = (row['votes'] as num?)?.toInt() ?? 0;
            final ratio = _totalVotes > 0 ? votes / _totalVotes : 0.0;
            final pct = (ratio * 100).round();
            final isLeader = votes > 0 && votes == maxVotes;

            return Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          label,
                          style: Theme.of(context).textTheme.bodyMedium
                              ?.copyWith(
                                fontWeight: isLeader
                                    ? FontWeight.w700
                                    : FontWeight.w500,
                              ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        '$pct% ($votes)',
                        style: Theme.of(context).textTheme.labelMedium
                            ?.copyWith(
                              color: isLeader ? p.primary : p.muted,
                              fontWeight: FontWeight.w700,
                            ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(999),
                    child: LinearProgressIndicator(
                      value: ratio.clamp(0.0, 1.0),
                      minHeight: 8,
                      backgroundColor: p.elevated,
                      valueColor: AlwaysStoppedAnimation<Color>(
                        isLeader ? p.primary : p.muted.withValues(alpha: 0.45),
                      ),
                    ),
                  ),
                ],
              ),
            );
          }),
        ],
      ),
    );
  }
}
