import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/feedback/ertad_feedback.dart';
import '../../../core/shell/shell_l10n.dart';
import '../../../core/state/shell_providers.dart';
import '../../../core/theme/ertad_theme.dart';
import '../../../core/widgets/ertad_ui.dart';

/// Opens a modal sheet allowing a member to:
/// - start a 1:1 or multi-member private chat (searching by name, group, or unique `#K4M9P2` code), OR
/// - add 1+ participants to an existing private chat when [existingChannelId] is provided.
Future<Map<String, dynamic>?> showDirectPeersSheet(
  BuildContext context, {
  String? existingChannelId,
  Set<String> existingMemberIds = const <String>{},
}) {
  return showModalBottomSheet<Map<String, dynamic>>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => DirectPeersSheet(
      existingChannelId: existingChannelId,
      existingMemberIds: existingMemberIds,
    ),
  );
}

class DirectPeersSheet extends ConsumerStatefulWidget {
  final String? existingChannelId;
  final Set<String> existingMemberIds;

  const DirectPeersSheet({
    super.key,
    this.existingChannelId,
    this.existingMemberIds = const <String>{},
  });

  @override
  ConsumerState<DirectPeersSheet> createState() => _DirectPeersSheetState();
}

class _DirectPeersSheetState extends ConsumerState<DirectPeersSheet> {
  final TextEditingController _search = TextEditingController();
  final TextEditingController _groupTitle = TextEditingController();
  Timer? _debounce;

  List<Map<String, dynamic>> _peers = const [];
  final Map<String, Map<String, dynamic>> _selectedById =
      <String, Map<String, dynamic>>{};
  String _selfCode = '';
  bool _loading = true;
  bool _submitting = false;
  String _query = '';

  bool get _isAddMode =>
      widget.existingChannelId != null && widget.existingChannelId!.isNotEmpty;

  @override
  void initState() {
    super.initState();
    _loadPeers();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    _groupTitle.dispose();
    super.dispose();
  }

  Future<void> _loadPeers({String? search}) async {
    final session = ref.read(shellSessionProvider);
    if (!session.isLiveConnected || session.activeOrgId.startsWith('org-')) {
      setState(() => _loading = false);
      return;
    }
    try {
      final res = await ref
          .read(mobileApiClientProvider)
          .fetchDirectPeersDirectory(
            organizationId: session.activeOrgId,
            search: search,
          );
      if (!mounted) return;
      setState(() {
        if (res.selfCode.isNotEmpty) _selfCode = res.selfCode;
        _peers = res.items;
        _loading = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() => _loading = false);
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  void _onSearchChanged(String value) {
    setState(() => _query = value);
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 220), () {
      if (mounted) {
        _loadPeers(search: value);
      }
    });
  }

  void _togglePeer(Map<String, dynamic> peer) {
    if (_submitting) return;
    final id = peer['memberId']?.toString() ?? '';
    if (id.isEmpty || widget.existingMemberIds.contains(id)) return;
    setState(() {
      if (_selectedById.containsKey(id)) {
        _selectedById.remove(id);
      } else {
        _selectedById[id] = peer;
      }
    });
  }

  Future<void> _submitSelection() async {
    if (_submitting || _selectedById.isEmpty) return;
    setState(() => _submitting = true);
    final ids = _selectedById.keys.toList(growable: false);
    try {
      Map<String, dynamic>? channel;
      if (_isAddMode) {
        channel = await ref
            .read(shellSessionProvider.notifier)
            .addMembersToDirectChat(widget.existingChannelId!, ids);
      } else {
        final title = ids.length > 1 ? _groupTitle.text.trim() : null;
        channel = await ref
            .read(shellSessionProvider.notifier)
            .openDirectChatMulti(ids, title: title);
      }
      if (!mounted) return;
      Navigator.of(context).pop(channel);
    } catch (err) {
      if (!mounted) return;
      setState(() => _submitting = false);
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  Future<void> _copySelfCode() async {
    if (_selfCode.isEmpty) return;
    await Clipboard.setData(ClipboardData(text: '#$_selfCode'));
    if (!mounted) return;
    ref.read(ertadFeedbackProvider.notifier).showSuccess(
      '${shellTr(context, 'msg_code_copied', fallback: 'Unique code copied')}: #$_selfCode',
    );
  }

  String _extractCode(Map<String, dynamic> peer) {
    final direct = peer['memberCode']?.toString().trim() ?? '';
    if (direct.isNotEmpty) return direct;
    final label = peer['label']?.toString() ?? '';
    final idx = label.lastIndexOf('#');
    if (idx >= 0 && idx + 1 < label.length) {
      return label.substring(idx + 1).trim();
    }
    return '';
  }

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final keyboardInset = MediaQuery.viewInsetsOf(context).bottom;
    final selectedCount = _selectedById.length;

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.78,
      minChildSize: 0.50,
      maxChildSize: 0.94,
      builder: (context, scrollController) {
        return Padding(
          padding: EdgeInsets.only(bottom: keyboardInset),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 640),
              child: Column(
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 12, 12, 6),
                    child: ErtadModalSheetHeader(
                      icon: _isAddMode
                          ? Icons.group_add_rounded
                          : Icons.person_add_alt_1_rounded,
                      title: _isAddMode
                          ? shellTr(
                              context,
                              'msg_add_participants',
                              fallback: 'Add participant',
                            )
                          : shellTr(
                              context,
                              'msg_new_private',
                              fallback: 'New private chat',
                            ),
                      closeTooltip: shellTr(
                        context,
                        'close',
                        fallback: 'Close',
                      ),
                    ),
                  ),
                  if (_selfCode.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                      child: InkWell(
                        borderRadius: BorderRadius.circular(12),
                        onTap: _copySelfCode,
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 12,
                            vertical: 8,
                          ),
                          decoration: BoxDecoration(
                            color: p.primarySoft,
                            borderRadius: BorderRadius.circular(12),
                            border: Border.all(
                              color: p.primary.withValues(alpha: 0.25),
                            ),
                          ),
                          child: Row(
                            children: [
                              Icon(
                                Icons.tag_rounded,
                                size: 17,
                                color: p.primary,
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  '${shellTr(context, 'msg_your_code_label', fallback: 'Your unique code:')} #$_selfCode',
                                  style: Theme.of(context).textTheme.labelMedium
                                      ?.copyWith(
                                        color: p.primary,
                                        fontWeight: FontWeight.w700,
                                      ),
                                ),
                              ),
                              Icon(
                                Icons.copy_rounded,
                                size: 16,
                                color: p.primary,
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    child: TextField(
                      controller: _search,
                      onChanged: _onSearchChanged,
                      decoration: InputDecoration(
                        prefixIcon: const Icon(Icons.search_rounded),
                        suffixIcon: _query.isEmpty
                            ? null
                            : IconButton(
                                icon: const Icon(Icons.clear_rounded, size: 18),
                                onPressed: () {
                                  _search.clear();
                                  _onSearchChanged('');
                                },
                              ),
                        hintText: shellTr(
                          context,
                          'msg_search_peers_code',
                          fallback:
                              'Search by name, group, or code (e.g. #K4M9P2)...',
                        ),
                        filled: true,
                        fillColor: p.elevated,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 14,
                          vertical: 10,
                        ),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(14),
                          borderSide: BorderSide(color: p.hairline),
                        ),
                        enabledBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(14),
                          borderSide: BorderSide(color: p.hairline),
                        ),
                      ),
                    ),
                  ),
                  if (_selectedById.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    SizedBox(
                      height: 36,
                      child: ListView(
                        scrollDirection: Axis.horizontal,
                        padding: const EdgeInsets.symmetric(horizontal: 16),
                        children: _selectedById.entries.map((entry) {
                          final peer = entry.value;
                          final code = _extractCode(peer);
                          final label =
                              peer['label']?.toString() ??
                              (code.isNotEmpty ? '#$code' : 'Member');
                          return Padding(
                            padding: const EdgeInsets.only(right: 8),
                            child: InputChip(
                              label: Text(
                                label,
                                style: Theme.of(context).textTheme.labelMedium
                                    ?.copyWith(fontWeight: FontWeight.w600),
                              ),
                              onDeleted: _submitting
                                  ? null
                                  : () => setState(
                                      () => _selectedById.remove(entry.key),
                                    ),
                            ),
                          );
                        }).toList(),
                      ),
                    ),
                  ],
                  if (!_isAddMode && selectedCount > 1) ...[
                    const SizedBox(height: 8),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      child: TextField(
                        controller: _groupTitle,
                        decoration: InputDecoration(
                          prefixIcon: const Icon(Icons.groups_rounded),
                          hintText: shellTr(
                            context,
                            'msg_group_title_hint',
                            fallback: 'Chat title (optional, min 3 chars)',
                          ),
                          filled: true,
                          fillColor: p.elevated,
                          contentPadding: const EdgeInsets.symmetric(
                            horizontal: 14,
                            vertical: 10,
                          ),
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(14),
                            borderSide: BorderSide(color: p.hairline),
                          ),
                          enabledBorder: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(14),
                            borderSide: BorderSide(color: p.hairline),
                          ),
                        ),
                      ),
                    ),
                  ],
                  const SizedBox(height: 8),
                  Expanded(
                    child: _loading
                        ? const Center(child: CircularProgressIndicator())
                        : Builder(
                            builder: (context) {
                              final rawQ = _query
                                  .trim()
                                  .toLowerCase()
                                  .replaceFirst(RegExp(r'^#+'), '');
                              final filteredPeers = rawQ.isEmpty
                                  ? _peers
                                  : _peers.where((peer) {
                                      final label =
                                          (peer['label']?.toString() ?? '')
                                              .toLowerCase();
                                      final unit =
                                          (peer['unitName']?.toString() ?? '')
                                              .toLowerCase();
                                      final code = _extractCode(
                                        peer,
                                      ).toLowerCase();
                                      return label.contains(rawQ) ||
                                          unit.contains(rawQ) ||
                                          code.contains(rawQ);
                                    }).toList(growable: false);

                              return ListView(
                                controller: scrollController,
                                padding: const EdgeInsets.fromLTRB(
                                  16,
                                  4,
                                  16,
                                  16,
                                ),
                                children: [
                                  if (filteredPeers.isEmpty)
                                    ErtadEmptyState(
                                      icon: Icons.people_outline_rounded,
                                      title: shellTr(
                                        context,
                                        'msg_no_peers',
                                        fallback:
                                            'No matching active members found',
                                      ),
                                      body: shellTr(
                                        context,
                                        'msg_privacy_peer_hint',
                                        fallback:
                                            'Private members appear with a unique alphanumeric code (#XXXXXX) unless they opt in to share a name.',
                                      ),
                                    )
                                  else
                                    ...filteredPeers.map((peer) {
                                      final id =
                                          peer['memberId']?.toString() ?? '';
                                      final code = _extractCode(peer);
                                      final label =
                                          peer['label']?.toString() ??
                                          shellTr(
                                            context,
                                            'dev_persona_member',
                                            fallback: 'Member',
                                          );
                                      final unitName =
                                          peer['unitName']?.toString() ?? '';
                                      final isCoord =
                                          peer['roleKind']?.toString() ==
                                          'coordinator';
                                      final alreadyInChat = widget
                                          .existingMemberIds
                                          .contains(id);
                                      final selected = _selectedById
                                          .containsKey(id);

                                      return Padding(
                                        padding: const EdgeInsets.only(
                                          bottom: 8,
                                        ),
                                        child: ErtadSurfaceCard(
                                          borderColor: selected
                                              ? p.primary
                                              : null,
                                          backgroundColor: selected
                                              ? p.primarySoft.withValues(
                                                  alpha: 0.45,
                                                )
                                              : null,
                                          onTap: alreadyInChat || _submitting
                                              ? null
                                              : () => _togglePeer(peer),
                                          padding: const EdgeInsets.symmetric(
                                            horizontal: 14,
                                            vertical: 11,
                                          ),
                                          child: Row(
                                            children: [
                                              ErtadIconCircle(
                                                icon: isCoord
                                                    ? Icons
                                                          .verified_user_outlined
                                                    : Icons
                                                          .person_outline_rounded,
                                                tone: isCoord
                                                    ? ErtadTone.primary
                                                    : ErtadTone.secondary,
                                                size: 40,
                                                iconSize: 20,
                                              ),
                                              const SizedBox(width: 12),
                                              Expanded(
                                                child: Column(
                                                  crossAxisAlignment:
                                                      CrossAxisAlignment.start,
                                                  children: [
                                                    Row(
                                                      children: [
                                                        Flexible(
                                                          child: Text(
                                                            label,
                                                            maxLines: 1,
                                                            overflow:
                                                                TextOverflow
                                                                    .ellipsis,
                                                            style: Theme.of(
                                                              context,
                                                            ).textTheme.titleMedium,
                                                          ),
                                                        ),
                                                        if (code.isNotEmpty &&
                                                            !label.contains(
                                                              '#$code',
                                                            )) ...[
                                                          const SizedBox(
                                                            width: 6,
                                                          ),
                                                          ErtadStatusPill(
                                                            label: '#$code',
                                                            tone: ErtadTone
                                                                .primary,
                                                          ),
                                                        ],
                                                      ],
                                                    ),
                                                    if (unitName.isNotEmpty ||
                                                        alreadyInChat) ...[
                                                      const SizedBox(height: 2),
                                                      Text(
                                                        alreadyInChat
                                                            ? '$unitName · ${shellTr(context, 'msg_already_in_chat', fallback: 'Already in chat')}'
                                                            : unitName,
                                                        style: Theme.of(
                                                          context,
                                                        ).textTheme.bodySmall,
                                                      ),
                                                    ],
                                                  ],
                                                ),
                                              ),
                                              const SizedBox(width: 8),
                                              if (alreadyInChat)
                                                Icon(
                                                  Icons.check_circle_rounded,
                                                  color: p.muted,
                                                  size: 22,
                                                )
                                              else
                                                Checkbox(
                                                  value: selected,
                                                  onChanged: _submitting
                                                      ? null
                                                      : (_) =>
                                                            _togglePeer(peer),
                                                ),
                                            ],
                                          ),
                                        ),
                                      );
                                    }),
                                ],
                              );
                            },
                          ),
                  ),
                  if (selectedCount > 0)
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
                      decoration: BoxDecoration(
                        color: p.surface,
                        border: Border(top: BorderSide(color: p.hairline)),
                      ),
                      child: FilledButton.icon(
                        onPressed: _submitting ? null : _submitSelection,
                        style: FilledButton.styleFrom(
                          minimumSize: const Size(double.infinity, 48),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(14),
                          ),
                        ),
                        icon: _submitting
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : Icon(
                                _isAddMode
                                    ? Icons.person_add_alt_1_rounded
                                    : selectedCount == 1
                                    ? Icons.chat_bubble_outline_rounded
                                    : Icons.groups_rounded,
                              ),
                        label: Text(
                          _isAddMode
                              ? '${shellTr(context, 'msg_add_selected', fallback: 'Add selected')} ($selectedCount)'
                              : selectedCount == 1
                              ? shellTr(
                                  context,
                                  'msg_start_chat_one',
                                  fallback: 'Start private chat (1)',
                                )
                              : '${shellTr(context, 'msg_start_chat_multi', fallback: 'Create private group chat')} ($selectedCount)',
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}
