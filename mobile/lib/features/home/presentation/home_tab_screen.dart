import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/feedback/ertad_feedback.dart';
import '../../../core/shell/account_privacy_sheet.dart';
import '../../../core/shell/inbox_sheet.dart';
import '../../../core/shell/org_context_sheet.dart';
import '../../../core/shell/shell_l10n.dart';
import '../../../core/shell/tab_scroll_registry.dart';
import '../../../core/state/shell_providers.dart';
import '../../../core/theme/ertad_theme.dart';
import '../../../core/widgets/ertad_ui.dart';
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

    final (String privacyLabel, ErtadTone privacyTone, IconData privacyIcon) =
        switch (session.privacyLevel) {
          PrivacyDisclosureLevel.privateHidden => (
            shellTr(context, 'privacy_private', fallback: 'Private (Default)'),
            ErtadTone.success,
            Icons.visibility_off_rounded,
          ),
          PrivacyDisclosureLevel.sharedContextOptIn => (
            shellTr(
              context,
              'privacy_optin',
              fallback: 'Shared-context Opt-in',
            ),
            ErtadTone.warning,
            Icons.badge_rounded,
          ),
        };

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

        // 1. Clear Group & Privacy Card (obvious tap targets, zero tiny header dropdown)
        ErtadSurfaceCard(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: () => showOrgContextSheet(context),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 2),
                  child: Row(
                    children: [
                      const ErtadIconCircle(
                        icon: Icons.groups_2_rounded,
                        tone: ErtadTone.primary,
                        size: 44,
                        iconSize: 22,
                        radius: 14,
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              session.activeOrg.unitName,
                              style: Theme.of(context).textTheme.titleMedium,
                            ),
                            const SizedBox(height: 2),
                            Text(
                              session.activeOrg.name,
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ],
                        ),
                      ),
                      Icon(
                        Icons.swap_horiz_rounded,
                        size: 20,
                        color: p.primary,
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 12),
              Divider(height: 1, color: p.hairline),
              const SizedBox(height: 12),
              InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: () => showAccountPrivacySheet(context),
                child: Row(
                  children: [
                    Expanded(
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: ErtadStatusPill(
                          label: privacyLabel,
                          icon: privacyIcon,
                          tone: privacyTone,
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Icon(
                      Icons.chevron_right_rounded,
                      size: 20,
                      color: p.muted,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),

        const SizedBox(height: 14),

        // 2. Two Crisp Member Quick-Navigation Summary Cards
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

        const SizedBox(height: 20),

        // 3. Clean Unified Member Action Queue (no duplicate second feed)
        ErtadSectionHeader(
          icon: Icons.bolt_rounded,
          title: shellTr(
            context,
            'home_requires_action',
            fallback: 'Requires your action',
          ),
          tone: ErtadTone.primary,
          trailing: ActionChip(
            avatar: Icon(
              Icons.notifications_none_rounded,
              size: 16,
              color: session.unreadInboxCount > 0 ? p.danger : p.primary,
            ),
            label: Text(
              '${session.unreadInboxCount > 0 ? session.unreadInboxCount : session.liveInboxItems.length}',
            ),
            onPressed: () => showInboxSheet(context),
          ),
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
              ref.read(tasksSegmentRequestProvider.notifier).state = 4;
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
