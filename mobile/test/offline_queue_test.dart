import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:ertad_mobile/core/state/offline_action_queue.dart';

void main() {
  test('OfflineActionQueue enqueues idempotently and bounds size', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final queue = OfflineActionQueue();

    final a1 = OfflineQueuedAction(
      idempotencyKey: 'key-1',
      kind: 'channel_post',
      organizationId: 'org-1',
      payload: const {'channelId': 'ch-1', 'body': 'Hello offline'},
      createdAtIso: '2026-11-19T10:00:00Z',
    );
    expect(await queue.enqueue(a1), 1);
    // Duplicate idempotency key is deduplicated.
    expect(await queue.enqueue(a1), 1);

    final a2 = OfflineQueuedAction(
      idempotencyKey: 'key-2',
      kind: 'event_rsvp',
      organizationId: 'org-1',
      payload: const {'eventId': 'ev-1', 'action': 'rsvp'},
      createdAtIso: '2026-11-19T10:01:00Z',
    );
    expect(await queue.enqueue(a2), 2);

    final stored = await queue.list();
    expect(stored.length, 2);
    expect(stored.first.kind, 'channel_post');
    expect(stored.last.kind, 'event_rsvp');

    await queue.clear();
    expect(await queue.list(), isEmpty);
  });
}
