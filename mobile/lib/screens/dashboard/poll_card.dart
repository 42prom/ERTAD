import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../core/shell/shell_l10n.dart';
import '../../core/theme/ertad_theme.dart';
import '../../core/widgets/ertad_ui.dart';
import '../../models/poll.dart';
import '../../services/localization_service.dart';
import '../voting/poll_details_screen.dart';
import '../voting/referendum_screen.dart';
import '../voting/survey_screen.dart';

/// Shared decision-route opener routing directly to Survey / Referendum / Poll details.
Future<void> openPollDecision(BuildContext context, Poll poll) {
  final Widget screen;
  if (poll.isSurvey) {
    screen = SurveyScreen(poll: poll);
  } else if (poll.type == 'referendum') {
    screen = ReferendumScreen(poll: poll);
  } else {
    screen = PollDetailsScreen(poll: poll);
  }
  return Navigator.of(
    context,
    rootNavigator: true,
  ).push(MaterialPageRoute<void>(builder: (_) => screen));
}

/// Unified 2026 decision card built on ErtadSurfaceCard & semantic palette tokens.
class PollCard extends StatelessWidget {
  final Poll poll;
  final VoidCallback? onVoteComplete;
  final bool compact;

  const PollCard({
    super.key,
    required this.poll,
    this.onVoteComplete,
    this.compact = false,
  });

  bool get _isEnded {
    final raw = poll.endAt;
    if (raw == null || raw.isEmpty) return false;
    final parsed = DateTime.tryParse(raw);
    if (parsed == null) return false;
    return !parsed.isAfter(DateTime.now().toUtc());
  }

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final locService = Provider.of<LocalizationService>(context);
    final isEnded = _isEnded;
    final isReadOnly = poll.hasVoted || isEnded;

    final (IconData typeIcon, ErtadTone typeTone) = switch (poll.type) {
      'referendum' => (Icons.how_to_vote_rounded, ErtadTone.secondary),
      'survey' => (Icons.fact_check_rounded, ErtadTone.primary),
      _ => (Icons.poll_rounded, ErtadTone.success),
    };

    Future<void> openDecision() async {
      HapticFeedback.selectionClick();
      await openPollDecision(context, poll);
      onVoteComplete?.call();
    }

    if (compact) {
      return ErtadSurfaceCard(
        onTap: openDecision,
        padding: const EdgeInsets.all(14),
        child: Row(
          children: [
            ErtadIconCircle(
              icon: typeIcon,
              tone: typeTone,
              size: 40,
              iconSize: 20,
              radius: 12,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    poll.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 6),
                  Wrap(
                    spacing: 6,
                    runSpacing: 4,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      if (poll.hasVoted)
                        ErtadStatusPill(
                          icon: Icons.check_circle_rounded,
                          label: shellTr(
                            context,
                            'polls_already_voted',
                            fallback: 'Participated',
                          ),
                          tone: ErtadTone.success,
                        ),
                      if (isEnded)
                        ErtadStatusPill(
                          icon: Icons.lock_clock_outlined,
                          label: shellTr(
                            context,
                            'poll_closed_label',
                            fallback: 'Closed',
                          ),
                          tone: ErtadTone.neutral,
                        ),
                      if (poll.endAt != null)
                        Text(
                          formatShellDateTime(
                            context,
                            DateTime.parse(poll.endAt!).toLocal(),
                          ),
                          style: Theme.of(context).textTheme.labelSmall
                              ?.copyWith(color: p.muted),
                        ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Icon(Icons.chevron_right_rounded, color: p.muted),
          ],
        ),
      );
    }

    return ErtadSurfaceCard(
      onTap: openDecision,
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              ErtadIconCircle(
                icon: typeIcon,
                tone: typeTone,
                size: 36,
                iconSize: 19,
                radius: 11,
              ),
              const SizedBox(width: 10),
              ErtadStatusPill(
                label: poll.type.isEmpty
                    ? ''
                    : locService.translate(poll.type.toLowerCase()),
                tone: typeTone,
              ),
              const Spacer(),
              if (poll.endAt != null) ...[
                Icon(Icons.schedule_rounded, size: 14, color: p.muted),
                const SizedBox(width: 4),
                Text(
                  formatShellDateTime(
                    context,
                    DateTime.parse(poll.endAt!).toLocal(),
                  ),
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: p.muted,
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 12),
          Text(
            poll.title,
            style: Theme.of(context).textTheme.titleLarge?.copyWith(
              height: 1.25,
            ),
          ),
          if (poll.referendumQuestion != null ||
              poll.electionQuestion != null) ...[
            const SizedBox(height: 8),
            Text(
              poll.referendumQuestion ?? poll.electionQuestion!,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: ertadToneColor(p, typeTone),
                fontWeight: FontWeight.w600,
              ),
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
            ),
          ],
          if (poll.tags.isNotEmpty || poll.hasVoted || isEnded) ...[
            const SizedBox(height: 12),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                if (poll.hasVoted)
                  ErtadStatusPill(
                    icon: Icons.check_circle_rounded,
                    label: shellTr(
                      context,
                      'polls_already_voted',
                      fallback: 'Participated',
                    ),
                    tone: ErtadTone.success,
                  ),
                if (isEnded)
                  ErtadStatusPill(
                    icon: Icons.lock_clock_outlined,
                    label: shellTr(
                      context,
                      'poll_closed_label',
                      fallback: 'Closed',
                    ),
                    tone: ErtadTone.neutral,
                  ),
                ...poll.tags.map((tag) {
                  final label = switch (tag) {
                    'anonymous' => shellTr(
                      context,
                      'polls_privacy_anonymous',
                      fallback: 'Anonymous',
                    ),
                    'named' => shellTr(
                      context,
                      'polls_privacy_named',
                      fallback: 'Named',
                    ),
                    'binding' => shellTr(
                      context,
                      'polls_binding',
                      fallback: 'Binding',
                    ),
                    'advisory' => shellTr(
                      context,
                      'polls_advisory',
                      fallback: 'Advisory',
                    ),
                    _ => tag,
                  };
                  return ErtadStatusPill(
                    label: label,
                    tone: tag == 'anonymous'
                        ? ErtadTone.primary
                        : ErtadTone.neutral,
                  );
                }),
              ],
            ),
          ],
          const SizedBox(height: 14),
          SizedBox(
            width: double.infinity,
            child: isReadOnly
                ? OutlinedButton.icon(
                    onPressed: openDecision,
                    icon: Icon(
                      poll.hasVoted
                          ? Icons.check_circle_outline_rounded
                          : Icons.visibility_outlined,
                      size: 18,
                    ),
                    label: Text(
                      shellTr(
                        context,
                        'poll_view_summary',
                        fallback: 'View details',
                      ),
                    ),
                  )
                : FilledButton.icon(
                    onPressed: openDecision,
                    icon: Icon(typeIcon, size: 18),
                    label: Text(
                      poll.isSurvey
                          ? locService.translate('take_survey')
                          : poll.type == 'referendum'
                          ? locService.translate('vote_on_referendum')
                          : locService.translate('vote_now'),
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}
