import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/feedback/ertad_feedback.dart';
import '../../../core/shell/shell_l10n.dart';
import '../../../core/shell/tab_scroll_registry.dart';
import '../../../core/state/shell_providers.dart';
import '../../../core/theme/ertad_theme.dart';
import '../../../core/widgets/ertad_ui.dart';
import 'event_detail_screen.dart';
import 'work_detail_screen.dart';

/// Tasks & Events tab (index 3): #64 plain-member Available | Mine | Events | History.
class TasksTabScreen extends ConsumerStatefulWidget {
  const TasksTabScreen({super.key});

  @override
  ConsumerState<TasksTabScreen> createState() => _TasksTabScreenState();
}

class _TasksTabScreenState extends ConsumerState<TasksTabScreen> {
  int _segment = 0;
  final TextEditingController _search = TextEditingController();
  String _query = '';

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  String _localizedWorkStatus(BuildContext context, String raw) {
    return switch (raw.toLowerCase()) {
      'applied' => shellTr(context, 'work_status_applied', fallback: 'Applied'),
      'reserved' =>
        shellTr(context, 'work_status_reserved', fallback: 'Reserved'),
      'assigned' =>
        shellTr(context, 'work_status_assigned', fallback: 'Assigned'),
      'in_progress' =>
        shellTr(context, 'work_status_in_progress', fallback: 'In progress'),
      'submitted' =>
        shellTr(context, 'work_status_submitted', fallback: 'Submitted'),
      'verified' =>
        shellTr(context, 'work_status_verified', fallback: 'Verified'),
      'withdrawn' =>
        shellTr(context, 'work_status_withdrawn', fallback: 'Withdrawn'),
      'rejected' =>
        shellTr(context, 'work_status_rejected', fallback: 'Declined'),
      _ => raw,
    };
  }

  Future<void> _openWork(Map<String, dynamic> item) async {
    final orgId = ref.read(shellSessionProvider).activeOrgId;
    if (orgId.startsWith('org-') || orgId.isEmpty) return;
    await showWorkDetailSheet(
      context,
      organizationId: orgId,
      initialWork: item,
    );
    if (!mounted) return;
    ref.read(shellSessionProvider.notifier).refreshWorkspace();
  }

  Future<void> _openEvent(Map<String, dynamic> ev) async {
    final orgId = ref.read(shellSessionProvider).activeOrgId;
    if (orgId.startsWith('org-') || orgId.isEmpty) return;
    await showEventDetailSheet(
      context,
      organizationId: orgId,
      initialEvent: ev,
    );
    if (!mounted) return;
    ref.read(shellSessionProvider.notifier).refreshWorkspace();
  }

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final session = ref.watch(shellSessionProvider);
    final requestedSegment = ref.watch(tasksSegmentRequestProvider);
    if (requestedSegment != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        ref.read(tasksSegmentRequestProvider.notifier).state = null;
        if (_segment != requestedSegment) {
          setState(() => _segment = requestedSegment);
        }
      });
    }
    final controller = ref.watch(tabScrollRegistryProvider).controllerFor(3);

    final segmentItems = <ErtadCategoryItem>[
      ErtadCategoryItem(
        label: shellTr(
          context,
          'tasks_tab_available',
          fallback: 'Available',
        ),
      ),
      ErtadCategoryItem(
        label: shellTr(context, 'tasks_tab_mine', fallback: 'Mine'),
        badgeCount: session.myWorkItems.length,
      ),
      ErtadCategoryItem(
        label: shellTr(context, 'tasks_tab_events', fallback: 'Events'),
      ),
      ErtadCategoryItem(
        label: shellTr(context, 'tasks_tab_history', fallback: 'History'),
      ),
      if (session.isGroupManager)
        ErtadCategoryItem(
          label: shellTr(context, 'tasks_tab_review', fallback: 'Review'),
          badgeCount: session.reviewWorkItems.length,
        ),
    ];
    final activeSegment = _segment >= segmentItems.length ? 0 : _segment;

    final normalizedQuery = _query.trim().toLowerCase();
    bool matchesSearch(Map<String, dynamic> row) {
      if (normalizedQuery.isEmpty) return true;
      final hay = [
        row['title']?.toString() ?? '',
        row['description']?.toString() ?? '',
        row['location']?.toString() ?? '',
      ].join(' ').toLowerCase();
      return hay.contains(normalizedQuery);
    }

    final List<Map<String, dynamic>> rawWorkList = switch (activeSegment) {
      0 => session.liveWorkItems,
      1 => session.myWorkItems,
      3 => session.historyWorkItems,
      4 => session.reviewWorkItems,
      _ => const <Map<String, dynamic>>[],
    };
    final workList = rawWorkList.where(matchesSearch).toList(growable: false);
    final filteredEvents = session.liveEvents
        .where(matchesSearch)
        .toList(growable: false);

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
        TextField(
          controller: _search,
          onChanged: (v) => setState(() => _query = v),
          decoration: InputDecoration(
            prefixIcon: Icon(Icons.search_rounded),
            hintText: shellTr(
              context,
              'search_tasks_hint',
              fallback: 'Search tasks or events...',
            ),
            suffixIcon: _query.isNotEmpty
                ? IconButton(
                    tooltip: shellTr(context, 'close', fallback: 'Close'),
                    onPressed: () {
                      _search.clear();
                      setState(() => _query = '');
                    },
                    icon: Icon(Icons.close_rounded, size: 18),
                  )
                : null,
            filled: true,
            fillColor: p.elevated,
            contentPadding: EdgeInsets.symmetric(
              horizontal: 14,
              vertical: 12,
            ),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(16),
              borderSide: BorderSide(color: p.hairline),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(16),
              borderSide: BorderSide(color: p.hairline),
            ),
          ),
        ),
        SizedBox(height: 12),
        ErtadCategoryBar(
          items: segmentItems,
          selectedIndex: activeSegment,
          onSelected: (i) => setState(() => _segment = i),
        ),
        SizedBox(height: 14),
        if (activeSegment == 2) ...[
          if (filteredEvents.isNotEmpty)
            ...filteredEvents.map((ev) {
              final myRsvp = ev['myRsvp'];
              final rsvpStatus = myRsvp is Map
                  ? (myRsvp['status']?.toString() ?? '')
                  : '';
              return Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: ErtadSurfaceCard(
                  onTap: () => _openEvent(ev),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const ErtadIconCircle(
                        icon: Icons.event_available_rounded,
                        tone: ErtadTone.success,
                        size: 44,
                        iconSize: 22,
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              ev['title']?.toString() ??
                                  shellTr(
                                    context,
                                    'src_event',
                                    fallback: 'Event',
                                  ),
                              style: Theme.of(context).textTheme.titleMedium,
                            ),
                            if (ev['location'] != null) ...[
                              const SizedBox(height: 4),
                              Row(
                                children: [
                                  Icon(
                                    Icons.place_outlined,
                                    size: 14,
                                    color: p.muted,
                                  ),
                                  const SizedBox(width: 4),
                                  Expanded(
                                    child: Text(
                                      ev['location'].toString(),
                                      style: Theme.of(
                                        context,
                                      ).textTheme.bodySmall,
                                    ),
                                  ),
                                ],
                              ),
                            ],
                            const SizedBox(height: 8),
                            ErtadStatusPill(
                              label: switch (rsvpStatus.toLowerCase()) {
                                'going' => shellTr(
                                    context,
                                    'event_going_label',
                                    fallback: 'Going',
                                  ),
                                'waitlist' => shellTr(
                                    context,
                                    'event_status_waitlist',
                                    fallback: 'Waitlisted',
                                  ),
                                'checked_in' => shellTr(
                                    context,
                                    'event_status_checked_in',
                                    fallback: 'Checked in',
                                  ),
                                _ when rsvpStatus.isNotEmpty => rsvpStatus,
                                _ => shellTr(
                                    context,
                                    'event_rsvp_label',
                                    fallback: 'RSVP',
                                  ),
                              },
                              icon: Icons.check_circle_outline_rounded,
                              tone: rsvpStatus.toLowerCase() == 'going' ||
                                      rsvpStatus.toLowerCase() == 'checked_in'
                                  ? ErtadTone.success
                                  : ErtadTone.primary,
                            ),
                          ],
                        ),
                      ),
                      Icon(Icons.chevron_right_rounded, color: p.muted),
                    ],
                  ),
                ),
              );
            })
          else
            ErtadEmptyState(
              icon: Icons.event_available_outlined,
              title: segmentItems[2].label,
              body: shellTr(
                context,
                'events_empty',
                fallback: 'No upcoming events scheduled',
              ),
            ),
        ] else if (workList.isNotEmpty) ...[
          ...workList.map((item) {
            final myStatus = item['myStatus']?.toString();
            final priority = item['priority']?.toString() ?? 'normal';
            return Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: ErtadSurfaceCard(
                onTap: () => _openWork(item),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const ErtadIconCircle(
                      icon: Icons.task_alt_rounded,
                      tone: ErtadTone.primary,
                      size: 44,
                      iconSize: 22,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            item['title']?.toString() ??
                                shellTr(context, 'src_work', fallback: 'Task'),
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                          if (item['description'] != null) ...[
                            const SizedBox(height: 4),
                            Text(
                              item['description'].toString(),
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ],
                          const SizedBox(height: 8),
                          Wrap(
                            spacing: 6,
                            runSpacing: 4,
                            children: [
                              ErtadStatusPill(
                                label: shellTr(
                                  context,
                                  'prio_${priority.toLowerCase()}',
                                  fallback: priority,
                                ),
                                icon: Icons.flag_outlined,
                                tone: priority == 'urgent'
                                    ? ErtadTone.danger
                                    : priority == 'high'
                                    ? ErtadTone.warning
                                    : ErtadTone.secondary,
                              ),
                              if (myStatus != null && myStatus.isNotEmpty)
                                ErtadStatusPill(
                                  label:
                                      _localizedWorkStatus(context, myStatus),
                                  tone: ErtadTone.primary,
                                ),
                            ],
                          ),
                        ],
                      ),
                    ),
                    Icon(Icons.chevron_right_rounded, color: p.muted),
                  ],
                ),
              ),
            );
          }),
        ] else
          ErtadEmptyState(
            icon: _segment == 3
                ? Icons.history_rounded
                : Icons.task_alt_rounded,
            title: segmentItems[_segment].label,
            body: _segment == 3
                ? shellTr(
                    context,
                    'tasks_history_empty',
                    fallback: 'Completed or archived tasks will appear here.',
                  )
                : shellTr(
                    context,
                    'tasks_empty',
                    fallback: 'No tasks or events in this category yet.',
                  ),
          ),
      ],
    );
  }
}
