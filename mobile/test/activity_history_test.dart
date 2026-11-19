import 'dart:convert';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:ertad_mobile/models/activity_item.dart';
import 'package:ertad_mobile/services/storage_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('restoring participation history drops retired payout data', () {
    final item = ActivityItem.fromJson({
      'pollId': 'synthetic-poll',
      'title': 'Synthetic participation',
      'type': 'survey',
      'votedAt': '2030-01-01T12:00:00Z',
      'status': 'ENDED',
      'rewardAmount': '5',
      'rewardToken': 'retired-token',
      'reward': {'amount': '5', 'token': 'retired-token'},
      'votedOptionId': 'synthetic-option',
      'votedOptionText': 'Sensitive cached choice',
      'receipt': {
        'payload': {'voteId': 'synthetic-vote-id'},
      },
    });

    final restored = ActivityItem.listFromJsonString(
      ActivityItem.listToJsonString([item]),
    ).single;
    expect(restored.pollId, 'synthetic-poll');
    expect(restored.title, 'Synthetic participation');
    expect(restored.hasEnded, isTrue);
    expect(restored.votedAt, DateTime.utc(2030, 1, 1, 12));
    final stored = restored.toJson();
    for (final key in [
      'rewardAmount',
      'rewardToken',
      'reward',
      'votedOptionId',
      'votedOptionText',
      'receipt',
    ]) {
      expect(stored.containsKey(key), isFalse);
    }
  });

  test(
    'startup sanitizes every account cache, erases malformed data and is repeatable',
    () async {
      const channel = MethodChannel(
        'plugins.it_nomads.com/flutter_secure_storage',
      );
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(channel, (_) async => null);
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      final cached = jsonEncode([
        {
          'pollId': 'synthetic-poll',
          'title': 'Participation',
          'type': 'election',
          'votedAt': '2030-01-01T00:00:00Z',
          'votedOptionText': 'sensitive-choice',
          'receipt': {'voteId': 'sensitive-receipt'},
          'unknownAnswer': 'sensitive-answer',
        },
      ]);
      SharedPreferences.setMockInitialValues({
        'activity_items_account_a': cached,
        'activity_items_account_b': cached,
        'activity_items': cached,
        'activity_items_broken': '{invalid',
        'activity_items_wrong_type': 123,
        'app_language': 'ka',
      });
      final storage = StorageService();
      await storage.purgeLegacyVotingSecrets();
      final prefs = await SharedPreferences.getInstance();
      for (final key in [
        'activity_items_account_a',
        'activity_items_account_b',
        'activity_items',
      ]) {
        final sanitized = prefs.getString(key)!;
        expect(sanitized, isNot(contains('sensitive-')));
        expect(
          ActivityItem.listFromJsonString(sanitized).single.pollId,
          'synthetic-poll',
        );
      }
      expect(prefs.containsKey('activity_items_broken'), isFalse);
      expect(prefs.containsKey('activity_items_wrong_type'), isFalse);
      expect(prefs.getString('app_language'), 'ka');
      final first = prefs.getString('activity_items_account_a');
      await storage.purgeLegacyVotingSecrets();
      expect(prefs.getString('activity_items_account_a'), first);
    },
  );
}
