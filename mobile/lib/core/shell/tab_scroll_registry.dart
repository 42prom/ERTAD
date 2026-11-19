import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Shared registry linking each of the 5 primary tabs to a ScrollController
/// so re-tapping an active dock tab smoothly scrolls back to top.
class TabScrollRegistry {
  final Map<int, ScrollController> _controllers = <int, ScrollController>{};

  ScrollController controllerFor(int tabIndex) {
    return _controllers.putIfAbsent(tabIndex, ScrollController.new);
  }

  Future<void> scrollToTop(int tabIndex) async {
    final ctrl = _controllers[tabIndex];
    if (ctrl == null || !ctrl.hasClients) return;
    if (ctrl.offset <= 2) return;
    await ctrl.animateTo(
      0,
      duration: const Duration(milliseconds: 280),
      curve: Curves.easeOutCubic,
    );
  }

  void dispose() {
    for (final ctrl in _controllers.values) {
      ctrl.dispose();
    }
    _controllers.clear();
  }
}

final tabScrollRegistryProvider = Provider<TabScrollRegistry>((ref) {
  final registry = TabScrollRegistry();
  ref.onDispose(registry.dispose);
  return registry;
});

