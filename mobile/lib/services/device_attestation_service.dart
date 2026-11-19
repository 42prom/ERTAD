import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

class DeviceAttestationEvidence {
  const DeviceAttestationEvidence({
    required this.token,
    required this.platform,
    required this.provider,
  });

  final String token;
  final String platform;
  final String provider;
}

/// Hardware-backed integrity evidence obtained from native platform APIs.
///
/// This service deliberately has no fingerprint, emulator, or debug-token
/// fallback. If the platform cannot produce genuine evidence, verification fails
/// closed and the user can retry after correcting the device/app state.
class DeviceAttestationService {
  static const MethodChannel _channel = MethodChannel(
    'ge.ertad.mobile/device_attestation',
  );
  static final DeviceInfoPlugin _deviceInfo = DeviceInfoPlugin();

  @visibleForTesting
  static String? debugPlatformOverride;

  static String get platform {
    if (!kReleaseMode && debugPlatformOverride != null) {
      return debugPlatformOverride!;
    }
    if (Platform.isAndroid) return 'android';
    if (Platform.isIOS) return 'ios';
    return 'unsupported';
  }

  static Future<DeviceAttestationEvidence> getAttestationEvidence(
    String nonce,
  ) {
    return getAttestationEvidenceForPlatform(nonce, platform);
  }

  @visibleForTesting
  static Future<DeviceAttestationEvidence> getAttestationEvidenceForPlatform(
    String nonce,
    String targetPlatform,
  ) async {
    if (nonce.trim().isEmpty) {
      throw ArgumentError.value(nonce, 'nonce', 'must not be empty');
    }

    final String method;
    final String provider;
    switch (targetPlatform) {
      case 'android':
        method = 'playIntegrityToken';
        provider = 'play_integrity_standard';
        break;
      case 'ios':
        method = 'appAttestEvidence';
        provider = 'app_attest';
        break;
      default:
        throw UnsupportedError(
          'Device attestation is unavailable on this platform',
        );
    }

    try {
      final token = await _channel.invokeMethod<String>(method, {
        'nonce': nonce,
      });
      if (token == null || token.trim().isEmpty) {
        throw StateError('The platform returned empty attestation evidence');
      }
      return DeviceAttestationEvidence(
        token: token,
        platform: targetPlatform,
        provider: provider,
      );
    } on PlatformException catch (error) {
      throw StateError(
        'Device integrity verification is unavailable (${error.code}).',
      );
    } on MissingPluginException {
      throw StateError('Device integrity verification is not installed.');
    }
  }

  /// Deletes the one-time attestation object only after the backend has
  /// accepted a request that registered the App Attest key.
  static Future<void> confirmAppAttestRegistration() async {
    if (platform != 'ios') return;
    try {
      await _channel.invokeMethod<void>('confirmAppAttestRegistration');
    } on PlatformException catch (error) {
      throw StateError(
        'Could not finalize App Attest registration (${error.code}).',
      );
    }
  }

  static Future<bool> isPhysicalDevice() async {
    try {
      if (Platform.isAndroid) {
        return (await _deviceInfo.androidInfo).isPhysicalDevice;
      }
      if (Platform.isIOS) return (await _deviceInfo.iosInfo).isPhysicalDevice;
    } catch (_) {
      return false;
    }
    return false;
  }
}
