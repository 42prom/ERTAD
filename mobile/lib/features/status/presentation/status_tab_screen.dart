import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:share_plus/share_plus.dart';

import '../../../core/feedback/ertad_feedback.dart';
import '../../../core/shell/shell_l10n.dart';
import '../../../core/shell/tab_scroll_registry.dart';
import '../../../core/state/shell_providers.dart';
import '../../../core/theme/ertad_theme.dart';
import '../../../core/widgets/ertad_ui.dart';

/// Status tab (index 0): #61 live contribution points, activity ledger & privacy/membership.
class StatusTabScreen extends ConsumerWidget {
  final ValueChanged<int>? onSwitchTab;

  const StatusTabScreen({super.key, this.onSwitchTab});

  String _categoryLabel(BuildContext context, String category) {
    return switch (category.toLowerCase()) {
      'vote' => shellTr(
        context,
        'status_pts_source_vote',
        fallback: 'Decision Vote',
      ),
      'survey' => shellTr(
        context,
        'status_pts_source_survey',
        fallback: 'Survey',
      ),
      'task' => shellTr(
        context,
        'status_pts_source_task',
        fallback: 'Task / Event',
      ),
      'referral_join' => shellTr(
        context,
        'status_pts_source_ref_join',
        fallback: 'Referral signup',
      ),
      'referral_verified' => shellTr(
        context,
        'status_pts_source_ref_verified',
        fallback: 'Referral verification',
      ),
      'referral_l2_verified' => shellTr(
        context,
        'status_pts_source_ref_l2',
        fallback: 'Level-2 referral',
      ),
      _ => shellTr(
        context,
        'status_pts_source_manual',
        fallback: 'Group Recognition',
      ),
    };
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(shellSessionProvider);
    final controller = ref.watch(tabScrollRegistryProvider).controllerFor(0);

    final entries = session.contributionEntries;

    return ErtadTabScrollView(
      controller: controller,
      onRefresh: () async {
        await ref.read(shellSessionProvider.notifier).refreshWorkspace();
        if (!context.mounted) return;
        if (ref.read(shellSessionProvider).isOffline) {
          ref.read(ertadFeedbackProvider.notifier).showWarning(
            shellTr(
              context,
              'session_check_unavailable',
              fallback: 'Connection unavailable. Pull down to retry syncing.',
            ),
          );
        }
      },
      children: [
        // 1. Clean Contribution Points Hero Card (zero technical badges or verbose notes)
        ErtadSurfaceCard(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              const ErtadIconCircle(
                icon: Icons.stars_rounded,
                tone: ErtadTone.primary,
                size: 46,
                iconSize: 22,
                radius: 14,
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${session.contributionBalance} ${shellTr(context, 'status_points_unit', fallback: 'pts')}',
                      style: Theme.of(context).textTheme.headlineSmall
                          ?.copyWith(
                            fontWeight: FontWeight.w800,
                            letterSpacing: -0.4,
                          ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      shellTr(
                        context,
                        'status_points_title',
                        fallback: 'Contribution Points',
                      ),
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),

        const SizedBox(height: 14),

        // 2. Personal Referral Hierarchy & Points Card
        _PersonalReferralsCard(
          summary: session.referralSummary,
          onCopyCode: (code) {
            HapticFeedback.lightImpact();
            Clipboard.setData(ClipboardData(text: code));
            ref.read(ertadFeedbackProvider.notifier).showSuccess(
                  shellTr(
                    context,
                    'profile_code_copied',
                    fallback: 'Personal referral code copied',
                  ),
                );
          },
          onShareCode: (code) {
            HapticFeedback.selectionClick();
            SharePlus.instance.share(ShareParams(text: 'ERTAD · $code'));
          },
        ),

        const SizedBox(height: 18),

        // 3. Real Activity Ledger (#61: what happened, why, source, verified status)
        ErtadSectionHeader(
          icon: Icons.history_toggle_off_rounded,
          title: shellTr(
            context,
            'status_activity_history',
            fallback: 'My Activity Ledger',
          ),
          tone: ErtadTone.primary,
        ),
        const SizedBox(height: 10),
        if (entries.isEmpty)
          ErtadEmptyState(
            icon: Icons.verified_outlined,
            title: shellTr(
              context,
              'status_activity_history',
              fallback: 'My Activity Ledger',
            ),
            body: shellTr(
              context,
              'status_no_points_yet',
              fallback:
                  'No earned contribution entries yet — verified participation appears here',
            ),
            tone: ErtadTone.primary,
          )
        else
          ErtadSurfaceCard(
            child: Column(
              children: List.generate(entries.length, (i) {
                final item = entries[i];
                final pts = (item['points'] as num?)?.toInt() ?? 0;
                final category = item['category']?.toString() ?? 'manual';
                final reason = (item['reason']?.toString() ?? '').trim();
                final src = item['recognitionSource'];
                final srcTitle = src is Map
                    ? (src['title']?.toString() ?? '')
                    : '';
                final date = item['date']?.toString() ?? '';
                final isPositive = pts >= 0;

                return ErtadTimelineTile(
                  icon: isPositive
                      ? Icons.add_circle_outline_rounded
                      : Icons.remove_circle_outline_rounded,
                  tone: isPositive ? ErtadTone.success : ErtadTone.warning,
                  title: srcTitle.isNotEmpty
                      ? srcTitle
                      : _categoryLabel(context, category),
                  subtitle: [
                    if (reason.isNotEmpty) reason,
                    if (date.isNotEmpty) date,
                  ].join(' · '),
                  trailingValue: '${isPositive ? '+' : ''}$pts',
                  isLast: i == entries.length - 1,
                );
              }),
            ),
          ),

        const SizedBox(height: 20),

        // 4. Current Involvement Summary (#61 Membership & Scope overview)
        ErtadSectionHeader(
          icon: Icons.workspace_premium_outlined,
          title: shellTr(
            context,
            'status_my_involvement',
            fallback: 'My Participation & Qualifications',
          ),
          tone: ErtadTone.secondary,
        ),
        const SizedBox(height: 10),
        ErtadSurfaceCard(
          child: Column(
            children: [
              ErtadTimelineTile(
                icon: Icons.task_alt_rounded,
                tone: ErtadTone.primary,
                title: shellTr(context, 'tasks_tab_mine', fallback: 'Mine'),
                subtitle: shellTr(
                  context,
                  'activity_ready',
                  fallback: 'Ready for participation',
                ),
                trailingValue: '${session.myWorkItems.length}',
                onTap: () {
                  ref.read(tasksSegmentRequestProvider.notifier).state = 1;
                  if (onSwitchTab != null) {
                    onSwitchTab!(3);
                  } else {
                    GoRouter.maybeOf(context)?.go('/tasks');
                  }
                },
              ),
              ErtadTimelineTile(
                icon: Icons.event_available_rounded,
                tone: ErtadTone.success,
                title: shellTr(
                  context,
                  'tasks_tab_events',
                  fallback: 'Events',
                ),
                subtitle: session.liveEvents.isNotEmpty
                    ? (session.liveEvents.first['title']?.toString() ?? '')
                    : shellTr(
                        context,
                        'activity_ready',
                        fallback: 'Ready for participation',
                      ),
                trailingValue: '${session.liveEvents.length}',
                onTap: () {
                  ref.read(tasksSegmentRequestProvider.notifier).state = 2;
                  if (onSwitchTab != null) {
                    onSwitchTab!(3);
                  } else {
                    GoRouter.maybeOf(context)?.go('/tasks');
                  }
                },
              ),
              ErtadTimelineTile(
                icon: Icons.how_to_vote_rounded,
                tone: ErtadTone.secondary,
                title: shellTr(context, 'nav_polls', fallback: 'Polls'),
                subtitle: shellTr(
                  context,
                  'polls_tab_history',
                  fallback: 'History',
                ),
                trailingValue:
                    '${{...session.historyPolls.map((p) => p.id), ...session.livePolls.where((p) => p.hasVoted).map((p) => p.id)}.length}',
                isLast: true,
                onTap: () {
                  ref.read(pollsSegmentRequestProvider.notifier).state = 2;
                  if (onSwitchTab != null) {
                    onSwitchTab!(4);
                  } else {
                    GoRouter.maybeOf(context)?.go('/polls');
                  }
                },
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _PersonalReferralsCard extends StatelessWidget {
  final Map<String, dynamic>? summary;
  final ValueChanged<String> onCopyCode;
  final ValueChanged<String> onShareCode;

  const _PersonalReferralsCard({
    required this.summary,
    required this.onCopyCode,
    required this.onShareCode,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final directCount = (summary?['directCount'] as num?)?.toInt() ?? 0;
    final directVerified =
        (summary?['directVerifiedCount'] as num?)?.toInt() ?? 0;
    final networkTotal = (summary?['networkTotalCount'] as num?)?.toInt() ?? 0;
    final pointsEarned = (summary?['pointsEarned'] as num?)?.toInt() ?? 0;
    final personalCode = summary?['personalCode']?.toString() ?? '';
    final invitedBy = summary?['invitedBy'] is Map
        ? Map<String, dynamic>.from(summary!['invitedBy'] as Map)
        : null;
    final invitees = (summary?['directInvitees'] as List? ?? const [])
        .whereType<Map>()
        .map(Map<String, dynamic>.from)
        .toList(growable: false);
    final rules = summary?['rules'] is Map
        ? Map<String, dynamic>.from(summary!['rules'] as Map)
        : const <String, dynamic>{};

    final joinRule = rules['referralJoin'] is Map
        ? Map<String, dynamic>.from(rules['referralJoin'] as Map)
        : const <String, dynamic>{};
    final verRule = rules['referralVerified'] is Map
        ? Map<String, dynamic>.from(rules['referralVerified'] as Map)
        : const <String, dynamic>{};
    final l2Rule = rules['referralL2Verified'] is Map
        ? Map<String, dynamic>.from(rules['referralL2Verified'] as Map)
        : const <String, dynamic>{};

    final ruleParts = <String>[
      if (joinRule['enabled'] == true && (joinRule['amount'] as num? ?? 0) > 0)
        '${shellTr(context, 'status_pts_source_ref_join', fallback: 'Signup')} +${joinRule['amount']}',
      if (verRule['enabled'] == true && (verRule['amount'] as num? ?? 0) > 0)
        '${shellTr(context, 'ref_verified_label', fallback: 'Verified')} +${verRule['amount']}',
      if (l2Rule['enabled'] == true && (l2Rule['amount'] as num? ?? 0) > 0)
        'L2 +${l2Rule['amount']}',
    ];

    return ErtadSurfaceCard(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const ErtadIconCircle(
                icon: Icons.account_tree_rounded,
                tone: ErtadTone.secondary,
                size: 42,
                iconSize: 20,
                radius: 13,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      shellTr(
                        context,
                        'ref_status_title',
                        fallback: 'My Referrals',
                      ),
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    if (invitedBy != null) ...[
                      const SizedBox(height: 2),
                      Text(
                        '${shellTr(context, 'ref_invited_by', fallback: 'Invited by')}: ${invitedBy['displayLabel'] ?? invitedBy['code'] ?? ''}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(
                          context,
                        ).textTheme.bodySmall?.copyWith(color: p.muted),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: _RefStatCell(
                  value: '$directCount',
                  subtitle: '$directVerified ${shellTr(context, 'ref_verified_label', fallback: 'Verified')}',
                  label: shellTr(context, 'ref_direct_label', fallback: 'Direct'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _RefStatCell(
                  value: '$networkTotal',
                  label: shellTr(
                    context,
                    'ref_network_label',
                    fallback: 'Network',
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _RefStatCell(
                  value: '+$pointsEarned',
                  label: shellTr(
                    context,
                    'ref_points_label',
                    fallback: 'Points',
                  ),
                  highlight: true,
                ),
              ),
            ],
          ),
          if (ruleParts.isNotEmpty) ...[
            const SizedBox(height: 10),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
              decoration: BoxDecoration(
                color: p.primarySoft,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text(
                ruleParts.join(' · '),
                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                      color: p.primary,
                      fontWeight: FontWeight.w600,
                    ),
              ),
            ),
          ],
          if (personalCode.isNotEmpty) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: p.elevated,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: p.hairline),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          shellTr(
                            context,
                            'profile_referral_title',
                            fallback: 'My personal referral code',
                          ),
                          style: Theme.of(
                            context,
                          ).textTheme.labelSmall?.copyWith(color: p.muted),
                        ),
                        const SizedBox(height: 2),
                        SelectableText(
                          personalCode,
                          style: Theme.of(context).textTheme.titleSmall
                              ?.copyWith(
                                fontFamily: 'monospace',
                                fontWeight: FontWeight.w700,
                                color: p.primary,
                              ),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: shellTr(context, 'copy', fallback: 'Copy'),
                    onPressed: () => onCopyCode(personalCode),
                    icon: const Icon(Icons.copy_rounded, size: 18),
                  ),
                  IconButton(
                    tooltip: shellTr(
                      context,
                      'profile_share_invite',
                      fallback: 'Share',
                    ),
                    onPressed: () => onShareCode(personalCode),
                    icon: const Icon(Icons.share_rounded, size: 18),
                  ),
                ],
              ),
            ),
          ],
          if (invitees.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text(
              shellTr(
                context,
                'ref_direct_list_title',
                fallback: 'My invitees',
              ),
              style: Theme.of(
                context,
              ).textTheme.labelMedium?.copyWith(color: p.muted),
            ),
            const SizedBox(height: 6),
            ...invitees.take(5).map((inv) {
              final verified = inv['verified'] == true;
              return Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(
                  children: [
                    Icon(
                      verified
                          ? Icons.verified_rounded
                          : Icons.person_outline_rounded,
                      size: 16,
                      color: verified ? p.success : p.muted,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        inv['displayLabel']?.toString() ?? 'Member',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ),
                    ErtadStatusPill(
                      label: verified
                          ? shellTr(
                              context,
                              'ref_verified_label',
                              fallback: 'Verified',
                            )
                          : shellTr(
                              context,
                              'status_pending',
                              fallback: 'Pending',
                            ),
                      tone: verified ? ErtadTone.success : ErtadTone.neutral,
                    ),
                  ],
                ),
              );
            }),
          ] else ...[
            const SizedBox(height: 10),
            Text(
              shellTr(
                context,
                'ref_empty',
                fallback: 'No invitees yet — share your personal code.',
              ),
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(color: p.muted),
            ),
          ],
        ],
      ),
    );
  }
}

class _RefStatCell extends StatelessWidget {
  final String value;
  final String label;
  final String? subtitle;
  final bool highlight;

  const _RefStatCell({
    required this.value,
    required this.label,
    this.subtitle,
    this.highlight = false,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
      decoration: BoxDecoration(
        color: highlight ? p.primarySoft : p.elevated,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: highlight ? p.primary : p.hairline),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              value,
              style: Theme.of(context).textTheme.titleLarge?.copyWith(
                    fontWeight: FontWeight.w800,
                    color: highlight ? p.primary : p.text,
                  ),
            ),
          ),
          const SizedBox(height: 2),
          Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(
              context,
            ).textTheme.labelSmall?.copyWith(color: p.muted),
          ),
          if (subtitle != null) ...[
            const SizedBox(height: 1),
            Text(
              subtitle!,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: p.success,
                    fontSize: 10,
                  ),
            ),
          ],
        ],
      ),
    );
  }
}
