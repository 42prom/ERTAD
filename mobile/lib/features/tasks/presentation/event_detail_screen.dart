import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/feedback/ertad_feedback.dart';
import '../../../core/network/mobile_api_client.dart';
import '../../../core/shell/shell_l10n.dart';
import '../../../core/state/offline_action_queue.dart';
import '../../../core/state/shell_providers.dart';
import '../../../core/theme/ertad_theme.dart';
import '../../../core/widgets/ertad_ui.dart';

/// Opens Event detail & live RSVP / Check-in code pass in a unified modal popup sheet.
Future<void> showEventDetailSheet(
  BuildContext context, {
  required String organizationId,
  required Map<String, dynamic> initialEvent,
}) {
  return showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => EventDetailScreen(
      organizationId: organizationId,
      initialEvent: initialEvent,
    ),
  );
}

/// Modal Event detail & live RSVP / Check-in code pass (/mobile/work/event_*).
class EventDetailScreen extends ConsumerStatefulWidget {
  final String organizationId;
  final Map<String, dynamic> initialEvent;

  const EventDetailScreen({
    super.key,
    required this.organizationId,
    required this.initialEvent,
  });

  @override
  ConsumerState<EventDetailScreen> createState() => _EventDetailScreenState();
}

class _EventDetailScreenState extends ConsumerState<EventDetailScreen> {
  final TextEditingController _checkinController = TextEditingController();
  late Map<String, dynamic> _event;
  bool _loading = true;
  bool _mutating = false;

  String get _eventId => _event['id']?.toString() ?? '';

  @override
  void initState() {
    super.initState();
    _event = Map<String, dynamic>.from(widget.initialEvent);
    _loadDetail();
  }

  @override
  void dispose() {
    _checkinController.dispose();
    super.dispose();
  }

  Future<void> _loadDetail() async {
    try {
      final res = await ref.read(mobileApiClientProvider).fetchEventDetail(
        organizationId: widget.organizationId,
        eventId: _eventId,
      );
      if (!mounted) return;
      setState(() {
        _event = res;
        _loading = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() => _loading = false);
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  Future<void> _toggleRsvp(String action) async {
    if (_mutating) return;
    setState(() => _mutating = true);
    final api = ref.read(mobileApiClientProvider);
    try {
      await api.rsvpEvent(
        organizationId: widget.organizationId,
        eventId: _eventId,
        action: action,
      );
      if (!mounted) return;
      setState(() => _mutating = false);
      await _loadDetail();
      if (!mounted) return;
      ref.read(shellSessionProvider.notifier).refreshWorkspace();
    } catch (err) {
      if (!mounted) return;
      final isNetworkFailure =
          err is MobileApiException &&
          (err.statusCode == null || err.statusCode == 0);
      if (isNetworkFailure) {
        await OfflineActionQueue().enqueue(
          OfflineQueuedAction(
            idempotencyKey: api.newIdempotencyKey(),
            kind: 'event_rsvp',
            organizationId: widget.organizationId,
            payload: <String, dynamic>{
              'eventId': _eventId,
              'action': action,
            },
            createdAtIso: DateTime.now().toUtc().toIso8601String(),
          ),
        );
        await ref.read(shellSessionProvider.notifier).refreshOfflineQueueCount();
        if (!mounted) return;
        setState(() => _mutating = false);
        ref.read(ertadFeedbackProvider.notifier).showWarning(
          shellTr(
            context,
            'offline_queued_notice',
            fallback:
                'Offline — saved to queue and will send automatically once connected.',
          ),
        );
        return;
      }
      setState(() => _mutating = false);
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final title =
        _event['title']?.toString() ??
        shellTr(context, 'src_event', fallback: 'Event');
    final description = _event['description']?.toString() ?? '';
    final location = _event['location']?.toString() ?? '';
    final startsAt = _event['startsAt']?.toString() ?? '';
    final going = (_event['goingCount'] as num?)?.toInt() ?? 0;
    final cap = (_event['capacityLimit'] as num?)?.toInt();
    final myRsvp = _event['myRsvp'];
    final rsvpStatus = myRsvp is Map
        ? (myRsvp['status']?.toString() ?? '').toLowerCase()
        : '';
    final checkinCode = myRsvp is Map
        ? (myRsvp['checkinCode']?.toString() ?? '')
        : '';
    final isGoing =
        rsvpStatus == 'going' ||
        rsvpStatus == 'waitlist' ||
        rsvpStatus == 'checked_in';

    final String datePreview = startsAt.length >= 16
        ? '${startsAt.substring(0, 10)} · ${startsAt.substring(11, 16)}'
        : startsAt;

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.82,
      minChildSize: 0.5,
      maxChildSize: 0.95,
      builder: (context, scrollController) {
        final bottomInset = MediaQuery.viewPaddingOf(context).bottom;
        return Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 640),
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 12, 8),
                  child: ErtadModalSheetHeader(
                    icon: Icons.event_outlined,
                    title: title,
                    closeTooltip: shellTr(context, 'close', fallback: 'Close'),
                  ),
                ),
                Expanded(
                  child: _loading
                      ? const Center(child: CircularProgressIndicator())
                      : ListView(
                          controller: scrollController,
                          padding: EdgeInsets.fromLTRB(
                            16,
                            8,
                            16,
                            28 + bottomInset,
                          ),
                          children: [
                            ErtadSurfaceCard(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Wrap(
                              spacing: 8,
                              runSpacing: 6,
                              children: [
                                if (datePreview.isNotEmpty)
                                  ErtadStatusPill(
                                    icon: Icons.schedule_rounded,
                                    label: datePreview,
                                    tone: ErtadTone.primary,
                                  ),
                                ErtadStatusPill(
                                  icon: Icons.people_outline_rounded,
                                  label: cap != null
                                      ? '$going / $cap ${shellTr(context, 'event_spots', fallback: 'spots')}'
                                      : '$going ${shellTr(context, 'event_going_words', fallback: 'going')}',
                                  tone: ErtadTone.secondary,
                                ),
                              ],
                            ),
                            const SizedBox(height: 12),
                            Text(
                              title,
                              style: Theme.of(context).textTheme.titleLarge,
                            ),
                            if (location.isNotEmpty) ...[
                              const SizedBox(height: 6),
                              Row(
                                children: [
                                  Icon(
                                    Icons.place_outlined,
                                    size: 16,
                                    color: p.muted,
                                  ),
                                  const SizedBox(width: 4),
                                  Expanded(
                                    child: Text(
                                      location,
                                      style: Theme.of(context)
                                          .textTheme
                                          .bodySmall
                                          ?.copyWith(color: p.primary),
                                    ),
                                  ),
                                ],
                              ),
                            ],
                            if (description.isNotEmpty) ...[
                              const SizedBox(height: 10),
                              Text(
                                description,
                                style: Theme.of(context).textTheme.bodyMedium,
                              ),
                            ],
                          ],
                        ),
                      ),
                      if (rsvpStatus == 'going' && checkinCode.isNotEmpty) ...[
                        const SizedBox(height: 14),
                        ErtadSurfaceCard(
                          backgroundColor: p.primarySoft,
                          borderColor: p.primary.withValues(alpha: 0.35),
                          child: Column(
                            children: [
                              Row(
                                children: [
                                  Icon(
                                    Icons.qr_code_2_rounded,
                                    color: p.primary,
                                    size: 28,
                                  ),
                                  const SizedBox(width: 10),
                                  Expanded(
                                    child: Text(
                                      shellTr(
                                        context,
                                        'event_checkin_pass',
                                        fallback: 'Check-in pass code',
                                      ),
                                      style: Theme.of(
                                        context,
                                      ).textTheme.titleMedium,
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 10),
                              Container(
                                width: double.infinity,
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 14,
                                  vertical: 12,
                                ),
                                decoration: BoxDecoration(
                                  color: p.surface,
                                  borderRadius: BorderRadius.circular(14),
                                  border: Border.all(color: p.hairline),
                                ),
                                child: SelectableText(
                                  checkinCode,
                                  textAlign: TextAlign.center,
                                  style: Theme.of(context)
                                      .textTheme
                                      .headlineSmall
                                      ?.copyWith(
                                        fontFamily: 'monospace',
                                        fontWeight: FontWeight.w800,
                                        letterSpacing: 2.2,
                                      ),
                                ),
                              ),
                              const SizedBox(height: 10),
                              OutlinedButton.icon(
                                onPressed: () {
                                  Clipboard.setData(
                                    ClipboardData(text: checkinCode),
                                  );
                                  ref
                                      .read(ertadFeedbackProvider.notifier)
                                      .showSuccess(
                                        shellTr(
                                          context,
                                          'event_code_copied',
                                          fallback: 'Check-in code copied',
                                        ),
                                      );
                                },
                                icon: const Icon(Icons.copy_rounded, size: 17),
                                label: Text(
                                  shellTr(
                                    context,
                                    'event_copy_code',
                                    fallback: 'Copy code',
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                      const SizedBox(height: 16),
                      if (rsvpStatus != 'checked_in')
                        SizedBox(
                          width: double.infinity,
                          child: isGoing
                              ? OutlinedButton.icon(
                                  onPressed: _mutating
                                      ? null
                                      : () => _toggleRsvp('cancel'),
                                  style: OutlinedButton.styleFrom(
                                    minimumSize: const Size(48, 48),
                                  ),
                                  icon: const Icon(Icons.close_rounded),
                                  label: Text(
                                    shellTr(
                                      context,
                                      'event_rsvp_cancel',
                                      fallback: 'Cancel RSVP',
                                    ),
                                  ),
                                )
                              : FilledButton.icon(
                                  onPressed: _mutating
                                      ? null
                                      : () => _toggleRsvp('rsvp'),
                                  style: FilledButton.styleFrom(
                                    minimumSize: const Size(48, 48),
                                  ),
                                  icon: const Icon(
                                    Icons.event_available_rounded,
                                  ),
                                  label: Text(
                                    shellTr(
                                      context,
                                      'event_rsvp_going',
                                      fallback: 'Going (RSVP)',
                                    ),
                                  ),
                                ),
                        ),
                      if (_event['canManage'] == true ||
                          ref.watch(shellSessionProvider).isGroupManager) ...[
                        const SizedBox(height: 16),
                        ErtadSurfaceCard(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                shellTr(
                                  context,
                                  'mgr_event_checkin_title',
                                  fallback: 'Check-in participant',
                                ),
                                style: Theme.of(context).textTheme.titleMedium,
                              ),
                              const SizedBox(height: 8),
                              TextField(
                                controller: _checkinController,
                                textCapitalization:
                                    TextCapitalization.characters,
                                decoration: InputDecoration(
                                  hintText: shellTr(
                                    context,
                                    'mgr_event_checkin_hint',
                                    fallback: '12-char check-in code',
                                  ),
                                ),
                              ),
                              const SizedBox(height: 10),
                              SizedBox(
                                width: double.infinity,
                                child: FilledButton.icon(
                                  onPressed: _mutating
                                      ? null
                                      : () async {
                                          final code = _checkinController.text
                                              .trim();
                                          if (code.length < 6) return;
                                          setState(() => _mutating = true);
                                          try {
                                            await ref
                                                .read(mobileApiClientProvider)
                                                .checkinEvent(
                                                  organizationId:
                                                      widget.organizationId,
                                                  eventId: _eventId,
                                                  checkinCode: code,
                                                );
                                            if (!context.mounted) return;
                                            _checkinController.clear();
                                            setState(() => _mutating = false);
                                            ref
                                                .read(
                                                  ertadFeedbackProvider
                                                      .notifier,
                                                )
                                                .showSuccess(
                                                  shellTr(
                                                    context,
                                                    'mgr_event_checkin_ok',
                                                    fallback:
                                                        'Participant checked in',
                                                  ),
                                                );
                                            await _loadDetail();
                                          } catch (err) {
                                            if (!context.mounted) return;
                                            setState(() => _mutating = false);
                                            ref
                                                .read(
                                                  ertadFeedbackProvider
                                                      .notifier,
                                                )
                                                .showError(err);
                                          }
                                        },
                                  icon: const Icon(Icons.qr_code_scanner),
                                  label: Text(
                                    shellTr(
                                      context,
                                      'mgr_event_checkin_btn',
                                      fallback: 'Verify check-in',
                                    ),
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
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

