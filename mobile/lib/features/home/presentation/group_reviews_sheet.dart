import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/feedback/ertad_feedback.dart';
import '../../../core/shell/shell_l10n.dart';
import '../../../core/state/shell_providers.dart';
import '../../../core/theme/ertad_theme.dart';
import '../../../core/widgets/ertad_ui.dart';

/// Opens pending membership reviews in a modal sheet for Group Managers.
Future<void> showGroupReviewsSheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => const _GroupReviewsSheet(),
  );
}

class _GroupReviewsSheet extends ConsumerStatefulWidget {
  const _GroupReviewsSheet();

  @override
  ConsumerState<_GroupReviewsSheet> createState() => _GroupReviewsSheetState();
}

class _GroupReviewsSheetState extends ConsumerState<_GroupReviewsSheet> {
  final TextEditingController _reasonController = TextEditingController();
  String? _busyReviewId;

  @override
  void dispose() {
    _reasonController.dispose();
    super.dispose();
  }

  Future<void> _decide(
    Map<String, dynamic> review,
    String decision,
  ) async {
    final reviewId = review['id']?.toString() ?? '';
    if (reviewId.isEmpty || _busyReviewId != null) return;

    final reason = _reasonController.text.trim();
    if (reason.length < 10) {
      ref.read(ertadFeedbackProvider.notifier).showWarning(
        shellTr(
          context,
          'review_reason_too_short',
          fallback: 'Enter at least 10 characters explaining your decision.',
        ),
      );
      return;
    }

    setState(() => _busyReviewId = reviewId);
    final api = ref.read(mobileApiClientProvider);
    final orgId = ref.read(shellSessionProvider).activeOrgId;
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
        run: (key) => api.decideReview(
          organizationId: orgId,
          reviewId: reviewId,
          decision: decision,
          reason: reason,
          idempotencyKey: key,
        ),
      );
      if (!mounted) return;
      _reasonController.clear();
      setState(() => _busyReviewId = null);
      ref.read(ertadFeedbackProvider.notifier).showSuccess(
        decision == 'approved'
            ? shellTr(
                context,
                'review_approved_toast',
                fallback: 'Membership review approved',
              )
            : shellTr(
                context,
                'review_rejected_toast',
                fallback: 'Membership review declined',
              ),
      );
      await ref.read(shellSessionProvider.notifier).refreshWorkspace();
    } on ErtadCancelledException {
      if (!mounted) return;
      setState(() => _busyReviewId = null);
    } catch (err) {
      if (!mounted) return;
      setState(() => _busyReviewId = null);
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final session = ref.watch(shellSessionProvider);
    final reviews = session.pendingReviews;

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.78,
      minChildSize: 0.5,
      maxChildSize: 0.94,
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
                    icon: Icons.how_to_reg_outlined,
                    title: shellTr(
                      context,
                      'mgr_reviews_title',
                      fallback: 'Membership reviews',
                    ),
                    closeTooltip: shellTr(context, 'close', fallback: 'Close'),
                  ),
                ),
                Expanded(
                  child: ListView(
                    controller: scrollController,
                    padding: EdgeInsets.fromLTRB(16, 8, 16, bottomInset + 24),
                    children: [
                      if (reviews.isEmpty)
                        ErtadEmptyState(
                          icon: Icons.verified_user_outlined,
                          tone: ErtadTone.success,
                          title: shellTr(
                            context,
                            'mgr_reviews_empty_title',
                            fallback: 'No pending reviews',
                          ),
                          body: shellTr(
                            context,
                            'mgr_reviews_empty_body',
                            fallback:
                                'All membership requests in your unit are up to date.',
                          ),
                        )
                      else ...[
                        ErtadSurfaceCard(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                shellTr(
                                  context,
                                  'mgr_review_reason_label',
                                  fallback: 'Decision reason (min 10 chars)',
                                ),
                                style: Theme.of(context).textTheme.labelMedium,
                              ),
                              const SizedBox(height: 8),
                              TextField(
                                controller: _reasonController,
                                maxLines: 2,
                                decoration: InputDecoration(
                                  hintText: shellTr(
                                    context,
                                    'mgr_review_reason_hint',
                                    fallback:
                                        'Explain why you approve or decline...',
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 12),
                        for (final rev in reviews) ...[
                          _ReviewItemCard(
                            review: rev,
                            busy: _busyReviewId == rev['id']?.toString(),
                            anyBusy: _busyReviewId != null,
                            onApprove: () => _decide(rev, 'approved'),
                            onReject: () => _decide(rev, 'rejected'),
                            hairline: p.hairline,
                          ),
                          const SizedBox(height: 10),
                        ],
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

class _ReviewItemCard extends StatelessWidget {
  final Map<String, dynamic> review;
  final bool busy;
  final bool anyBusy;
  final VoidCallback onApprove;
  final VoidCallback onReject;
  final Color hairline;

  const _ReviewItemCard({
    required this.review,
    required this.busy,
    required this.anyBusy,
    required this.onApprove,
    required this.onReject,
    required this.hairline,
  });

  @override
  Widget build(BuildContext context) {
    final kind = review['kind']?.toString() ?? 'membership';
    final unitName = review['unitName']?.toString() ?? '';
    final positionName = review['positionName']?.toString() ?? '';
    final targetLabel =
        review['targetLabel']?.toString() ??
        review['targetId']?.toString() ??
        '';
    final reason = review['reason']?.toString() ?? '';

    return ErtadSurfaceCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 6,
            children: [
              ErtadStatusPill(
                icon: Icons.pending_actions_rounded,
                label: kind,
                tone: ErtadTone.warning,
              ),
              if (unitName.isNotEmpty)
                ErtadStatusPill(
                  icon: Icons.groups_2_outlined,
                  label: unitName,
                  tone: ErtadTone.primary,
                ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            positionName.isNotEmpty ? '$positionName · $targetLabel' : targetLabel,
            style: Theme.of(context).textTheme.titleMedium,
          ),
          if (reason.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              reason,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: anyBusy ? null : onReject,
                  child: Text(
                    shellTr(context, 'mgr_reject', fallback: 'Decline'),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: FilledButton(
                  onPressed: anyBusy ? null : onApprove,
                  child: busy
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : Text(
                          shellTr(context, 'mgr_approve', fallback: 'Approve'),
                        ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
