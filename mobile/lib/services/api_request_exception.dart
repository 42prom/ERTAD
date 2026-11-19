/// HTTP status is authoritative; response text must never decide authentication.
class ApiRequestException implements Exception {
  final int statusCode;

  const ApiRequestException(this.statusCode);

  @override
  String toString() => 'API request failed ($statusCode)';
}
