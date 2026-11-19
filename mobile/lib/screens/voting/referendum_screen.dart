import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/shell/shell_l10n.dart';
import '../../core/theme/ertad_theme.dart';
import '../../core/widgets/ertad_ui.dart';
import '../../models/poll.dart';
import '../../services/localization_service.dart';
import 'confirm_vote_screen.dart';
import 'decision_results_card.dart';

class ReferendumScreen extends StatefulWidget {
  final Poll poll;

  const ReferendumScreen({super.key, required this.poll});

  @override
  State<ReferendumScreen> createState() => _ReferendumScreenState();
}

class _ReferendumScreenState extends State<ReferendumScreen> {
  String? _selectedOptionId;

  bool get _isClosed {
    final raw = widget.poll.endAt;
    if (raw == null || raw.isEmpty) return false;
    final parsed = DateTime.tryParse(raw);
    if (parsed == null) return false;
    return !parsed.isAfter(DateTime.now().toUtc());
  }

  bool get _isReadOnly => widget.poll.hasVoted || _isClosed;

  (ErtadTone, IconData) _optionVisual(int index) {
    if (index == 0) return (ErtadTone.success, Icons.check_circle_rounded);
    if (index == 1) return (ErtadTone.danger, Icons.cancel_rounded);
    return (ErtadTone.neutral, Icons.remove_circle_outline_rounded);
  }

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final loc = Provider.of<LocalizationService>(context);
    final isClosed = _isClosed;
    final isReadOnly = _isReadOnly;

    return ErtadSubpageScaffold(
      title: loc.translate('referendum'),
      bottomBar: SizedBox(
        width: double.infinity,
        child: isReadOnly
            ? OutlinedButton.icon(
                onPressed: () => Navigator.of(context).pop(),
                icon: const Icon(Icons.check_rounded),
                label: Text(shellTr(context, 'close', fallback: 'Close')),
              )
            : FilledButton.icon(
                onPressed: _selectedOptionId == null
                    ? null
                    : () {
                        final selectedOption = widget.poll.options.firstWhere(
                          (opt) => opt.id == _selectedOptionId,
                        );
                        Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (_) => ConfirmVoteScreen(
                              poll: widget.poll,
                              selectedOption: selectedOption,
                            ),
                          ),
                        );
                      },
                icon: const Icon(Icons.rate_review_outlined),
                label: Text(loc.translate('review_vote')),
              ),
      ),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Wrap(
              alignment: WrapAlignment.center,
              spacing: 8,
              runSpacing: 8,
              children: [
                if (widget.poll.hasVoted)
                  ErtadStatusPill(
                    icon: Icons.check_circle_rounded,
                    tone: ErtadTone.success,
                    label: shellTr(
                      context,
                      'polls_already_voted',
                      fallback: 'Participated',
                    ),
                  ),
                if (isClosed)
                  ErtadStatusPill(
                    icon: Icons.lock_clock_outlined,
                    tone: ErtadTone.neutral,
                    label: shellTr(
                      context,
                      'poll_closed_label',
                      fallback: 'Closed',
                    ),
                  ),
                if (widget.poll.endAt != null)
                  ErtadStatusPill(
                    icon: Icons.schedule_rounded,
                    label:
                        '${loc.translate('poll_ends')} ${DateFormat.yMMMd().add_Hm().format(DateTime.parse(widget.poll.endAt!).toLocal())}',
                  ),
                if (widget.poll.referendumThreshold != null)
                  ErtadStatusPill(
                    icon: Icons.people_outline_rounded,
                    tone: ErtadTone.secondary,
                    label:
                        '${loc.translate('req_participation')}: ${widget.poll.referendumThreshold}%',
                  ),
              ],
            ),
            if (isReadOnly) ...[
              const SizedBox(height: 12),
              DecisionResultsCard(poll: widget.poll, isClosed: isClosed),
              const SizedBox(height: 12),
              ErtadStateBanner(
                icon: Icons.verified_user_outlined,
                tone: ErtadTone.primary,
                message: shellTr(
                  context,
                  'decision_readonly_notice',
                  fallback:
                      'Your participation is recorded — options are shown read-only to protect ballot privacy.',
                ),
              ),
            ],
            const SizedBox(height: 16),
            ErtadSurfaceCard(
              backgroundColor: p.secondarySoft,
              borderColor: p.secondary.withValues(alpha: 0.35),
              padding: const EdgeInsets.all(20),
              child: Column(
                children: [
                  const ErtadIconCircle(
                    icon: Icons.how_to_vote_rounded,
                    tone: ErtadTone.secondary,
                    size: 48,
                    iconSize: 25,
                    radius: 15,
                  ),
                  const SizedBox(height: 12),
                  Text(
                    widget.poll.title,
                    style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                      color: p.text,
                    ),
                    textAlign: TextAlign.center,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 20),
            Expanded(
              child: widget.poll.options.isEmpty
                  ? Center(
                      child: ErtadEmptyState(
                        icon: Icons.how_to_vote_outlined,
                        tone: ErtadTone.secondary,
                        title: widget.poll.title,
                        body: shellTr(
                          context,
                          'poll_no_options',
                          fallback:
                              'No ballot options are currently available for this decision.',
                        ),
                      ),
                    )
                  : ListView.builder(
                      itemCount: widget.poll.options.length,
                      itemBuilder: (context, index) {
                        final option = widget.poll.options[index];
                        final isSelected = _selectedOptionId == option.id;
                        final (tone, icon) = _optionVisual(index);
                        final accent = ertadToneColor(p, tone);

                        return Padding(
                          padding: const EdgeInsets.only(bottom: 12),
                          child: ErtadSurfaceCard(
                            onTap: isReadOnly
                                ? null
                                : () => setState(
                                    () => _selectedOptionId = option.id,
                                  ),
                            backgroundColor: isSelected
                                ? ertadToneSoftColor(p, tone)
                                : p.surface,
                            borderColor: isSelected ? accent : p.hairline,
                            padding: const EdgeInsets.all(18),
                            child: Row(
                              children: [
                                Icon(
                                  isSelected
                                      ? icon
                                      : Icons.radio_button_off_rounded,
                                  color: isSelected ? accent : p.muted,
                                  size: 28,
                                ),
                                const SizedBox(width: 14),
                                Expanded(
                                  child: Text(
                                    option.text,
                                    style: Theme.of(context)
                                        .textTheme
                                        .titleMedium
                                        ?.copyWith(
                                          color: isSelected ? accent : p.text,
                                          fontWeight: isSelected
                                              ? FontWeight.w700
                                              : FontWeight.w500,
                                        ),
                                  ),
                                ),
                                if (isSelected)
                                  Icon(
                                    Icons.check_rounded,
                                    color: accent,
                                    size: 22,
                                  ),
                              ],
                            ),
                          ),
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
