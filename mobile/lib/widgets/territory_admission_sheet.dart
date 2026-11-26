import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/feedback/ertad_feedback.dart';
import '../core/network/mobile_api_client.dart';
import '../core/shell/shell_l10n.dart';
import '../core/state/shell_providers.dart';
import '../core/theme/ertad_theme.dart';
import '../core/widgets/ertad_ui.dart';
import '../services/localization_service.dart';

Future<void> showTerritoryAdmissionSheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => const TerritoryAdmissionSheet(),
  );
}

class TerritoryAdmissionSheet extends ConsumerStatefulWidget {
  const TerritoryAdmissionSheet({super.key});

  @override
  ConsumerState<TerritoryAdmissionSheet> createState() =>
      _TerritoryAdmissionSheetState();
}

class _TerritoryAdmissionSheetState
    extends ConsumerState<TerritoryAdmissionSheet> {
  final TextEditingController _reasonController = TextEditingController();
  List<Map<String, dynamic>> _areas = const [];
  List<Map<String, dynamic>> _groups = const [];
  String? _selectedRegionId;
  String? _selectedLocalityId;
  String? _requestingUnitId;
  String? _requestKey;
  bool _loadingCatalogue = true;
  bool _loadingGroups = false;
  bool _submitting = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadCatalogue();
  }

  @override
  void dispose() {
    _reasonController.dispose();
    super.dispose();
  }

  bool get _isKa {
    final lang = maybeLocalizationOf(context, listen: false)?.currentLanguage;
    if (lang != null) return lang == AppLanguage.georgian;
    return Localizations.maybeLocaleOf(context)?.languageCode != 'en';
  }

  String _areaLabel(Map<String, dynamic> area) {
    final ka = area['nameKa']?.toString() ?? '';
    final en = area['nameEn']?.toString() ?? '';
    return _isKa ? (ka.isNotEmpty ? ka : en) : (en.isNotEmpty ? en : ka);
  }

  Future<void> _loadCatalogue() async {
    setState(() {
      _loadingCatalogue = true;
      _error = null;
    });
    try {
      final res = await ref
          .read(mobileApiClientProvider)
          .fetchTerritoryCatalogue();
      if (!mounted) return;
      final items = (res['items'] as List? ?? const [])
          .whereType<Map>()
          .map(Map<String, dynamic>.from)
          .toList(growable: false);
      setState(() {
        _areas = items;
        _loadingCatalogue = false;
      });
    } on MobileApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loadingCatalogue = false;
        _error = e.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loadingCatalogue = false;
        _error = shellTr(
          context,
          'failed_load_regions',
          fallback: 'Failed to load regions',
        );
      });
    }
  }

  Future<void> _loadGroups() async {
    final areaId = _selectedLocalityId ?? _selectedRegionId;
    if (areaId == null || areaId.isEmpty) {
      setState(() => _groups = const []);
      return;
    }
    final orgId = ref.read(shellSessionProvider).activeOrgId;
    if (orgId.isEmpty || orgId.startsWith('org-')) return;
    setState(() {
      _loadingGroups = true;
      _error = null;
    });
    try {
      final rows = await ref
          .read(mobileApiClientProvider)
          .fetchPublishedTerritoryGroups(
            organizationId: orgId,
            areaId: areaId,
          );
      if (!mounted) return;
      setState(() {
        _groups = rows;
        _loadingGroups = false;
      });
    } on MobileApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loadingGroups = false;
        _error = e.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loadingGroups = false;
        _error = shellTr(
          context,
          'error_retry',
          fallback: 'Could not load groups',
        );
      });
    }
  }

  Future<void> _submitAdmission(String unitId) async {
    final reason = _reasonController.text.trim();
    if (reason.length < 10 || _submitting) return;
    final api = ref.read(mobileApiClientProvider);
    _requestKey ??= api.newIdempotencyKey();
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await ref
          .read(shellSessionProvider.notifier)
          .requestGroupAdmission(
            unitId: unitId,
            reason: reason,
            idempotencyKey: _requestKey,
          );
      if (!mounted) return;
      HapticFeedback.mediumImpact();
      setState(() {
        _submitting = false;
        _requestingUnitId = null;
        _requestKey = null;
        _reasonController.clear();
      });
      ref
          .read(ertadFeedbackProvider.notifier)
          .showSuccess(
            shellTr(
              context,
              'territory_admission_sent',
              fallback: 'Admission request submitted for review',
            ),
          );
      await _loadGroups();
    } on MobileApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = e.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = shellTr(
          context,
          'error_retry',
          fallback: 'Could not submit request. Please try again.',
        );
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final maxH = MediaQuery.sizeOf(context).height * 0.88;
    final regions = _areas
        .where((a) => a['kind'] == 'region')
        .toList(growable: false);
    final localities = _selectedRegionId == null
        ? const <Map<String, dynamic>>[]
        : _areas
              .where((a) => a['parentId'] == _selectedRegionId)
              .toList(growable: false);

    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: maxH),
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          16,
          12,
          16,
          MediaQuery.viewInsetsOf(context).bottom + 16,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ErtadModalSheetHeader(
              icon: Icons.location_city_rounded,
              title: shellTr(
                context,
                'territory_browse_title',
                fallback: 'Find local group',
              ),
              closeTooltip: shellTr(context, 'close', fallback: 'Close'),
            ),
            const SizedBox(height: 12),
            if (_loadingCatalogue)
              const Padding(
                padding: EdgeInsets.all(24),
                child: Center(child: CircularProgressIndicator()),
              )
            else ...[
              DropdownButtonFormField<String>(
                key: ValueKey('region_${_selectedRegionId ?? 'none'}'),
                initialValue: _selectedRegionId,
                decoration: InputDecoration(
                  labelText: shellTr(
                    context,
                    'territory_select_region',
                    fallback: 'Region / city',
                  ),
                  filled: true,
                  fillColor: p.elevated,
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(14),
                  ),
                ),
                items: regions
                    .map(
                      (r) => DropdownMenuItem<String>(
                        value: r['id']?.toString(),
                        child: Text(_areaLabel(r)),
                      ),
                    )
                    .toList(growable: false),
                onChanged: (val) {
                  HapticFeedback.selectionClick();
                  setState(() {
                    _selectedRegionId = val;
                    _selectedLocalityId = null;
                    _requestingUnitId = null;
                    _requestKey = null;
                  });
                  _loadGroups();
                },
              ),
              if (localities.isNotEmpty) ...[
                const SizedBox(height: 10),
                DropdownButtonFormField<String>(
                  key: ValueKey(
                    'loc_${_selectedRegionId}_${_selectedLocalityId ?? 'all'}',
                  ),
                  initialValue: _selectedLocalityId,
                  decoration: InputDecoration(
                    labelText: shellTr(
                      context,
                      'territory_select_locality',
                      fallback: 'Municipality / district (optional)',
                    ),
                    filled: true,
                    fillColor: p.elevated,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(14),
                    ),
                  ),
                  items: [
                    DropdownMenuItem<String>(
                      value: null,
                      child: Text(
                        shellTr(
                          context,
                          'territory_all_areas',
                          fallback: 'All districts in region',
                        ),
                      ),
                    ),
                    ...localities.map(
                      (loc) => DropdownMenuItem<String>(
                        value: loc['id']?.toString(),
                        child: Text(_areaLabel(loc)),
                      ),
                    ),
                  ],
                  onChanged: (val) {
                    HapticFeedback.selectionClick();
                    setState(() {
                      _selectedLocalityId = val;
                      _requestingUnitId = null;
                      _requestKey = null;
                    });
                    _loadGroups();
                  },
                ),
              ],
              if (_error != null) ...[
                const SizedBox(height: 10),
                Text(
                  _error!,
                  style: Theme.of(
                    context,
                  ).textTheme.bodySmall?.copyWith(color: p.danger),
                ),
              ],
              const SizedBox(height: 12),
              Flexible(
                child: _loadingGroups
                    ? const Padding(
                        padding: EdgeInsets.all(24),
                        child: Center(child: CircularProgressIndicator()),
                      )
                    : _selectedRegionId == null
                    ? Padding(
                        padding: const EdgeInsets.symmetric(vertical: 20),
                        child: Text(
                          shellTr(
                            context,
                            'territory_choose_area_hint',
                            fallback:
                                'Select a region or municipality to view published local groups.',
                          ),
                          textAlign: TextAlign.center,
                          style: Theme.of(
                            context,
                          ).textTheme.bodyMedium?.copyWith(color: p.muted),
                        ),
                      )
                    : _groups.isEmpty
                    ? Padding(
                        padding: const EdgeInsets.symmetric(vertical: 20),
                        child: Text(
                          shellTr(
                            context,
                            'territory_no_groups',
                            fallback:
                                'No published groups accepting admission requests in this area yet.',
                          ),
                          textAlign: TextAlign.center,
                          style: Theme.of(
                            context,
                          ).textTheme.bodyMedium?.copyWith(color: p.muted),
                        ),
                      )
                    : ListView.separated(
                        shrinkWrap: true,
                        itemCount: _groups.length,
                        separatorBuilder: (_, _) => const SizedBox(height: 10),
                        itemBuilder: (context, index) {
                          final g = _groups[index];
                          final unitId = g['id']?.toString() ?? '';
                          final name = g['name']?.toString() ?? '';
                          final posName = g['positionName']?.toString() ?? '';
                          final alreadyMember = g['alreadyMember'] == true;
                          final pendingId = g['pendingRequestId']?.toString();
                          final isRequesting = _requestingUnitId == unitId;
                          final geo = g['geography'] is Map
                              ? Map<String, dynamic>.from(g['geography'] as Map)
                              : null;

                          return ErtadSurfaceCard(
                            padding: const EdgeInsets.all(14),
                            borderColor: isRequesting ? p.primary : p.hairline,
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    Expanded(
                                      child: Text(
                                        name,
                                        style: Theme.of(context)
                                            .textTheme
                                            .titleSmall
                                            ?.copyWith(
                                              fontWeight: FontWeight.w700,
                                            ),
                                      ),
                                    ),
                                    if (alreadyMember)
                                      _Pill(
                                        label: shellTr(
                                          context,
                                          'territory_already_member',
                                          fallback: 'Member',
                                        ),
                                        color: p.success,
                                      )
                                    else if (pendingId != null &&
                                        pendingId.isNotEmpty)
                                      _Pill(
                                        label: shellTr(
                                          context,
                                          'territory_pending_badge',
                                          fallback: 'Pending review',
                                        ),
                                        color: p.warning,
                                      ),
                                  ],
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  [
                                    if (geo != null) _areaLabel(geo),
                                    if (posName.isNotEmpty) posName,
                                  ].join(' · '),
                                  style: Theme.of(context).textTheme.bodySmall
                                      ?.copyWith(color: p.muted),
                                ),
                                const SizedBox(height: 6),
                                Text(
                                  shellTr(
                                    context,
                                    'territory_history_notice',
                                    fallback:
                                        'Admission opens this group chat according to standard retention policy and requires independent approval.',
                                  ),
                                  style: Theme.of(context).textTheme.labelSmall
                                      ?.copyWith(color: p.muted),
                                ),
                                if (!alreadyMember &&
                                    (pendingId == null || pendingId.isEmpty)) ...[
                                  const SizedBox(height: 10),
                                  if (!isRequesting)
                                    FilledButton.tonalIcon(
                                      onPressed: () {
                                        HapticFeedback.selectionClick();
                                        setState(() {
                                          _requestingUnitId = unitId;
                                          _requestKey = null;
                                          _reasonController.clear();
                                        });
                                      },
                                      icon: const Icon(
                                        Icons.person_add_outlined,
                                        size: 18,
                                      ),
                                      label: Text(
                                        shellTr(
                                          context,
                                          'territory_join_btn',
                                          fallback: 'Request admission',
                                        ),
                                      ),
                                    )
                                  else ...[
                                    TextField(
                                      controller: _reasonController,
                                      minLines: 2,
                                      maxLines: 3,
                                      maxLength: 500,
                                      onChanged: (_) => setState(() {}),
                                      decoration: InputDecoration(
                                        labelText: shellTr(
                                          context,
                                          'territory_reason_label',
                                          fallback:
                                              'Reason for admission (min 10 chars)',
                                        ),
                                        hintText: shellTr(
                                          context,
                                          'territory_reason_hint',
                                          fallback:
                                              'Briefly explain why you want to join this local group...',
                                        ),
                                        border: OutlineInputBorder(
                                          borderRadius: BorderRadius.circular(
                                            12,
                                          ),
                                        ),
                                      ),
                                    ),
                                    const SizedBox(height: 8),
                                    Row(
                                      children: [
                                        Expanded(
                                          child: FilledButton(
                                            onPressed:
                                                _submitting ||
                                                    _reasonController.text
                                                            .trim()
                                                            .length <
                                                        10
                                                ? null
                                                : () => _submitAdmission(unitId),
                                            child: Text(
                                              shellTr(
                                                context,
                                                'territory_submit_admission',
                                                fallback: 'Submit request',
                                              ),
                                            ),
                                          ),
                                        ),
                                        const SizedBox(width: 8),
                                        TextButton(
                                          onPressed: _submitting
                                              ? null
                                              : () => setState(() {
                                                    _requestingUnitId = null;
                                                    _requestKey = null;
                                                  }),
                                          child: Text(
                                            shellTr(
                                              context,
                                              'cancel',
                                              fallback: 'Cancel',
                                            ),
                                          ),
                                        ),
                                      ],
                                    ),
                                  ],
                                ],
                              ],
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

class _Pill extends StatelessWidget {
  final String label;
  final Color color;

  const _Pill({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
          color: color,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}
