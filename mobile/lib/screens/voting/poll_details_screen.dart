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
import 'referendum_screen.dart';
import 'survey_screen.dart';

class PollDetailsScreen extends StatefulWidget {
  final Poll poll;

  const PollDetailsScreen({super.key, required this.poll});

  @override
  State<PollDetailsScreen> createState() => _PollDetailsScreenState();
}

class _PollDetailsScreenState extends State<PollDetailsScreen> {
  String? _selectedOptionId;

  bool get _isClosed {
    final raw = widget.poll.endAt;
    if (raw == null || raw.isEmpty) return false;
    final parsed = DateTime.tryParse(raw);
    if (parsed == null) return false;
    return !parsed.isAfter(DateTime.now().toUtc());
  }

  bool get _isReadOnly => widget.poll.hasVoted || _isClosed;

  @override
  void initState() {
    super.initState();
    if (widget.poll.isSurvey) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        Navigator.of(context).pushReplacement(
          MaterialPageRoute<void>(
            builder: (_) => SurveyScreen(poll: widget.poll),
          ),
        );
      });
    } else if (widget.poll.type == 'referendum') {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        Navigator.of(context).pushReplacement(
          MaterialPageRoute<void>(
            builder: (_) => ReferendumScreen(poll: widget.poll),
          ),
        );
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final loc = Provider.of<LocalizationService>(context);
    final isClosed = _isClosed;
    final isReadOnly = _isReadOnly;

    return ErtadSubpageScaffold(
      title: loc.translate('poll_details'),
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
          crossAxisAlignment: CrossAxisAlignment.start,
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
              ],
            ),
            if (isReadOnly) ...[
              const SizedBox(height: 16),
              Expanded(
                child: SingleChildScrollView(
                  child: DecisionResultsCard(
                    poll: widget.poll,
                    isClosed: isClosed,
                  ),
                ),
              ),
            ] else ...[
              const SizedBox(height: 14),
              ErtadSurfaceCard(
                backgroundColor: p.primarySoft,
                borderColor: p.primary.withValues(alpha: 0.35),
                padding: const EdgeInsets.all(20),
                child: Column(
                  children: [
                    const ErtadIconCircle(
                      icon: Icons.how_to_vote_rounded,
                      tone: ErtadTone.primary,
                      size: 48,
                      iconSize: 25,
                      radius: 15,
                    ),
                    const SizedBox(height: 12),
                    Text(
                      widget.poll.title,
                      style: Theme.of(context).textTheme.headlineSmall
                          ?.copyWith(color: p.text),
                      textAlign: TextAlign.center,
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 18),
              Expanded(
                child: widget.poll.options.isEmpty
                    ? Center(
                        child: ErtadEmptyState(
                          icon: Icons.how_to_vote_outlined,
                          tone: ErtadTone.primary,
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

                          return Padding(
                            padding: const EdgeInsets.only(bottom: 10),
                            child: ErtadSurfaceCard(
                              onTap: () => setState(
                                () => _selectedOptionId = option.id,
                              ),
                              backgroundColor: isSelected
                                  ? p.primarySoft
                                  : p.surface,
                              borderColor: isSelected ? p.primary : p.hairline,
                              padding: const EdgeInsets.all(16),
                              child: Row(
                                children: [
                                  Icon(
                                    isSelected
                                        ? Icons.radio_button_checked_rounded
                                        : Icons.radio_button_off_rounded,
                                    color: isSelected ? p.primary : p.muted,
                                    size: 24,
                                  ),
                                  const SizedBox(width: 14),
                                  Expanded(
                                    child: Text(
                                      option.text,
                                      style: Theme.of(context)
                                          .textTheme
                                          .titleMedium
                                          ?.copyWith(
                                            color: isSelected
                                                ? p.primary
                                                : p.text,
                                          ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          );
                        },
                      ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
