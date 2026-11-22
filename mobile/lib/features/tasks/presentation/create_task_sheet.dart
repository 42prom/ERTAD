import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/feedback/ertad_feedback.dart';
import '../../../core/shell/shell_l10n.dart';
import '../../../core/state/shell_providers.dart';
import '../../../core/theme/ertad_theme.dart';
import '../../../core/widgets/ertad_ui.dart';

/// Opens a hierarchy-scoped modal sheet allowing a Group Manager to create a task.
Future<Map<String, dynamic>?> showCreateTaskSheet(
  BuildContext context, {
  required String organizationId,
}) {
  return showModalBottomSheet<Map<String, dynamic>>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => _CreateTaskSheet(organizationId: organizationId),
  );
}

class _CreateTaskSheet extends ConsumerStatefulWidget {
  final String organizationId;

  const _CreateTaskSheet({required this.organizationId});

  @override
  ConsumerState<_CreateTaskSheet> createState() => _CreateTaskSheetState();
}

class _CreateTaskSheetState extends ConsumerState<_CreateTaskSheet> {
  final _formKey = GlobalKey<FormState>();
  final _titleCtrl = TextEditingController();
  final _descCtrl = TextEditingController();
  final _roleCtrl = TextEditingController(text: 'Member');

  List<Map<String, dynamic>> _units = const [];
  String? _selectedUnitId;
  String _priority = 'normal';
  int _capacity = 5;
  int _deadlineDays = 7;
  bool _loadingUnits = true;
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    _loadUnits();
  }

  @override
  void dispose() {
    _titleCtrl.dispose();
    _descCtrl.dispose();
    _roleCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadUnits() async {
    try {
      final api = ref.read(mobileApiClientProvider);
      final list = await api.fetchWorkUnits(
        organizationId: widget.organizationId,
      );
      if (!mounted) return;
      setState(() {
        _units = list;
        _selectedUnitId = list.isNotEmpty ? list.first['id']?.toString() : null;
        _loadingUnits = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() => _loadingUnits = false);
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  Future<void> _submit() async {
    if (_submitting || _selectedUnitId == null) return;
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() => _submitting = true);
    try {
      final api = ref.read(mobileApiClientProvider);
      final deadlineIso = DateTime.now()
          .toUtc()
          .add(Duration(days: _deadlineDays))
          .toIso8601String();
      final created = await api.createWorkItem(
        organizationId: widget.organizationId,
        unitId: _selectedUnitId!,
        title: _titleCtrl.text.trim(),
        description: _descCtrl.text.trim(),
        roleLabel: _roleCtrl.text.trim().isEmpty
            ? 'Member'
            : _roleCtrl.text.trim(),
        priority: _priority,
        capacity: _capacity,
        deadlineIso: deadlineIso,
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
                    icon: Icons.add_task_rounded,
                    title: shellTr(
                      context,
                      'mgr_create_task_title',
                      fallback: 'Create task in unit',
                    ),
                    closeTooltip: shellTr(context, 'close', fallback: 'Close'),
                  ),
                  const SizedBox(height: 12),
                  if (_loadingUnits)
                    const ErtadSkeletonList(count: 2)
                  else if (_units.isEmpty)
                    ErtadEmptyState(
                      icon: Icons.lock_outline_rounded,
                      title: shellTr(context, 'error', fallback: 'Error'),
                      body: shellTr(
                        context,
                        'tasks_empty',
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
                      items: _units
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
                        if (t.length < 5) return '>= 5';
                        return null;
                      },
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: _roleCtrl,
                      decoration: InputDecoration(
                        labelText: shellTr(
                          context,
                          'mgr_role_label',
                          fallback: 'Role / position',
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      shellTr(
                        context,
                        'mgr_priority_label',
                        fallback: 'Priority',
                      ),
                      style: Theme.of(context).textTheme.labelMedium?.copyWith(
                        color: p.muted,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 8,
                      children: ['low', 'normal', 'high', 'urgent']
                          .map(
                            (lvl) => ChoiceChip(
                              label: Text(lvl.toUpperCase()),
                              selected: _priority == lvl,
                              onSelected: (_) =>
                                  setState(() => _priority = lvl),
                            ),
                          )
                          .toList(growable: false),
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: _StepperBox(
                            label: shellTr(
                              context,
                              'mgr_capacity_label',
                              fallback: 'Capacity',
                            ),
                            value: _capacity,
                            min: 1,
                            max: 100,
                            onChanged: (v) => setState(() => _capacity = v),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: _StepperBox(
                            label: shellTr(
                              context,
                              'mgr_deadline_days_label',
                              fallback: 'Deadline (days)',
                            ),
                            value: _deadlineDays,
                            min: 1,
                            max: 60,
                            onChanged: (v) =>
                                setState(() => _deadlineDays = v),
                          ),
                        ),
                      ],
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
                            : const Icon(Icons.check_rounded, size: 18),
                        label: Text(
                          shellTr(
                            context,
                            'mgr_create_action',
                            fallback: 'Create',
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

class _StepperBox extends StatelessWidget {
  final String label;
  final int value;
  final int min;
  final int max;
  final ValueChanged<int> onChanged;

  const _StepperBox({
    required this.label,
    required this.value,
    required this.min,
    required this.max,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: p.elevated,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: p.hairline),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(
              context,
            ).textTheme.labelSmall?.copyWith(color: p.muted),
          ),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              IconButton(
                onPressed: value > min ? () => onChanged(value - 1) : null,
                icon: const Icon(Icons.remove_rounded, size: 18),
                visualDensity: VisualDensity.compact,
              ),
              Text(
                '$value',
                style: Theme.of(
                  context,
                ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700),
              ),
              IconButton(
                onPressed: value < max ? () => onChanged(value + 1) : null,
                icon: const Icon(Icons.add_rounded, size: 18),
                visualDensity: VisualDensity.compact,
              ),
            ],
          ),
        ],
      ),
    );
  }
}
