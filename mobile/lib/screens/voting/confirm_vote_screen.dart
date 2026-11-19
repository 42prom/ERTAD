import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart'
    show ProviderContainer, ProviderScope;
import 'package:provider/provider.dart';

import '../../core/feedback/ertad_feedback.dart';
import '../../core/shell/shell_l10n.dart';
import '../../core/state/shell_providers.dart';
import '../../core/widgets/ertad_ui.dart';
import '../../models/poll.dart';
import '../../services/localization_service.dart';
import '../../widgets/decision_unavailable_notice.dart';

/// Ballot confirmation screen: casts real server vote when live-connected,
/// and stays fail-closed ([DecisionUnavailableNotice]) offline/standalone.
class ConfirmVoteScreen extends StatefulWidget {
  final Poll poll;
  final PollOption selectedOption;

  const ConfirmVoteScreen({
    super.key,
    required this.poll,
    required this.selectedOption,
  });

  @override
  State<ConfirmVoteScreen> createState() => _ConfirmVoteScreenState();
}

class _ConfirmVoteScreenState extends State<ConfirmVoteScreen> {
  bool _submitting = false;

  ProviderContainer? _maybeContainer(BuildContext context) {
    try {
      return ProviderScope.containerOf(context, listen: false);
    } catch (_) {
      return null;
    }
  }

  Future<void> _submitVote(ProviderContainer container) async {
    if (_submitting) return;
    final session = container.read(shellSessionProvider);
    final api = container.read(mobileApiClientProvider);
    if (!session.isLiveConnected || session.activeOrgId.startsWith('org-')) {
      return;
    }

    setState(() => _submitting = true);
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
          fallback: 'Confirm your session to submit this vote?',
        ),
        confirmLabel: shellTr(
          context,
          'stepup_confirm',
          fallback: 'Confirm',
        ),
        run: (key) => api.voteDecision(
          organizationId: session.activeOrgId,
          decisionId: widget.poll.id,
          choice: widget.selectedOption.displayOrder,
          idempotencyKey: key,
        ),
      );
      if (!mounted) return;
      container.read(ertadFeedbackProvider.notifier).showSuccess(
        shellTr(
          context,
          'polls_vote_recorded',
          fallback: 'Your vote was securely recorded!',
        ),
      );
      container.read(shellSessionProvider.notifier).refreshWorkspace();
      final nav = Navigator.of(context, rootNavigator: true);
      nav.pop();
      if (nav.canPop()) nav.pop();
    } on ErtadCancelledException {
      if (!mounted) return;
      setState(() => _submitting = false);
    } catch (err) {
      if (!mounted) return;
      setState(() => _submitting = false);
      container.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  @override
  Widget build(BuildContext context) {
    final loc = context.watch<LocalizationService>();
    final container = _maybeContainer(context);
    final session = container?.read(shellSessionProvider);
    final canVoteLive =
        container != null &&
        session != null &&
        session.isLiveConnected &&
        !session.activeOrgId.startsWith('org-');

    return ErtadSubpageScaffold(
      title: loc.translate('review_vote'),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (!canVoteLive) ...[
              const DecisionUnavailableNotice(),
              const SizedBox(height: 16),
            ],
            ErtadSurfaceCard(
              padding: const EdgeInsets.all(22),
              child: Column(
                children: [
                  const ErtadIconCircle(
                    icon: Icons.how_to_vote_rounded,
                    tone: ErtadTone.primary,
                    size: 50,
                    iconSize: 26,
                    radius: 16,
                  ),
                  const SizedBox(height: 14),
                  Text(
                    widget.poll.title,
                    style: Theme.of(context).textTheme.titleLarge,
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 10),
                  ErtadStatusPill(
                    label: widget.selectedOption.text,
                    icon: Icons.check_circle_outline_rounded,
                    tone: ErtadTone.primary,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 20),
            ElevatedButton(
              onPressed: canVoteLive && !_submitting
                  ? () => _submitVote(container)
                  : null,
              style: ElevatedButton.styleFrom(
                minimumSize: const Size.fromHeight(52),
              ),
              child: _submitting
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Text(loc.translate('confirm_vote')),
            ),
          ],
        ),
      ),
    );
  }
}
