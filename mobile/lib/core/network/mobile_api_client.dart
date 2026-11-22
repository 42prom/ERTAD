import 'dart:math';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../config/app_config.dart';

/// Structured API error returned from ERTAD mobile endpoints.
class MobileApiException implements Exception {
  final int? statusCode;
  final String code;
  final String message;

  const MobileApiException({
    this.statusCode,
    required this.code,
    required this.message,
  });

  @override
  String toString() => 'MobileApiException($statusCode, $code: $message)';
}

/// Non-sensitive dev persona summary returned by /mobile/dev/personas.
class MobileDevPersonaInfo {
  final String id;
  final String memberId;
  final String unitId;
  final String unitName;
  final String label;
  final String roleKind;

  const MobileDevPersonaInfo({
    required this.id,
    required this.memberId,
    required this.unitId,
    required this.unitName,
    required this.label,
    required this.roleKind,
  });

  factory MobileDevPersonaInfo.fromJson(Map<String, dynamic> json) {
    return MobileDevPersonaInfo(
      id: json['id'] as String,
      memberId: json['memberId'] as String,
      unitId: json['unitId'] as String,
      unitName: json['unitName'] as String? ?? 'Group',
      label: json['label'] as String? ?? 'Member',
      roleKind: json['roleKind'] as String? ?? 'member',
    );
  }
}

/// Authenticated mobile session client storing opaque tokens strictly in [FlutterSecureStorage].
class MobileApiClient {
  static const String _sessionTokenKey = 'ertad_mobile_session_token';
  static const String _csrfTokenKey = 'ertad_mobile_csrf_token';

  final Dio _dio;
  final FlutterSecureStorage _secureStorage;

  MobileApiClient({
    String? baseUrl,
    Dio? dio,
    FlutterSecureStorage? secureStorage,
  }) : _secureStorage =
           secureStorage ??
           const FlutterSecureStorage(
             aOptions: AndroidOptions(),
           ),
       _dio =
           dio ??
           Dio(
             BaseOptions(
               baseUrl: baseUrl ?? AppConfig.apiBaseUrl,
               connectTimeout: const Duration(seconds: 10),
               sendTimeout: const Duration(seconds: 25),
               receiveTimeout: const Duration(seconds: 25),
               headers: const {'Accept': 'application/json'},
             ),
           ) {
    _dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) async {
          final token = await _safeRead(_sessionTokenKey);
          if (token != null && token.isNotEmpty) {
            options.headers['Authorization'] = 'Bearer $token';
          }
          final method = options.method.toUpperCase();
          if (method != 'GET' && method != 'HEAD' && method != 'OPTIONS') {
            final csrf = await _safeRead(_csrfTokenKey);
            if (csrf != null && csrf.isNotEmpty) {
              options.headers['X-Mobile-CSRF'] = csrf;
            }
          }
          handler.next(options);
        },
        onError: (error, handler) {
          if (error.response?.statusCode == 401) {
            final reqPath = error.requestOptions.path;
            if (!reqPath.endsWith('/mobile/dev/login') &&
                !reqPath.contains('/mobile/m4/')) {
              clearStoredSession().ignore();
            }
          }
          handler.next(error);
        },
      ),
    );
  }

  Future<String?> _safeRead(String key) async {
    try {
      return await _secureStorage.read(key: key);
    } catch (e) {
      debugPrint('[MobileApiClient] SecureStorage read failed for $key: $e');
      try {
        await _secureStorage.delete(key: key);
      } catch (_) {}
      return null;
    }
  }

  Future<bool> hasStoredSession() async {
    final token = await _safeRead(_sessionTokenKey);
    return token != null && token.isNotEmpty;
  }

  Future<void> clearStoredSession() async {
    try {
      await _secureStorage.delete(key: _sessionTokenKey);
    } catch (_) {}
    try {
      await _secureStorage.delete(key: _csrfTokenKey);
    } catch (_) {}
  }

  Never _rethrow(Object error) {
    if (error is DioException) {
      final status = error.response?.statusCode;
      final data = error.response?.data;
      if (data is Map && data['error'] is Map) {
        final err = data['error'] as Map;
        throw MobileApiException(
          statusCode: status,
          code: err['code']?.toString() ?? 'REQUEST_FAILED',
          message: err['message']?.toString() ?? 'Request failed',
        );
      }
      throw MobileApiException(
        statusCode: status,
        code: status == null ? 'NETWORK_UNAVAILABLE' : 'HTTP_$status',
        message: error.message ?? 'Connection unavailable',
      );
    }
    throw MobileApiException(code: 'UNEXPECTED', message: error.toString());
  }

  Future<({bool enabled, String? organizationId, List<MobileDevPersonaInfo> personas})>
  fetchDevPersonas() async {
    try {
      final res = await _dio.get<Map<String, dynamic>>('/mobile/dev/personas');
      final body = res.data ?? const {};
      final rawList = (body['personas'] as List? ?? const []);
      return (
        enabled: body['enabled'] == true,
        organizationId: body['organizationId'] as String?,
        personas: rawList
            .map((e) => MobileDevPersonaInfo.fromJson(Map<String, dynamic>.from(e as Map)))
            .toList(),
      );
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<Map<String, dynamic>> devLogin(String personaId) async {
    try {
      final res = await _dio.post<Map<String, dynamic>>(
        '/mobile/dev/login',
        data: <String, dynamic>{'personaId': personaId},
      );
      final body = res.data ?? const {};
      final token = body['sessionToken'] as String?;
      final csrf = body['csrfToken'] as String?;
      if (token == null || csrf == null) {
        throw const MobileApiException(
          code: 'INVALID_SESSION',
          message: 'Session response incomplete',
        );
      }
      await _secureStorage.write(key: _sessionTokenKey, value: token);
      await _secureStorage.write(key: _csrfTokenKey, value: csrf);
      return Map<String, dynamic>.from(body['persona'] as Map? ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<void> logout() async {
    try {
      if (await hasStoredSession()) {
        await _dio.post<void>('/mobile/logout');
      }
    } catch (_) {
      // Clear local session credentials regardless of transport failure.
    } finally {
      await clearStoredSession();
    }
  }

  Future<void> devLogout() async {
    try {
      if (await hasStoredSession()) {
        await _dio.post<void>('/mobile/dev/logout');
      }
    } catch (_) {
      // Clear local session credentials regardless of transport failure.
    } finally {
      await clearStoredSession();
    }
  }

  Future<Map<String, dynamic>> fetchWorkspaceBootstrap() async {
    try {
      final res = await _dio.get<Map<String, dynamic>>('/mobile/workspace/bootstrap');
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<Map<String, dynamic>> fetchPrivacy(String organizationId) async {
    try {
      final res = await _dio.get<Map<String, dynamic>>(
        '/mobile/privacy',
        queryParameters: <String, dynamic>{'organizationId': organizationId},
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<Map<String, dynamic>> updatePrivacy({
    required String organizationId,
    required String disclosureMode,
    String? displayName,
  }) async {
    try {
      final res = await _dio.post<Map<String, dynamic>>(
        '/mobile/privacy/update',
        data: <String, dynamic>{
          'organizationId': organizationId,
          'disclosureMode': disclosureMode,
          'displayName': ?displayName,
        },
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<List<Map<String, dynamic>>> fetchDecisions({
    required String organizationId,
    String view = 'open',
  }) async {
    try {
      final res = await _dio.get<Map<String, dynamic>>(
        '/mobile/decisions/list',
        queryParameters: <String, dynamic>{
          'organizationId': organizationId,
          'view': view,
          'page': 1,
        },
      );
      final items = (res.data?['items'] as List? ?? const []);
      return items.map((e) => Map<String, dynamic>.from(e as Map)).toList();
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<List<Map<String, dynamic>>> fetchWorkItems({
    required String organizationId,
    String view = 'open',
  }) async {
    try {
      final res = await _dio.get<Map<String, dynamic>>(
        '/mobile/work/list',
        queryParameters: <String, dynamic>{
          'organizationId': organizationId,
          'view': view,
          'page': 1,
        },
      );
      final items = (res.data?['items'] as List? ?? const []);
      return items.map((e) => Map<String, dynamic>.from(e as Map)).toList();
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<List<Map<String, dynamic>>> fetchEvents({
    required String organizationId,
    String status = 'open',
  }) async {
    try {
      final res = await _dio.get<Map<String, dynamic>>(
        '/mobile/work/event_list',
        queryParameters: <String, dynamic>{
          'organizationId': organizationId,
          'status': status,
          'page': 1,
        },
      );
      final items = (res.data?['items'] as List? ?? const []);
      return items.map((e) => Map<String, dynamic>.from(e as Map)).toList();
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<List<Map<String, dynamic>>> fetchChannels({
    required String organizationId,
    String view = 'active',
    String kind = 'member_all',
  }) async {
    try {
      final res = await _dio.get<Map<String, dynamic>>(
        '/mobile/channels/list',
        queryParameters: <String, dynamic>{
          'organizationId': organizationId,
          'view': view,
          'kind': kind,
          'page': 1,
        },
      );
      final items = (res.data?['items'] as List? ?? const []);
      return items.map((e) => Map<String, dynamic>.from(e as Map)).toList();
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Generates a cryptographic random RFC-4122 v4 UUID for idempotent write commands.
  String newIdempotencyKey() {
    final rng = Random.secure();
    final bytes = List<int>.generate(16, (_) => rng.nextInt(256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    String h(int b) => b.toRadixString(16).padLeft(2, '0');
    final hex = bytes.map(h).join();
    return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}';
  }

  Future<Map<String, dynamic>> fetchChannelThread({
    required String organizationId,
    required String channelId,
    int beforeSeq = 0,
  }) async {
    try {
      final res = await _dio.get<Map<String, dynamic>>(
        '/mobile/channels/thread',
        queryParameters: <String, dynamic>{
          'organizationId': organizationId,
          'id': channelId,
          'before': beforeSeq,
        },
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<Map<String, dynamic>> postChannelMessage({
    required String organizationId,
    required String channelId,
    required String body,
    String? replyId,
    String? attachmentId,
    String? idempotencyKey,
  }) async {
    try {
      final res = await _dio.post<Map<String, dynamic>>(
        '/mobile/channels/post',
        data: <String, dynamic>{
          'organizationId': organizationId,
          'id': channelId,
          'key': idempotencyKey ?? newIdempotencyKey(),
          'body': body,
          'replyId': ?replyId,
          'attachmentId': ?attachmentId,
        },
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Uploads an image/PDF attachment to a channel (`/mobile/channels/attachment`).
  Future<Map<String, dynamic>> uploadChannelAttachment({
    required String organizationId,
    required String channelId,
    required Uint8List bytes,
    required String contentType,
    String? idempotencyKey,
  }) async {
    try {
      final res = await _dio.post<Map<String, dynamic>>(
        '/mobile/channels/attachment',
        queryParameters: <String, dynamic>{
          'organizationId': organizationId,
          'id': channelId,
          'key': idempotencyKey ?? newIdempotencyKey(),
        },
        data: Stream.fromIterable(<List<int>>[bytes]),
        options: Options(
          contentType: contentType,
          headers: <String, dynamic>{'Content-Length': bytes.length},
        ),
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Downloads sanitized channel attachment bytes (`/mobile/channels/attachment/download`).
  Future<Uint8List> downloadChannelAttachment({
    required String organizationId,
    required String channelId,
    required String attachmentId,
  }) async {
    try {
      final res = await _dio.get<List<int>>(
        '/mobile/channels/attachment/download',
        queryParameters: <String, dynamic>{
          'organizationId': organizationId,
          'id': channelId,
          'attachmentId': attachmentId,
        },
        options: Options(responseType: ResponseType.bytes),
      );
      return Uint8List.fromList(res.data ?? const <int>[]);
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<void> markChannelRead({
    required String organizationId,
    required String channelId,
    required int seq,
  }) async {
    try {
      await _dio.post<Map<String, dynamic>>(
        '/mobile/channels/read',
        data: <String, dynamic>{
          'organizationId': organizationId,
          'id': channelId,
          'key': newIdempotencyKey(),
          'seq': seq,
        },
      );
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<void> setChannelMuted({
    required String organizationId,
    required String channelId,
    required bool muted,
  }) async {
    try {
      await _dio.post<Map<String, dynamic>>(
        '/mobile/channels/mute',
        data: <String, dynamic>{
          'organizationId': organizationId,
          'id': channelId,
          'key': newIdempotencyKey(),
          'muted': muted,
        },
      );
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<Map<String, dynamic>> reactChannelMessage({
    required String organizationId,
    required String channelId,
    required String messageId,
    required String emoji,
  }) async {
    try {
      final res = await _dio.post<Map<String, dynamic>>(
        '/mobile/channels/react',
        data: <String, dynamic>{
          'organizationId': organizationId,
          'id': channelId,
          'key': newIdempotencyKey(),
          'messageId': messageId,
          'emoji': emoji,
        },
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<void> removeChannelMessage({
    required String organizationId,
    required String channelId,
    required String messageId,
  }) async {
    try {
      await _dio.post<Map<String, dynamic>>(
        '/mobile/channels/remove',
        data: <String, dynamic>{
          'organizationId': organizationId,
          'id': channelId,
          'key': newIdempotencyKey(),
          'messageId': messageId,
        },
      );
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<void> reportChannelMessage({
    required String organizationId,
    required String channelId,
    required String messageId,
    required String category,
  }) async {
    try {
      await _dio.post<Map<String, dynamic>>(
        '/mobile/channels/report',
        data: <String, dynamic>{
          'organizationId': organizationId,
          'id': channelId,
          'key': newIdempotencyKey(),
          'messageId': messageId,
          'category': category,
        },
      );
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<List<Map<String, dynamic>>> fetchDirectPeers({
    required String organizationId,
    String? search,
  }) async {
    final res = await fetchDirectPeersDirectory(
      organizationId: organizationId,
      search: search,
    );
    return res.items;
  }

  Future<({String selfCode, List<Map<String, dynamic>> items})>
  fetchDirectPeersDirectory({
    required String organizationId,
    String? search,
  }) async {
    try {
      final q = search?.trim() ?? '';
      final res = await _dio.get<Map<String, dynamic>>(
        '/mobile/channels/direct-peers',
        queryParameters: <String, dynamic>{
          'organizationId': organizationId,
          if (q.isNotEmpty) 'search': q,
        },
      );
      final selfCode = res.data?['selfCode']?.toString() ?? '';
      final items = (res.data?['items'] as List? ?? const [])
          .map((e) => Map<String, dynamic>.from(e as Map))
          .toList();
      return (selfCode: selfCode, items: items);
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<Map<String, dynamic>> openDirectChannel({
    required String organizationId,
    String? peerId,
    List<String>? peerIds,
    String? title,
  }) async {
    try {
      final cleanTitle = title?.trim();
      final res = await _dio.post<Map<String, dynamic>>(
        '/mobile/channels/direct-open',
        data: <String, dynamic>{
          'organizationId': organizationId,
          'peerId': ?peerId,
          if (peerIds != null && peerIds.isNotEmpty) 'peerIds': peerIds,
          if (cleanTitle != null && cleanTitle.length >= 3) 'title': cleanTitle,
          'key': newIdempotencyKey(),
        },
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<Map<String, dynamic>> addDirectChannelMembers({
    required String organizationId,
    required String channelId,
    required List<String> peerIds,
  }) async {
    try {
      final res = await _dio.post<Map<String, dynamic>>(
        '/mobile/channels/direct-add',
        data: <String, dynamic>{
          'organizationId': organizationId,
          'id': channelId,
          'peerIds': peerIds,
          'key': newIdempotencyKey(),
        },
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<Map<String, dynamic>> setDirectBlocked({
    required String organizationId,
    required String channelId,
    required bool blocked,
  }) async {
    try {
      final res = await _dio.post<Map<String, dynamic>>(
        '/mobile/channels/direct-block',
        data: <String, dynamic>{
          'organizationId': organizationId,
          'id': channelId,
          'key': newIdempotencyKey(),
          'blocked': blocked,
        },
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<Map<String, dynamic>> fetchInbox({
    required String organizationId,
    String view = 'all',
    String source = 'all',
  }) async {
    try {
      final res = await _dio.get<Map<String, dynamic>>(
        '/mobile/inbox',
        queryParameters: <String, dynamic>{
          'organizationId': organizationId,
          'view': view,
          'source': source,
          'page': 1,
        },
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<void> devStepUp() async {
    try {
      await _dio.post<void>('/mobile/dev/step-up');
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<Map<String, dynamic>> fetchContributionPoints({
    required String organizationId,
  }) async {
    try {
      final res = await _dio.get<Map<String, dynamic>>(
        '/mobile/collective/points',
        queryParameters: <String, dynamic>{
          'organizationId': organizationId,
          'page': 1,
        },
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<Map<String, dynamic>> fetchWorkDetail({
    required String organizationId,
    required String workId,
  }) async {
    try {
      final res = await _dio.get<Map<String, dynamic>>(
        '/mobile/work/detail',
        queryParameters: <String, dynamic>{
          'organizationId': organizationId,
          'id': workId,
        },
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<Map<String, dynamic>> mutateWork({
    required String op,
    required String organizationId,
    required String workId,
    required int version,
    String note = '',
    String? needId,
    String? criterionId,
    String? qualificationId,
    String? reference,
    String? idempotencyKey,
  }) async {
    try {
      final res = await _dio.post<Map<String, dynamic>>(
        '/mobile/work/$op',
        data: <String, dynamic>{
          'organizationId': organizationId,
          'id': workId,
          'version': version,
          'key': idempotencyKey ?? newIdempotencyKey(),
          'note': note,
          'needId': ?needId,
          'criterionId': ?criterionId,
          'qualificationId': ?qualificationId,
          'reference': ?reference,
        },
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<Map<String, dynamic>> fetchEventDetail({
    required String organizationId,
    required String eventId,
  }) async {
    try {
      final res = await _dio.get<Map<String, dynamic>>(
        '/mobile/work/event_detail',
        queryParameters: <String, dynamic>{
          'organizationId': organizationId,
          'id': eventId,
        },
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<Map<String, dynamic>> rsvpEvent({
    required String organizationId,
    required String eventId,
    required String action,
    String? idempotencyKey,
  }) async {
    try {
      final res = await _dio.post<Map<String, dynamic>>(
        '/mobile/work/event_rsvp',
        data: <String, dynamic>{
          'organizationId': organizationId,
          'id': eventId,
          'action': action,
          'key': idempotencyKey ?? newIdempotencyKey(),
        },
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<Map<String, dynamic>> fetchWorkChannel({
    required String organizationId,
    required String workId,
  }) async {
    try {
      final res = await _dio.get<Map<String, dynamic>>(
        '/mobile/channels/work',
        queryParameters: <String, dynamic>{
          'organizationId': organizationId,
          'workId': workId,
        },
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<Map<String, dynamic>> fetchDecisionDetail({
    required String organizationId,
    required String decisionId,
  }) async {
    try {
      final res = await _dio.get<Map<String, dynamic>>(
        '/mobile/decisions/detail',
        queryParameters: <String, dynamic>{
          'organizationId': organizationId,
          'id': decisionId,
        },
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<Map<String, dynamic>> voteDecision({
    required String organizationId,
    required String decisionId,
    int? choice,
    Map<String, dynamic>? answers,
    String? idempotencyKey,
  }) async {
    try {
      final res = await _dio.post<Map<String, dynamic>>(
        '/mobile/decisions/vote',
        data: <String, dynamic>{
          'organizationId': organizationId,
          'id': decisionId,
          'key': idempotencyKey ?? newIdempotencyKey(),
          'choice': ?choice,
          'answers': ?answers,
        },
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<void> markInboxRead({
    required String organizationId,
    required String source,
    required String id,
    required int version,
  }) async {
    try {
      await _dio.post<Map<String, dynamic>>(
        '/mobile/inbox/read',
        data: <String, dynamic>{
          'organizationId': organizationId,
          'source': source,
          'id': id,
          'version': version,
        },
      );
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Lists membership reviews in the caller's authorized scope (/mobile/reviews).
  Future<List<Map<String, dynamic>>> fetchReviews({
    required String organizationId,
    String view = 'pending',
  }) async {
    try {
      final res = await _dio.get<Map<String, dynamic>>(
        '/mobile/reviews',
        queryParameters: <String, dynamic>{
          'organizationId': organizationId,
          'view': view,
        },
      );
      final raw = res.data?['items'];
      if (raw is List) {
        return raw.whereType<Map>().map(Map<String, dynamic>.from).toList();
      }
      return const [];
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Approves or rejects a pending membership review (/mobile/reviews/decision).
  Future<Map<String, dynamic>> decideReview({
    required String organizationId,
    required String reviewId,
    required String decision,
    required String reason,
    String? idempotencyKey,
  }) async {
    try {
      final res = await _dio.post<Map<String, dynamic>>(
        '/mobile/reviews/decision',
        data: <String, dynamic>{
          'organizationId': organizationId,
          'id': reviewId,
          'key': idempotencyKey ?? newIdempotencyKey(),
          'decision': decision,
          'reason': reason,
        },
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Executes a Group Manager work-assignment transition (`/mobile/work/<op>`).
  Future<Map<String, dynamic>> mutateWorkMember({
    required String op,
    required String organizationId,
    required String workId,
    required int version,
    required String memberId,
    String note = '',
    String? idempotencyKey,
  }) async {
    try {
      final res = await _dio.post<Map<String, dynamic>>(
        '/mobile/work/$op',
        data: <String, dynamic>{
          'organizationId': organizationId,
          'id': workId,
          'key': idempotencyKey ?? newIdempotencyKey(),
          'version': version,
          'memberId': memberId,
          'note': note,
        },
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Records event attendance using a participant's 12-hex check-in code.
  Future<Map<String, dynamic>> checkinEvent({
    required String organizationId,
    required String eventId,
    required String checkinCode,
    String? idempotencyKey,
  }) async {
    try {
      final res = await _dio.post<Map<String, dynamic>>(
        '/mobile/work/event_checkin',
        data: <String, dynamic>{
          'organizationId': organizationId,
          'id': eventId,
          'key': idempotencyKey ?? newIdempotencyKey(),
          'checkinCode': checkinCode.trim(),
        },
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Fetches the caller's M4 identity & device assurance status (`/mobile/m4/status`).
  Future<Map<String, dynamic>> fetchM4Status({String? deviceId}) async {
    try {
      final cleanId = deviceId?.trim() ?? '';
      final res = await _dio.get<Map<String, dynamic>>(
        '/mobile/m4/status',
        queryParameters: cleanId.isNotEmpty
            ? <String, dynamic>{'deviceId': cleanId}
            : null,
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Requests a single-use cryptographic attestation challenge (`/mobile/m4/attestation/challenge`).
  Future<Map<String, dynamic>> requestAttestationChallenge(
    String platform,
  ) async {
    try {
      final res = await _dio.post<Map<String, dynamic>>(
        '/mobile/m4/attestation/challenge',
        data: <String, dynamic>{'platform': platform},
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Submits Play Integrity / App Attest proof (`/mobile/m4/attestation/verify`).
  Future<Map<String, dynamic>> verifyDeviceAttestation({
    required String platform,
    required String provider,
    required String deviceId,
    required String appId,
    required String nonce,
    required String token,
    int counter = 0,
  }) async {
    try {
      final res = await _dio.post<Map<String, dynamic>>(
        '/mobile/m4/attestation/verify',
        data: <String, dynamic>{
          'platform': platform,
          'provider': provider,
          'deviceId': deviceId,
          'appId': appId,
          'nonce': nonce,
          'token': token,
          'counter': counter,
        },
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Fetches public Google OIDC client IDs configured by technical operators (`/mobile/m4/google/config`).
  Future<Map<String, dynamic>> fetchGoogleOidcConfig() async {
    try {
      final res = await _dio.get<Map<String, dynamic>>(
        '/mobile/m4/google/config',
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Binds a verified Google OIDC ID token to the caller's hybrid session (`/mobile/m4/google/bind`).
  Future<Map<String, dynamic>> bindGoogleIdentity(String idToken) async {
    try {
      final res = await _dio.post<Map<String, dynamic>>(
        '/mobile/m4/google/bind',
        data: <String, dynamic>{'idToken': idToken},
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Completes eID document/NFC/liveness/face verification (`/mobile/m4/biometric/complete`).
  Future<Map<String, dynamic>> completeBiometricVerification({
    String? deviceId,
    required bool sodCscaVerified,
    required String citizenshipCountry,
    required double livenessScore,
    required double faceMatchScore,
    required String personSubjectKey,
    String? biometricTemplate,
    String? docPortraitBase64,
    String? selfieBase64,
  }) async {
    try {
      final res = await _dio.post<Map<String, dynamic>>(
        '/mobile/m4/biometric/complete',
        data: <String, dynamic>{
          'deviceId': ?deviceId,
          'sodCscaVerified': sodCscaVerified,
          'citizenshipCountry': citizenshipCountry,
          'livenessScore': livenessScore,
          'faceMatchScore': faceMatchScore,
          'personSubjectKey': personSubjectKey,
          'biometricTemplate': ?biometricTemplate,
          'docPortraitBase64': ?docPortraitBase64,
          'selfieBase64': ?selfieBase64,
        },
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Re-authenticates a verified member against their stored encrypted biometric template (`/mobile/m4/biometric/reauth`).
  Future<Map<String, dynamic>> reauthBiometric({
    required double livenessScore,
    required double faceMatchScore,
    String? deviceId,
    String? platform,
    String? selfieBase64,
  }) async {
    try {
      final res = await _dio.post<Map<String, dynamic>>(
        '/mobile/m4/biometric/reauth',
        data: <String, dynamic>{
          'livenessScore': livenessScore,
          'faceMatchScore': faceMatchScore,
          if (deviceId != null && deviceId.trim().isNotEmpty)
            'deviceId': deviceId.trim(),
          'platform': ?platform,
          if (selfieBase64 != null && selfieBase64.isNotEmpty)
            'selfieBase64': selfieBase64,
        },
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  Future<T> _withDevStepUpRetry<T>(Future<T> Function() fn) async {
    try {
      return await fn();
    } on MobileApiException catch (e) {
      if (e.statusCode == 428 && !kReleaseMode && AppConfig.devWorkspace) {
        await devStepUp();
        return await fn();
      }
      rethrow;
    }
  }

  /// Fetches units in caller's hierarchy where they hold `workitem.create` (`/mobile/work/units`).
  Future<List<Map<String, dynamic>>> fetchWorkUnits({
    required String organizationId,
  }) async {
    try {
      final res = await _dio.get<List<dynamic>>(
        '/mobile/work/units',
        queryParameters: <String, dynamic>{'organizationId': organizationId},
      );
      return (res.data ?? const <dynamic>[])
          .whereType<Map>()
          .map(Map<String, dynamic>.from)
          .where((u) => u['canCreate'] == true)
          .toList(growable: false);
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Creates a hierarchy-scoped task (`/mobile/work/create`).
  Future<Map<String, dynamic>> createWorkItem({
    required String organizationId,
    required String unitId,
    required String title,
    required String description,
    required String roleLabel,
    required String priority,
    required int capacity,
    required String deadlineIso,
  }) async {
    try {
      return await _withDevStepUpRetry(() async {
        final res = await _dio.post<Map<String, dynamic>>(
          '/mobile/work/create',
          data: <String, dynamic>{
            'key': newIdempotencyKey(),
            'organizationId': organizationId,
            'unitId': unitId,
            'title': title.trim(),
            'description': description.trim(),
            'roleLabel': roleLabel.trim(),
            'priority': priority,
            'capacity': capacity,
            'deadline': deadlineIso,
            'contributionRuleId': null,
          },
        );
        return Map<String, dynamic>.from(res.data ?? const {});
      });
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Fetches units where caller can create channels (`/mobile/channels/units`).
  Future<List<Map<String, dynamic>>> fetchChannelUnits({
    required String organizationId,
  }) async {
    try {
      final res = await _dio.get<Map<String, dynamic>>(
        '/mobile/channels/units',
        queryParameters: <String, dynamic>{
          'organizationId': organizationId,
          'page': 1,
        },
      );
      final raw = res.data?['items'] as List? ?? const [];
      return raw
          .whereType<Map>()
          .map(Map<String, dynamic>.from)
          .toList(growable: false);
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Creates a group or hierarchical channel (`/mobile/channels/create`).
  Future<Map<String, dynamic>> createChannel({
    required String organizationId,
    required String unitId,
    required String title,
    String kind = 'group',
  }) async {
    try {
      return await _withDevStepUpRetry(() async {
        final res = await _dio.post<Map<String, dynamic>>(
          '/mobile/channels/create',
          data: <String, dynamic>{
            'key': newIdempotencyKey(),
            'organizationId': organizationId,
            'unitId': unitId,
            'title': title.trim(),
            'kind': kind,
          },
        );
        return Map<String, dynamic>.from(res.data ?? const {});
      });
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Fetches subordinate audience units where caller holds `decision.manage` (`/mobile/decisions/audiences`).
  Future<List<Map<String, dynamic>>> fetchDecisionAudiences({
    required String organizationId,
  }) async {
    try {
      final res = await _dio.get<List<dynamic>>(
        '/mobile/decisions/audiences',
        queryParameters: <String, dynamic>{'organizationId': organizationId},
      );
      return (res.data ?? const <dynamic>[])
          .whereType<Map>()
          .map(Map<String, dynamic>.from)
          .toList(growable: false);
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Creates and immediately publishes a hierarchy-scoped poll or referendum (`/mobile/decisions/create` + `publish`).
  Future<Map<String, dynamic>> createAndPublishDecision({
    required String organizationId,
    required String unitId,
    required String kind,
    required String privacy,
    required String title,
    required String description,
    required List<String> options,
    required int quorum,
    required String closesAtIso,
    int? threshold,
    Map<String, String>? referendumLabels,
  }) async {
    try {
      return await _withDevStepUpRetry(() async {
        final created = await _dio.post<Map<String, dynamic>>(
          '/mobile/decisions/create',
          data: <String, dynamic>{
            'key': newIdempotencyKey(),
            'organizationId': organizationId,
            'unitId': unitId,
            'kind': kind,
            'privacy': privacy,
            'title': title.trim(),
            'description': description.trim(),
            'options': kind == 'referendum'
                ? const <String>['Yes', 'No', 'Abstain']
                : options.map((e) => e.trim()).toList(growable: false),
            'quorum': quorum,
            'closesAt': closesAtIso,
            'includedUnitIds': <String>[unitId],
            if (kind == 'referendum') 'threshold': threshold ?? 50,
            if (kind == 'referendum' && referendumLabels != null)
              'referendumLabels': referendumLabels,
          },
        );
        final draft = Map<String, dynamic>.from(created.data ?? const {});
        final decisionId = draft['id']?.toString() ?? '';
        if (decisionId.isEmpty) return draft;
        final pub = await _dio.post<Map<String, dynamic>>(
          '/mobile/decisions/publish',
          data: <String, dynamic>{
            'key': newIdempotencyKey(),
            'organizationId': organizationId,
            'id': decisionId,
            'version': 1,
          },
        );
        return Map<String, dynamic>.from(pub.data ?? draft);
      });
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Fetches the member's personal referral code, upline referrer, downline pyramid counts & earned points.
  Future<Map<String, dynamic>> fetchReferralSummary({
    required String organizationId,
  }) async {
    try {
      final res = await _dio.get<Map<String, dynamic>>(
        '/mobile/m4/referrals/summary',
        queryParameters: <String, dynamic>{'organizationId': organizationId},
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Links the caller to an upline referrer using their personal referral code (`ERTAD-P-XXXX-XXXX`).
  Future<Map<String, dynamic>> redeemReferralCode({
    required String organizationId,
    required String code,
    String? unitId,
  }) async {
    try {
      final res = await _dio.post<Map<String, dynamic>>(
        '/mobile/m4/referrals/redeem',
        data: <String, dynamic>{
          'organizationId': organizationId,
          'code': code.trim().toUpperCase(),
          'unitId': ?unitId,
        },
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Fetches opt-in parallel notification channels (Push / Telegram / WhatsApp / Viber).
  Future<List<Map<String, dynamic>>> fetchNotificationChannels() async {
    try {
      final res = await _dio.get<Map<String, dynamic>>('/mobile/m4/channels');
      final raw = (res.data?['channels'] as List? ?? const []);
      return raw.whereType<Map>().map(Map<String, dynamic>.from).toList();
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Updates an opt-in notification channel preference (handle is encrypted on server).
  Future<List<Map<String, dynamic>>> updateNotificationChannel({
    required String channel,
    required bool enabled,
    String? handle,
  }) async {
    try {
      final res = await _dio.post<Map<String, dynamic>>(
        '/mobile/m4/channels',
        data: <String, dynamic>{
          'channel': channel,
          'enabled': enabled,
          'handle': ?handle,
        },
      );
      final raw = (res.data?['channels'] as List? ?? const []);
      return raw.whereType<Map>().map(Map<String, dynamic>.from).toList();
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Fetches member's own verified eID metadata & masked phone number (`/mobile/m4/profile`).
  Future<Map<String, dynamic>> fetchMemberProfile() async {
    try {
      final res = await _dio.get<Map<String, dynamic>>('/mobile/m4/profile');
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }

  /// Stores or clears the member's own phone number (AES-256-GCM encrypted on server).
  Future<Map<String, dynamic>> updateMemberPhone({
    String? phone,
    bool clear = false,
  }) async {
    try {
      final res = await _dio.post<Map<String, dynamic>>(
        '/mobile/m4/profile/phone',
        data: clear
            ? <String, dynamic>{'clear': true}
            : <String, dynamic>{'phone': phone?.trim() ?? ''},
      );
      return Map<String, dynamic>.from(res.data ?? const {});
    } catch (e) {
      _rethrow(e);
    }
  }
}

