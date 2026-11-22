import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../config/app_config.dart';
import '../../../core/feedback/ertad_feedback.dart';
import '../../../core/shell/shell_l10n.dart';
import '../../../core/shell/tab_scroll_registry.dart';
import '../../../core/state/shell_providers.dart';
import '../../../core/theme/ertad_theme.dart';
import '../../../core/widgets/ertad_ui.dart';
import '../../../models/poll.dart';
import '../../../screens/dashboard/poll_card.dart';
import '../../../services/service_locator.dart';
import 'create_poll_sheet.dart';

/// Polls & Decisions tab (index 4): unified scroll, search, filter chips & ErtadSurfaceCard PollCards.
class PollsTabScreen extends ConsumerStatefulWidget {
  final Future<List<Poll>> Function()? pollsLoader;

  const PollsTabScreen({super.key, this.pollsLoader});

  @override
  ConsumerState<PollsTabScreen> createState() => _PollsTabScreenState();
}

class _PollsTabScreenState extends ConsumerState<PollsTabScreen> {
  final TextEditingController _search = TextEditingController();
  List<Poll> _legacyPolls = const [];
  bool _loading = true;
  String? _errorMessage;
  int _filterIndex = 0;
  String _searchQuery = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _createPoll() async {
    final orgId = ref.read(shellSessionProvider).activeOrgId;
    if (orgId.startsWith('org-') || orgId.isEmpty) return;
    final created = await showCreatePollSheet(
      context,
      organizationId: orgId,
    );
    if (created != null && mounted) {
      ref.read(ertadFeedbackProvider.notifier).showSuccess(
        shellTr(
          context,
          'mgr_poll_created_ok',
          fallback: 'Poll created and published',
        ),
      );
      await _load();
    }
  }

  Future<void> _load() async {
    final session = ref.read(shellSessionProvider);
    if (widget.pollsLoader == null &&
        (session.isLiveConnected || AppConfig.devWorkspace)) {
      setState(() {
        _loading = true;
        _errorMessage = null;
      });
      if (session.isLiveConnected) {
        await ref.read(shellSessionProvider.notifier).refreshWorkspace();
      } else {
        await ref.read(shellSessionProvider.notifier).connectDevSession();
      }
      if (!mounted) return;
      final updated = ref.read(shellSessionProvider);
      setState(() {
        _loading = false;
        if (!updated.isLiveConnected) {
          _errorMessage = shellTr(
            context,
            'failed_load_polls',
            fallback: 'Failed to load polls',
          );
        }
      });
      if (updated.isOffline) {
        ref.read(ertadFeedbackProvider.notifier).showWarning(
          shellTr(
            context,
            'session_check_unavailable',
            fallback: 'Connection unavailable. Pull down to retry syncing.',
          ),
        );
      }
      return;
    }

    setState(() {
      _loading = true;
      _errorMessage = null;
    });
    try {
      final loader = widget.pollsLoader ?? ServiceLocator.apiService.getPolls;
      final list = await loader();
      if (!mounted) return;
      setState(() {
        _legacyPolls = list;
        _loading = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _errorMessage = shellTr(
          context,
          'failed_load_polls',
          fallback: 'Failed to load polls',
        );
      });
      ref.read(ertadFeedbackProvider.notifier).showError(
        err,
        retryLabel: shellTr(context, 'retry', fallback: 'Retry'),
        onRetry: _load,
      );
    }
  }

  bool isEnded(Poll poll) {
    final raw = poll.endAt;
    if (raw == null || raw.isEmpty) return false;
    final parsed = DateTime.tryParse(raw);
    if (parsed == null) return false;
    return !parsed.isAfter(DateTime.now().toUtc());
  }

  List<Poll> filter(List<Poll> source) {
    final q = _searchQuery.trim().toLowerCase();
    return source.where((poll) {
      if (q.isNotEmpty && !poll.title.toLowerCase().contains(q)) {
        return false;
      }
      final ended = isEnded(poll);
      return switch (_filterIndex) {
        1 => !ended && poll.hasVoted,
        2 => ended,
        _ => !ended && !poll.hasVoted,
      };
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(shellSessionProvider);
    final requestedSegment = ref.watch(pollsSegmentRequestProvider);
    if (requestedSegment != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        ref.read(pollsSegmentRequestProvider.notifier).state = null;
        if (_filterIndex != requestedSegment) {
          setState(() => _filterIndex = requestedSegment);
        }
      });
    }
    final controller = ref.watch(tabScrollRegistryProvider).controllerFor(4);

    List<Poll> mergeUnique(Iterable<Poll> first, Iterable<Poll> second) {
      final seen = <String>{};
      final out = <Poll>[];
      for (final p in <Poll>[...first, ...second]) {
        if (seen.add(p.id)) out.add(p);
      }
      return out;
    }

    final List<Poll> submittedActive = session.livePolls
        .where((p) => !isEnded(p) && p.hasVoted)
        .toList(growable: false);
    final List<Poll> historyEnded = mergeUnique(
      session.historyPolls,
      session.livePolls.where((p) => isEnded(p)),
    );

    final segmentItems = <ErtadCategoryItem>[
      ErtadCategoryItem(
        label: shellTr(context, 'polls_tab_active', fallback: 'New'),
        badgeCount: session.openDecisionsCount,
      ),
      ErtadCategoryItem(
        label: shellTr(context, 'polls_tab_submitted', fallback: 'In progress'),
        badgeCount: submittedActive.length,
      ),
      ErtadCategoryItem(
        label: shellTr(context, 'polls_tab_history', fallback: 'Completed'),
      ),
    ];

    final List<Poll> source =
        (widget.pollsLoader == null && session.isLiveConnected)
            ? switch (_filterIndex) {
                1 => submittedActive,
                2 => historyEnded,
                _ => session.livePolls,
              }
            : _legacyPolls;
    final visible = _filterIndex == 2 && session.isLiveConnected
        ? source
              .where(
                (p) =>
                    _searchQuery.trim().isEmpty ||
                    p.title.toLowerCase().contains(
                      _searchQuery.trim().toLowerCase(),
                    ),
              )
              .toList()
        : filter(source);

    final p = context.ertad;
    return ErtadTabScrollView(
      controller: controller,
      onRefresh: _load,
      children: [
        ErtadCategoryBar(
          items: segmentItems,
          selectedIndex: _filterIndex,
          onSelected: (i) => setState(() => _filterIndex = i),
        ),
        if ((session.canCreateDecision || session.isGroupManager) &&
            session.isLiveConnected &&
            !session.activeOrgId.startsWith('org-')) ...[
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            child: FilledButton.tonalIcon(
              onPressed: _createPoll,
              icon: const Icon(Icons.add_chart_rounded, size: 18),
              label: Text(
                shellTr(
                  context,
                  'mgr_create_poll_btn',
                  fallback: 'New poll',
                ),
              ),
            ),
          ),
        ],
        if (_searchQuery.isNotEmpty || source.length > 4) ...[
          const SizedBox(height: 10),
          TextField(
            controller: _search,
            onChanged: (v) => setState(() => _searchQuery = v),
            decoration: InputDecoration(
              prefixIcon: const Icon(Icons.search_rounded),
              hintText: shellTr(
                context,
                'search_by_title',
                fallback: 'Search by title...',
              ),
              suffixIcon: _searchQuery.isNotEmpty
                  ? IconButton(
                      tooltip: shellTr(context, 'close', fallback: 'Close'),
                      onPressed: () {
                        _search.clear();
                        setState(() => _searchQuery = '');
                      },
                      icon: const Icon(Icons.close_rounded, size: 18),
                    )
                  : null,
              filled: true,
              fillColor: p.elevated,
              contentPadding: const EdgeInsets.symmetric(
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
        ],
        const SizedBox(height: 14),
        if (_loading && !session.isLiveConnected)
          const ErtadSkeletonList(count: 3)
        else if (_errorMessage != null && !session.isLiveConnected)
          ErtadEmptyState(
            icon: Icons.wifi_off_rounded,
            tone: ErtadTone.danger,
            title: shellTr(context, 'error', fallback: 'Error'),
            body: _errorMessage!,
            actionLabel: shellTr(context, 'retry', fallback: 'Retry'),
            onAction: _load,
          )
        else if (visible.isEmpty)
          ErtadEmptyState(
            icon: Icons.how_to_vote_outlined,
            tone: ErtadTone.primary,
            title: shellTr(
              context,
              'no_polls_available',
              fallback: 'No polls available',
            ),
            body: shellTr(
              context,
              'pull_to_refresh',
              fallback: 'Pull down to refresh',
            ),
          )
        else
          ...visible.map(
            (poll) => Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: PollCard(
                poll: poll,
                onVoteComplete: _load,
                compact: _filterIndex == 2,
              ),
            ),
          ),
      ],
    );
  }
}
