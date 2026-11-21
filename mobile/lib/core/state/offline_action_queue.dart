import 'dart:convert';

import 'package:flutter/foundation.dart' show immutable;
import 'package:shared_preferences/shared_preferences.dart';

import '../network/mobile_api_client.dart';

@immutable
class OfflineFlushResult {
  final int flushed;
  final int remaining;
  final int dropped;

  const OfflineFlushResult({
    required this.flushed,
    required this.remaining,
    required this.dropped,
  });
}

/// Durable local queue for non-sensitive offline member actions (channel posts,
/// event RSVPs) that replays idempotently once connectivity returns.
class OfflineQueuedAction {
  final String idempotencyKey;
  final String kind; // 'channel_post' | 'event_rsvp'
  final String organizationId;
  final Map<String, dynamic> payload;
  final String createdAtIso;

  const OfflineQueuedAction({
    required this.idempotencyKey,
    required this.kind,
    required this.organizationId,
    required this.payload,
    required this.createdAtIso,
  });

  Map<String, dynamic> toJson() => <String, dynamic>{
    'idempotencyKey': idempotencyKey,
    'kind': kind,
    'organizationId': organizationId,
    'payload': payload,
    'createdAtIso': createdAtIso,
  };

  factory OfflineQueuedAction.fromJson(Map<String, dynamic> json) {
    return OfflineQueuedAction(
      idempotencyKey: json['idempotencyKey']?.toString() ?? '',
      kind: json['kind']?.toString() ?? '',
      organizationId: json['organizationId']?.toString() ?? '',
      payload: Map<String, dynamic>.from(
        json['payload'] as Map? ?? const <String, dynamic>{},
      ),
      createdAtIso: json['createdAtIso']?.toString() ?? '',
    );
  }
}

class OfflineActionQueue {
  static const String _storageKey = 'ertad_offline_action_queue_v1';
  static const int maxQueuedItems = 50;

  Future<List<OfflineQueuedAction>> list() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_storageKey);
    if (raw == null || raw.isEmpty) return const [];
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! List) return const [];
      return decoded
          .whereType<Map>()
          .map(
            (m) => OfflineQueuedAction.fromJson(Map<String, dynamic>.from(m)),
          )
          .where((a) => a.idempotencyKey.isNotEmpty && a.kind.isNotEmpty)
          .toList(growable: false);
    } catch (_) {
      return const [];
    }
  }

  Future<int> count() async => (await list()).length;

  Future<int> enqueue(OfflineQueuedAction action) async {
    final current = List<OfflineQueuedAction>.from(await list());
    if (current.any((a) => a.idempotencyKey == action.idempotencyKey)) {
      return current.length;
    }
    current.add(action);
    final bounded = current.length > maxQueuedItems
        ? current.sublist(current.length - maxQueuedItems)
        : current;
    await _save(bounded);
    return bounded.length;
  }

  Future<OfflineFlushResult> flushDetailed(MobileApiClient api) async {
    final current = await list();
    if (current.isEmpty) {
      return const OfflineFlushResult(flushed: 0, remaining: 0, dropped: 0);
    }

    final remaining = <OfflineQueuedAction>[];
    int flushed = 0;
    int dropped = 0;

    for (final item in current) {
      try {
        if (item.kind == 'channel_post') {
          await api.postChannelMessage(
            organizationId: item.organizationId,
            channelId: item.payload['channelId']?.toString() ?? '',
            body: item.payload['body']?.toString() ?? '',
            replyId: item.payload['replyId']?.toString(),
            idempotencyKey: item.idempotencyKey,
          );
          flushed++;
        } else if (item.kind == 'event_rsvp') {
          await api.rsvpEvent(
            organizationId: item.organizationId,
            eventId: item.payload['eventId']?.toString() ?? '',
            action: item.payload['action']?.toString() ?? 'rsvp',
            idempotencyKey: item.idempotencyKey,
          );
          flushed++;
        }
      } on MobileApiException catch (e) {
        // Drop permanent client rejections (400/403/404/409); keep transient/network failures.
        final code = e.statusCode ?? 0;
        if (code == 0 || code >= 500 || code == 429) {
          remaining.add(item);
        } else {
          dropped++;
        }
      } catch (_) {
        remaining.add(item);
      }
    }

    await _save(remaining);
    return OfflineFlushResult(
      flushed: flushed,
      remaining: remaining.length,
      dropped: dropped,
    );
  }

  Future<int> flush(MobileApiClient api) async {
    final res = await flushDetailed(api);
    return res.flushed;
  }

  Future<void> clear() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_storageKey);
  }

  Future<void> _save(List<OfflineQueuedAction> items) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      _storageKey,
      jsonEncode(items.map((e) => e.toJson()).toList(growable: false)),
    );
  }
}
