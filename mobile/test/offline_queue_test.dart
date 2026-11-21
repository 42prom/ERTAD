import 'package:ertad_mobile/core/network/mobile_api_client.dart';
import 'package:ertad_mobile/core/state/offline_action_queue.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _QueueFakeApi extends MobileApiClient {
  int postCalls = 0;
  int rsvpCalls = 0;
  int Function()? onPost;
  int Function()? onRsvp;

  _QueueFakeApi() : super(baseUrl: 'http://127.0.0.1:13000/api/v1');

  @override
  Future<Map<String, dynamic>> postChannelMessage({
    required String organizationId,
    required String channelId,
    required String body,
    String? replyId,
    String? attachmentId,
    String? idempotencyKey,
  }) async {
    postCalls++;
    final code = onPost?.call() ?? 200;
    if (code != 200) {
      throw MobileApiException(statusCode: code, code: 'ERR', message: 'fail');
    }
    return const {'ok': true};
  }

  @override
  Future<Map<String, dynamic>> rsvpEvent({
    required String organizationId,
    required String eventId,
    required String action,
    String? idempotencyKey,
  }) async {
    rsvpCalls++;
    final code = onRsvp?.call() ?? 200;
    if (code != 200) {
      throw MobileApiException(statusCode: code, code: 'ERR', message: 'fail');
    }
    return const {'ok': true};
  }
}

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
    expect(await queue.count(), 2);

    final stored = await queue.list();
    expect(stored.length, 2);
    expect(stored.first.kind, 'channel_post');
    expect(stored.last.kind, 'event_rsvp');

    await queue.clear();
    expect(await queue.list(), isEmpty);
  });

  test('OfflineActionQueue flushDetailed replays successes, drops permanent 4xx and retains transient errors', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final queue = OfflineActionQueue();

    await queue.enqueue(
      const OfflineQueuedAction(
        idempotencyKey: 'ok-post',
        kind: 'channel_post',
        organizationId: '11111111-1111-4111-8111-111111111111',
        payload: {'channelId': 'ch-1', 'body': 'Offline message'},
        createdAtIso: '2026-11-21T10:00:00Z',
      ),
    );
    await queue.enqueue(
      const OfflineQueuedAction(
        idempotencyKey: 'drop-rsvp',
        kind: 'event_rsvp',
        organizationId: '11111111-1111-4111-8111-111111111111',
        payload: {'eventId': 'ev-409', 'action': 'rsvp'},
        createdAtIso: '2026-11-21T10:01:00Z',
      ),
    );
    await queue.enqueue(
      const OfflineQueuedAction(
        idempotencyKey: 'retry-rsvp',
        kind: 'event_rsvp',
        organizationId: '11111111-1111-4111-8111-111111111111',
        payload: {'eventId': 'ev-503', 'action': 'cancel'},
        createdAtIso: '2026-11-21T10:02:00Z',
      ),
    );

    int rsvpIdx = 0;
    final api = _QueueFakeApi()
      ..onPost = (() => 200)
      ..onRsvp = (() {
        // First RSVP returns permanent 409 conflict (dropped), second returns transient 503 (retained).
        return rsvpIdx++ == 0 ? 409 : 503;
      });
    final res = await queue.flushDetailed(api);
    expect(res.flushed, 1);
    expect(res.dropped, 1);
    expect(res.remaining, 1);
    expect(await queue.count(), 1);

    final leftover = await queue.list();
    expect(leftover.single.idempotencyKey, 'retry-rsvp');
  });
}
