import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import '../models/poll.dart';
import '../models/ticket.dart';
import '../config/app_config.dart';

class ApiService {
  static String get baseUrl => AppConfig.apiBaseUrl;

  String? _credential;

  void setCredential(String credential) {
    _credential = credential;
  }

  Future<List<Poll>> getPolls() async {
    if (_credential == null) {
      debugPrint('[ApiService] ❌ Error: Not authenticated (no credential)');
      throw Exception('Not authenticated');
    }

    final url = '$baseUrl/polls';
    debugPrint('[ApiService] ===== FETCHING POLLS =====');
    debugPrint('[ApiService] URL: $url');

    final response = await http.get(
      Uri.parse(url),
      headers: {'Authorization': 'Bearer $_credential'},
    );

    debugPrint('[ApiService] Response status: ${response.statusCode}');
    debugPrint('[ApiService] Response body length: ${response.body.length}');

    if (response.statusCode == 200) {
      final Map<String, dynamic> data = json.decode(response.body);
      final List<dynamic> pollsData = data['polls'] ?? [];
      debugPrint('[ApiService] Parsed ${pollsData.length} polls from response');
      final polls = pollsData.map((poll) => Poll.fromJson(poll)).toList();
      debugPrint('[ApiService] ✅ Converted to ${polls.length} Poll objects');
      return polls;
    } else {
      debugPrint('[ApiService] ❌ Failed with status ${response.statusCode}');
      debugPrint('[ApiService] Response: ${response.body}');
      throw Exception('Failed to load polls');
    }
  }

  /// Create a new support ticket
  Future<Map<String, dynamic>> createTicket({
    required String subject,
    required String message,
    String category = 'general',
    String priority = 'medium',
    Map<String, dynamic>? deviceInfo,
  }) async {
    if (_credential == null) {
      throw Exception('Not authenticated');
    }

    final response = await http.post(
      Uri.parse('$baseUrl/tickets'),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $_credential',
      },
      body: json.encode({
        'subject': subject,
        'message': message,
        'category': category,
        'priority': priority,
        'deviceInfo': deviceInfo,
      }),
    );

    if (response.statusCode == 201) {
      return json.decode(response.body);
    } else {
      final error = _parseError(response.body);
      throw Exception(error);
    }
  }

  /// Get list of user's tickets
  Future<List<Ticket>> getTickets({int page = 1, int pageSize = 20}) async {
    if (_credential == null) {
      throw Exception('Not authenticated');
    }

    final response = await http.get(
      Uri.parse('$baseUrl/tickets?page=$page&pageSize=$pageSize'),
      headers: {'Authorization': 'Bearer $_credential'},
    );

    if (response.statusCode == 200) {
      final data = json.decode(response.body);
      final List<dynamic> ticketsData = data['tickets'] ?? [];
      return ticketsData.map((t) => Ticket.fromJson(t)).toList();
    } else {
      throw Exception('Failed to load tickets');
    }
  }

  /// Get ticket details with responses
  Future<TicketDetail> getTicketDetail(String ticketId) async {
    if (_credential == null) {
      throw Exception('Not authenticated');
    }

    final response = await http.get(
      Uri.parse('$baseUrl/tickets/$ticketId'),
      headers: {'Authorization': 'Bearer $_credential'},
    );

    if (response.statusCode == 200) {
      return TicketDetail.fromJson(json.decode(response.body));
    } else {
      throw Exception('Failed to load ticket details');
    }
  }

  /// Add response to a ticket
  Future<Map<String, dynamic>> respondToTicket(
    String ticketId,
    String message,
  ) async {
    if (_credential == null) {
      throw Exception('Not authenticated');
    }

    final response = await http.post(
      Uri.parse('$baseUrl/tickets/$ticketId/respond'),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $_credential',
      },
      body: json.encode({'message': message}),
    );

    if (response.statusCode == 201) {
      return json.decode(response.body);
    } else {
      final error = _parseError(response.body);
      throw Exception(error);
    }
  }

  String _parseError(String body) {
    try {
      final data = json.decode(body);
      if (data is Map) {
        if (data['error'] is Map) {
          return data['error']['message'] ?? 'Unknown error';
        } else if (data['error'] is String) {
          return data['error'];
        }
      }
      return 'Request failed';
    } catch (e) {
      return 'Request failed';
    }
  }
}
