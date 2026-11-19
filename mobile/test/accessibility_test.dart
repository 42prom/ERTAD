import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:ertad_mobile/models/poll.dart';
import 'package:ertad_mobile/screens/voting/confirm_vote_screen.dart';
import 'package:ertad_mobile/screens/voting/survey_screen.dart';
import 'package:ertad_mobile/services/localization_service.dart';

final poll = Poll(
  id: 'synthetic-poll',
  title: 'Synthetic question',
  type: 'election',
  options: [PollOption(id: 'option-a', text: 'Option A', displayOrder: 0)],
  tags: [],
);

void main() {
  for (final language in AppLanguage.values) {
    for (final brightness in Brightness.values) {
      testWidgets('review is unavailable in $language/$brightness', (
        tester,
      ) async {
        SharedPreferences.setMockInitialValues({});
        final loc = LocalizationService();
        await loc.setLanguage(language);
        tester.view.physicalSize = const Size(360, 640);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final semantics = tester.ensureSemantics();
        try {
          await tester.pumpWidget(
            ChangeNotifierProvider.value(
              value: loc,
              child: MaterialApp(
                theme: ThemeData(brightness: brightness),
                builder: (context, child) => MediaQuery(
                  data: MediaQuery.of(
                    context,
                  ).copyWith(textScaler: TextScaler.linear(2)),
                  child: child!,
                ),
                home: ConfirmVoteScreen(
                  poll: poll,
                  selectedOption: poll.options.first,
                ),
              ),
            ),
          );
          expect(
            find.text(loc.translate('decision_unavailable_title')),
            findsOneWidget,
          );
          expect(find.text('Option A'), findsOneWidget);
          final button = find.byType(ElevatedButton);
          await tester.ensureVisible(button);
          expect(tester.widget<ElevatedButton>(button).onPressed, isNull);
          await tester.tap(button, warnIfMissed: false);
          await tester.pump();
          expect(find.byType(ConfirmVoteScreen), findsOneWidget);
          expect(tester.takeException(), isNull);
          final prefs = await SharedPreferences.getInstance();
          expect(
            prefs.getKeys().where((k) => k.startsWith('activity_items')),
            isEmpty,
          );
          expect(
            tester.getSemantics(button),
            matchesSemantics(
              label: loc.translate('confirm_vote'),
              isButton: true,
              hasEnabledState: true,
            ),
          );
        } finally {
          semantics.dispose();
        }
      });
    }
  }
  testWidgets(
    'survey questions remain reviewable but answers cannot be submitted',
    (tester) async {
      SharedPreferences.setMockInitialValues({});
      final loc = LocalizationService();
      final survey = Poll.fromJson({
        'id': 'synthetic-survey',
        'title': 'Survey preview',
        'type': 'survey',
        'options': [],
        'questions': [
          {
            'id': 'q1',
            'questionText': 'First question',
            'questionType': 'single_choice',
            'required': true,
            'displayOrder': 0,
            'config': {},
            'options': [
              {'id': 'a', 'optionText': 'Answer A', 'displayOrder': 0},
            ],
          },
          {
            'id': 'q2',
            'questionText': 'Second question',
            'questionType': 'text',
            'required': false,
            'displayOrder': 1,
            'config': {},
            'options': [],
          },
        ],
      });
      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: loc,
          child: MaterialApp(home: SurveyScreen(poll: survey)),
        ),
      );
      expect(
        find.text(loc.translate('decision_unavailable_title')),
        findsOneWidget,
      );
      await tester.tap(find.text('Answer A'));
      await tester.pump();
      await tester.tap(find.text(loc.translate('next')));
      await tester.pump();
      expect(find.text('Second question'), findsOneWidget);
      expect(
        tester.widget<ElevatedButton>(find.byType(ElevatedButton)).onPressed,
        isNull,
      );
      expect(tester.takeException(), isNull);
      expect((await SharedPreferences.getInstance()).getKeys(), isEmpty);
    },
  );
}
