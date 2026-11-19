import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/shell/shell_l10n.dart';
import '../core/theme/ertad_theme.dart';
import '../core/widgets/ertad_ui.dart';
import '../models/verification_models.dart';
import '../services/interfaces/i_api_service.dart';

/// Canonical Georgian regions (ISO 3166-2:GE) for instant offline/M4 selection.
final List<Region> kGeorgianRegions = <Region>[
  Region(id: 'GE-TB', code: 'GE-TB', nameEn: 'Tbilisi', nameKa: 'თბილისი'),
  Region(id: 'GE-AJ', code: 'GE-AJ', nameEn: 'Adjara', nameKa: 'აჭარა'),
  Region(id: 'GE-IM', code: 'GE-IM', nameEn: 'Imereti', nameKa: 'იმერეთი'),
  Region(id: 'GE-KA', code: 'GE-KA', nameEn: 'Kakheti', nameKa: 'კახეთი'),
  Region(id: 'GE-KK', code: 'GE-KK', nameEn: 'Kvemo Kartli', nameKa: 'ქვემო ქართლი'),
  Region(id: 'GE-SK', code: 'GE-SK', nameEn: 'Shida Kartli', nameKa: 'შიდა ქართლი'),
  Region(
    id: 'GE-SZ',
    code: 'GE-SZ',
    nameEn: 'Samegrelo-Zemo Svaneti',
    nameKa: 'სამეგრელო-ზემო სვანეთი',
  ),
  Region(id: 'GE-GU', code: 'GE-GU', nameEn: 'Guria', nameKa: 'გურია'),
  Region(id: 'GE-SJ', code: 'GE-SJ', nameEn: 'Samtskhe-Javakheti', nameKa: 'სამცხე-ჯავახეთი'),
  Region(id: 'GE-MM', code: 'GE-MM', nameEn: 'Mtskheta-Mtianeti', nameKa: 'მცხეთა-მთიანეთი'),
  Region(
    id: 'GE-RL',
    code: 'GE-RL',
    nameEn: 'Racha-Lechkhumi & Kvemo Svaneti',
    nameKa: 'რაჭა-ლეჩხუმი და ქვემო სვანეთი',
  ),
  Region(id: 'GE-AB', code: 'GE-AB', nameEn: 'Abkhazia', nameKa: 'აფხაზეთი'),
];

String resolveGeorgianRegionLabel(String code, {bool georgian = true}) {
  for (final r in kGeorgianRegions) {
    if (r.code.toUpperCase() == code.toUpperCase()) {
      return georgian ? r.nameKa : r.nameEn;
    }
  }
  return code;
}

class RegionSelectionSheet extends StatefulWidget {
  final IApiService? apiService;
  final String? selectedCode;

  const RegionSelectionSheet({
    super.key,
    this.apiService,
    this.selectedCode,
  });

  @override
  State<RegionSelectionSheet> createState() => _RegionSelectionSheetState();
}

class _RegionSelectionSheetState extends State<RegionSelectionSheet> {
  final TextEditingController _searchController = TextEditingController();
  late List<Region> _filteredRegions;

  @override
  void initState() {
    super.initState();
    _filteredRegions = kGeorgianRegions;
    _searchController.addListener(_onSearchChanged);
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  void _onSearchChanged() {
    final query = _searchController.text.toLowerCase().trim();
    setState(() {
      if (query.isEmpty) {
        _filteredRegions = kGeorgianRegions;
      } else {
        _filteredRegions = kGeorgianRegions.where((r) {
          return r.nameKa.toLowerCase().contains(query) ||
              r.nameEn.toLowerCase().contains(query) ||
              r.code.toLowerCase().contains(query);
        }).toList(growable: false);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final maxH = MediaQuery.sizeOf(context).height * 0.82;

    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: maxH),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ErtadModalSheetHeader(
              icon: Icons.location_on_outlined,
              title: shellTr(
                context,
                'origin_region',
                fallback: 'აირჩიეთ რეგიონი',
              ),
              closeTooltip: shellTr(context, 'close', fallback: 'Close'),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _searchController,
              decoration: InputDecoration(
                prefixIcon: const Icon(Icons.search_rounded),
                hintText: shellTr(context, 'search', fallback: 'ძიება...'),
                filled: true,
                fillColor: p.elevated,
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 10,
                ),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(14),
                  borderSide: BorderSide(color: p.hairline),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(14),
                  borderSide: BorderSide(color: p.hairline),
                ),
              ),
            ),
            const SizedBox(height: 12),
            Flexible(
              child: ListView.separated(
                shrinkWrap: true,
                itemCount: _filteredRegions.length,
                separatorBuilder: (_, _) => const SizedBox(height: 8),
                itemBuilder: (context, index) {
                  final region = _filteredRegions[index];
                  final isSelected =
                      widget.selectedCode?.toUpperCase() ==
                      region.code.toUpperCase();
                  return ErtadSurfaceCard(
                    onTap: () {
                      HapticFeedback.selectionClick();
                      Navigator.of(context).pop(region);
                    },
                    padding: const EdgeInsets.symmetric(
                      horizontal: 14,
                      vertical: 12,
                    ),
                    backgroundColor: isSelected ? p.primarySoft : p.surface,
                    borderColor: isSelected ? p.primary : p.hairline,
                    child: Row(
                      children: [
                        Icon(
                          isSelected
                              ? Icons.check_circle_rounded
                              : Icons.location_on_outlined,
                          size: 20,
                          color: isSelected ? p.primary : p.muted,
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                region.nameKa,
                                style: Theme.of(context).textTheme.titleSmall
                                    ?.copyWith(
                                      fontWeight: isSelected
                                          ? FontWeight.w700
                                          : FontWeight.w600,
                                      color: isSelected ? p.primary : p.text,
                                    ),
                              ),
                              Text(
                                region.nameEn,
                                style: Theme.of(context).textTheme.bodySmall
                                    ?.copyWith(color: p.muted),
                              ),
                            ],
                          ),
                        ),
                        if (isSelected)
                          Icon(Icons.check_rounded, size: 18, color: p.primary),
                      ],
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
