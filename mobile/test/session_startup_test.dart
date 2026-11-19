import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:ertad_mobile/main.dart';
import 'package:ertad_mobile/models/poll.dart';
import 'package:ertad_mobile/screens/dashboard/dashboard_screen.dart';
import 'package:ertad_mobile/screens/enrollment/intro_screen.dart';
import 'package:ertad_mobile/services/api_request_exception.dart';
import 'package:ertad_mobile/services/interfaces/i_api_service.dart';
import 'package:ertad_mobile/services/localization_service.dart';
import 'package:ertad_mobile/services/service_locator.dart';

class ProbeApi implements IApiService {
  Future<List<Poll>> Function() response = () async => [];
  int calls = 0;
  String? credential;
  @override
  void setCredential(String value) => credential = value;
  @override
  Future<List<Poll>> getPolls() {
    calls++;
    return response();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  final secure = <String, String>{};
  late ProbeApi api;
  bool storageUnavailable = false;

  setUp(() {
    storageUnavailable = false;
    secure
      ..clear()
      ..['credential'] = 'synthetic-credential';
    SharedPreferences.setMockInitialValues({'is_enrolled': true});
    api = ProbeApi();
    ServiceLocator.mockApiService = api;
    messenger.setMockMethodCallHandler(channel, (call) async {
      if (storageUnavailable) throw PlatformException(code: 'UNAVAILABLE');
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
    ServiceLocator.reset();
    messenger.setMockMethodCallHandler(channel, null);
  });

  Future<void> start(
    WidgetTester tester, {
    bool dark = false,
    bool georgian = false,
    bool narrow = false,
  }) async {
    final localization = LocalizationService();
    if (georgian) await localization.setLanguage(AppLanguage.georgian);
    if (narrow) {
      tester.view.physicalSize = const Size(360, 740);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
    }
    await tester.pumpWidget(
      ChangeNotifierProvider.value(
        value: localization,
        child: MaterialApp(
          theme: dark ? ThemeData.dark() : ThemeData.light(),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: TextScaler.linear(narrow ? 2 : 1)),
            child: child!,
          ),
          home: const SplashScreen(),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
  }

  final failures = <String, Object>{
    'offline': TimeoutException('synthetic timeout'),
    'forbidden': const ApiRequestException(403),
    'server failure': const ApiRequestException(500),
    'throttled': const ApiRequestException(429),
    'malformed response': const FormatException('synthetic'),
    'misleading error text': Exception('401 unauthorized expired'),
  };
  for (final entry in failures.entries) {
    testWidgets('${entry.key} blocks navigation and retains credentials', (
      tester,
    ) async {
      api.response = () async => throw entry.value;
      await start(tester);
      expect(find.byType(DashboardScreen), findsNothing);
      expect(find.byType(IntroScreen), findsNothing);
      expect(find.text('Retry'), findsOneWidget);
      expect(secure['credential'], 'synthetic-credential');
      expect(
        (await SharedPreferences.getInstance()).getBool('is_enrolled'),
        true,
      );
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
    'authoritative 401 clears the invalid session and opens enrollment',
    (tester) async {
      api.response = () async => throw const ApiRequestException(401);
      await start(tester);
      await tester.pumpAndSettle();
      expect(find.byType(IntroScreen), findsOneWidget);
      expect(find.byType(DashboardScreen), findsNothing);
      expect(secure, isEmpty);
      expect(
        (await SharedPreferences.getInstance()).getBool('is_enrolled'),
        isNull,
      );
    },
  );

  testWidgets(
    'secure storage failure blocks startup without making a request',
    (tester) async {
      storageUnavailable = true;
      await start(tester);
      expect(api.calls, 0);
      expect(find.text('Retry'), findsOneWidget);
      expect(secure['credential'], 'synthetic-credential');
    },
  );

  testWidgets(
    'retry waits for confirmation, suppresses duplicate requests and then navigates',
    (tester) async {
      api.response = () async => throw const ApiRequestException(503);
      await start(tester);
      final response = Completer<List<Poll>>();
      api.response = () => response.future;
      final onPressed = tester
          .widget<FilledButton>(find.byType(FilledButton))
          .onPressed!;
      onPressed();
      onPressed();
      await tester.pump();
      expect(api.calls, 2);
      expect(find.byType(DashboardScreen), findsNothing);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      api.response = () async => []; // Dashboard's own retained fetch.
      response.complete([]);
      await tester.pumpAndSettle();
      expect(find.byType(DashboardScreen), findsOneWidget);
      expect(api.credential, 'synthetic-credential');
      expect(secure['credential'], 'synthetic-credential');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'disposing while a request is pending does not navigate or erase storage',
    (tester) async {
      final response = Completer<List<Poll>>();
      api.response = () => response.future;
      await start(tester);
      await tester.pumpWidget(const MaterialApp(home: Text('Replacement')));
      response.completeError(const ApiRequestException(401));
      await tester.pumpAndSettle();
      expect(find.text('Replacement'), findsOneWidget);
      expect(secure['credential'], 'synthetic-credential');
      expect(tester.takeException(), isNull);
    },
  );

  for (final dark in [false, true]) {
    for (final georgian in [false, true]) {
      testWidgets('retry is readable at 360px / 2x text dark=$dark ka=$georgian', (
        tester,
      ) async {
        api.response = () async => throw const ApiRequestException(503);
        await start(tester, dark: dark, georgian: georgian, narrow: true);
        await tester.pumpAndSettle();
        final label = georgian ? 'თავიდან ცდა' : 'Retry';
        await tester.ensureVisible(find.text(label));
        expect(find.text(label).hitTestable(), findsOneWidget);
        expect(
          find.text(
            georgian
                ? 'სესიის შემოწმება ვერ მოხერხდა. შეამოწმეთ კავშირი და სცადეთ ხელახლა.'
                : 'Your session could not be verified. Check your connection and try again.',
          ),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      });
    }
  }
}
