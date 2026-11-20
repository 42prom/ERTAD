import 'package:ertad_mobile/core/router/app_router.dart';
import 'package:ertad_mobile/core/shell/account_privacy_sheet.dart';
import 'package:ertad_mobile/core/shell/adaptive_header.dart';
import 'package:ertad_mobile/core/shell/floating_bottom_dock.dart';
import 'package:ertad_mobile/core/shell/inbox_sheet.dart';
import 'package:ertad_mobile/core/state/shell_providers.dart';
import 'package:ertad_mobile/core/theme/ertad_theme.dart';
import 'package:ertad_mobile/core/widgets/ertad_ui.dart';
import 'package:ertad_mobile/features/home/presentation/home_tab_screen.dart';
import 'package:ertad_mobile/features/messages/presentation/messages_tab_screen.dart';
import 'package:ertad_mobile/features/polls/presentation/polls_tab_screen.dart';
import 'package:ertad_mobile/features/status/presentation/status_tab_screen.dart';
import 'package:ertad_mobile/features/tasks/presentation/tasks_tab_screen.dart';
import 'package:ertad_mobile/models/poll.dart';
import 'package:ertad_mobile/screens/settings/help_screen.dart';
import 'package:ertad_mobile/screens/voting/referendum_screen.dart';
import 'package:ertad_mobile/screens/voting/survey_screen.dart';
import 'package:ertad_mobile/services/interfaces/i_api_service.dart';
import 'package:ertad_mobile/services/localization_service.dart';
import 'package:ertad_mobile/services/service_locator.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart' as legacy_provider;
import 'package:shared_preferences/shared_preferences.dart';

class _ShellFakeApi implements IApiService {
  @override
  Future<List<Poll>> getPolls() async => <Poll>[];

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  setUpAll(() {
    ServiceLocator.mockApiService = _ShellFakeApi();
  });

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  Future<void> pumpShell(
    WidgetTester tester, {
    required Size size,
    required EdgeInsets safePadding,
    required Brightness brightness,
    required AppLanguage language,
    double textScale = 1.0,
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final loc = LocalizationService();
    await loc.setLanguage(language);
    final router = createErtadRouter();
    addTearDown(router.dispose);

    await tester.pumpWidget(
      ProviderScope(
        child:
            legacy_provider.ChangeNotifierProvider<LocalizationService>.value(
              value: loc,
              child: Consumer(
                builder: (context, ref, _) {
                  final themeMode = ref.watch(themeModeProvider);
                  return MaterialApp.router(
                    theme: ErtadTheme.lightTheme,
                    darkTheme: ErtadTheme.darkTheme,
                    themeMode: brightness == Brightness.dark
                        ? ThemeMode.dark
                        : themeMode == ThemeMode.system
                        ? ThemeMode.light
                        : themeMode,
                    locale: loc.locale,
                    routerConfig: router,
                    builder: (context, child) {
                      final mq = MediaQuery.of(context);
                      return MediaQuery(
                        data: mq.copyWith(
                          padding: safePadding,
                          viewPadding: safePadding,
                          textScaler: TextScaler.linear(textScale),
                        ),
                        child: child!,
                      );
                    },
                  );
                },
              ),
            ),
      ),
    );
    await tester.pumpAndSettle();
  }

  group('Wave M1 Universal Adaptive Shell Gates', () {
    final matrix = <({String name, Size size, EdgeInsets padding})>[
      (
        name: 'Android compact 360px',
        size: const Size(360, 740),
        padding: const EdgeInsets.only(top: 32, bottom: 24),
      ),
      (
        name: 'iPhone Dynamic Island 390px',
        size: const Size(390, 844),
        padding: const EdgeInsets.only(top: 59, bottom: 34),
      ),
      (
        name: 'Tablet 800dp',
        size: const Size(800, 1200),
        padding: const EdgeInsets.only(top: 24, bottom: 20),
      ),
    ];

    for (final vp in matrix) {
      for (final lang in AppLanguage.values) {
        for (final brightness in Brightness.values) {
          testWidgets(
            '${vp.name} / ${lang.code} / $brightness / 2x text has zero overflow and >=48dp targets',
            (tester) async {
              await pumpShell(
                tester,
                size: vp.size,
                safePadding: vp.padding,
                brightness: brightness,
                language: lang,
                textScale: 2.0,
              );

              expect(find.byType(AdaptiveHeader), findsOneWidget);
              expect(find.byType(FloatingBottomDock), findsOneWidget);

              // Verify dock stays comfortably inside bottom SafeArea margin
              final dockRect = tester.getRect(find.byType(FloatingBottomDock));
              expect(dockRect.bottom, lessThanOrEqualTo(vp.size.height));
              expect(dockRect.height, greaterThanOrEqualTo(48));

              // Verify no layout overflow exceptions under 2x text scaling
              expect(tester.takeException(), isNull);
            },
          );
        }
      }
    }

    testWidgets(
      'All 5 GoRouter icons-only tabs switch cleanly and AccountPrivacySheet toggles Privacy cleanly for Member',
      (tester) async {
        await pumpShell(
          tester,
          size: const Size(412, 915),
          safePadding: const EdgeInsets.only(top: 32, bottom: 24),
          brightness: Brightness.light,
          language: AppLanguage.georgian,
        );

        // Starts at center Home tab
        expect(find.text('კონტრიბუციის ქულები (ხილულ სკოპში)'), findsNothing);

        // Switch via icons-only dock keys: Status -> Messages -> Tasks -> Polls -> Home
        await tester.tap(find.byKey(const Key('dock_tab_0')));
        await tester.pumpAndSettle();
        expect(find.text('კონტრიბუციის ქულები (ხილულ სკოპში)'), findsOneWidget);

        await tester.tap(find.byKey(const Key('dock_tab_1')));
        await tester.pumpAndSettle();
        expect(find.text('სისტემური'), findsOneWidget);
        expect(find.text('არხები'), findsOneWidget);
        expect(find.text('პირადი'), findsOneWidget);

        await tester.tap(find.byKey(const Key('dock_tab_3')));
        await tester.pumpAndSettle();
        expect(find.text('ახალი'), findsAtLeastNWidgets(1));
        expect(find.text('მიმდინარე'), findsAtLeastNWidgets(1));
        expect(find.text('დასრულებული'), findsAtLeastNWidgets(1));

        await tester.tap(find.byKey(const Key('dock_tab_4')));
        await tester.pumpAndSettle();
        expect(find.text('ახალი'), findsAtLeastNWidgets(1));
        expect(find.text('მიმდინარე'), findsAtLeastNWidgets(1));
        expect(find.text('დასრულებული'), findsAtLeastNWidgets(1));

        await tester.tap(find.byKey(const Key('dock_tab_2')));
        await tester.pumpAndSettle();

        // Open Header Account & Privacy sheet
        await tester.tap(
          find.descendant(
            of: find.byType(AdaptiveHeader),
            matching: find.byIcon(Icons.tune_rounded),
          ),
        );
        await tester.pumpAndSettle();

        final sheet = find.byType(AccountPrivacySheet);
        expect(sheet, findsOneWidget);
        expect(
          find.descendant(
            of: sheet,
            matching: find.text('ანგარიში და ანონიმურობა'),
          ),
          findsOneWidget,
        );

        // Select Public (shared-context opt-in) privacy
        final optInTile = find.descendant(
          of: sheet,
          matching: find.text('საჯარო'),
        );
        await tester.ensureVisible(optInTile);
        await tester.pumpAndSettle();
        await tester.tap(optInTile);
        await tester.pumpAndSettle();

        // Confirm privacy change in the confirmation AlertDialog
        expect(find.byType(AlertDialog), findsOneWidget);
        await tester.tap(find.text('დადასტურება'));
        await tester.pumpAndSettle();

        // Close sheet via unified X button and confirm Member Privacy updates cleanly
        await tester.tap(
          find.descendant(
            of: sheet,
            matching: find.byIcon(Icons.close_rounded),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('MGR'), findsNothing);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'SurveyScreen exit dialog pops dialog and SurveyScreen without popping GoRouter stack',
      (tester) async {
        await pumpShell(
          tester,
          size: const Size(390, 844),
          safePadding: const EdgeInsets.only(top: 24, bottom: 24),
          brightness: Brightness.dark,
          language: AppLanguage.english,
        );

        final survey = Poll(
          id: 'survey-exit-test',
          title: 'Exit Test Survey',
          type: 'survey',
          options: const <PollOption>[],
          tags: const <String>[],
          questions: <SurveyQuestion>[
            SurveyQuestion(
              id: 'q1',
              questionText: 'Sample question?',
              questionType: 'single_choice',
              required: true,
              displayOrder: 1,
              config: const <String, dynamic>{},
              options: <QuestionOption>[
                QuestionOption(id: 'o1', optionText: 'Yes', displayOrder: 1),
              ],
            ),
          ],
        );

        final shellContext = tester.element(find.byType(AdaptiveHeader));
        Navigator.of(shellContext).push(
          MaterialPageRoute<void>(builder: (_) => SurveyScreen(poll: survey)),
        );
        await tester.pumpAndSettle();

        expect(find.byType(SurveyScreen), findsOneWidget);

        await tester.tap(find.byIcon(Icons.close_rounded));
        await tester.pumpAndSettle();

        expect(find.byType(AlertDialog), findsOneWidget);
        await tester.tap(find.byType(FilledButton).last);
        await tester.pumpAndSettle();

        expect(find.byType(SurveyScreen), findsNothing);
        expect(find.byType(AdaptiveHeader), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'Shell survives Android zero-size initial frame before resizing to 390x844',
      (tester) async {
        await pumpShell(
          tester,
          size: Size.zero,
          safePadding: EdgeInsets.zero,
          brightness: Brightness.dark,
          language: AppLanguage.georgian,
        );
        expect(tester.takeException(), isNull);

        tester.view.physicalSize = const Size(390, 844);
        await tester.pumpAndSettle();
        expect(find.byType(AdaptiveHeader), findsOneWidget);
        expect(find.byType(FloatingBottomDock), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'Messages (#62), Tasks (#64), and Polls (#65) category bars switch cleanly at 360px 2x scale',
      (tester) async {
        await pumpShell(
          tester,
          size: const Size(360, 740),
          safePadding: const EdgeInsets.only(top: 24, bottom: 20),
          brightness: Brightness.light,
          language: AppLanguage.georgian,
          textScale: 2.0,
        );

        // Messages tab: System | Channels | Private
        await tester.tap(find.byKey(const Key('dock_tab_1')));
        await tester.pumpAndSettle();
        for (final cat in ['სისტემური', 'არხები', 'პირადი']) {
          expect(find.text(cat), findsOneWidget);
          await tester.tap(find.text(cat));
          await tester.pumpAndSettle();
        }

        // Tasks tab (#64): New | In progress | Completed
        await tester.tap(find.byKey(const Key('dock_tab_3')));
        await tester.pumpAndSettle();
        final tasksBar = find.descendant(
          of: find.byType(TasksTabScreen),
          matching: find.byType(ErtadCategoryBar),
        );
        for (final cat in ['ახალი', 'მიმდინარე', 'დასრულებული']) {
          final target = find.descendant(
            of: tasksBar,
            matching: find.text(cat),
          );
          expect(target, findsOneWidget);
          await tester.ensureVisible(target);
          await tester.pumpAndSettle();
          await tester.tap(target);
          await tester.pumpAndSettle();
        }

        // Polls tab (#65): New | In progress | Completed
        await tester.tap(find.byKey(const Key('dock_tab_4')));
        await tester.pumpAndSettle();
        final pollsBar = find.descendant(
          of: find.byType(PollsTabScreen),
          matching: find.byType(ErtadCategoryBar),
        );
        expect(
          find.descendant(of: pollsBar, matching: find.text('ახალი')),
          findsOneWidget,
        );
        final historyPill = find.descendant(
          of: pollsBar,
          matching: find.text('დასრულებული'),
        );
        expect(historyPill, findsOneWidget);
        await tester.ensureVisible(historyPill);
        await tester.pumpAndSettle();
        await tester.tap(historyPill);
        await tester.pumpAndSettle();

        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'ReferendumScreen bottomBar stays docked below body options and read-only closes cleanly',
      (tester) async {
        await pumpShell(
          tester,
          size: const Size(390, 844),
          safePadding: const EdgeInsets.only(top: 24, bottom: 20),
          brightness: Brightness.dark,
          language: AppLanguage.english,
        );

        final activeRef = Poll(
          id: 'ref-open',
          title: 'Neighborhood Coordinator Rotation',
          type: 'referendum',
          tags: const [],
          options: [
            PollOption(id: '0', text: 'Support', displayOrder: 0),
            PollOption(id: '1', text: 'Oppose', displayOrder: 1),
            PollOption(id: '2', text: 'Abstain', displayOrder: 2),
          ],
          endAt: DateTime.now()
              .toUtc()
              .add(const Duration(days: 2))
              .toIso8601String(),
          referendumThreshold: 60.0,
        );

        final shellContext = tester.element(find.byType(AdaptiveHeader));
        Navigator.of(shellContext, rootNavigator: true).push(
          MaterialPageRoute<void>(
            builder: (_) => ReferendumScreen(poll: activeRef),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('Neighborhood Coordinator Rotation'), findsOneWidget);
        expect(find.text('Support'), findsOneWidget);
        expect(find.text('Oppose'), findsOneWidget);

        // Regression check: bottomBar must NOT expand over the body to top of screen.
        final titleRect = tester.getRect(
          find.text('Neighborhood Coordinator Rotation'),
        );
        final supportRect = tester.getRect(find.text('Support'));
        final reviewBtnRect = tester.getRect(find.text('Review Vote'));
        expect(reviewBtnRect.top, greaterThan(supportRect.bottom));
        expect(reviewBtnRect.top, greaterThan(titleRect.bottom));

        // Return cleanly to shell
        await tester.tap(find.byTooltip('Back'));
        await tester.pumpAndSettle();
        expect(find.byType(ReferendumScreen), findsNothing);

        // Read-only (voted/closed) referendum displays Close button and exits cleanly
        final votedRef = Poll(
          id: 'ref-voted',
          title: 'Closed Charter Vote',
          type: 'referendum',
          tags: const [],
          hasVoted: true,
          options: [PollOption(id: '0', text: 'Support', displayOrder: 0)],
        );
        Navigator.of(shellContext, rootNavigator: true).push(
          MaterialPageRoute<void>(
            builder: (_) => ReferendumScreen(poll: votedRef),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Participated'), findsOneWidget);
        expect(find.text('Close'), findsOneWidget);
        await tester.tap(find.text('Close'));
        await tester.pumpAndSettle();
        expect(find.byType(ReferendumScreen), findsNothing);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'AccountPrivacySheet -> HelpScreen -> Ask in group chat routes cleanly to Messages',
      (tester) async {
        await pumpShell(
          tester,
          size: const Size(390, 844),
          safePadding: const EdgeInsets.only(top: 24, bottom: 20),
          brightness: Brightness.light,
          language: AppLanguage.english,
        );

        await tester.tap(find.byTooltip('Account & Privacy'));
        await tester.pumpAndSettle();

        final sheetScrollable = find.descendant(
          of: find.byType(AccountPrivacySheet),
          matching: find.byType(Scrollable),
        );
        await tester.scrollUntilVisible(
          find.text('Help & Support'),
          200,
          scrollable: sheetScrollable,
        );
        await tester.pumpAndSettle();

        expect(find.text('Help & Support'), findsOneWidget);
        await tester.tap(find.text('Help & Support'));
        await tester.pumpAndSettle();

        expect(find.byType(HelpScreen), findsOneWidget);
        expect(find.text('Ask in group chat'), findsOneWidget);

        await tester.tap(find.text('Ask in group chat'));
        await tester.pumpAndSettle();

        expect(find.byType(HelpScreen), findsNothing);
        expect(find.byType(MessagesTabScreen), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'InboxEntryCard navigates cleanly to Status for membership notices without dead-ending',
      (tester) async {
        await pumpShell(
          tester,
          size: const Size(390, 844),
          safePadding: const EdgeInsets.only(top: 24, bottom: 20),
          brightness: Brightness.light,
          language: AppLanguage.english,
        );

        final shellCtx = tester.element(find.byType(AdaptiveHeader));
        showModalBottomSheet<void>(
          context: shellCtx,
          useRootNavigator: true,
          builder: (_) => Material(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: const InboxEntryCard(
                closeModalOnTap: true,
                item: <String, dynamic>{
                  'id': 'notice-1',
                  'source': 'contribution',
                  'version': 1,
                  'title': 'Verified participation recorded',
                  'unitName': 'Saburtalo Group',
                  'status': 'open',
                  'unread': false,
                },
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(find.text('Verified participation recorded'));
        await tester.pumpAndSettle();

        expect(find.byType(StatusTabScreen), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'AdaptiveHeader exposes distinct Organization & Group and Account & Privacy actions',
      (tester) async {
        await pumpShell(
          tester,
          size: const Size(390, 844),
          safePadding: const EdgeInsets.only(top: 24, bottom: 20),
          brightness: Brightness.light,
          language: AppLanguage.english,
        );

        final headerOrgBtn = find.descendant(
          of: find.byType(AdaptiveHeader),
          matching: find.byIcon(Icons.person_rounded),
        );
        expect(headerOrgBtn, findsOneWidget);
        expect(find.byTooltip('Account & Privacy'), findsOneWidget);
        expect(
          find.descendant(
            of: find.byType(AdaptiveHeader),
            matching: find.byIcon(Icons.tune_rounded),
          ),
          findsOneWidget,
        );

        await tester.tap(headerOrgBtn);
        await tester.pumpAndSettle();

        expect(find.text('Phone Number'), findsOneWidget);
        expect(find.byIcon(Icons.phone_outlined), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'StatusTabScreen involvement tiles navigate with deep-link segment requests',
      (tester) async {
        final loc = LocalizationService();
        await loc.setLanguage(AppLanguage.english);
        final switchedTabs = <int>[];

        await tester.pumpWidget(
          ProviderScope(
            child:
                legacy_provider.ChangeNotifierProvider<
                  LocalizationService
                >.value(
                  value: loc,
                  child: MaterialApp(
                    theme: ErtadTheme.lightTheme,
                    home: Scaffold(
                      body: StatusTabScreen(onSwitchTab: switchedTabs.add),
                    ),
                  ),
                ),
          ),
        );
        await tester.pumpAndSettle();

        final mineFinder = find.text('In progress');
        await tester.scrollUntilVisible(
          mineFinder,
          150,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.ensureVisible(mineFinder);
        await tester.pumpAndSettle();
        await tester.tap(mineFinder);
        await tester.pumpAndSettle();

        expect(switchedTabs, equals(<int>[3]));
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'GroupManager persona unlocks Group management card and Tasks Review tab',
      (tester) async {
        final loc = LocalizationService();
        await loc.setLanguage(AppLanguage.english);
        final container = ProviderContainer();
        addTearDown(container.dispose);
        await container
            .read(shellSessionProvider.notifier)
            .setDevPersona(DevPersona.groupManager);

        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child:
                legacy_provider.ChangeNotifierProvider<
                  LocalizationService
                >.value(
                  value: loc,
                  child: MaterialApp(
                    theme: ErtadTheme.lightTheme,
                    home: const Scaffold(body: HomeTabScreen()),
                  ),
                ),
          ),
        );
        await tester.pumpAndSettle();

        final mgrTitle = find.text('Group management');
        await tester.scrollUntilVisible(
          mgrTitle,
          150,
          scrollable: find.byType(Scrollable).first,
        );
        expect(mgrTitle, findsOneWidget);
        expect(find.text('Membership reviews'), findsOneWidget);
        expect(find.text('Task verification'), findsOneWidget);

        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child:
                legacy_provider.ChangeNotifierProvider<
                  LocalizationService
                >.value(
                  value: loc,
                  child: const MaterialApp(
                    home: Scaffold(body: TasksTabScreen()),
                  ),
                ),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('Review'), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );
  });
}
