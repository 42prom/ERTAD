import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/feedback/ertad_feedback.dart';
import '../../../core/shell/shell_l10n.dart';
import '../../../core/state/shell_providers.dart';
import '../../../core/theme/ertad_theme.dart';
import '../../../core/widgets/ertad_ui.dart';

/// Opens a modal sheet allowing a member to start a privacy-safe direct chat.
Future<Map<String, dynamic>?> showDirectPeersSheet(BuildContext context) {
  return showModalBottomSheet<Map<String, dynamic>>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => const DirectPeersSheet(),
  );
}

class DirectPeersSheet extends ConsumerStatefulWidget {
  const DirectPeersSheet({super.key});

  @override
  ConsumerState<DirectPeersSheet> createState() => _DirectPeersSheetState();
}

class _DirectPeersSheetState extends ConsumerState<DirectPeersSheet> {
  final TextEditingController _search = TextEditingController();
  List<Map<String, dynamic>> _peers = const [];
  bool _loading = true;
  String? _openingPeerId;
  String _query = '';

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    _loadPeers();
  }

  Future<void> _loadPeers() async {
    final session = ref.read(shellSessionProvider);
    if (!session.isLiveConnected || session.activeOrgId.startsWith('org-')) {
      setState(() => _loading = false);
      return;
    }
    try {
      final list = await ref
          .read(mobileApiClientProvider)
          .fetchDirectPeers(organizationId: session.activeOrgId);
      if (!mounted) return;
      setState(() {
        _peers = list;
        _loading = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() => _loading = false);
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  Future<void> _pickPeer(String peerId) async {
    setState(() => _openingPeerId = peerId);
    try {
      final ch = await ref
          .read(shellSessionProvider.notifier)
          .openDirectChat(peerId);
      if (!mounted) return;
      Navigator.of(context).pop(ch);
    } catch (err) {
      if (!mounted) return;
      setState(() => _openingPeerId = null);
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final bottomInset = MediaQuery.viewPaddingOf(context).bottom;
    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.62,
      minChildSize: 0.42,
      maxChildSize: 0.90,
      builder: (context, scrollController) {
        return Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 640),
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 12, 8),
                  child: ErtadModalSheetHeader(
                    icon: Icons.person_add_alt_1_rounded,
                    title: shellTr(
                      context,
                      'msg_new_private',
                      fallback: 'New private chat',
                    ),
                    closeTooltip: shellTr(context, 'close', fallback: 'Close'),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: ErtadStateBanner(
                    icon: Icons.shield_outlined,
                    tone: ErtadTone.primary,
                    message: shellTr(
                      context,
                      'msg_privacy_peer_hint',
                      fallback:
                          'Private members appear with an anonymous handle unless they opt in to share a name.',
                    ),
                  ),
                ),
                const SizedBox(height: 10),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: TextField(
                    controller: _search,
                    onChanged: (v) => setState(() => _query = v),
                    decoration: InputDecoration(
                      prefixIcon: const Icon(Icons.search_rounded),
                      hintText: shellTr(
                        context,
                        'msg_search_peers',
                        fallback: 'Search members...',
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
                const SizedBox(height: 10),
                Expanded(
                  child: _loading
                      ? const Center(child: CircularProgressIndicator())
                      : Builder(
                          builder: (context) {
                            final q = _query.trim().toLowerCase();
                            final filteredPeers = q.isEmpty
                                ? _peers
                                : _peers
                                      .where((peer) {
                                        final label =
                                            peer['label']?.toString() ?? '';
                                        final unit =
                                            peer['unitName']?.toString() ?? '';
                                        return label.toLowerCase().contains(
                                              q,
                                            ) ||
                                            unit.toLowerCase().contains(q);
                                      })
                                      .toList(growable: false);
                            return ListView(
                              controller: scrollController,
                              padding: EdgeInsets.fromLTRB(
                                16,
                                4,
                                16,
                                24 + bottomInset,
                              ),
                              children: [
                                if (filteredPeers.isEmpty)
                                  ErtadEmptyState(
                                    icon: Icons.people_outline_rounded,
                                    title: shellTr(
                                      context,
                                      'msg_no_peers',
                                      fallback:
                                          'No other active group members found yet',
                                    ),
                                    body: shellTr(
                                      context,
                                      'msg_privacy_peer_hint',
                                      fallback:
                                          'Private members appear with an anonymous handle unless they opt in to share a name.',
                                    ),
                                  )
                                else
                                  ...filteredPeers.map((peer) {
                                final id = peer['memberId']?.toString() ?? '';
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
                                final busy = _openingPeerId == id;

                                return Padding(
                                  padding: const EdgeInsets.only(bottom: 10),
                                  child: ErtadSurfaceCard(
                                    onTap: _openingPeerId != null
                                        ? null
                                        : () => _pickPeer(id),
                                    child: Row(
                                      children: [
                                        ErtadIconCircle(
                                          icon: isCoord
                                              ? Icons.verified_user_outlined
                                              : Icons.person_outline_rounded,
                                          tone: isCoord
                                              ? ErtadTone.primary
                                              : ErtadTone.secondary,
                                          size: 42,
                                          iconSize: 21,
                                        ),
                                        const SizedBox(width: 12),
                                        Expanded(
                                          child: Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.start,
                                            children: [
                                              Text(
                                                label,
                                                style: Theme.of(
                                                  context,
                                                ).textTheme.titleMedium,
                                              ),
                                              if (unitName.isNotEmpty) ...[
                                                const SizedBox(height: 2),
                                                Text(
                                                  unitName,
                                                  style: Theme.of(
                                                    context,
                                                  ).textTheme.bodySmall,
                                                ),
                                              ],
                                            ],
                                          ),
                                        ),
                                        if (busy)
                                          const SizedBox(
                                            width: 20,
                                            height: 20,
                                            child: CircularProgressIndicator(
                                              strokeWidth: 2,
                                            ),
                                          )
                                        else
                                          Icon(
                                            Icons.chevron_right_rounded,
                                            color: p.muted,
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
              ],
            ),
          ),
        );
      },
    );
  }
}
