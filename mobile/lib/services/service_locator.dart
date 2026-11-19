import 'package:flutter/foundation.dart';
import '../config/app_config.dart';
import 'interfaces/i_api_service.dart';
import 'real/real_api_service.dart';

/// Lightweight service locator that selects mock or real implementations.
///
/// Test overrides are accepted only outside release builds.
class ServiceLocator {
  ServiceLocator._();

  static IApiService? _mockApiService;

  /// Visible for testing
  static set mockApiService(IApiService? mock) {
    if (kReleaseMode) throw StateError('Test service overrides are disabled');
    _mockApiService = mock;
  }

  static IApiService get apiService {
    if (!kReleaseMode && _mockApiService != null) {
      return _mockApiService!;
    }
    return RealApiService();
  }

  /// Reset all services (useful for testing or toggling mock mode at runtime).
  static void reset() {
    _mockApiService = null;
  }

  /// Debug info for development.
  static void printConfig() {
    if (kDebugMode) {
      print(
        '[ServiceLocator] '
        'flavor=${AppConfig.flavor}, '
        'isRelease=${AppConfig.isRelease}',
      );
    }
  }
}
