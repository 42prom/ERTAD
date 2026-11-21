import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/feedback/ertad_feedback.dart';
import '../../core/shell/shell_l10n.dart';
import '../../core/state/shell_providers.dart';
import '../../core/theme/ertad_theme.dart';
import '../../core/widgets/ertad_ui.dart';
import '../../models/poll.dart';

/// Persists and retrieves on-device cryptographic ballot verification codes per decision.
class VoteReceiptStore {
  static const String _prefix = 'ertad_vote_receipt_';

  static String formatCode(String raw) {
    final clean = raw.replaceAll(RegExp(r'[^A-Za-z0-9]'), '').toUpperCase();
    if (clean.length <= 4) return clean;
    final parts = <String>[];
    for (var i = 0; i < clean.length && i < 16; i += 4) {
      final end = (i + 4 < clean.length) ? i + 4 : clean.length;
      parts.add(clean.substring(i, end));
    }
    return parts.join('-');
  }

  static String deriveOrExtract({
    required String decisionId,
    required Map<String, dynamic> response,
    String? idempotencyKey,
  }) {
    final serverDigest = response['receiptDigest']?.toString().trim() ?? '';
    if (serverDigest.isNotEmpty) {
      return serverDigest.toUpperCase();
    }
    final seed = 'ertad-receipt-v1:$decisionId:${idempotencyKey ?? DateTime.now().toIso8601String()}';
    return sha256.convert(utf8.encode(seed)).toString().substring(0, 16).toUpperCase();
  }

  static Future<String> saveReceipt({
    required String decisionId,
    required Map<String, dynamic> response,
    String? idempotencyKey,
  }) async {
    final raw = deriveOrExtract(
      decisionId: decisionId,
      response: response,
      idempotencyKey: idempotencyKey,
    );
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('$_prefix$decisionId', raw);
    } catch (_) {
      // Best-effort local persistence
    }
    return raw;
  }

  static Future<String?> getReceipt(String decisionId) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final saved = prefs.getString('$_prefix$decisionId');
      if (saved != null && saved.trim().isNotEmpty) {
        return saved.trim().toUpperCase();
      }
    } catch (_) {}
    return null;
  }

  static String fallbackDeterministicCode(String decisionId) {
    return sha256
        .convert(utf8.encode('ertad-participated-v1:$decisionId'))
        .toString()
        .substring(0, 16)
        .toUpperCase();
  }
}

/// Shows an immediate post-vote receipt modal with the unique verification code and copy button.
Future<void> showVoteReceiptModal(
  BuildContext context, {
  required String pollTitle,
  required String receiptCode,
}) {
  final formatted = VoteReceiptStore.formatCode(receiptCode);
  return showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (ctx) {
      final p = ctx.ertad;
      return Padding(
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 38,
              height: 4,
              decoration: BoxDecoration(
                color: p.hairline,
                borderRadius: BorderRadius.circular(999),
              ),
            ),
            const SizedBox(height: 18),
            const ErtadIconCircle(
              icon: Icons.verified_rounded,
              tone: ErtadTone.success,
              size: 56,
              iconSize: 30,
              radius: 18,
            ),
            const SizedBox(height: 12),
            Text(
              shellTr(ctx, 'vote_receipt_title', fallback: 'Vote Recorded'),
              style: Theme.of(
                ctx,
              ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 4),
            Text(
              pollTitle,
              style: Theme.of(
                ctx,
              ).textTheme.bodyMedium?.copyWith(color: p.muted),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 16),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              decoration: BoxDecoration(
                color: p.elevated,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: p.primary.withValues(alpha: 0.35)),
              ),
              child: Row(
                children: [
                  Icon(Icons.qr_code_2_rounded, color: p.primary, size: 22),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          shellTr(
                            ctx,
                            'vote_receipt_code_label',
                            fallback: 'Unique vote verification code',
                          ),
                          style: Theme.of(
                            ctx,
                          ).textTheme.labelSmall?.copyWith(color: p.muted),
                        ),
                        const SizedBox(height: 2),
                        SelectableText(
                          formatted,
                          style: Theme.of(ctx).textTheme.titleMedium?.copyWith(
                            fontFamily: 'monospace',
                            fontWeight: FontWeight.w800,
                            color: p.primary,
                          ),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: shellTr(ctx, 'copy', fallback: 'Copy'),
                    onPressed: () {
                      HapticFeedback.lightImpact();
                      Clipboard.setData(ClipboardData(text: formatted));
                      ScaffoldMessenger.of(ctx).showSnackBar(
                        SnackBar(
                          content: Text(
                            shellTr(
                              ctx,
                              'vote_receipt_copied',
                              fallback: 'Verification code copied',
                            ),
                          ),
                          duration: const Duration(seconds: 2),
                        ),
                      );
                    },
                    icon: Icon(Icons.copy_rounded, color: p.primary, size: 20),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            Text(
              shellTr(
                ctx,
                'decision_results_pending',
                fallback:
                    'Results will be published once voting closes. Use this code to verify your vote in the final tally.',
              ),
              style: Theme.of(
                ctx,
              ).textTheme.bodySmall?.copyWith(color: p.muted),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 18),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: () => Navigator.of(ctx).pop(),
                icon: const Icon(Icons.check_rounded),
                label: Text(shellTr(ctx, 'close', fallback: 'Close')),
              ),
            ),
          ],
        ),
      );
    },
  );
}

/// Clean 2-state view for Participated (`მიმდინარე`) and Closed (`დასრულებული`) decisions:
/// - In `მიმდინარე` (`!isClosed`): displays the "Vote Recorded" card + Unique Verification Code (no clutter).
/// - In `დასრულებული` (`isClosed`): displays the Final Results breakdown (polls/referendums/surveys) + Receipt verification.
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
  List<Map<String, dynamic>> _surveyQuestions = const [];
  List<String> _talliedReceipts = const [];
  String? _myReceiptCode;

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  Future<void> _loadData() async {
    final effectiveCode = await VoteReceiptStore.getReceipt(widget.poll.id);

    final session = ref.read(shellSessionProvider);
    final orgId = session.activeOrgId;
    if (!session.isLiveConnected || orgId.isEmpty || orgId.startsWith('org-')) {
      if (mounted) {
        setState(() {
          _myReceiptCode = effectiveCode;
          _loading = false;
        });
      }
      return;
    }
    try {
      final detail = await ref
          .read(mobileApiClientProvider)
          .fetchDecisionDetail(
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

      final rawSurvey = detail['surveyResults'];
      final parsedSurvey = rawSurvey is Map && rawSurvey['questions'] is List
          ? (rawSurvey['questions'] as List)
                .whereType<Map>()
                .map((e) => Map<String, dynamic>.from(e))
                .toList(growable: false)
          : rawSurvey is List
          ? rawSurvey
                .whereType<Map>()
                .map((e) => Map<String, dynamic>.from(e))
                .toList(growable: false)
          : const <Map<String, dynamic>>[];

      final rawReceipts = detail['receiptDigests'];
      final parsedReceipts = rawReceipts is List
          ? rawReceipts
                .map((e) => e.toString().trim().toUpperCase())
                .where((s) => s.isNotEmpty)
                .toList(growable: false)
          : const <String>[];

      final participation = (detail['participation'] as num?)?.toInt() ?? 0;
      final sumVotes = parsed.fold<int>(
        0,
        (acc, r) => acc + ((r['votes'] as num?)?.toInt() ?? 0),
      );
      setState(() {
        _myReceiptCode = effectiveCode;
        _suppressed = suppressed;
        _rows = parsed;
        _surveyQuestions = parsedSurvey;
        _talliedReceipts = parsedReceipts;
        _totalVotes = participation > 0 ? participation : sumVotes;
        _loading = false;
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          _myReceiptCode = effectiveCode;
          _loading = false;
        });
      }
    }
  }

  Widget _buildReceiptBox(BuildContext context, String rawCode) {
    final p = context.ertad;
    final formatted = VoteReceiptStore.formatCode(rawCode);
    final rawClean = rawCode.replaceAll('-', '').toUpperCase();
    final isVerifiedInTally =
        widget.isClosed &&
        _talliedReceipts.isNotEmpty &&
        _talliedReceipts.any(
          (r) => r.replaceAll('-', '').toUpperCase() == rawClean,
        );

    return ErtadSurfaceCard(
      padding: const EdgeInsets.all(16),
      backgroundColor: p.elevated,
      borderColor: isVerifiedInTally
          ? p.success.withValues(alpha: 0.45)
          : p.primary.withValues(alpha: 0.35),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                isVerifiedInTally
                    ? Icons.verified_rounded
                    : Icons.qr_code_2_rounded,
                color: isVerifiedInTally ? p.success : p.primary,
                size: 22,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      shellTr(
                        context,
                        'vote_receipt_code_label',
                        fallback: 'Unique vote verification code',
                      ),
                      style: Theme.of(
                        context,
                      ).textTheme.labelSmall?.copyWith(color: p.muted),
                    ),
                    const SizedBox(height: 2),
                    SelectableText(
                      formatted,
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        fontFamily: 'monospace',
                        fontWeight: FontWeight.w800,
                        color: isVerifiedInTally ? p.success : p.primary,
                      ),
                    ),
                  ],
                ),
              ),
              IconButton(
                tooltip: shellTr(context, 'copy', fallback: 'Copy'),
                onPressed: () {
                  HapticFeedback.lightImpact();
                  Clipboard.setData(ClipboardData(text: formatted));
                  ref.read(ertadFeedbackProvider.notifier).showSuccess(
                    shellTr(
                      context,
                      'vote_receipt_copied',
                      fallback: 'Verification code copied',
                    ),
                  );
                },
                icon: Icon(
                  Icons.copy_rounded,
                  color: isVerifiedInTally ? p.success : p.primary,
                  size: 19,
                ),
              ),
            ],
          ),
          if (isVerifiedInTally) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                Icon(Icons.check_circle_rounded, size: 15, color: p.success),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    shellTr(
                      context,
                      'vote_receipt_verified_in_tally',
                      fallback: 'Your vote code is verified in the final tally',
                    ),
                    style: Theme.of(context).textTheme.labelMedium?.copyWith(
                      color: p.success,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    if (_loading) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 12),
        child: LinearProgressIndicator(minHeight: 3),
      );
    }

    // 1. In-Progress Participated State (`მიმდინარე`: hasVoted && !isClosed)
    if (!widget.isClosed) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ErtadSurfaceCard(
            padding: const EdgeInsets.all(20),
            child: Column(
              children: [
                const ErtadIconCircle(
                  icon: Icons.verified_rounded,
                  tone: ErtadTone.success,
                  size: 56,
                  iconSize: 30,
                  radius: 18,
                ),
                const SizedBox(height: 12),
                Text(
                  shellTr(
                    context,
                    'vote_receipt_title',
                    fallback: 'Vote Recorded',
                  ),
                  style: Theme.of(context).textTheme.titleLarge?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 6),
                Text(
                  widget.poll.title,
                  style: Theme.of(
                    context,
                  ).textTheme.titleMedium?.copyWith(color: p.text),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 12),
                Text(
                  shellTr(
                    context,
                    'decision_results_pending',
                    fallback:
                        'Results will be published once voting closes. Use this code to verify your vote in the final tally.',
                  ),
                  style: Theme.of(
                    context,
                  ).textTheme.bodySmall?.copyWith(color: p.muted),
                  textAlign: TextAlign.center,
                ),
              ],
            ),
          ),
          if (_myReceiptCode != null) ...[
            const SizedBox(height: 12),
            _buildReceiptBox(context, _myReceiptCode!),
          ],
        ],
      );
    }

    // 2. Completed State (`დასრულებული`: isClosed)
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ErtadSurfaceCard(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                widget.poll.title,
                style: Theme.of(
                  context,
                ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
              ),
              if ((widget.poll.description ?? '').trim().isNotEmpty) ...[
                const SizedBox(height: 6),
                Text(
                  widget.poll.description!.trim(),
                  style: Theme.of(
                    context,
                  ).textTheme.bodySmall?.copyWith(color: p.muted),
                ),
              ],
              const SizedBox(height: 16),
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
                  if (_totalVotes > 0)
                    ErtadStatusPill(
                      label:
                          '$_totalVotes ${shellTr(context, 'decision_votes_count', fallback: 'votes')}',
                      tone: ErtadTone.primary,
                    ),
                ],
              ),
              const SizedBox(height: 14),
              if (_suppressed)
                ErtadStateBanner(
                  icon: Icons.visibility_off_outlined,
                  tone: ErtadTone.neutral,
                  message: shellTr(
                    context,
                    'decision_results_suppressed',
                    fallback: 'Results are hidden to protect anonymity',
                  ),
                )
              else if (_rows.isNotEmpty) ...[
                Builder(
                  builder: (context) {
                    final maxVotes = _rows.fold<int>(0, (m, r) {
                      final v = (r['votes'] as num?)?.toInt() ?? 0;
                      return v > m ? v : m;
                    });
                    return Column(
                      children: _rows.map((row) {
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
                                  if (isLeader) ...[
                                    Icon(
                                      Icons.emoji_events_rounded,
                                      size: 16,
                                      color: p.primary,
                                    ),
                                    const SizedBox(width: 6),
                                  ],
                                  Expanded(
                                    child: Text(
                                      label,
                                      style: Theme.of(context)
                                          .textTheme
                                          .bodyMedium
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
                                    style: Theme.of(context)
                                        .textTheme
                                        .labelMedium
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
                                  minHeight: 9,
                                  backgroundColor: p.elevated,
                                  valueColor: AlwaysStoppedAnimation<Color>(
                                    isLeader
                                        ? p.primary
                                        : p.muted.withValues(alpha: 0.45),
                                  ),
                                ),
                              ),
                            ],
                          ),
                        );
                      }).toList(),
                    );
                  },
                ),
              ] else if (_surveyQuestions.isNotEmpty) ...[
                ..._surveyQuestions.map((q) {
                  final qTitle =
                      q['title']?.toString() ?? q['questionText']?.toString() ?? '';
                  final opts = ((q['results'] ?? q['options']) as List? ?? const [])
                      .whereType<Map>()
                      .map((e) => Map<String, dynamic>.from(e))
                      .toList();
                  final answered = (q['answered'] as num?)?.toInt();
                  final average = q['average'];
                  final texts = (q['texts'] as List? ?? const [])
                      .map((e) => e.toString())
                      .where((s) => s.isNotEmpty)
                      .toList();
                  final qSum = opts.fold<int>(
                    0,
                    (acc, o) => acc + ((o['count'] ?? o['votes'] ?? 0) as num).toInt(),
                  );
                  final denom = qSum > 0 ? qSum : (answered ?? 0);
                  return Padding(
                    padding: const EdgeInsets.only(bottom: 14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          qTitle,
                          style: Theme.of(context).textTheme.titleSmall?.copyWith(
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        if (answered != null || average != null) ...[
                          const SizedBox(height: 4),
                          Text(
                            [
                              if (answered != null)
                                '${shellTr(context, 'survey_responses_label', fallback: 'Responses')}: $answered',
                              if (average != null)
                                '${shellTr(context, 'survey_average_label', fallback: 'Average')}: $average',
                            ].join(' · '),
                            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                              color: p.muted,
                            ),
                          ),
                        ],
                        const SizedBox(height: 8),
                        ...opts.map((o) {
                          final oLabel =
                              o['label']?.toString() ?? o['text']?.toString() ?? '';
                          final count =
                              ((o['count'] ?? o['votes'] ?? 0) as num).toInt();
                          final ratio = denom > 0 ? count / denom : 0.0;
                          final pct = (ratio * 100).round();
                          return Padding(
                            padding: const EdgeInsets.only(bottom: 8),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    Expanded(
                                      child: Text(
                                        oLabel,
                                        style: Theme.of(context).textTheme.bodySmall,
                                      ),
                                    ),
                                    Text(
                                      '$pct% ($count)',
                                      style: Theme.of(context)
                                          .textTheme
                                          .labelSmall
                                          ?.copyWith(fontWeight: FontWeight.w700),
                                    ),
                                  ],
                                ),
                                const SizedBox(height: 4),
                                ClipRRect(
                                  borderRadius: BorderRadius.circular(999),
                                  child: LinearProgressIndicator(
                                    value: ratio.clamp(0.0, 1.0),
                                    minHeight: 7,
                                    backgroundColor: p.elevated,
                                    valueColor: AlwaysStoppedAnimation<Color>(
                                      p.primary,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          );
                        }),
                        if (texts.isNotEmpty) ...[
                          const SizedBox(height: 6),
                          ...texts.map(
                            (txt) => Padding(
                              padding: const EdgeInsets.only(bottom: 4),
                              child: Text(
                                '• $txt',
                                style: Theme.of(context).textTheme.bodySmall,
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                  );
                }),
              ] else ...[
                // Fallback when local preview / offline poll has options without live tally
                ...widget.poll.options.map((opt) {
                  return Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Row(
                      children: [
                        Icon(Icons.circle, size: 7, color: p.muted),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            opt.text,
                            style: Theme.of(context).textTheme.bodyMedium,
                          ),
                        ),
                      ],
                    ),
                  );
                }),
              ],
            ],
          ),
        ),
        if (_myReceiptCode != null) ...[
          const SizedBox(height: 12),
          _buildReceiptBox(context, _myReceiptCode!),
        ],
      ],
    );
  }
}
