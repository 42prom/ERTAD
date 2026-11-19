import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/feedback/ertad_feedback.dart';
import '../../../core/shell/inbox_sheet.dart';
import '../../../core/shell/shell_l10n.dart';
import '../../../core/shell/tab_scroll_registry.dart';
import '../../../core/state/shell_providers.dart';
import '../../../core/theme/ertad_theme.dart';
import '../../../core/widgets/ertad_ui.dart';
import 'channel_thread_screen.dart';
import 'direct_peers_sheet.dart';

/// Messages tab (index 1):
/// System | Channels (global + group + task chats) | Private (1:1 direct chats).
class MessagesTabScreen extends ConsumerStatefulWidget {
  const MessagesTabScreen({super.key});

  @override
  ConsumerState<MessagesTabScreen> createState() => _MessagesTabScreenState();
}

class _MessagesTabScreenState extends ConsumerState<MessagesTabScreen> {
  // Default to Channels (index 1) so members see active conversations immediately,
  // while System (0) and Private (2) are 1 tap away with zero horizontal scroll.
  int _selectedCategory = 1;

  int _unreadForKinds(List<Map<String, dynamic>> channels, Set<String> kinds) {
    int sum = 0;
    for (final ch in channels) {
      final kind = (ch['kind']?.toString() ?? 'group').toLowerCase();
      if (kinds.contains(kind) && ch['muted'] != true) {
        sum += ((ch['unreadCount'] ?? ch['unread']) as num?)?.toInt() ?? 0;
      }
    }
    return sum;
  }

  Future<void> _openChannel(Map<String, dynamic> channel) async {
    final orgId = ref.read(shellSessionProvider).activeOrgId;
    if (orgId.startsWith('org-') || orgId.isEmpty) return;
    await Navigator.of(context, rootNavigator: true).push<void>(
      MaterialPageRoute<void>(
        builder: (_) =>
            ChannelThreadScreen(organizationId: orgId, initialChannel: channel),
      ),
    );
    if (!mounted) return;
    ref.read(shellSessionProvider.notifier).refreshWorkspace();
  }

  Future<void> _startNewPrivateChat() async {
    final createdChannel = await showDirectPeersSheet(context);
    if (createdChannel != null && mounted) {
      await _openChannel(createdChannel);
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(shellSessionProvider);
    final controller = ref.watch(tabScrollRegistryProvider).controllerFor(1);

    final systemUnread = session.unreadInboxCount;
    final channelsUnread = _unreadForKinds(session.liveChannels, {
      'global',
      'group',
      'task',
    });
    final privateUnread = _unreadForKinds(session.liveChannels, {'direct'});

    final categories = <({String label, int unread, IconData icon})>[
      (
        label: shellTr(context, 'msg_cat_system', fallback: 'System'),
        unread: systemUnread,
        icon: Icons.notifications_none_rounded,
      ),
      (
        label: shellTr(context, 'msg_cat_channels', fallback: 'Channels'),
        unread: channelsUnread,
        icon: Icons.groups_outlined,
      ),
      (
        label: shellTr(context, 'msg_cat_private', fallback: 'Private'),
        unread: privateUnread,
        icon: Icons.lock_outline_rounded,
      ),
    ];

    final filteredChannels = session.liveChannels.where((ch) {
      final kind = (ch['kind']?.toString() ?? 'group').toLowerCase();
      return switch (_selectedCategory) {
        1 => kind == 'global' || kind == 'group' || kind == 'task',
        2 => kind == 'direct',
        _ => false,
      };
    }).toList(growable: false);

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
        ErtadCategoryBar(
          items: categories
              .map((c) => ErtadCategoryItem(label: c.label, badgeCount: c.unread))
              .toList(growable: false),
          selectedIndex: _selectedCategory,
          onSelected: (i) => setState(() => _selectedCategory = i),
        ),
        const SizedBox(height: 14),
        if (_selectedCategory == 0) ...[
          if (session.liveInboxItems.isEmpty)
            ErtadEmptyState(
              icon: Icons.notifications_paused_outlined,
              title: shellTr(
                context,
                'inbox_empty_title',
                fallback: 'All caught up',
              ),
              body: shellTr(
                context,
                'msg_empty_system',
                fallback: 'System notifications appear here',
              ),
              tone: ErtadTone.primary,
            )
          else
            ...session.liveInboxItems.map((item) => InboxEntryCard(item: item)),
        ] else ...[
          if (_selectedCategory == 2 &&
              session.isLiveConnected &&
              !session.activeOrgId.startsWith('org-')) ...[
            SizedBox(
              width: double.infinity,
              child: FilledButton.tonalIcon(
                onPressed: _startNewPrivateChat,
                style: FilledButton.styleFrom(
                  minimumSize: const Size(48, 48),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16),
                  ),
                ),
                icon: const Icon(Icons.edit_square),
                label: Text(
                  shellTr(
                    context,
                    'msg_new_private',
                    fallback: 'New private chat',
                  ),
                ),
              ),
            ),
            const SizedBox(height: 12),
          ],
          if (filteredChannels.isNotEmpty)
            ...filteredChannels.map((ch) => _buildChannelCard(context, ch))
          else
            ErtadEmptyState(
              icon: categories[_selectedCategory].icon,
              title: shellTr(
                context,
                'no_messages_yet',
                fallback: 'No messages yet',
              ),
              body: switch (_selectedCategory) {
                1 => shellTr(
                  context,
                  'msg_empty_groups',
                  fallback: 'Group and task conversations appear here',
                ),
                _ => shellTr(
                  context,
                  'msg_empty_private',
                  fallback:
                      'No direct conversations yet — start one with your coordinator or a peer',
                ),
              },
              tone: ErtadTone.primary,
            ),
        ],
      ],
    );
  }

  Widget _buildChannelCard(BuildContext context, Map<String, dynamic> ch) {
    final p = context.ertad;
    final unreadCount =
        ((ch['unreadCount'] ?? ch['unread']) as num?)?.toInt() ?? 0;
    final kind = (ch['kind']?.toString() ?? 'group').toLowerCase();
    final isMuted = ch['muted'] == true;
    final isBlocked = ch['blocked'] == true;
    final lastMsg = ch['lastMessage'];
    final pinned = ch['pinnedMessage'];

    final String? preview = lastMsg is Map &&
            (lastMsg['body']?.toString() ?? '').trim().isNotEmpty
        ? lastMsg['body'].toString()
        : (pinned is Map ? pinned['body']?.toString() : null);

    final (IconData icon, String? badgeLabel, ErtadTone badgeTone) =
        switch (kind) {
          'global' => (
            Icons.campaign_rounded,
            shellTr(context, 'msg_kind_global', fallback: 'Global'),
            ErtadTone.primary,
          ),
          'task' => (
            Icons.assignment_rounded,
            shellTr(context, 'msg_kind_task', fallback: 'Task'),
            ErtadTone.secondary,
          ),
          'direct' => (
            Icons.lock_outline_rounded,
            null,
            ErtadTone.primary,
          ),
          _ => (
            Icons.forum_rounded,
            shellTr(context, 'msg_kind_group', fallback: 'Group'),
            ErtadTone.neutral,
          ),
        };

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: ErtadSurfaceCard(
        borderColor: unreadCount > 0 && !isMuted
            ? p.primary.withValues(alpha: 0.30)
            : null,
        onTap: () => _openChannel(ch),
        child: Row(
          children: [
            ErtadIconCircle(
              icon: icon,
              tone: unreadCount > 0 && !isMuted
                  ? ErtadTone.primary
                  : ErtadTone.secondary,
              size: 46,
              iconSize: 22,
              radius: 15,
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
                          ch['title']?.toString() ??
                              shellTr(
                                context,
                                'nav_messages',
                                fallback: 'Messages',
                              ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.titleMedium
                              ?.copyWith(
                                fontWeight: unreadCount > 0
                                    ? FontWeight.w700
                                    : FontWeight.w600,
                              ),
                        ),
                      ),
                      if (badgeLabel != null) ...[
                        const SizedBox(width: 8),
                        ErtadStatusPill(label: badgeLabel, tone: badgeTone),
                      ],
                    ],
                  ),
                  if (preview != null && preview.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text(
                      preview,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(
                        context,
                      ).textTheme.bodySmall?.copyWith(color: p.muted),
                    ),
                  ],
                  if (isMuted || isBlocked) ...[
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 6,
                      children: [
                        if (isMuted)
                          ErtadStatusPill(
                            icon: Icons.notifications_off_outlined,
                            label: shellTr(
                              context,
                              'msg_muted_badge',
                              fallback: 'Muted',
                            ),
                            tone: ErtadTone.neutral,
                          ),
                        if (isBlocked)
                          ErtadStatusPill(
                            icon: Icons.block_rounded,
                            label: shellTr(
                              context,
                              'msg_block',
                              fallback: 'Blocked',
                            ),
                            tone: ErtadTone.warning,
                          ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
            if (unreadCount > 0 && !isMuted) ...[
              const SizedBox(width: 8),
              ErtadStatusPill(
                label: '$unreadCount',
                tone: ErtadTone.primary,
              ),
            ] else
              Icon(Icons.chevron_right_rounded, color: p.muted),
          ],
        ),
      ),
    );
  }
}
