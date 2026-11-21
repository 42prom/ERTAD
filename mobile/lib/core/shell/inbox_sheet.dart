import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/tasks/presentation/event_detail_screen.dart';
import '../../features/tasks/presentation/work_detail_screen.dart';
import '../../models/poll.dart';
import '../../screens/dashboard/poll_card.dart';
import '../feedback/ertad_feedback.dart';
import '../state/shell_providers.dart';
import '../theme/ertad_theme.dart';
import '../widgets/ertad_ui.dart';
import 'shell_l10n.dart';

/// Opens the unified personal inbox modal sheet anchored to the universal header bell.
Future<void> showInboxSheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => const InboxSheet(),
  );
}

/// Shared metadata mapper for canonical /mobile/inbox entries.
({IconData icon, ErtadTone tone, String label}) inboxSourceMeta(
  BuildContext context,
  String source,
) {
  return switch (source.toLowerCase()) {
    'decision' => (
      icon: Icons.how_to_vote_rounded,
      tone: ErtadTone.primary,
      label: shellTr(context, 'src_decision', fallback: 'Decision'),
    ),
    'work' => (
      icon: Icons.task_alt_rounded,
      tone: ErtadTone.secondary,
      label: shellTr(context, 'src_work', fallback: 'Task'),
    ),
    'event' => (
      icon: Icons.event_available_rounded,
      tone: ErtadTone.success,
      label: shellTr(context, 'src_event', fallback: 'Event'),
    ),
    'moderation' => (
      icon: Icons.gavel_rounded,
      tone: ErtadTone.warning,
      label: shellTr(context, 'src_moderation', fallback: 'Moderation'),
    ),
    'contribution' => (
      icon: Icons.stars_rounded,
      tone: ErtadTone.success,
      label: shellTr(context, 'src_contribution', fallback: 'Contribution'),
    ),
    'membership' => (
      icon: Icons.badge_outlined,
      tone: ErtadTone.primary,
      label: shellTr(context, 'src_membership', fallback: 'Membership'),
    ),
    'unit' => (
      icon: Icons.groups_outlined,
      tone: ErtadTone.primary,
      label: shellTr(context, 'src_unit', fallback: 'Group'),
    ),
    _ => (
      icon: Icons.notifications_none_rounded,
      tone: ErtadTone.neutral,
      label: shellTr(context, 'src_collective', fallback: 'Notice'),
    ),
  };
}

/// Navigates directly from an inbox/home domain entry to its target screen or tab.
Future<void> openMemberDomainItem(
  BuildContext context,
  WidgetRef ref, {
  required String source,
  required String id,
  bool closeModal = false,
  VoidCallback? onTabFallback,
}) async {
  final session = ref.read(shellSessionProvider);
  final rootNav = Navigator.of(context, rootNavigator: true);
  final hostContext = rootNav.context;
  final router = GoRouter.maybeOf(hostContext);

  if (closeModal && rootNav.canPop()) {
    rootNav.pop();
  }

  final lower = source.toLowerCase();
  if (lower == 'decision') {
    Poll? match;
    for (final p in [...session.livePolls, ...session.historyPolls]) {
      if (p.id == id) {
        match = p;
        break;
      }
    }
    if (match != null && hostContext.mounted) {
      await openPollDecision(hostContext, match);
      return;
    }
    if (onTabFallback != null) {
      onTabFallback();
    } else {
      router?.go('/polls');
    }
    return;
  }

  if (lower == 'work') {
    Map<String, dynamic>? match;
    for (final w in [
      ...session.liveWorkItems,
      ...session.myWorkItems,
      ...session.historyWorkItems,
      ...session.reviewWorkItems,
    ]) {
      if (w['id']?.toString() == id) {
        match = w;
        break;
      }
    }
    if (match != null && hostContext.mounted) {
      await showWorkDetailSheet(
        hostContext,
        organizationId: session.activeOrgId,
        initialWork: match,
      );
      return;
    }
    if (onTabFallback != null) {
      onTabFallback();
    } else {
      router?.go('/tasks');
    }
    return;
  }

  if (lower == 'event') {
    Map<String, dynamic>? match;
    for (final ev in session.liveEvents) {
      if (ev['id']?.toString() == id) {
        match = ev;
        break;
      }
    }
    if (match != null && hostContext.mounted) {
      await showEventDetailSheet(
        hostContext,
        organizationId: session.activeOrgId,
        initialEvent: match,
      );
      return;
    }
    if (onTabFallback != null) {
      onTabFallback();
    } else {
      router?.go('/tasks');
    }
    return;
  }

  if (onTabFallback != null) {
    onTabFallback();
  } else {
    router?.go('/status');
  }
}

/// Builds a standardized inbox card shared by both [InboxSheet] and SYSTEM Messages.
class InboxEntryCard extends ConsumerWidget {
  final Map<String, dynamic> item;
  final bool closeModalOnTap;

  const InboxEntryCard({
    super.key,
    required this.item,
    this.closeModalOnTap = false,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = context.ertad;
    final source = item['source']?.toString() ?? '';
    final id = item['id']?.toString() ?? '';
    final version = (item['version'] as num?)?.toInt() ?? 1;
    final title = item['title']?.toString() ?? '';
    final unitName = item['unitName']?.toString() ?? '';
    final rawStatus = item['status']?.toString() ?? '';
    final status = rawStatus == 'open'
        ? shellTr(context, 'open_label', fallback: 'open')
        : rawStatus == 'active'
        ? shellTr(context, 'active_label', fallback: 'active')
        : rawStatus;
    final unread = item['unread'] == true;
    final action = item['action']?.toString() ?? '';
    final meta = inboxSourceMeta(context, source);

    final subtitleParts = <String>[
      if (unitName.isNotEmpty) unitName,
      if (status.isNotEmpty) status,
    ];
    final subtitle = subtitleParts.join(' · ');

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: ErtadSurfaceCard(
        padding: const EdgeInsets.all(14),
        borderColor: unread ? p.primary.withValues(alpha: 0.32) : null,
        onTap: id.isEmpty
            ? null
            : () async {
                if (unread) {
                  try {
                    await ref
                        .read(shellSessionProvider.notifier)
                        .markInboxEntryRead(
                          source: source,
                          id: id,
                          version: version,
                        );
                  } catch (err) {
                    if (context.mounted) {
                      ref.read(ertadFeedbackProvider.notifier).showError(err);
                    }
                  }
                }
                if (!context.mounted) return;
                await openMemberDomainItem(
                  context,
                  ref,
                  source: source,
                  id: id,
                  closeModal: closeModalOnTap,
                );
              },
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ErtadIconCircle(
              icon: meta.icon,
              tone: unread ? meta.tone : ErtadTone.neutral,
              size: 42,
              iconSize: 21,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          title,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.titleMedium
                              ?.copyWith(
                                fontWeight: unread
                                    ? FontWeight.w700
                                    : FontWeight.w600,
                              ),
                        ),
                      ),
                      if (unread) ...[
                        const SizedBox(width: 8),
                        Container(
                          width: 9,
                          height: 9,
                          decoration: BoxDecoration(
                            color: p.primary,
                            shape: BoxShape.circle,
                          ),
                        ),
                      ],
                      const SizedBox(width: 6),
                      Icon(
                        Icons.chevron_right_rounded,
                        size: 20,
                        color: p.muted,
                      ),
                    ],
                  ),
                  if (subtitle.isNotEmpty) ...[
                    const SizedBox(height: 3),
                    Text(
                      subtitle,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(
                        context,
                      ).textTheme.bodySmall?.copyWith(color: p.muted),
                    ),
                  ],
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 6,
                    runSpacing: 4,
                    children: [
                      ErtadStatusPill(label: meta.label, tone: meta.tone),
                      if (action.isNotEmpty)
                        ErtadStatusPill(
                          label: shellTr(
                            context,
                            'inbox_filter_action',
                            fallback: 'Needs action',
                          ),
                          tone: ErtadTone.warning,
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class InboxSheet extends ConsumerStatefulWidget {
  const InboxSheet({super.key});

  @override
  ConsumerState<InboxSheet> createState() => _InboxSheetState();
}

class _InboxSheetState extends ConsumerState<InboxSheet> {
  int _filterIndex = 0;

  @override
  void initState() {
    super.initState();
    final items = ref.read(shellSessionProvider).liveInboxItems;
    final hasAction = items.any(
      (e) => (e['action']?.toString() ?? '').isNotEmpty,
    );
    final hasUnread = items.any((e) => e['unread'] == true);
    if (!hasAction && hasUnread) {
      _filterIndex = 1;
    } else if (!hasAction && items.isNotEmpty) {
      _filterIndex = 2;
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(shellSessionProvider);
    final allItems = session.liveInboxItems;
    final actionCount = allItems
        .where((e) => (e['action']?.toString() ?? '').isNotEmpty)
        .length;
    final unreadCount = allItems.where((e) => e['unread'] == true).length;

    final categoryItems = <ErtadCategoryItem>[
      ErtadCategoryItem(
        label: shellTr(context, 'inbox_filter_action', fallback: 'Needs action'),
        badgeCount: actionCount,
      ),
      ErtadCategoryItem(
        label: shellTr(context, 'inbox_filter_unread', fallback: 'Unread'),
        badgeCount: unreadCount,
      ),
      ErtadCategoryItem(
        label: shellTr(context, 'inbox_filter_all', fallback: 'All'),
      ),
    ];

    final visible = switch (_filterIndex) {
      0 => allItems
          .where((e) => (e['action']?.toString() ?? '').isNotEmpty)
          .toList(growable: false),
      1 => allItems.where((e) => e['unread'] == true).toList(growable: false),
      _ => allItems,
    };

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.68,
      minChildSize: 0.45,
      maxChildSize: 0.94,
      builder: (context, scrollController) {
        final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
        return Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 640),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 12, 8),
                  child: ErtadModalSheetHeader(
                    icon: Icons.notifications_active_outlined,
                    title: shellTr(context, 'inbox_title', fallback: 'Inbox'),
                    closeTooltip: shellTr(context, 'close', fallback: 'Close'),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: ErtadCategoryBar(
                    items: categoryItems,
                    selectedIndex: _filterIndex,
                    onSelected: (i) => setState(() => _filterIndex = i),
                  ),
                ),
                const SizedBox(height: 12),
                Expanded(
                  child: ListView(
                    controller: scrollController,
                    padding: EdgeInsets.fromLTRB(16, 4, 16, 20 + bottomInset),
                    children: [
                      if (visible.isEmpty)
                        ErtadEmptyState(
                          icon: Icons.mark_email_read_outlined,
                          title: shellTr(
                            context,
                            'inbox_empty_title',
                            fallback: 'All caught up',
                          ),
                          body: shellTr(
                            context,
                            'inbox_empty_body',
                            fallback:
                                'Event reminders, decisions, tasks and point notices will appear here.',
                          ),
                          tone: ErtadTone.primary,
                        )
                      else
                        ...visible.map(
                          (item) =>
                              InboxEntryCard(item: item, closeModalOnTap: true),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}
