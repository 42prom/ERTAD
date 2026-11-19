import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:ertad_mobile/services/api_request_exception.dart';
import 'package:ertad_mobile/services/real/real_api_service.dart';

void main() {
  final api = RealApiService()..setCredential('synthetic-credential');
  for (final status in [401, 403, 429, 500, 503]) {
    test(
      'preserves HTTP $status without interpreting or exposing response text',
      () async {
        await http.runWithClient(
          () async {
            await expectLater(
              api.getPolls(),
              throwsA(
                isA<ApiRequestException>()
                    .having((e) => e.statusCode, 'status', status)
                    .having(
                      (e) => e.toString(),
                      'safe message',
                      isNot(contains('synthetic-private')),
                    ),
              ),
            );
          },
          () => MockClient(
            (_) async => http.Response('synthetic-private 401 expired', status),
          ),
        );
      },
    );
  }
  for (final body in [
    '{}',
    '{"polls":null}',
    '{"polls":{}}',
    '[]',
    'not-json',
  ]) {
    test('a malformed 200 response cannot confirm startup: $body', () async {
      await http.runWithClient(() async {
        await expectLater(api.getPolls(), throwsA(anything));
      }, () => MockClient((_) async => http.Response(body, 200)));
    });
  }
  test(
    'accepts the retained authenticated read contract and sends only its credential',
    () async {
      await http.runWithClient(
        () async {
          expect(await api.getPolls(), isEmpty);
        },
        () => MockClient((request) async {
          expect(request.url.path, '/api/v1/polls');
          expect(
            request.headers['Authorization'],
            'Bearer synthetic-credential',
          );
          return http.Response('{"polls":[]}', 200);
        }),
      );
    },
  );
}
