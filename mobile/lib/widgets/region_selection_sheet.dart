import 'package:flutter/material.dart';
import '../core/shell/shell_l10n.dart';
import '../models/verification_models.dart';
import '../services/interfaces/i_api_service.dart';
import '../config/theme.dart';

/// Canonical Georgian regions fallback (ISO 3166-2:GE) for offline/M4 selection.
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
  final IApiService apiService;
  final String? selectedCode; // Pre-selection support

  const RegionSelectionSheet({
    super.key,
    required this.apiService,
    this.selectedCode,
  });

  @override
  State<RegionSelectionSheet> createState() => _RegionSelectionSheetState();
}

class _RegionSelectionSheetState extends State<RegionSelectionSheet> {
  List<Region>? _regions;
  List<Region>? _filteredRegions;
  String? _selectedCode;
  bool _isLoading = true;
  String? _error;
  final TextEditingController _searchController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _selectedCode = widget.selectedCode;
    _loadRegions();
    _searchController.addListener(_onSearchChanged);
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  void _onSearchChanged() {
    if (_regions == null) return;
    final query = _searchController.text.toLowerCase().trim();
    setState(() {
      if (query.isEmpty) {
        _filteredRegions = _regions;
      } else {
        _filteredRegions = _regions!.where((r) {
          return r.nameEn.toLowerCase().contains(query) ||
              r.nameKa.toLowerCase().contains(query) ||
              r.code.toLowerCase().contains(query);
        }).toList();
      }
    });
  }

  Future<void> _loadRegions() async {
    try {
      final list = await widget.apiService.getRegions();
      final effective = list.isNotEmpty ? list : kGeorgianRegions;
      if (mounted) {
        setState(() {
          _regions = effective;
          _filteredRegions = effective;
          _isLoading = false;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _regions = kGeorgianRegions;
          _filteredRegions = kGeorgianRegions;
          _isLoading = false;
        });
      }
    }
  }

  void _toggleRegion(Region region) {
    setState(() {
      if (_selectedCode == region.code) {
        _selectedCode = null; // Deselect if clicking same
      } else {
        _selectedCode = region.code; // Single select
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    // Premium Glassmorphism / Dark Theme Style
    final theme = Theme.of(context);
    final isDark = theme.brightness == Brightness.dark;

    return Container(
      decoration: BoxDecoration(
        color: isDark ? const Color(0xFF1E1E1E) : Colors.white,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
        boxShadow: [
          BoxShadow(
            color: Colors.grey.withValues(alpha: 0.4),
            blurRadius: 20,
            offset: const Offset(0, -5),
          ),
        ],
      ),
      child: Column(
        children: [
          // Handle Bar
          Center(
            child: Container(
              margin: const EdgeInsets.only(top: 12, bottom: 8),
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: isDark ? Colors.grey[700] : Colors.grey[300],
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),

          // Header
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  'Where are you from?',
                  style: theme.textTheme.titleLarge?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ],
            ),
          ),

          // Search Bar
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            child: TextField(
              controller: _searchController,
              decoration: InputDecoration(
                hintText: shellTr(
                  context,
                  'search_region_hint',
                  fallback: 'Search region...',
                ),
                prefixIcon: const Icon(Icons.search),
                filled: true,
                fillColor: isDark ? Colors.grey[800] : Colors.grey[100],
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(16),
                  borderSide: BorderSide.none,
                ),
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 14,
                ),
              ),
            ),
          ),

          // List
          Expanded(child: _buildContent(isDark)),

          // Confirm Button
          Padding(
            padding: const EdgeInsets.all(16),
            child: ElevatedButton(
              onPressed: () {
                // Return Single Region based on selection
                if (_regions == null || _selectedCode == null) return;
                final selected = _regions!.firstWhere(
                  (r) => r.code == _selectedCode,
                );
                Navigator.pop(context, selected);
              },
              style: ElevatedButton.styleFrom(
                minimumSize: const Size(double.infinity, 50),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
              child: Text(shellTr(context, 'confirm', fallback: 'Confirm')),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildContent(bool isDark) {
    if (_isLoading) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(
                Icons.error_outline,
                size: 48,
                color: Colors.redAccent,
              ),
              const SizedBox(height: 16),
              Text(
                shellTr(
                  context,
                  'failed_load_regions',
                  fallback: 'Failed to load regions',
                ),
                style: TextStyle(
                  color: isDark ? Colors.white70 : Colors.black87,
                ),
              ),
              const SizedBox(height: 8),
              TextButton(
                onPressed: () {
                  setState(() {
                    _isLoading = true;
                    _error = null;
                  });
                  _loadRegions();
                },
                child: Text(shellTr(context, 'retry', fallback: 'Try Again')),
              ),
            ],
          ),
        ),
      );
    }

    if (_filteredRegions == null || _filteredRegions!.isEmpty) {
      return Center(
        child: Text(
          shellTr(
            context,
            'no_regions_found',
            fallback: 'No regions found',
          ),
          style: TextStyle(color: isDark ? Colors.white54 : Colors.black54),
        ),
      );
    }

    return ListView.builder(
      itemCount: _filteredRegions!.length,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      itemBuilder: (context, index) {
        final region = _filteredRegions![index];
        final isSelected = _selectedCode == region.code;

        return Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Material(
            color: Colors.transparent,
            child: InkWell(
              onTap: () => _toggleRegion(region),
              borderRadius: BorderRadius.circular(12),
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 12,
                ),
                decoration: BoxDecoration(
                  color: isDark
                      ? (isSelected
                            ? Colors.blue.withValues(alpha: 0.2)
                            : Colors.blue.withValues(alpha: 0.05))
                      : (isSelected
                            ? Colors.blue.withValues(alpha: 0.1)
                            : Colors.grey[50]),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(
                    color: isSelected
                        ? Colors.blue
                        : (isDark ? Colors.white10 : Colors.grey[200]!),
                    width: isSelected ? 2 : 1,
                  ),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 40,
                      height: 40,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: AppTheme.facebookBlue.withValues(alpha: 0.1),
                        shape: BoxShape.circle,
                      ),
                      child: Text(
                        region.code.substring(0, 1),
                        style: const TextStyle(
                          color: AppTheme.facebookBlue,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            region.nameEn,
                            style: TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w600,
                              color: isDark ? Colors.white : Colors.black,
                            ),
                          ),
                          Text(
                            region.nameKa,
                            style: TextStyle(
                              fontSize: 13,
                              color: isDark ? Colors.white54 : Colors.black54,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                    Icon(
                      isSelected ? Icons.check_circle : Icons.circle_outlined,
                      color: isSelected
                          ? Colors.blue
                          : (isDark ? Colors.white24 : Colors.grey),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}
