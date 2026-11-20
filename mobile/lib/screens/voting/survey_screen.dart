import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart'
    show ProviderContainer, ProviderScope;
import 'package:provider/provider.dart';
import '../../core/feedback/ertad_feedback.dart';
import '../../core/shell/shell_l10n.dart';
import '../../core/state/shell_providers.dart';
import '../../core/widgets/ertad_ui.dart';
import '../../models/poll.dart';
import '../../widgets/decision_unavailable_notice.dart';
import '../../services/localization_service.dart';
import 'decision_results_card.dart';

class SurveyScreen extends StatefulWidget {
  final Poll poll;

  const SurveyScreen({super.key, required this.poll});

  @override
  State<SurveyScreen> createState() => _SurveyScreenState();
}

class _SurveyScreenState extends State<SurveyScreen> {
  int _currentQuestionIndex = 0;
  bool _submitting = false;

  // Stores responses per question
  final Map<String, QuestionResponseData> _responses = {};

  ProviderContainer? _maybeContainer(BuildContext context) {
    try {
      return ProviderScope.containerOf(context, listen: false);
    } catch (_) {
      return null;
    }
  }

  bool _isQuestionVisible(SurveyQuestion q) {
    final cond = q.config['visibleIf'];
    if (cond is! Map) return true;
    final targetId = cond['questionId']?.toString();
    final equals = cond['equals']?.toString();
    if (targetId == null || equals == null) return true;
    final r = _responses[targetId];
    if (r == null) return false;
    if (r.selectedOptionIds != null) {
      return r.selectedOptionIds!.contains(equals);
    }
    if (r.rankedOptionIds != null) {
      return r.rankedOptionIds!.contains(equals);
    }
    if (r.selectedOptionId != null) {
      return r.selectedOptionId == equals;
    }
    if (r.ratingValue != null) {
      return r.ratingValue.toString() == equals;
    }
    return (r.textResponse ?? '').trim() == equals;
  }

  Map<String, dynamic> _encodeSurveyAnswers() {
    final out = <String, dynamic>{};
    for (final q in _questions) {
      if (!_isQuestionVisible(q)) continue;
      final r = _responses[q.id];
      if (r == null) continue;
      switch (q.questionType) {
        case 'single_choice':
          final idx = int.tryParse(r.selectedOptionId ?? '');
          if (idx != null) out[q.id] = idx;
        case 'multiple_choice':
          final ids = (r.selectedOptionIds ?? const [])
              .map(int.tryParse)
              .whereType<int>()
              .toList();
          if (ids.isNotEmpty) out[q.id] = ids;
        case 'ranked_choice':
          final ids = (r.rankedOptionIds ?? const [])
              .map(int.tryParse)
              .whereType<int>()
              .toList();
          if (ids.isNotEmpty) out[q.id] = ids;
        case 'rating_scale':
          if (r.ratingValue != null) out[q.id] = r.ratingValue;
        case 'text':
          final txt = (r.textResponse ?? '').trim();
          if (txt.isNotEmpty) out[q.id] = txt;
      }
    }
    return out;
  }

  Future<void> _submitLiveSurvey(ProviderContainer container) async {
    if (_submitting) return;
    final session = container.read(shellSessionProvider);
    final api = container.read(mobileApiClientProvider);
    if (!session.isLiveConnected || session.activeOrgId.startsWith('org-')) {
      return;
    }
    setState(() => _submitting = true);
    try {
      String? usedKey;
      final res = await runWithStepUpConfirmation(
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
          fallback: 'Confirm your session to submit this survey?',
        ),
        confirmLabel: shellTr(
          context,
          'stepup_confirm',
          fallback: 'Confirm',
        ),
        run: (key) {
          usedKey = key;
          return api.voteDecision(
            organizationId: session.activeOrgId,
            decisionId: widget.poll.id,
            answers: _encodeSurveyAnswers(),
            idempotencyKey: key,
          );
        },
      );
      final receiptCode = await VoteReceiptStore.saveReceipt(
        decisionId: widget.poll.id,
        response: res,
        idempotencyKey: usedKey,
      );
      if (!mounted) return;
      container.read(shellSessionProvider.notifier).refreshWorkspace();
      final nav = Navigator.of(context, rootNavigator: true);
      nav.pop();
      if (nav.context.mounted) {
        await showVoteReceiptModal(
          nav.context,
          pollTitle: widget.poll.title,
          receiptCode: receiptCode,
        );
      }
    } on ErtadCancelledException {
      if (!mounted) return;
      setState(() => _submitting = false);
    } catch (err) {
      if (!mounted) return;
      setState(() => _submitting = false);
      container.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  List<SurveyQuestion> get _questions => widget.poll.questions ?? [];
  SurveyQuestion get _currentQuestion => _questions[_currentQuestionIndex];
  double get _progress =>
      _questions.isEmpty ? 0 : (_currentQuestionIndex + 1) / _questions.length;
  int? _nextVisibleIndexAfter(int index) {
    for (int i = index + 1; i < _questions.length; i++) {
      if (_isQuestionVisible(_questions[i])) return i;
    }
    return null;
  }

  int? _prevVisibleIndexBefore(int index) {
    for (int i = index - 1; i >= 0; i--) {
      if (_isQuestionVisible(_questions[i])) return i;
    }
    return null;
  }

  bool get _isLastQuestion =>
      _nextVisibleIndexAfter(_currentQuestionIndex) == null;

  bool get _currentQuestionAnswered {
    final response = _responses[_currentQuestion.id];
    if (response == null) return false;

    switch (_currentQuestion.questionType) {
      case 'single_choice':
        return response.selectedOptionId != null;
      case 'multiple_choice':
        return response.selectedOptionIds != null &&
            response.selectedOptionIds!.isNotEmpty;
      case 'text':
        return response.textResponse != null &&
            response.textResponse!.trim().isNotEmpty;
      case 'rating_scale':
        return response.ratingValue != null;
      case 'ranked_choice':
        return response.rankedOptionIds != null &&
            response.rankedOptionIds!.isNotEmpty;
      default:
        return false;
    }
  }

  bool get _canProceed {
    if (!_currentQuestion.required) return true;
    return _currentQuestionAnswered;
  }

  bool get _isClosed {
    final raw = widget.poll.endAt;
    if (raw == null || raw.isEmpty) return false;
    final parsed = DateTime.tryParse(raw);
    if (parsed == null) return false;
    return !parsed.isAfter(DateTime.now().toUtc());
  }

  bool get _isReadOnly => widget.poll.hasVoted || _isClosed;

  @override
  Widget build(BuildContext context) {
    final locService = Provider.of<LocalizationService>(context);
    if (_questions.isEmpty) {
      return ErtadSubpageScaffold(
        title: locService.translate('survey_title'),
        body: Center(child: Text(locService.translate('no_questions'))),
      );
    }

    if (_isReadOnly) {
      return ErtadSubpageScaffold(
        title: widget.poll.title,
        closeStyle: true,
        bottomBar: SizedBox(
          width: double.infinity,
          child: OutlinedButton.icon(
            onPressed: () => Navigator.of(context).pop(),
            icon: const Icon(Icons.check_rounded),
            label: Text(shellTr(context, 'close', fallback: 'Close')),
          ),
        ),
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Wrap(
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
                if (_isClosed)
                  ErtadStatusPill(
                    icon: Icons.lock_clock_outlined,
                    tone: ErtadTone.neutral,
                    label: shellTr(
                      context,
                      'poll_closed_label',
                      fallback: 'Closed',
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 12),
            DecisionResultsCard(poll: widget.poll, isClosed: _isClosed),
          ],
        ),
      );
    }

    return ErtadSubpageScaffold(
      title: widget.poll.title,
      closeStyle: true,
      onCloseRequested: _confirmExit,
      body: _buildQuestionView(),
    );
  }

  Widget _buildQuestionView() {
    final locService = Provider.of<LocalizationService>(context);
    final container = _maybeContainer(context);
    final session = container?.read(shellSessionProvider);
    final canVoteLive =
        container != null &&
        session != null &&
        session.isLiveConnected &&
        !session.activeOrgId.startsWith('org-');

    return Column(
      children: [
        if (!canVoteLive)
          const Padding(
            padding: EdgeInsets.all(16),
            child: DecisionUnavailableNotice(),
          ),
        // Progress bar
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 8.0),
          child: Column(
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    '${locService.translate('question_of')} ${_currentQuestionIndex + 1} ${locService.translate('of')} ${_questions.length}',
                    style: Theme.of(
                      context,
                    ).textTheme.bodySmall?.copyWith(color: Colors.grey),
                  ),
                  Text(
                    '${(_progress * 100).round()}%',
                    style: Theme.of(
                      context,
                    ).textTheme.bodySmall?.copyWith(color: Colors.grey),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              ClipRRect(
                borderRadius: BorderRadius.circular(4),
                child: LinearProgressIndicator(
                  value: _progress,
                  minHeight: 6,
                  backgroundColor: Colors.grey.shade800,
                ),
              ),
            ],
          ),
        ),

        // Question content
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(16.0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Question type badge
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 4,
                  ),
                  decoration: BoxDecoration(
                    color: Theme.of(
                      context,
                    ).primaryColor.withValues(alpha: 0.2),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    _formatQuestionType(_currentQuestion.questionType),
                    style: TextStyle(
                      fontSize: 11,
                      color: Theme.of(context).primaryColor,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                if (_currentQuestion.required)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(
                      locService.translate('required'),
                      style: TextStyle(
                        fontSize: 11,
                        color: Colors.red.shade300,
                      ),
                    ),
                  ),
                const SizedBox(height: 16),

                // Question text
                Text(
                  _currentQuestion.questionText,
                  style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                    fontWeight: FontWeight.bold,
                    height: 1.3, // Better readability for wrapped questions
                  ),
                ),
                const SizedBox(height: 24),

                // Question-specific input
                _buildQuestionInput(),
              ],
            ),
          ),
        ),

        // Navigation buttons
        Padding(
          padding: const EdgeInsets.all(16.0),
          child: Row(
            children: [
              if (_prevVisibleIndexBefore(_currentQuestionIndex) != null)
                Expanded(
                  child: OutlinedButton(
                    onPressed: () {
                      final prev = _prevVisibleIndexBefore(
                        _currentQuestionIndex,
                      );
                      if (prev != null) {
                        setState(() => _currentQuestionIndex = prev);
                      }
                    },
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size(0, 52),
                    ),
                    child: Text(locService.translate('back')),
                  ),
                ),
              if (_prevVisibleIndexBefore(_currentQuestionIndex) != null)
                const SizedBox(width: 12),
              Expanded(
                flex: 2,
                child: ElevatedButton(
                  onPressed: !_canProceed || _submitting
                      ? null
                      : !_isLastQuestion
                      ? _nextQuestion
                      : canVoteLive
                      ? () => _submitLiveSurvey(container)
                      : null,
                  style: ElevatedButton.styleFrom(
                    minimumSize: const Size(0, 52),
                  ),
                  child: _submitting
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : Text(
                          _isLastQuestion
                              ? locService.translate('submit_survey')
                              : locService.translate('next'),
                        ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildQuestionInput() {
    switch (_currentQuestion.questionType) {
      case 'single_choice':
        return _buildSingleChoice();
      case 'multiple_choice':
        return _buildMultipleChoice();
      case 'text':
        return _buildTextInput();
      case 'rating_scale':
        return _buildRatingScale();
      case 'ranked_choice':
        return _buildRankedChoice();
      default:
        return Text(
          '${shellTr(context, 'survey_unknown_question_type', fallback: 'Unknown question type:')} ${_currentQuestion.questionType}',
        );
    }
  }

  // --- Single Choice (Radio) ---
  Widget _buildSingleChoice() {
    final selectedId = _responses[_currentQuestion.id]?.selectedOptionId;

    return Column(
      children: _currentQuestion.options.map((option) {
        final isSelected = selectedId == option.id;
        return Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: InkWell(
            onTap: () {
              setState(() {
                _responses[_currentQuestion.id] = QuestionResponseData(
                  questionId: _currentQuestion.id,
                  selectedOptionId: option.id,
                );
              });
            },
            borderRadius: BorderRadius.circular(16),
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 200),
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: isSelected
                    ? Theme.of(context).primaryColor.withValues(alpha: 0.1)
                    : Colors.grey.withValues(alpha: 0.05),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(
                  color: isSelected
                      ? Theme.of(context).primaryColor
                      : Colors.grey.shade300,
                  width: isSelected ? 2 : 1,
                ),
              ),
              child: Row(
                children: [
                  Icon(
                    isSelected
                        ? Icons.radio_button_checked
                        : Icons.radio_button_off,
                    color: isSelected
                        ? Theme.of(context).primaryColor
                        : Colors.grey,
                    size: 28,
                  ),
                  const SizedBox(width: 16),
                  Expanded(
                    child: Text(
                      option.optionText,
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: isSelected
                            ? FontWeight.bold
                            : FontWeight.w500,
                        height: 1.4, // Good line height for long options
                        color: isSelected
                            ? Theme.of(context).primaryColor
                            : Theme.of(context).textTheme.bodyLarge?.color,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      }).toList(),
    );
  }

  // --- Multiple Choice (Checkboxes) ---
  Widget _buildMultipleChoice() {
    final locService = Provider.of<LocalizationService>(context);
    final selectedIds =
        _responses[_currentQuestion.id]?.selectedOptionIds ?? [];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          locService.translate('select_all_apply'),
          style: Theme.of(
            context,
          ).textTheme.bodySmall?.copyWith(color: Colors.grey),
        ),
        const SizedBox(height: 8),
        ..._currentQuestion.options.map((option) {
          final isSelected = selectedIds.contains(option.id);
          return Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: InkWell(
              onTap: () {
                setState(() {
                  final newIds = List<String>.from(selectedIds);
                  if (!isSelected) {
                    newIds.add(option.id);
                  } else {
                    newIds.remove(option.id);
                  }
                  _responses[_currentQuestion.id] = QuestionResponseData(
                    questionId: _currentQuestion.id,
                    selectedOptionIds: newIds,
                  );
                });
              },
              borderRadius: BorderRadius.circular(16),
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 200),
                padding: const EdgeInsets.all(20),
                decoration: BoxDecoration(
                  color: isSelected
                      ? Theme.of(context).primaryColor.withValues(alpha: 0.1)
                      : Colors.grey.withValues(alpha: 0.05),
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(
                    color: isSelected
                        ? Theme.of(context).primaryColor
                        : Colors.grey.shade300,
                    width: isSelected ? 2 : 1,
                  ),
                ),
                child: Row(
                  children: [
                    Icon(
                      isSelected
                          ? Icons.check_box
                          : Icons.check_box_outline_blank,
                      color: isSelected
                          ? Theme.of(context).primaryColor
                          : Colors.grey,
                      size: 28,
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Text(
                        option.optionText,
                        style: TextStyle(
                          fontSize: 16,
                          fontWeight: isSelected
                              ? FontWeight.bold
                              : FontWeight.w500,
                          height: 1.4, // Good line height for long options
                          color: isSelected
                              ? Theme.of(context).primaryColor
                              : Theme.of(context).textTheme.bodyLarge?.color,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          );
        }),
      ],
    );
  }

  // --- Text Input ---
  Widget _buildTextInput() {
    final locService = Provider.of<LocalizationService>(context);
    final maxLength =
        (_currentQuestion.config['maxLength'] as num?)?.toInt() ?? 500;
    final placeholder =
        _currentQuestion.config['placeholder'] as String? ??
        locService.translate('type_your_answer');
    final currentText = _responses[_currentQuestion.id]?.textResponse ?? '';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextField(
          maxLines: 6,
          maxLength: maxLength,
          decoration: InputDecoration(
            hintText: placeholder,
            border: const OutlineInputBorder(),
            alignLabelWithHint: true,
          ),
          controller: TextEditingController.fromValue(
            TextEditingValue(
              text: currentText,
              selection: TextSelection.collapsed(offset: currentText.length),
            ),
          ),
          onChanged: (value) {
            _responses[_currentQuestion.id] = QuestionResponseData(
              questionId: _currentQuestion.id,
              textResponse: value,
            );
            // Trigger rebuild for canProceed
            setState(() {});
          },
        ),
        const SizedBox(height: 8),
        Text(
          locService.translate('response_anonymous'),
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
            color: Colors.grey,
            fontStyle: FontStyle.italic,
          ),
        ),
      ],
    );
  }

  // --- Rating Scale ---
  Widget _buildRatingScale() {
    final locService = Provider.of<LocalizationService>(context);
    final config = _currentQuestion.config;
    final min = (config['min'] as num?)?.toInt() ?? 1;
    final max = (config['max'] as num?)?.toInt() ?? 5;
    final minLabel = config['minLabel'] as String? ?? '';
    final maxLabel = config['maxLabel'] as String? ?? '';
    final currentValue = _responses[_currentQuestion.id]?.ratingValue;

    return Column(
      children: [
        // Labels
        if (minLabel.isNotEmpty || maxLabel.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  minLabel,
                  style: Theme.of(
                    context,
                  ).textTheme.bodySmall?.copyWith(color: Colors.grey),
                ),
                Text(
                  maxLabel,
                  style: Theme.of(
                    context,
                  ).textTheme.bodySmall?.copyWith(color: Colors.grey),
                ),
              ],
            ),
          ),

        // Rating buttons
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceEvenly,
          children: List.generate(max - min + 1, (index) {
            final value = min + index;
            final isSelected = currentValue == value;
            return GestureDetector(
              onTap: () {
                setState(() {
                  _responses[_currentQuestion.id] = QuestionResponseData(
                    questionId: _currentQuestion.id,
                    ratingValue: value,
                  );
                });
              },
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 200),
                width: 52,
                height: 52,
                decoration: BoxDecoration(
                  color: isSelected
                      ? Theme.of(context).primaryColor
                      : Colors.grey.shade800,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(
                    color: isSelected
                        ? Theme.of(context).primaryColor
                        : Colors.grey.shade600,
                    width: 2,
                  ),
                ),
                child: Center(
                  child: Text(
                    '$value',
                    style: TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                      color: isSelected ? Colors.white : Colors.grey.shade300,
                    ),
                  ),
                ),
              ),
            );
          }),
        ),

        if (currentValue != null)
          Padding(
            padding: const EdgeInsets.only(top: 16),
            child: Text(
              '${locService.translate('you_selected')} $currentValue',
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: Theme.of(context).primaryColor,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
      ],
    );
  }

  // --- Ranked Choice (drag to reorder) ---
  Widget _buildRankedChoice() {
    final locService = Provider.of<LocalizationService>(context);
    final rankedIds = _responses[_currentQuestion.id]?.rankedOptionIds ?? [];
    final maxRanks =
        (_currentQuestion.config['maxRanks'] as num?)?.toInt() ??
        _currentQuestion.options.length;

    // Options not yet ranked
    final unrankedOptions = _currentQuestion.options
        .where((opt) => !rankedIds.contains(opt.id))
        .toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '${locService.translate('tap_to_rank')} (up to $maxRanks)',
          style: Theme.of(
            context,
          ).textTheme.bodySmall?.copyWith(color: Colors.grey),
        ),
        const SizedBox(height: 12),

        // Ranked items
        if (rankedIds.isNotEmpty) ...[
          Text(
            locService.translate('your_ranking'),
            style: Theme.of(
              context,
            ).textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 8),
          ...rankedIds.asMap().entries.map((entry) {
            final rank = entry.key + 1;
            final optionId = entry.value;
            final option = _currentQuestion.options.firstWhere(
              (o) => o.id == optionId,
            );
            return Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 200),
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: Theme.of(context).primaryColor.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(
                    color: Theme.of(
                      context,
                    ).primaryColor.withValues(alpha: 0.3),
                  ),
                ),
                child: Row(
                  children: [
                    CircleAvatar(
                      radius: 14,
                      backgroundColor: Theme.of(context).primaryColor,
                      child: Text(
                        '$rank',
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 12,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        option.optionText,
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                    ),
                    IconButton(
                      icon: const Icon(Icons.close, size: 20),
                      padding: EdgeInsets.zero,
                      constraints: const BoxConstraints(),
                      onPressed: () {
                        setState(() {
                          final newIds = List<String>.from(rankedIds);
                          newIds.remove(optionId);
                          _responses[_currentQuestion.id] =
                              QuestionResponseData(
                                questionId: _currentQuestion.id,
                                rankedOptionIds: newIds,
                              );
                        });
                      },
                    ),
                  ],
                ),
              ),
            );
          }),
          const SizedBox(height: 16),
        ],

        // Unranked items
        if (unrankedOptions.isNotEmpty && rankedIds.length < maxRanks) ...[
          Text(
            rankedIds.isEmpty
                ? locService.translate('available_options')
                : locService.translate('tap_to_add'),
            style: Theme.of(
              context,
            ).textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 8),
          ...unrankedOptions.map((option) {
            return Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: InkWell(
                onTap: () {
                  setState(() {
                    final newIds = List<String>.from(rankedIds);
                    newIds.add(option.id);
                    _responses[_currentQuestion.id] = QuestionResponseData(
                      questionId: _currentQuestion.id,
                      rankedOptionIds: newIds,
                    );
                  });
                },
                borderRadius: BorderRadius.circular(16),
                child: Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: Colors.grey.withValues(alpha: 0.05),
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: Colors.grey.shade300),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          option.optionText,
                          style: const TextStyle(fontWeight: FontWeight.w500),
                        ),
                      ),
                      const Icon(
                        Icons.add_circle_outline,
                        size: 20,
                        color: Colors.grey,
                      ),
                    ],
                  ),
                ),
              ),
            );
          }),
        ],
      ],
    );
  }

  // --- Navigation ---

  void _nextQuestion() {
    final next = _nextVisibleIndexAfter(_currentQuestionIndex);
    if (next != null) {
      setState(() => _currentQuestionIndex = next);
    }
  }

  Future<bool> _confirmExit() {
    final locService = Provider.of<LocalizationService>(context, listen: false);
    return showErtadConfirmDialog(
      context,
      icon: Icons.exit_to_app_rounded,
      title: locService.translate('leave_survey'),
      message: locService.translate('progress_lost'),
      cancelLabel: locService.translate('stay'),
      confirmLabel: locService.translate('leave'),
      destructive: true,
    );
  }

  String _formatQuestionType(String type) {
    final locService = Provider.of<LocalizationService>(context, listen: false);
    switch (type) {
      case 'single_choice':
        return locService.translate('single_choice');
      case 'multiple_choice':
        return locService.translate('multiple_choice');
      case 'text':
        return locService.translate('text_response');
      case 'rating_scale':
        return locService.translate('rating_scale');
      case 'ranked_choice':
        return locService.translate('ranked_choice');
      default:
        return type;
    }
  }
}
