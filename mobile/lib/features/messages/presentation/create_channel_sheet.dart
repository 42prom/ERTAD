import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/feedback/ertad_feedback.dart';
import '../../../core/shell/shell_l10n.dart';
import '../../../core/state/shell_providers.dart';
import '../../../core/theme/ertad_theme.dart';
import '../../../core/widgets/ertad_ui.dart';

/// Opens a hierarchy-scoped modal sheet allowing a Group Manager to create a
/// group or global channel that immediately appears under Channels.
Future<Map<String, dynamic>?> showCreateChannelSheet(
  BuildContext context, {
  required String organizationId,
}) {
  return showModalBottomSheet<Map<String, dynamic>>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => _CreateChannelSheet(organizationId: organizationId),
  );
}

class _CreateChannelSheet extends ConsumerStatefulWidget {
  final String organizationId;

  const _CreateChannelSheet({required this.organizationId});

  @override
  ConsumerState<_CreateChannelSheet> createState() =>
      _CreateChannelSheetState();
}

class _CreateChannelSheetState extends ConsumerState<_CreateChannelSheet> {
  final _formKey = GlobalKey<FormState>();
  final _titleCtrl = TextEditingController();

  List<Map<String, dynamic>> _units = const [];
  String? _selectedUnitId;
  String _kind = 'group';
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
    super.dispose();
  }

  Future<void> _loadUnits() async {
    try {
      final api = ref.read(mobileApiClientProvider);
      final list = await api.fetchChannelUnits(
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
      final title = _titleCtrl.text.trim();
      final created = await api.createChannel(
        organizationId: widget.organizationId,
        unitId: _selectedUnitId!,
        title: title,
        kind: _kind,
      );
      if (!mounted) return;
      Navigator.of(context).pop(<String, dynamic>{
        ...created,
        if (created['title'] == null) 'title': title,
        if (created['kind'] == null) 'kind': _kind,
      });
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
                    icon: Icons.groups_rounded,
                    title: shellTr(
                      context,
                      'mgr_create_channel_title',
                      fallback: 'Create channel in unit',
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
                        'msg_empty_groups',
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
                      maxLength: 120,
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
                    Text(
                      shellTr(
                        context,
                        'mgr_channel_kind_label',
                        fallback: 'Channel type',
                      ),
                      style: Theme.of(context).textTheme.labelMedium?.copyWith(
                        color: p.muted,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 8,
                      children: [
                        ChoiceChip(
                          label: const Text('Group'),
                          selected: _kind == 'group',
                          onSelected: (_) => setState(() => _kind = 'group'),
                        ),
                        ChoiceChip(
                          label: const Text('Global'),
                          selected: _kind == 'global',
                          onSelected: (_) => setState(() => _kind = 'global'),
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
