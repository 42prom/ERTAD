import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/feedback/ertad_feedback.dart';
import '../../../core/shell/inbox_sheet.dart';
import '../../../core/shell/shell_l10n.dart';
import '../../../core/shell/tab_scroll_registry.dart';
import '../../../core/state/shell_providers.dart';
import '../../../core/theme/ertad_theme.dart';
import '../../../core/widgets/ertad_ui.dart';
import '../../../screens/enrollment/intro_screen.dart';
import 'group_reviews_sheet.dart';

/// Center Home tab (index 2): calm plain-member operational hub with zero clutter.
class HomeTabScreen extends ConsumerWidget {
  final ValueChanged<int>? onSwitchTab;

  const HomeTabScreen({super.key, this.onSwitchTab});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = context.ertad;
    final session = ref.watch(shellSessionProvider);
    final controller = ref.watch(tabScrollRegistryProvider).controllerFor(2);

    final openWorkAndEvents = session.openWorkCount + session.upcomingEvents48h;

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
            actionLabel: shellTr(context, 'retry', fallback: 'Retry'),
            onAction: () =>
                ref.read(shellSessionProvider.notifier).connectDevSession(),
          );
        }
      },
      children: [
        if (session.isOffline) ...[
          ErtadStateBanner(
            icon: Icons.cloud_off_rounded,
            tone: ErtadTone.warning,
            message: shellTr(
              context,
              'session_check_unavailable',
              fallback: 'Connection unavailable. Pull down to retry syncing.',
            ),
            actionLabel: shellTr(context, 'retry', fallback: 'Retry'),
            onAction: () =>
                ref.read(shellSessionProvider.notifier).connectDevSession(),
          ),
          const SizedBox(height: 12),
        ],

        if (session.isLiveConnected &&
            session.m4AssuranceLevel != 'biometric_verified') ...[
          ErtadStateBanner(
            icon: Icons.verified_user_outlined,
            tone: ErtadTone.primary,
            message: shellTr(
              context,
              'zt_banner_home',
              fallback:
                  'Complete eID biometric verification to unlock chats, voting, and tasks.',
            ),
            actionLabel: shellTr(
              context,
              'profile_verify_cta',
              fallback: 'Verify identity',
            ),
            onAction: () => Navigator.of(context, rootNavigator: true).push(
              MaterialPageRoute<void>(builder: (_) => const IntroScreen()),
            ),
          ),
          const SizedBox(height: 12),
        ],

        // 1. Crisp Member Quick-Navigation Summary Tiles (Polls, Tasks, Points)
        IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: ErtadMetricTile(
                  label: shellTr(context, 'nav_polls', fallback: 'Polls'),
                  value: '${session.openDecisionsCount}',
                  sublabel: shellTr(
                    context,
                    'active_label',
                    fallback: 'active',
                  ),
                  icon: Icons.how_to_vote_rounded,
                  subIcon: Icons.arrow_forward_rounded,
                  tone: ErtadTone.primary,
                  onTap: () => onSwitchTab?.call(4),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: ErtadMetricTile(
                  label: shellTr(context, 'nav_tasks', fallback: 'Tasks'),
                  value: '$openWorkAndEvents',
                  sublabel: shellTr(
                    context,
                    'open_label',
                    fallback: 'open',
                  ),
                  icon: Icons.task_alt_rounded,
                  subIcon: Icons.arrow_forward_rounded,
                  tone: ErtadTone.success,
                  onTap: () => onSwitchTab?.call(3),
                ),
              ),
            ],
          ),
        ),

        const SizedBox(height: 10),

        // Compact Points & Referrals Quick Row
        ErtadSurfaceCard(
          onTap: () => onSwitchTab?.call(0),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(
            children: [
              const ErtadIconCircle(
                icon: Icons.stars_rounded,
                tone: ErtadTone.secondary,
                size: 38,
                iconSize: 19,
                radius: 12,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  '${session.contributionBalance} ${shellTr(context, 'status_points_unit', fallback: 'pts')}',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                ),
              ),
              Icon(Icons.chevron_right_rounded, color: p.muted, size: 20),
            ],
          ),
        ),

        const SizedBox(height: 18),

        // 2. Clean Unified Member Action Queue
        ErtadSectionHeader(
          icon: Icons.bolt_rounded,
          title: shellTr(
            context,
            'home_requires_action',
            fallback: 'Requires your action',
          ),
          tone: ErtadTone.primary,
        ),
        const SizedBox(height: 10),
        if (session.urgentItems.isEmpty)
          ErtadEmptyState(
            icon: Icons.check_circle_outline_rounded,
            title: shellTr(
              context,
              'inbox_empty_title',
              fallback: 'All caught up',
            ),
            body: shellTr(
              context,
              'all_caught_up_actions',
              fallback: 'No pending items waiting for your action right now.',
            ),
            tone: ErtadTone.primary,
          )
        else
          ...session.urgentItems.take(5).map((item) {
            final kind = item['kind']?.toString() ?? 'item';
            final itemId = item['id']?.toString() ?? '';
            final title =
                item['title']?.toString() ??
                shellTr(
                  context,
                  'home_requires_action',
                  fallback: 'Requires your action',
                );
            final (
              IconData itemIcon,
              ErtadTone itemTone,
              String kindLabel,
              int targetTab,
            ) = switch (kind) {
              'decision' => (
                Icons.how_to_vote_rounded,
                ErtadTone.primary,
                shellTr(context, 'nav_polls', fallback: 'Polls'),
                4,
              ),
              'event' => (
                Icons.event_available_rounded,
                ErtadTone.success,
                shellTr(context, 'tasks_filter_events', fallback: 'Events'),
                3,
              ),
              _ => (
                Icons.task_alt_rounded,
                ErtadTone.secondary,
                shellTr(context, 'nav_tasks', fallback: 'Tasks'),
                3,
              ),
            };
            return Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: ErtadSurfaceCard(
                onTap: () => openMemberDomainItem(
                  context,
                  ref,
                  source: kind == 'item' ? 'work' : kind,
                  id: itemId,
                  onTabFallback: () => onSwitchTab?.call(targetTab),
                ),
                child: Row(
                  children: [
                    ErtadIconCircle(icon: itemIcon, tone: itemTone),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            title,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                          const SizedBox(height: 3),
                          Text(
                            kindLabel,
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                    Icon(Icons.chevron_right_rounded, color: p.muted),
                  ],
                ),
              ),
            );
          }),

        if (session.isGroupManager) ...[
          const SizedBox(height: 16),
          ErtadSectionHeader(
            icon: Icons.manage_accounts_outlined,
            tone: ErtadTone.warning,
            title: shellTr(
              context,
              'mgr_section_title',
              fallback: 'Group management',
            ),
          ),
          const SizedBox(height: 10),
          ErtadSurfaceCard(
            onTap: () => showGroupReviewsSheet(context),
            child: Row(
              children: [
                const ErtadIconCircle(
                  icon: Icons.how_to_reg_outlined,
                  tone: ErtadTone.warning,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        shellTr(
                          context,
                          'mgr_reviews_title',
                          fallback: 'Membership reviews',
                        ),
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '${session.pendingReviews.length} ${shellTr(context, 'mgr_pending_word', fallback: 'pending')}',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
                Icon(Icons.chevron_right_rounded, color: p.muted),
              ],
            ),
          ),
          const SizedBox(height: 10),
          ErtadSurfaceCard(
            onTap: () {
              ref.read(tasksSegmentRequestProvider.notifier).state = 3;
              onSwitchTab?.call(3);
            },
            child: Row(
              children: [
                const ErtadIconCircle(
                  icon: Icons.fact_check_outlined,
                  tone: ErtadTone.primary,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        shellTr(
                          context,
                          'mgr_work_reviews_title',
                          fallback: 'Task verification',
                        ),
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '${session.reviewWorkItems.length} ${shellTr(context, 'mgr_pending_word', fallback: 'pending')}',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
                Icon(Icons.chevron_right_rounded, color: p.muted),
              ],
            ),
          ),
        ],
      ],
    );
  }
}
