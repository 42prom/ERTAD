import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/activity_item.dart';
import 'secure_storage_service.dart';

class StorageService {
  // Non-sensitive keys (SharedPreferences)
  static const String _enrolledKey = 'is_enrolled';
  static const String _firstNameKey = 'first_name';
  static const String _lastNameKey = 'last_name';
  static const String _birthDateKey = 'birth_date';
  static const String _genderKey = 'gender';
  static const String _regionsKey = 'region_codes';
  // Activity key is now user-specific - see _getActivityKey()
  static const String _activityKeyPrefix = 'activity_items_';

  // Secure storage for sensitive data
  final SecureStorageService _secure = SecureStorageService();

  /// Get user-specific activity cache key
  /// This ensures different users on the same device don't see each other's activity
  Future<String> _getActivityKey() async {
    final userId = await getUserId();
    if (userId == null || userId.isEmpty) {
      // Fallback for unauthenticated state (should not happen in practice)
      return '${_activityKeyPrefix}anonymous';
    }
    return '$_activityKeyPrefix$userId';
  }

  // --- Non-sensitive: enrollment status (SharedPreferences) ---

  Future<bool> isEnrolled() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool(_enrolledKey) ?? false;
  }

  Future<void> setEnrolled(bool value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_enrolledKey, value);
  }

  // --- Sensitive: credential (Secure Storage) ---

  Future<String?> getCredential() async {
    return await _secure.getCredential();
  }

  Future<void> saveCredential(String credential) async {
    await _secure.saveCredential(credential);
  }

  // --- Sensitive: user ID (Secure Storage) ---

  Future<String?> getUserId() async {
    return await _secure.getUserId();
  }

  Future<void> saveUserId(String userId) async {
    await _secure.saveUserId(userId);
  }

  /// Returns a cryptographically random, non-PII identifier for this install.
  Future<String> getOrCreateInstallationId() async {
    var installationId = await _secure.getInstallationId();
    if (installationId != null && installationId.isNotEmpty) {
      return installationId;
    }

    final random = Random.secure();
    final bytes = Uint8List(32);
    for (var index = 0; index < bytes.length; index++) {
      bytes[index] = random.nextInt(256);
    }
    installationId = base64UrlEncode(bytes);
    await _secure.saveInstallationId(installationId);
    return installationId;
  }

  // --- Sensitive: display name, birth date & gender (SecureStorage + legacy SharedPreferences migration) ---

  Future<String?> _readWithMigration(
    String legacyPrefKey,
    Future<String?> Function() secureReader,
    Future<void> Function(String) secureWriter,
  ) async {
    final fromSecure = await secureReader();
    if (fromSecure != null && fromSecure.isNotEmpty) {
      return fromSecure;
    }
    final prefs = await SharedPreferences.getInstance();
    final legacy = prefs.getString(legacyPrefKey);
    if (legacy != null && legacy.isNotEmpty) {
      await secureWriter(legacy);
      await prefs.remove(legacyPrefKey);
      return legacy;
    }
    return null;
  }

  Future<String?> getFirstName() async {
    return _readWithMigration(
      _firstNameKey,
      _secure.getFirstName,
      _secure.saveFirstName,
    );
  }

  Future<String?> getLastName() async {
    return _readWithMigration(
      _lastNameKey,
      _secure.getLastName,
      _secure.saveLastName,
    );
  }

  Future<DateTime?> getBirthDate() async {
    final iso = await _readWithMigration(
      _birthDateKey,
      _secure.getBirthDateIso,
      _secure.saveBirthDateIso,
    );
    return iso != null ? DateTime.tryParse(iso) : null;
  }

  Future<void> saveName(String firstName, String lastName) async {
    await _secure.saveFirstName(firstName);
    await _secure.saveLastName(lastName);
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_firstNameKey);
    await prefs.remove(_lastNameKey);
  }

  Future<void> saveBirthDate(DateTime birthDate) async {
    await _secure.saveBirthDateIso(birthDate.toIso8601String());
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_birthDateKey);
  }

  Future<String?> getGender() async {
    return _readWithMigration(
      _genderKey,
      _secure.getGender,
      _secure.saveGender,
    );
  }

  Future<void> saveGender(String gender) async {
    await _secure.saveGender(gender);
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_genderKey);
  }

  Future<List<String>> getRegionCodes() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getStringList(_regionsKey) ?? [];
  }

  Future<void> saveRegionCodes(List<String> regionCodes) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(_regionsKey, regionCodes);
  }

  Future<String> getDisplayName() async {
    final firstName = await getFirstName();
    final lastName = await getLastName();
    if (firstName != null && lastName != null) {
      return '$firstName $lastName';
    }
    return 'Citizen';
  }

  /// Erase retired voting secrets and cached choice/receipt data before startup.
  Future<void> purgeLegacyVotingSecrets() async {
    await _secure.deleteLegacyCredentialSecret();
    final prefs = await SharedPreferences.getInstance();
    for (final key in prefs.getKeys().where(
      (key) => key.startsWith(_activityKeyPrefix) || key == 'activity_items',
    )) {
      try {
        final raw = prefs.getString(key);
        final items = ActivityItem.listFromJsonString(raw ?? '');
        final sanitized = ActivityItem.listToJsonString(items);
        if (raw != sanitized && !await prefs.setString(key, sanitized)) {
          throw StateError('Activity cleanup could not be persisted');
        }
      } on FormatException {
        if (!await prefs.remove(key)) {
          throw StateError('Activity cleanup failed');
        }
      } on TypeError {
        if (!await prefs.remove(key)) {
          throw StateError('Activity cleanup failed');
        }
      }
    }
  }

  // --- Non-sensitive: activity history (SharedPreferences) ---
  // SECURITY: Activity cache is user-specific to prevent data leakage
  // between different users on the same device

  Future<List<ActivityItem>> getActivityItems() async {
    final prefs = await SharedPreferences.getInstance();
    final activityKey = await _getActivityKey();
    final jsonString = prefs.getString(activityKey);
    if (jsonString == null || jsonString.isEmpty) return [];
    return ActivityItem.listFromJsonString(jsonString);
  }

  Future<void> saveActivityItem(ActivityItem item) async {
    final prefs = await SharedPreferences.getInstance();
    final activityKey = await _getActivityKey();
    final items = await getActivityItems();
    // Prevent duplicates by pollId
    items.removeWhere((e) => e.pollId == item.pollId);
    items.insert(0, item); // newest first
    await prefs.setString(activityKey, ActivityItem.listToJsonString(items));
  }

  /// Clear all activity items for current user (used when syncing from API)
  Future<void> clearActivityItems() async {
    final prefs = await SharedPreferences.getInstance();
    final activityKey = await _getActivityKey();
    await prefs.remove(activityKey);
  }

  /// Clear activity cache for ALL users on this device
  /// Call this on logout or when switching accounts
  Future<void> clearAllActivityCaches() async {
    final prefs = await SharedPreferences.getInstance();
    final keys = prefs.getKeys();
    for (final key in keys) {
      if (key.startsWith(_activityKeyPrefix)) {
        await prefs.remove(key);
      }
    }
    debugPrint('[Storage] Cleared all activity caches');
  }

  /// Clear all stored data (both secure and preferences).
  /// This is a full logout - clears all user data including activity caches.
  Future<void> clearAll() async {
    final prefs = await SharedPreferences.getInstance();
    // Clear all preferences (includes activity caches for all users)
    await prefs.clear();
    // Clear secure storage (credentials, userId, secrets)
    await _secure.deleteAll();
    debugPrint('[Storage] Cleared all user data (full logout)');
  }

  /// Decodes demographics from the JWT credential token and saves them locally.
  /// Used for synchronizing filtering data after login or on a new device.
  Future<void> syncDemographicsFromToken() async {
    final token = await getCredential();
    if (token == null || token.isEmpty) return;

    try {
      final parts = token.split('.');
      if (parts.length != 3) return;

      // Base64Url decode the payload (middle part)
      String normalized = base64Url.normalize(parts[1]);
      final payload = utf8.decode(base64Url.decode(normalized));
      final json = jsonDecode(payload);
      final data = json['data'] as Map<String, dynamic>?;

      if (data != null) {
        // Gender
        final gender = data['gender'] as String?;
        if (gender != null) {
          await saveGender(gender);
        }

        // Region Codes (UUIDs)
        final regions = data['region_codes'] as List<dynamic>?;
        if (regions != null) {
          await saveRegionCodes(regions.map((e) => e.toString()).toList());
        }

        // Note: birth_date is not in the JWT, only age_bucket.
        // We rely on the app already having birth_date from enrollment
        // or a manual refresh if we add a profile API later.
      }
    } catch (e) {
      // Non-critical, just log
      debugPrint('StorageService: Demographic sync failed: $e');
    }
  }
}
