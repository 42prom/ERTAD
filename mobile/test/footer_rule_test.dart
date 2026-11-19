import 'package:ertad_mobile/core/shell/adaptive_header.dart';
import 'package:ertad_mobile/core/shell/floating_bottom_dock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ertad_mobile/screens/enrollment/intro_screen.dart';
import 'package:ertad_mobile/screens/enrollment/liveness_screen.dart';
import 'package:ertad_mobile/screens/dashboard/dashboard_screen.dart';
import 'package:ertad_mobile/widgets/bottom_nav.dart';
import 'package:ertad_mobile/models/verification_models.dart';
import 'package:ertad_mobile/services/localization_service.dart';
import 'package:ertad_mobile/services/service_locator.dart';
import 'package:ertad_mobile/services/interfaces/i_api_service.dart';
import 'package:ertad_mobile/models/poll.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

class FakeApiService implements IApiService {
  @override
  Future<List<Poll>> getPolls() async => [];
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  setUpAll(() {
    ServiceLocator.mockApiService = FakeApiService();
  });

  final mockPolicy = VerificationPolicy(
    nfc: NfcPolicy(
      provider: 'mock',
      requireNfc: true,
      requireGeorgianCitizen: true,
      requirePersonalNumber: true,
      allowSkipDocumentWhenNfcHasPortrait: true,
    ),
    documentScanner: DocumentScannerPolicy(
      provider: 'manual',
      requireDocumentPhotoScan: true,
      strictness: 'strict',
    ),
    liveness: LivenessPolicy(
      provider: 'mock',
      minThreshold: 0.7,
      retryLimit: 3,
    ),
    faceMatch: FaceMatchPolicy(provider: 'mock', minThreshold: 0.75),
    allowMocks: true,
  );

  Widget createTestWidget(Widget child) {
    return ChangeNotifierProvider(
      create: (_) => LocalizationService(),
      child: MaterialApp(home: Scaffold(body: child)),
    );
  }

  group('Footer Rule Tests', () {
    testWidgets('Step 1 (Intro) has NO footer', (WidgetTester tester) async {
      await tester.pumpWidget(createTestWidget(const IntroScreen()));
      expect(find.byType(BottomNav), findsNothing);
    });

    testWidgets('Step 2 (Liveness) has NO footer', (WidgetTester tester) async {
      await tester.pumpWidget(
        createTestWidget(
          LivenessScreen(
            policy: mockPolicy,
            enrollmentSessionId: 'test-session',
            docPortraitBase64: 'test-portrait',
          ),
        ),
      );
      expect(find.byType(BottomNav), findsNothing);
    });

    testWidgets('Dashboard HAS header and 5-tab footer', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(createTestWidget(const DashboardScreen()));
      await tester.pumpAndSettle();
      expect(find.byType(AdaptiveHeader), findsOneWidget);
      expect(find.byType(BottomNav), findsOneWidget);
      expect(find.byType(FloatingBottomDock), findsOneWidget);
    });

    testWidgets(
      'V1 navigation offers 5 icons-only tabs (Status, Messages, Home, Tasks, Polls) with no Wallet/XP',
      (WidgetTester tester) async {
        await tester.pumpWidget(
          createTestWidget(BottomNav(currentIndex: 2, onTap: (_) {})),
        );
        expect(find.text('Wallet'), findsNothing);
        expect(find.text('XP'), findsNothing);
        expect(find.text('Leaderboard'), findsNothing);
        // Icons-only rule: zero visible text labels inside footer dock
        expect(find.text('Status'), findsNothing);
        expect(find.text('Messages'), findsNothing);
        expect(find.text('Home'), findsNothing);
        expect(find.text('Tasks'), findsNothing);
        expect(find.text('Polls'), findsNothing);
        for (var i = 0; i < 5; i++) {
          expect(find.byKey(Key('dock_tab_$i')), findsOneWidget);
        }
        expect(find.bySemanticsLabel('Status'), findsOneWidget);
        expect(find.bySemanticsLabel('Messages'), findsOneWidget);
        expect(find.bySemanticsLabel('Home'), findsOneWidget);
        expect(find.bySemanticsLabel('Tasks'), findsOneWidget);
        expect(find.bySemanticsLabel('Polls'), findsOneWidget);
      },
    );

    testWidgets('Footer defaults to center Home tab (index 2)', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(createTestWidget(const DashboardScreen()));
      await tester.pumpAndSettle();
      final bottomNav = tester.widget<BottomNav>(find.byType(BottomNav));
      expect(bottomNav.currentIndex, 2);
    });

    testWidgets('Footer tab switching works', (WidgetTester tester) async {
      int selectedIndex = 2;
      await tester.pumpWidget(
        ChangeNotifierProvider(
          create: (_) => LocalizationService(),
          child: MaterialApp(
            home: Scaffold(
              bottomNavigationBar: BottomNav(
                currentIndex: selectedIndex,
                onTap: (index) => selectedIndex = index,
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.byKey(const Key('dock_tab_0')));
      expect(selectedIndex, 0);
      await tester.tap(find.byKey(const Key('dock_tab_4')));
      expect(selectedIndex, 4);
    });

    testWidgets('Dashboard defaults to Home operational hub', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(createTestWidget(const DashboardScreen()));
      await tester.pumpAndSettle();
      expect(find.byType(FloatingBottomDock), findsOneWidget);
      expect(find.byIcon(Icons.home_rounded), findsOneWidget);
      expect(find.byIcon(Icons.how_to_vote_outlined), findsAtLeastNWidgets(1));
    });
  });
}
