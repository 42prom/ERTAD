import 'package:ertad_mobile/core/network/mobile_api_client.dart';
import 'package:ertad_mobile/core/state/offline_action_queue.dart';
import 'package:ertad_mobile/core/state/shell_providers.dart';
import 'package:ertad_mobile/core/theme/ertad_theme.dart';
import 'package:ertad_mobile/models/poll.dart';
import 'package:ertad_mobile/screens/voting/decision_results_card.dart';
import 'package:ertad_mobile/services/localization_service.dart';
import 'package:ertad_mobile/services/storage_service.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart' as legacy_provider;
import 'package:shared_preferences/shared_preferences.dart';

class _FakeMobileApiClient extends MobileApiClient {
  bool logoutCalled = false;
  bool fetchedNeedsReview = false;
  bool fetchedReviews = false;
  Map<String, dynamic> decisionDetailResponse = const <String, dynamic>{};

  _FakeMobileApiClient() : super(baseUrl: 'http://127.0.0.1:13000/api/v1');

  @override
  Future<void> logout() async {
    logoutCalled = true;
    await clearStoredSession();
  }

  @override
  Future<Map<String, dynamic>> fetchWorkspaceBootstrap() async {
    return <String, dynamic>{
      'units': const [
        <String, dynamic>{'id': '11111111-1111-4111-8111-111111111111', 'name': 'ERTAD Test'},
      ],
      'reviews': const [
        <String, dynamic>{'id': 'rev-ctx-1', 'name': 'Unit'},
      ],
      'summary': const <String, dynamic>{
        'pendingReviews': 2,
        'upcomingEvents48h': 1,
      },
      'inbox': const <String, dynamic>{'unread': 1},
      'channels': const <Map<String, dynamic>>[],
    };
  }

  @override
  Future<Map<String, dynamic>> fetchPrivacy(String organizationId) async =>
      const <String, dynamic>{'disclosureMode': 'private_hidden'};

  @override
  Future<List<Map<String, dynamic>>> fetchDecisions({
    required String organizationId,
    String view = 'open',
  }) async => const [];

  @override
  Future<List<Map<String, dynamic>>> fetchWorkItems({
    required String organizationId,
    String view = 'open',
  }) async {
    if (view == 'needs_review') {
      fetchedNeedsReview = true;
      return const [
        <String, dynamic>{'id': 'work-review-1', 'title': 'Verify report'},
      ];
    }
    return const [];
  }

  @override
  Future<List<Map<String, dynamic>>> fetchEvents({
    required String organizationId,
    String status = 'open',
  }) async => const [];

  @override
  Future<List<Map<String, dynamic>>> fetchChannels({
    required String organizationId,
    String view = 'active',
    String kind = 'member_all',
  }) async => const [];

  @override
  Future<Map<String, dynamic>> fetchInbox({
    required String organizationId,
    String view = 'all',
    String source = 'all',
  }) async => const <String, dynamic>{'items': <Map<String, dynamic>>[], 'unread': 0};

  @override
  Future<Map<String, dynamic>> fetchContributionPoints({
    required String organizationId,
  }) async => const <String, dynamic>{'balance': '42', 'entries': <Map<String, dynamic>>[]};

  @override
  Future<List<Map<String, dynamic>>> fetchReviews({
    required String organizationId,
    String view = 'pending',
  }) async {
    fetchedReviews = true;
    return const [
      <String, dynamic>{'id': 'rev-1', 'kind': 'membership'},
    ];
  }

  @override
  Future<Map<String, dynamic>> fetchM4Status() async => const <String, dynamic>{
    'assuranceLevel': 'biometric_verified',
    'sodCscaVerified': true,
  };

  @override
  Future<Map<String, dynamic>> fetchReferralSummary({
    required String organizationId,
  }) async => const <String, dynamic>{};

  @override
  Future<List<Map<String, dynamic>>> fetchNotificationChannels() async =>
      const [];

  @override
  Future<Map<String, dynamic>> fetchMemberProfile() async =>
      const <String, dynamic>{};

  @override
  Future<Map<String, dynamic>> fetchDecisionDetail({
    required String organizationId,
    required String decisionId,
  }) async => decisionDetailResponse;

  @override
  Future<Map<String, dynamic>> rsvpEvent({
    required String organizationId,
    required String eventId,
    required String action,
    String? idempotencyKey,
  }) async => const <String, dynamic>{'ok': true};
}

class _LiveConnectedShellNotifier extends ShellSessionNotifier {
  _LiveConnectedShellNotifier(super.api, {required String orgId}) {
    state = ShellSessionState(
      organizations: <OrgContextSummary>[
        OrgContextSummary(
          id: orgId,
          name: 'ERTAD Live',
          unitName: 'Unit',
          roleLabel: 'Member',
        ),
      ],
      activeOrgId: orgId,
      isLiveConnected: true,
    );
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const secureChannel = MethodChannel(
    'plugins.it_nomads.com/flutter_secure_storage',
  );
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  final secureMap = <String, String>{};

  setUp(() {
    secureMap.clear();
    SharedPreferences.setMockInitialValues(<String, Object>{});
    messenger.setMockMethodCallHandler(secureChannel, (call) async {
      final args = (call.arguments as Map?) ?? const {};
      switch (call.method) {
        case 'read':
          return secureMap[args['key']];
        case 'write':
          secureMap[args['key'] as String] = args['value'] as String;
          return null;
        case 'delete':
          secureMap.remove(args['key']);
          return null;
        case 'deleteAll':
          secureMap.clear();
          return null;
        default:
          throw PlatformException(code: 'UNSUPPORTED');
      }
    });
  });

  tearDown(() {
    messenger.setMockMethodCallHandler(secureChannel, null);
  });

  test(
    'ShellSessionNotifier derives manager authority from server bootstrap and signOut clears all state',
    () async {
      SharedPreferences.setMockInitialValues(<String, Object>{
        'ertad_offline_cache_11111111-1111-4111-8111-111111111111': '{"work":[]}',
        'ertad_vote_receipt_poll-1': 'A1B2C3D4E5F60718',
      });
      final api = _FakeMobileApiClient();
      final notifier = ShellSessionNotifier(api);

      expect(notifier.state.isGroupManager, isFalse);
      await notifier.refreshWorkspace();

      expect(notifier.state.hasManagerAuthority, isTrue);
      expect(notifier.state.isGroupManager, isTrue);
      expect(api.fetchedNeedsReview, isTrue);
      expect(api.fetchedReviews, isTrue);
      expect(notifier.state.reviewWorkItems, hasLength(1));
      expect(notifier.state.pendingReviews, hasLength(1));

      await notifier.signOut();

      expect(api.logoutCalled, isTrue);
      expect(notifier.state.isLiveConnected, isFalse);
      expect(notifier.state.hasManagerAuthority, isFalse);
      expect(notifier.state.isGroupManager, isFalse);
      expect(notifier.state.pendingReviews, isEmpty);
      expect(notifier.state.reviewWorkItems, isEmpty);

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('ertad_offline_cache_11111111-1111-4111-8111-111111111111'), isNull);
      expect(prefs.getString('ertad_vote_receipt_poll-1'), isNull);
    },
  );

  testWidgets(
    'DecisionResultsCard does not false-verify empty tallies and renders survey results breakdown',
    (tester) async {
      SharedPreferences.setMockInitialValues(<String, Object>{
        'ertad_vote_receipt_poll-empty': 'A1B2C3D4E5F60718',
        'ertad_vote_receipt_survey-1': 'A1B2C3D4E5F60718',
      });

      final api = _FakeMobileApiClient()
        ..decisionDetailResponse = <String, dynamic>{
          'resultsSuppressed': false,
          'participation': 4,
          'receiptDigests': const <String>[],
          'results': const [
            <String, dynamic>{'label': 'Approve', 'votes': 4},
          ],
        };

      final loc = LocalizationService();
      await loc.setLanguage(AppLanguage.english);

      final pollEmpty = Poll(
        id: 'poll-empty',
        title: 'Test Poll',
        type: 'poll',
        options: [PollOption(id: 'o1', text: 'Approve', displayOrder: 0)],
        tags: const [],
        endAt: '2020-01-01T00:00:00Z',
        hasVoted: true,
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            mobileApiClientProvider.overrideWithValue(api),
            shellSessionProvider.overrideWith(
              (ref) => _LiveConnectedShellNotifier(
                api,
                orgId: '11111111-1111-4111-8111-111111111111',
              ),
            ),
          ],
          child: legacy_provider.ChangeNotifierProvider<LocalizationService>.value(
            value: loc,
            child: MaterialApp(
              theme: ErtadTheme.lightTheme,
              home: Scaffold(
                body: SingleChildScrollView(
                  child: DecisionResultsCard(
                    key: const ValueKey('poll-empty'),
                    poll: pollEmpty,
                    isClosed: true,
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('A1B2-C3D4-E5F6-0718'), findsOneWidget);
      expect(
        find.text('Your vote code is verified in the final tally'),
        findsNothing,
      );

      api.decisionDetailResponse = <String, dynamic>{
        'resultsSuppressed': false,
        'participation': 4,
        'receiptDigests': const <String>['a1b2c3d4e5f60718'],
        'surveyResults': const [
          <String, dynamic>{
            'id': 'q1',
            'title': 'Priorities',
            'answered': 4,
            'average': 4.5,
            'results': <Map<String, dynamic>>[
              <String, dynamic>{'label': 'Choice A', 'votes': 3},
              <String, dynamic>{'label': 'Choice B', 'votes': 1},
            ],
            'texts': <String>['Synthetic text feedback'],
          },
        ],
      };

      final surveyPoll = Poll(
        id: 'survey-1',
        title: 'Closed Survey',
        type: 'survey',
        options: const [],
        tags: const [],
        endAt: '2020-01-01T00:00:00Z',
        hasVoted: true,
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            mobileApiClientProvider.overrideWithValue(api),
            shellSessionProvider.overrideWith(
              (ref) => _LiveConnectedShellNotifier(
                api,
                orgId: '11111111-1111-4111-8111-111111111111',
              ),
            ),
          ],
          child: legacy_provider.ChangeNotifierProvider<LocalizationService>.value(
            value: loc,
            child: MaterialApp(
              theme: ErtadTheme.lightTheme,
              home: Scaffold(
                body: SingleChildScrollView(
                  child: DecisionResultsCard(
                    key: const ValueKey('survey-1'),
                    poll: surveyPoll,
                    isClosed: true,
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.text('Your vote code is verified in the final tally'),
        findsOneWidget,
      );
      expect(find.text('Priorities'), findsOneWidget);
      expect(find.text('Responses: 4 · Average: 4.5'), findsOneWidget);
      expect(find.text('Choice A'), findsOneWidget);
      expect(find.text('75% (3)'), findsOneWidget);
      expect(find.text('• Synthetic text feedback'), findsOneWidget);
    },
  );

  test(
    'StorageService migrates legacy SharedPreferences PII to FlutterSecureStorage and stores new PII only in secure storage',
    () async {
      SharedPreferences.setMockInitialValues(<String, Object>{
        'first_name': 'Synthetic',
        'last_name': 'Member',
        'birth_date': '1990-01-02T00:00:00.000Z',
        'gender': 'F',
      });
      final storage = StorageService();
      expect(await storage.getFirstName(), 'Synthetic');
      expect(await storage.getLastName(), 'Member');
      expect(await storage.getBirthDate(), DateTime.utc(1990, 1, 2));
      expect(await storage.getGender(), 'F');

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('first_name'), isNull);
      expect(prefs.getString('last_name'), isNull);
      expect(prefs.getString('birth_date'), isNull);
      expect(prefs.getString('gender'), isNull);
      expect(secureMap['profile_first_name'], 'Synthetic');
      expect(secureMap['profile_last_name'], 'Member');

      await storage.saveName('Updated', 'User');
      expect(prefs.getString('first_name'), isNull);
      expect(secureMap['profile_first_name'], 'Updated');
      expect(secureMap['profile_last_name'], 'User');
    },
  );

  test(
    'ShellSessionNotifier syncOfflineQueue updates pendingOfflineActionsCount and signOut clears OfflineActionQueue',
    () async {
      final queue = OfflineActionQueue();
      await queue.enqueue(
        const OfflineQueuedAction(
          idempotencyKey: 'sync-key-1',
          kind: 'event_rsvp',
          organizationId: '11111111-1111-4111-8111-111111111111',
          payload: {'eventId': 'ev-1', 'action': 'rsvp'},
          createdAtIso: '2026-11-21T10:00:00Z',
        ),
      );
      final api = _FakeMobileApiClient();
      final notifier = ShellSessionNotifier(api);
      await notifier.refreshOfflineQueueCount();
      expect(notifier.state.pendingOfflineActionsCount, 1);

      final flushRes = await notifier.syncOfflineQueue();
      expect(flushRes.flushed, 1);
      expect(flushRes.remaining, 0);
      expect(notifier.state.pendingOfflineActionsCount, 0);

      await queue.enqueue(
        const OfflineQueuedAction(
          idempotencyKey: 'signout-key-1',
          kind: 'event_rsvp',
          organizationId: '11111111-1111-4111-8111-111111111111',
          payload: {'eventId': 'ev-2', 'action': 'cancel'},
          createdAtIso: '2026-11-21T10:05:00Z',
        ),
      );
      expect(await queue.count(), 1);
      await notifier.signOut();
      expect(await queue.count(), 0);
      expect(notifier.state.pendingOfflineActionsCount, 0);
    },
  );
}
