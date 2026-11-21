import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/feedback/ertad_feedback.dart';
import '../../../core/shell/shell_l10n.dart';
import '../../../core/state/shell_providers.dart';
import '../../../core/theme/ertad_theme.dart';
import '../../../core/widgets/ertad_ui.dart';
import '../../messages/presentation/channel_thread_screen.dart';

/// Opens WorkItem detail & member lifecycle actions in a unified modal popup sheet.
Future<void> showWorkDetailSheet(
  BuildContext context, {
  required String organizationId,
  required Map<String, dynamic> initialWork,
}) {
  return showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => WorkDetailScreen(
      organizationId: organizationId,
      initialWork: initialWork,
    ),
  );
}

/// Modal WorkItem detail & member lifecycle actions (/mobile/work/*).
class WorkDetailScreen extends ConsumerStatefulWidget {
  final String organizationId;
  final Map<String, dynamic> initialWork;

  const WorkDetailScreen({
    super.key,
    required this.organizationId,
    required this.initialWork,
  });

  @override
  ConsumerState<WorkDetailScreen> createState() => _WorkDetailScreenState();
}

class _WorkDetailScreenState extends ConsumerState<WorkDetailScreen> {
  final TextEditingController _noteController = TextEditingController();
  late Map<String, dynamic> _work;
  Map<String, dynamic>? _workChannelInfo;
  bool _loading = true;
  bool _mutating = false;

  String get _workId => _work['id']?.toString() ?? '';
  int get _version => (_work['version'] as num?)?.toInt() ?? 1;

  @override
  void initState() {
    super.initState();
    _work = Map<String, dynamic>.from(widget.initialWork);
    _loadDetail();
  }

  @override
  void dispose() {
    _noteController.dispose();
    super.dispose();
  }

  Future<void> _loadDetail() async {
    final api = ref.read(mobileApiClientProvider);
    try {
      final detail = await api.fetchWorkDetail(
        organizationId: widget.organizationId,
        workId: _workId,
      );
      final hasAssignments = (detail['assignments'] as List?)?.isNotEmpty == true;
      final canAccessChat = hasAssignments || detail['canManage'] == true;
      final channelInfo = canAccessChat
          ? await api
              .fetchWorkChannel(
                organizationId: widget.organizationId,
                workId: _workId,
              )
              .catchError((_) => const <String, dynamic>{})
          : const <String, dynamic>{};
      if (!mounted) return;
      setState(() {
        _work = detail;
        _workChannelInfo = channelInfo;
        _loading = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() => _loading = false);
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  String? _myAssignmentStatus() {
    final list = (_work['assignments'] as List? ?? const []);
    if (list.isEmpty) return null;
    final first = list.first;
    if (first is Map) return first['status']?.toString().toLowerCase();
    return null;
  }

  Future<void> _runWorkAction(String op, String successKey, String fallback) async {
    if (_mutating) return;
    setState(() => _mutating = true);
    final api = ref.read(mobileApiClientProvider);
    try {
      await runWithStepUpConfirmation(
        context,
        api,
        actionTitle: shellTr(
          context,
          'stepup_title',
          fallback: 'Confirm action',
        ),
        actionBody: shellTr(
          context,
          'stepup_body',
          fallback: 'Confirm your session to submit this action?',
        ),
        confirmLabel: shellTr(
          context,
          'stepup_confirm',
          fallback: 'Confirm',
        ),
        run: (key) => api.mutateWork(
          op: op,
          organizationId: widget.organizationId,
          workId: _workId,
          version: _version,
          note: _noteController.text.trim(),
          idempotencyKey: key,
        ),
      );
      if (!mounted) return;
      _noteController.clear();
      setState(() => _mutating = false);
      ref.read(ertadFeedbackProvider.notifier).showSuccess(
        shellTr(context, successKey, fallback: fallback),
      );
      await _loadDetail();
      if (!mounted) return;
      ref.read(shellSessionProvider.notifier).refreshWorkspace();
    } on ErtadCancelledException {
      if (!mounted) return;
      setState(() => _mutating = false);
    } catch (err) {
      if (!mounted) return;
      setState(() => _mutating = false);
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  Future<void> _runMemberReview(
    String memberId,
    String op,
    String successKey,
    String fallback,
  ) async {
    if (_mutating || memberId.isEmpty) return;
    setState(() => _mutating = true);
    final api = ref.read(mobileApiClientProvider);
    try {
      await runWithStepUpConfirmation(
        context,
        api,
        actionTitle: shellTr(
          context,
          'stepup_title',
          fallback: 'Confirm action',
        ),
        actionBody: shellTr(
          context,
          'stepup_body',
          fallback: 'Confirm your session to submit this action?',
        ),
        confirmLabel: shellTr(
          context,
          'stepup_confirm',
          fallback: 'Confirm',
        ),
        run: (key) => api.mutateWorkMember(
          op: op,
          organizationId: widget.organizationId,
          workId: _workId,
          version: _version,
          memberId: memberId,
          note: _noteController.text.trim(),
          idempotencyKey: key,
        ),
      );
      if (!mounted) return;
      _noteController.clear();
      setState(() => _mutating = false);
      ref.read(ertadFeedbackProvider.notifier).showSuccess(
        shellTr(context, successKey, fallback: fallback),
      );
      await _loadDetail();
      if (!mounted) return;
      ref.read(shellSessionProvider.notifier).refreshWorkspace();
    } on ErtadCancelledException {
      if (!mounted) return;
      setState(() => _mutating = false);
    } catch (err) {
      if (!mounted) return;
      setState(() => _mutating = false);
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  Future<void> _openTaskChat() async {
    final chId = _workChannelInfo?['id']?.toString();
    if (chId == null || chId.isEmpty) return;
    await Navigator.of(context, rootNavigator: true).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => ChannelThreadScreen(
          organizationId: widget.organizationId,
          initialChannel: <String, dynamic>{
            'id': chId,
            'title':
                _work['title']?.toString() ??
                shellTr(context, 'task_chat_title', fallback: 'Task Chat'),
            'kind': 'task',
            'canPost': (_work['status']?.toString() ?? 'open') == 'open',
          },
        ),
      ),
    );
  }

  String _assignmentLabel(BuildContext context, String? status) {
    return switch (status) {
      'applied' => shellTr(
        context,
        'task_status_applied',
        fallback: 'Applied',
      ),
      'reserved' => shellTr(
        context,
        'task_status_reserved',
        fallback: 'Reserve',
      ),
      'assigned' => shellTr(
        context,
        'task_status_assigned',
        fallback: 'Assigned',
      ),
      'in_progress' => shellTr(
        context,
        'task_status_in_progress',
        fallback: 'In progress',
      ),
      'submitted' => shellTr(
        context,
        'task_status_submitted',
        fallback: 'Awaiting verification',
      ),
      'verified' => shellTr(
        context,
        'task_status_verified',
        fallback: 'Verified',
      ),
      _ => status ?? '',
    };
  }

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final title =
        _work['title']?.toString() ??
        shellTr(context, 'src_work', fallback: 'Task');
    final description = _work['description']?.toString() ?? '';
    final roleLabel = _work['roleLabel']?.toString() ?? '';
    final priority = _work['priority']?.toString() ?? 'normal';
    final workStatus = (_work['status']?.toString() ?? 'open').toLowerCase();
    final deadline = _work['deadline']?.toString() ?? '';
    final offer = _work['contributionOffer'];
    final assignStatus = _myAssignmentStatus();
    final criteria = (_work['criteria'] as List? ?? const []);
    final hasChannel =
        _workChannelInfo?['id'] != null &&
        _workChannelInfo!['id'].toString().isNotEmpty;

    final String deadlineDay = deadline.length >= 10
        ? deadline.substring(0, 10)
        : deadline;

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.84,
      minChildSize: 0.5,
      maxChildSize: 0.95,
      builder: (context, scrollController) {
        final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
        return Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 640),
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 12, 8),
                  child: ErtadModalSheetHeader(
                    icon: Icons.assignment_outlined,
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
                                ErtadStatusPill(
                                  icon: Icons.flag_outlined,
                                  label: shellTr(
                                    context,
                                    'prio_${priority.toLowerCase()}',
                                    fallback: priority,
                                  ),
                                  tone: priority == 'urgent'
                                      ? ErtadTone.danger
                                      : priority == 'high'
                                      ? ErtadTone.warning
                                      : ErtadTone.secondary,
                                ),
                                if (assignStatus != null)
                                  ErtadStatusPill(
                                    icon: Icons.person_pin_circle_outlined,
                                    label: _assignmentLabel(
                                      context,
                                      assignStatus,
                                    ),
                                    tone: assignStatus == 'verified'
                                        ? ErtadTone.success
                                        : ErtadTone.primary,
                                  ),
                                if (deadlineDay.isNotEmpty)
                                  ErtadStatusPill(
                                    icon: Icons.schedule_rounded,
                                    label: deadlineDay,
                                    tone: ErtadTone.neutral,
                                  ),
                              ],
                            ),
                            const SizedBox(height: 12),
                            Text(
                              title,
                              style: Theme.of(context).textTheme.titleLarge,
                            ),
                            if (roleLabel.isNotEmpty) ...[
                              const SizedBox(height: 4),
                              Text(
                                roleLabel,
                                style: Theme.of(context).textTheme.bodySmall
                                    ?.copyWith(color: p.primary),
                              ),
                            ],
                            if (description.isNotEmpty) ...[
                              const SizedBox(height: 10),
                              Text(
                                description,
                                style: Theme.of(context).textTheme.bodyMedium,
                              ),
                            ],
                            if (offer is Map && offer['amount'] != null) ...[
                              const SizedBox(height: 12),
                              ErtadStatusPill(
                                icon: Icons.stars_rounded,
                                label:
                                    '+${offer['amount']} ${shellTr(context, 'status_points_unit', fallback: 'pts')} · ${shellTr(context, 'task_reward_offer', fallback: 'Verified offer')}',
                                tone: ErtadTone.success,
                              ),
                            ],
                          ],
                        ),
                      ),
                      if (hasChannel) ...[
                        const SizedBox(height: 12),
                        SizedBox(
                          width: double.infinity,
                          child: OutlinedButton.icon(
                            onPressed: _openTaskChat,
                            style: OutlinedButton.styleFrom(
                              minimumSize: const Size(48, 48),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(16),
                              ),
                            ),
                            icon: const Icon(Icons.forum_outlined),
                            label: Text(
                              shellTr(
                                context,
                                'task_open_chat',
                                fallback: 'Task conversation',
                              ),
                            ),
                          ),
                        ),
                      ],
                      if (criteria.isNotEmpty) ...[
                        const SizedBox(height: 16),
                        ErtadSectionHeader(
                          icon: Icons.checklist_rounded,
                          title: shellTr(
                            context,
                            'task_checklist',
                            fallback: 'Checklist',
                          ),
                        ),
                        const SizedBox(height: 8),
                        ErtadSurfaceCard(
                          child: Column(
                            children: criteria.map((raw) {
                              final c = raw is Map ? raw : const {};
                              final cStatus = c['status']?.toString() ?? 'open';
                              return ListTile(
                                contentPadding: EdgeInsets.zero,
                                leading: Icon(
                                  cStatus == 'verified'
                                      ? Icons.check_circle_rounded
                                      : Icons.radio_button_unchecked_rounded,
                                  color: cStatus == 'verified'
                                      ? p.success
                                      : p.muted,
                                ),
                                title: Text(c['title']?.toString() ?? ''),
                                trailing: ErtadStatusPill(
                                  label: cStatus == 'verified'
                                      ? shellTr(
                                          context,
                                          'work_status_verified',
                                          fallback: 'Verified',
                                        )
                                      : shellTr(
                                          context,
                                          'open_label',
                                          fallback: 'open',
                                        ),
                                  tone: cStatus == 'verified'
                                      ? ErtadTone.success
                                      : ErtadTone.neutral,
                                ),
                              );
                            }).toList(),
                          ),
                        ),
                      ],
                      if (workStatus == 'open' &&
                          assignStatus != 'verified' &&
                          assignStatus != 'submitted') ...[
                        const SizedBox(height: 16),
                        ErtadSurfaceCard(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              if (assignStatus != 'applied' &&
                                  assignStatus != 'reserved') ...[
                                TextField(
                                  controller: _noteController,
                                  minLines: 1,
                                  maxLines: 3,
                                  decoration: InputDecoration(
                                    labelText: assignStatus == 'in_progress'
                                        ? shellTr(
                                            context,
                                            'task_note_submit_hint',
                                            fallback:
                                                'Completion note or link (optional)',
                                          )
                                        : shellTr(
                                            context,
                                            'task_note_apply_hint',
                                            fallback:
                                                'Application note (optional)',
                                          ),
                                    border: OutlineInputBorder(
                                      borderRadius: BorderRadius.circular(14),
                                    ),
                                  ),
                                ),
                                const SizedBox(height: 12),
                              ],
                              SizedBox(
                                width: double.infinity,
                                child: _buildActionButton(
                                  context,
                                  assignStatus,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                      if ((_work['canManage'] == true ||
                              ref.watch(shellSessionProvider).isGroupManager) &&
                          workStatus == 'open') ...[
                        const SizedBox(height: 16),
                        _buildManagerReviewSection(context),
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

  Widget _buildManagerReviewSection(BuildContext context) {
    final list = (_work['assignments'] as List? ?? const [])
        .whereType<Map>()
        .map(Map<String, dynamic>.from)
        .where((a) => const {
              'applied',
              'reserved',
              'assigned',
              'in_progress',
              'submitted',
            }.contains(a['status']?.toString().toLowerCase()))
        .toList();
    if (list.isEmpty) return const SizedBox.shrink();

    return ErtadSurfaceCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            shellTr(
              context,
              'mgr_work_review_section',
              fallback: 'Manager review',
            ),
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 10),
          for (final a in list) ...[
            _ManagerAssignmentTile(
              assignment: a,
              mutating: _mutating,
              statusLabel: _assignmentLabel(
                context,
                a['status']?.toString().toLowerCase(),
              ),
              onAction: (op, key, fb) => _runMemberReview(
                a['memberId']?.toString() ?? a['userId']?.toString() ?? '',
                op,
                key,
                fb,
              ),
            ),
            const SizedBox(height: 8),
          ],
        ],
      ),
    );
  }

  Widget _buildActionButton(BuildContext context, String? assignStatus) {
    if (assignStatus == null ||
        assignStatus == 'withdrawn' ||
        assignStatus == 'rejected') {
      return FilledButton.icon(
        onPressed: _mutating
            ? null
            : () => _runWorkAction(
                'apply',
                'task_applied_ok',
                'Application sent',
              ),
        style: FilledButton.styleFrom(minimumSize: const Size(48, 48)),
        icon: const Icon(Icons.send_rounded),
        label: Text(
          shellTr(context, 'task_apply', fallback: 'Apply for task'),
        ),
      );
    }
    if (assignStatus == 'applied' || assignStatus == 'reserved') {
      return OutlinedButton.icon(
        onPressed: _mutating
            ? null
            : () => _runWorkAction(
                'withdraw',
                'task_withdrawn_ok',
                'Application withdrawn',
              ),
        style: OutlinedButton.styleFrom(minimumSize: const Size(48, 48)),
        icon: const Icon(Icons.undo_rounded),
        label: Text(
          shellTr(
            context,
            'task_withdraw',
            fallback: 'Withdraw application',
          ),
        ),
      );
    }
    if (assignStatus == 'assigned') {
      return FilledButton.icon(
        onPressed: _mutating
            ? null
            : () => _runWorkAction(
                'start',
                'task_started_ok',
                'Work started',
              ),
        style: FilledButton.styleFrom(minimumSize: const Size(48, 48)),
        icon: const Icon(Icons.play_arrow_rounded),
        label: Text(shellTr(context, 'task_start', fallback: 'Start work')),
      );
    }
    if (assignStatus == 'in_progress') {
      return FilledButton.icon(
        onPressed: _mutating
            ? null
            : () => _runWorkAction(
                'submit',
                'task_submitted_ok',
                'Submitted for verification',
              ),
        style: FilledButton.styleFrom(minimumSize: const Size(48, 48)),
        icon: const Icon(Icons.task_alt_rounded),
        label: Text(
          shellTr(context, 'task_submit', fallback: 'Submit completed'),
        ),
      );
    }
    return const SizedBox.shrink();
  }
}

class _ManagerAssignmentTile extends StatelessWidget {
  final Map<String, dynamic> assignment;
  final bool mutating;
  final String statusLabel;
  final void Function(String op, String successKey, String fallback) onAction;

  const _ManagerAssignmentTile({
    required this.assignment,
    required this.mutating,
    required this.statusLabel,
    required this.onAction,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final st = assignment['status']?.toString().toLowerCase() ?? '';
    final label =
        assignment['memberLabel']?.toString() ??
        assignment['displayName']?.toString() ??
        shellTr(context, 'msg_participant', fallback: 'Member');

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: p.elevated,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: p.hairline),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  label,
                  style: Theme.of(context).textTheme.titleSmall,
                ),
              ),
              ErtadStatusPill(
                icon: Icons.pending_outlined,
                label: statusLabel,
                tone: st == 'submitted' ? ErtadTone.warning : ErtadTone.primary,
              ),
            ],
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (st == 'applied' || st == 'reserved') ...[
                FilledButton(
                  onPressed: mutating
                      ? null
                      : () => onAction(
                          'assign',
                          'mgr_task_assigned_ok',
                          'Member assigned',
                        ),
                  child: Text(
                    shellTr(context, 'mgr_assign', fallback: 'Assign'),
                  ),
                ),
                OutlinedButton(
                  onPressed: mutating
                      ? null
                      : () => onAction(
                          'reject',
                          'mgr_task_rejected_ok',
                          'Application declined',
                        ),
                  child: Text(
                    shellTr(context, 'mgr_reject', fallback: 'Decline'),
                  ),
                ),
              ],
              if (st == 'submitted') ...[
                FilledButton(
                  onPressed: mutating
                      ? null
                      : () => onAction(
                          'verify',
                          'mgr_task_verified_ok',
                          'Completion verified',
                        ),
                  child: Text(
                    shellTr(context, 'mgr_verify', fallback: 'Verify'),
                  ),
                ),
                OutlinedButton(
                  onPressed: mutating
                      ? null
                      : () => onAction(
                          'return',
                          'mgr_task_returned_ok',
                          'Returned for revision',
                        ),
                  child: Text(
                    shellTr(context, 'mgr_return', fallback: 'Return'),
                  ),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }
}
