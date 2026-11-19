import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:ertad_mobile/services/device_attestation_service.dart';
import 'package:ertad_mobile/services/storage_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('ge.ertad.mobile/device_attestation');
  const secureChannel = MethodChannel(
    'plugins.it_nomads.com/flutter_secure_storage',
  );
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  final secure = <String, String>{};
  setUp(() {
    secure.clear();
    SharedPreferences.setMockInitialValues({});
    messenger.setMockMethodCallHandler(secureChannel, (call) async {
      final args = call.arguments as Map;
      switch (call.method) {
        case 'read':
          return secure[args['key']];
        case 'write':
          secure[args['key']] = args['value'];
          return null;
        case 'delete':
          secure.remove(args['key']);
          return null;
        case 'deleteAll':
          secure.clear();
          return null;
        default:
          throw PlatformException(code: 'UNEXPECTED_METHOD');
      }
    });
  });
  tearDown(() {
    messenger.setMockMethodCallHandler(channel, null);
    messenger.setMockMethodCallHandler(secureChannel, null);
  });
  for (final platform in ['android', 'ios']) {
    test('forwards the exact challenge to $platform', () async {
      final calls = <MethodCall>[];
      messenger.setMockMethodCallHandler(channel, (call) async {
        calls.add(call);
        return 'synthetic-provider-evidence';
      });
      final result =
          await DeviceAttestationService.getAttestationEvidenceForPlatform(
            'synthetic-fresh-action-challenge',
            platform,
          );
      expect(
        calls.single.method,
        platform == 'android' ? 'playIntegrityToken' : 'appAttestEvidence',
      );
      expect(calls.single.arguments, {
        'nonce': 'synthetic-fresh-action-challenge',
      });
      expect(result.token, 'synthetic-provider-evidence');
      expect(result.platform, platform);
      expect(
        result.provider,
        platform == 'android' ? 'play_integrity_standard' : 'app_attest',
      );
    });
  }
  test(
    'provider failure and empty evidence never become successful verification',
    () async {
      for (final failure in ['unavailable', 'empty', 'missing']) {
        messenger.setMockMethodCallHandler(channel, (_) async {
          if (failure == 'unavailable') {
            throw PlatformException(code: 'UNAVAILABLE');
          }
          if (failure == 'missing') throw MissingPluginException();
          return '';
        });
        await expectLater(
          DeviceAttestationService.getAttestationEvidenceForPlatform(
            'fresh-challenge',
            'android',
          ),
          throwsStateError,
        );
      }
    },
  );
  test(
    'blank challenge and unsupported platform do not call a native provider',
    () async {
      var calls = 0;
      messenger.setMockMethodCallHandler(channel, (_) async {
        calls++;
        return 'evidence';
      });
      await expectLater(
        DeviceAttestationService.getAttestationEvidenceForPlatform(
          ' ',
          'android',
        ),
        throwsArgumentError,
      );
      await expectLater(
        DeviceAttestationService.getAttestationEvidenceForPlatform(
          'challenge',
          'unsupported',
        ),
        throwsUnsupportedError,
      );
      expect(calls, 0);
    },
  );
  test(
    'installation ID is stable until logout and changes after erasure',
    () async {
      final storage = StorageService();
      final first = await storage.getOrCreateInstallationId();
      expect(await storage.getOrCreateInstallationId(), first);
      await storage.clearAll();
      expect(await storage.getOrCreateInstallationId(), isNot(first));
    },
  );
  test(
    'upgrade removes the retired secret without deleting the session',
    () async {
      secure['credential_secret'] = 'retired-synthetic-secret';
      secure['credential'] = 'synthetic-session';
      await StorageService().purgeLegacyVotingSecrets();
      expect(secure, {'credential': 'synthetic-session'});
    },
  );
}
