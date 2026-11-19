import '../../models/activity_item.dart';
import '../../models/poll.dart';
import '../../models/verification_models.dart';

/// Interface for the main API service (enrollment, polls and participation history).
abstract class IApiService {
  void setCredential(String credential);

  Future<List<Poll>> getPolls();

  Future<EnrollmentNfcResponse> submitNfc(Map<String, dynamic> payload);
  Future<EnrollmentContinueResponse> submitDocument(
    Map<String, dynamic> payload,
  );
  Future<EnrollmentFinalizeResponse> submitLiveness(
    Map<String, dynamic> payload,
  );
  Future<VerificationPolicy> fetchVerificationPolicy();

  Future<List<Region>> getRegions();
  Future<bool> checkUserExists(String personalNumber);
  Future<void> updateProfile({
    required String enrollmentSessionId,
    List<String>? regionCodes,
    String? firstName,
    String? lastName,
  });

  /// Get the user's participation history
  Future<List<ActivityItem>> getMyActivity();
  Future<Poll> getPollDetails(String id);
  Future<Map<String, dynamic>> getPollResults(String id);

  // Device registration (for push notifications)
  Future<void> registerDevice(String token, String platform);
  Future<void> unregisterDevice(String token);
}
