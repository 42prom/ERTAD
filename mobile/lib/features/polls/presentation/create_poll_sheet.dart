import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/feedback/ertad_feedback.dart';
import '../../../core/shell/shell_l10n.dart';
import '../../../core/state/shell_providers.dart';
import '../../../core/theme/ertad_theme.dart';
import '../../../core/widgets/ertad_ui.dart';

/// Opens a hierarchy-scoped modal sheet allowing a Group Manager to create and
/// immediately publish a poll or referendum.
Future<Map<String, dynamic>?> showCreatePollSheet(
  BuildContext context, {
  required String organizationId,
}) {
  return showModalBottomSheet<Map<String, dynamic>>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => _CreatePollSheet(organizationId: organizationId),
  );
}

class _CreatePollSheet extends ConsumerStatefulWidget {
  final String organizationId;

  const _CreatePollSheet({required this.organizationId});

  @override
  ConsumerState<_CreatePollSheet> createState() => _CreatePollSheetState();
}

class _CreatePollSheetState extends ConsumerState<_CreatePollSheet> {
  final _formKey = GlobalKey<FormState>();
  final _titleCtrl = TextEditingController();
  final _descCtrl = TextEditingController();
  final List<TextEditingController> _optionCtrls = [
    TextEditingController(),
    TextEditingController(),
  ];

  List<Map<String, dynamic>> _audiences = const [];
  String? _selectedUnitId;
  String _kind = 'poll';
  String _privacy = 'named';
  int _quorum = 20;
  int _threshold = 50;
  int _durationDays = 7;
  bool _loadingAudiences = true;
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    _loadAudiences();
  }

  @override
  void dispose() {
    _titleCtrl.dispose();
    _descCtrl.dispose();
    for (final c in _optionCtrls) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _loadAudiences() async {
    try {
      final api = ref.read(mobileApiClientProvider);
      final list = await api.fetchDecisionAudiences(
        organizationId: widget.organizationId,
      );
      if (!mounted) return;
      setState(() {
        _audiences = list;
        _selectedUnitId = list.isNotEmpty ? list.first['id']?.toString() : null;
        _loadingAudiences = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() => _loadingAudiences = false);
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  void _addOption() {
    if (_optionCtrls.length >= 8) return;
    setState(() => _optionCtrls.add(TextEditingController()));
  }

  void _removeOption(int index) {
    if (_optionCtrls.length <= 2) return;
    setState(() {
      final removed = _optionCtrls.removeAt(index);
      removed.dispose();
    });
  }

  Future<void> _submit() async {
    if (_submitting || _selectedUnitId == null) return;
    if (!(_formKey.currentState?.validate() ?? false)) return;

    final options = _kind == 'referendum'
        ? const ['Yes', 'No', 'Abstain']
        : _optionCtrls
              .map((c) => c.text.trim())
              .where((t) => t.isNotEmpty)
              .toList(growable: false);

    if (_kind == 'poll' && options.toSet().length < 2) {
      ref.read(ertadFeedbackProvider.notifier).showWarning(
        shellTr(context, 'mgr_options_label', fallback: 'Options'),
      );
      return;
    }

    setState(() => _submitting = true);
    try {
      final api = ref.read(mobileApiClientProvider);
      final closesAtIso = DateTime.now()
          .toUtc()
          .add(Duration(days: _durationDays))
          .toIso8601String();
      final created = await api.createAndPublishDecision(
        organizationId: widget.organizationId,
        unitId: _selectedUnitId!,
        kind: _kind,
        privacy: _privacy,
        title: _titleCtrl.text.trim(),
        description: _descCtrl.text.trim(),
        options: options,
        quorum: _quorum,
        closesAtIso: closesAtIso,
        threshold: _kind == 'referendum' ? _threshold : null,
        referendumLabels: _kind == 'referendum'
            ? const {'yes': 'Yes', 'no': 'No', 'abstain': 'Abstain'}
            : null,
      );
      if (!mounted) return;
      Navigator.of(context).pop(created);
    } catch (err) {
      if (!mounted) return;
      setState(() => _submitting = false);
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(
          16,
          12,
          16,
          16 + MediaQuery.viewInsetsOf(context).bottom,
        ),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 640),
            child: Form(
              key: _formKey,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  ErtadModalSheetHeader(
                    icon: Icons.how_to_vote_rounded,
                    title: shellTr(
                      context,
                      'mgr_create_poll_title',
                      fallback: 'Create poll / referendum',
                    ),
                    closeTooltip: shellTr(context, 'close', fallback: 'Close'),
                  ),
                  const SizedBox(height: 12),
                  if (_loadingAudiences)
                    const ErtadSkeletonList(count: 2)
                  else if (_audiences.isEmpty)
                    ErtadEmptyState(
                      icon: Icons.lock_outline_rounded,
                      title: shellTr(context, 'error', fallback: 'Error'),
                      body: shellTr(
                        context,
                        'no_polls_available',
                        fallback: 'No authorized units available.',
                      ),
                    )
                  else ...[
                    DropdownButtonFormField<String>(
                      initialValue: _selectedUnitId,
                      decoration: InputDecoration(
                        labelText: shellTr(
                          context,
                          'mgr_unit_label',
                          fallback: 'Target unit',
                        ),
                      ),
                      items: _audiences
                          .map(
                            (u) => DropdownMenuItem<String>(
                              value: u['id']?.toString(),
                              child: Text(u['name']?.toString() ?? ''),
                            ),
                          )
                          .toList(growable: false),
                      onChanged: (v) => setState(() => _selectedUnitId = v),
                    ),
                    const SizedBox(height: 12),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        ChoiceChip(
                          label: Text(
                            shellTr(
                              context,
                              'mgr_kind_poll',
                              fallback: 'Poll',
                            ),
                          ),
                          selected: _kind == 'poll',
                          onSelected: (_) => setState(() => _kind = 'poll'),
                        ),
                        ChoiceChip(
                          label: Text(
                            shellTr(
                              context,
                              'mgr_kind_referendum',
                              fallback: 'Referendum',
                            ),
                          ),
                          selected: _kind == 'referendum',
                          onSelected: (_) =>
                              setState(() => _kind = 'referendum'),
                        ),
                        const SizedBox(width: 8),
                        ChoiceChip(
                          label: Text(
                            shellTr(
                              context,
                              'mgr_privacy_named',
                              fallback: 'Named',
                            ),
                          ),
                          selected: _privacy == 'named',
                          onSelected: (_) => setState(() => _privacy = 'named'),
                        ),
                        ChoiceChip(
                          label: Text(
                            shellTr(
                              context,
                              'mgr_privacy_anonymous',
                              fallback: 'Anonymous',
                            ),
                          ),
                          selected: _privacy == 'anonymous',
                          onSelected: (_) =>
                              setState(() => _privacy = 'anonymous'),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: _titleCtrl,
                      maxLength: 160,
                      decoration: InputDecoration(
                        labelText: shellTr(
                          context,
                          'mgr_title_label',
                          fallback: 'Title',
                        ),
                      ),
                      validator: (v) {
                        final t = (v ?? '').trim();
                        if (t.length < 3) return '>= 3';
                        return null;
                      },
                    ),
                    const SizedBox(height: 10),
                    TextFormField(
                      controller: _descCtrl,
                      minLines: 2,
                      maxLines: 4,
                      decoration: InputDecoration(
                        labelText: shellTr(
                          context,
                          'mgr_desc_label',
                          fallback: 'Description',
                        ),
                      ),
                      validator: (v) {
                        final t = (v ?? '').trim();
                        if (t.length < 3) return '>= 3';
                        return null;
                      },
                    ),
                    const SizedBox(height: 12),
                    if (_kind == 'poll') ...[
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text(
                            shellTr(
                              context,
                              'mgr_options_label',
                              fallback: 'Options',
                            ),
                            style: Theme.of(context).textTheme.labelMedium
                                ?.copyWith(
                                  color: p.muted,
                                  fontWeight: FontWeight.w600,
                                ),
                          ),
                          if (_optionCtrls.length < 8)
                            TextButton.icon(
                              onPressed: _addOption,
                              icon: const Icon(Icons.add_rounded, size: 18),
                              label: Text(
                                shellTr(
                                  context,
                                  'mgr_add_option',
                                  fallback: 'Add option',
                                ),
                              ),
                            ),
                        ],
                      ),
                      ...List.generate(_optionCtrls.length, (i) {
                        return Padding(
                          padding: const EdgeInsets.only(bottom: 8),
                          child: Row(
                            children: [
                              Expanded(
                                child: TextFormField(
                                  controller: _optionCtrls[i],
                                  decoration: InputDecoration(
                                    labelText: '${i + 1}',
                                  ),
                                  validator: (v) {
                                    if (_kind != 'poll') return null;
                                    if ((v ?? '').trim().isEmpty) {
                                      return 'Required';
                                    }
                                    return null;
                                  },
                                ),
                              ),
                              if (_optionCtrls.length > 2)
                                IconButton(
                                  onPressed: () => _removeOption(i),
                                  icon: const Icon(
                                    Icons.remove_circle_outline_rounded,
                                  ),
                                ),
                            ],
                          ),
                        );
                      }),
                    ] else ...[
                      Text(
                        '${shellTr(context, 'mgr_options_label', fallback: 'Options')}: Yes / No / Abstain',
                        style: Theme.of(
                          context,
                        ).textTheme.bodySmall?.copyWith(color: p.muted),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        '${shellTr(context, 'mgr_threshold_label', fallback: 'Threshold (%)')}: $_threshold%',
                        style: Theme.of(context).textTheme.labelMedium,
                      ),
                      Slider(
                        value: _threshold.toDouble(),
                        min: 50,
                        max: 100,
                        divisions: 10,
                        label: '$_threshold%',
                        onChanged: (v) =>
                            setState(() => _threshold = v.round()),
                      ),
                    ],
                    const SizedBox(height: 8),
                    Text(
                      '${shellTr(context, 'mgr_quorum_label', fallback: 'Quorum (%)')}: $_quorum%',
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                    Slider(
                      value: _quorum.toDouble(),
                      min: 5,
                      max: 100,
                      divisions: 19,
                      label: '$_quorum%',
                      onChanged: (v) => setState(() => _quorum = v.round()),
                    ),
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 8,
                      children: [1, 3, 7, 14]
                          .map(
                            (d) => ChoiceChip(
                              label: Text('${d}d'),
                              selected: _durationDays == d,
                              onSelected: (_) =>
                                  setState(() => _durationDays = d),
                            ),
                          )
                          .toList(growable: false),
                    ),
                    const SizedBox(height: 16),
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton.icon(
                        onPressed: _submitting ? null : _submit,
                        icon: _submitting
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Icon(Icons.publish_rounded, size: 18),
                        label: Text(
                          shellTr(
                            context,
                            'mgr_publish_action',
                            fallback: 'Create & publish',
                          ),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
