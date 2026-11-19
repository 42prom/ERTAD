import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Supported languages
enum AppLanguage {
  english('en', 'English'),
  georgian('ka', 'ქართული');

  final String code;
  final String displayName;
  const AppLanguage(this.code, this.displayName);
}

/// Localization service that manages language and translations
class LocalizationService extends ChangeNotifier {
  static const String _languageKey = 'app_language';

  AppLanguage _currentLanguage = AppLanguage.english;
  AppLanguage get currentLanguage => _currentLanguage;

  Locale get locale => Locale(_currentLanguage.code);

  /// Initialize and load saved language preference
  Future<void> initialize() async {
    final prefs = await SharedPreferences.getInstance();
    final savedCode = prefs.getString(_languageKey);
    if (savedCode == 'ka') {
      _currentLanguage = AppLanguage.georgian;
    } else {
      _currentLanguage = AppLanguage.english;
    }
    notifyListeners();
  }

  /// Change language and persist preference
  Future<void> setLanguage(AppLanguage language) async {
    if (_currentLanguage == language) return;

    _currentLanguage = language;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_languageKey, language.code);
    notifyListeners();
  }

  /// Toggle between English and Georgian
  Future<void> toggleLanguage() async {
    if (_currentLanguage == AppLanguage.english) {
      await setLanguage(AppLanguage.georgian);
    } else {
      await setLanguage(AppLanguage.english);
    }
  }

  /// Get translated string
  String translate(String key) {
    final translations = _currentLanguage == AppLanguage.georgian
        ? _georgianTranslations
        : _englishTranslations;
    return translations[key] ?? key;
  }

  // ============================================
  // ENGLISH TRANSLATIONS
  // ============================================
  static const Map<String, String> _englishTranslations = {
    'session_check_unavailable':
        'Your session could not be verified. Check your connection and try again.',
    'decision_unavailable_title': 'Voting is not available yet',
    'decision_unavailable_body':
        'You can review the questions and options. No vote or response will be sent or saved.',
    // Common
    'app_name': 'ERTAD',
    'app_subtitle': 'ERTAD',
    'loading': 'Loading...',
    'error': 'Error',
    'success': 'Success',
    'cancel': 'Cancel',
    'confirm': 'Confirm',
    'save': 'Save',
    'done': 'Done',
    'next': 'Next',
    'back': 'Back',
    'retry': 'Retry',
    'yes': 'Yes',
    'no': 'No',
    'ok': 'OK',

    // Bottom Navigation
    'nav_voting': 'Voting',
    'nav_messages': 'Messages',
    'nav_activity': 'My Activity',
    'nav_settings': 'Settings',

    // Dashboard / Voting
    'poll': 'Poll',
    'poll_details': 'Poll Details',
    'review_vote': 'Review Vote',
    'survey_responses': 'Survey Responses',
    'search_by_title': 'Search by title...',
    'live': 'Live',
    'ended': 'Ended',
    'elections': 'Elections',
    'election': 'Election',
    'poll_ends': 'Poll Ends',
    'req_participation': 'Participation Required',
    'survey': 'Survey',
    'referendum': 'Referendum',
    'active_polls': 'Active Polls',
    'no_active_polls': 'No active polls at the moment',
    'no_activity': 'No activity yet',
    'no_search_results': 'No results match your search.',
    'take_survey': 'Take Survey',
    'vote_now': 'Vote Now',
    'vote_on_referendum': 'Vote in Referendum',

    'send': 'Send',
    'confirmed': 'Confirmed',
    'pending': 'Pending',
    'failed': 'Failed',
    'from': 'From',
    'to': 'To',

    // Messages
    'messages': 'Messages',
    'no_messages': 'No messages yet',
    'new_message': 'New',

    // Activity
    'my_activity': 'My Activity',
    'voting_history': 'Voting History',
    'activity_detail': 'Activity Detail',
    'voted_on': 'Voted on',
    'status': 'Status',
    'results_available_after_ends': 'Results available after poll ends.',
    'check_back_for_outcome':
        'Check back once the voting period is over to see the outcome.',
    'type': 'Type',
    'results': 'Results',
    'total_votes': 'Total Votes',
    'total': 'total',
    'ends_at': 'Ends at',
    'activity_survey_submitted': 'Survey Submitted',
    'survey_analyzed':
        'Thank you for your participation.\nSurvey results are analyzed by authorized staff.',

    // Liveness Feedback
    'center_face': 'Center your face in the frame',
    'face_lost': 'Face lost',
    'face_detected': 'Face detected',
    'hold_steady': 'Hold steady...',
    'hold_still': 'Hold still...',
    'move_left': 'Move LEFT ←',
    'move_right': 'Move RIGHT →',
    'move_up': 'Move UP ↑',
    'move_down': 'Move DOWN ↓',
    'move_closer': 'Move closer',
    'move_back': 'Move back',
    'more_light': 'More light needed',
    'blink_eyes': '👁️ Blink your eyes',
    'follow_instructions': 'Follow instructions',
    'blink_not_detected': 'Blink not detected — try better lighting',
    'challenge_timeout': 'Challenge timed out. Please try again.',
    'verifying_identity': 'Verifying identity...',
    'matching_id_photo': 'Matching with your ID photo...',
    'identity_verified': '✓ Identity Verified',
    'face_mismatch': 'Face Mismatch',
    'max_attempts_exhausted': 'Maximum attempts exhausted',
    'access_suspended': 'Access Suspended',
    'session_expired': 'Session Expired',
    'match_failed': 'Match Failed',
    'verification_failed': 'Verification Failed',
    'step_ratio': 'STEP', // To be used like "STEP 1/2"
    'try_again_with_attempts': 'Try Again', // Will be "Try Again (3)"
    // NFC & Errors
    'unable_unlock_chip':
        'Unable to unlock chip. The MRZ data must match exactly.',
    'pn_required_prompt': 'Enter Personal Number manually.',
    'save_retry_btn': 'Save & Retry',

    'recent_activity': 'Recent Activity',
    'm_ago': 'm ago',
    'h_ago': 'h ago',
    'd_ago': 'd ago',
    'yesterday': 'Yesterday',

    // Ticket Statuses
    'ticket_status_open': 'Open',
    'ticket_status_inProgress': 'In Progress',
    'ticket_status_waitingUser': 'Waiting for Response',
    'ticket_status_resolved': 'Resolved',
    'ticket_status_closed': 'Closed',

    // Ticket Priorities
    'ticket_priority_low': 'Low',
    'ticket_priority_medium': 'Medium',
    'ticket_priority_high': 'High',
    'ticket_priority_urgent': 'Urgent',

    // Ticket Categories
    'ticket_category_general': 'General',
    'ticket_category_account': 'Account',
    'ticket_category_voting': 'Voting',
    'ticket_category_technical': 'Technical Issue',
    'ticket_category_verification': 'Verification',
    'ticket_category_other': 'Other',

    // Settings
    'settings': 'Settings',
    'profile': 'Profile',
    'language': 'Language',
    'language_settings': 'Language Settings',
    'select_language': 'Select Language',
    'notifications': 'Notifications',
    'security': 'Security',
    'privacy': 'Privacy',
    'about': 'About',
    'help': 'Help & Support',
    'logout': 'Log Out',
    'version': 'Version',

    // Profile
    'profile_name': 'Name',
    'profile_region': 'Region',
    'profile_verified': 'Verified',
    'profile_not_verified': 'Not Verified',
    'edit_profile': 'Edit Profile',

    // Enrollment - Intro
    'welcome': 'Welcome',
    'get_started': 'Get Started',
    'enrollment_title': 'Identity Verification',
    'enrollment_subtitle': 'Verify your identity to participate in voting',
    'scan_document': 'Scan Document',
    'take_selfie': 'Take Selfie',
    'verify_identity': 'Verify your identity',
    'secure_enrollment': 'Secure enrollment',
    'secure_enrollment_desc':
        'To protect your vote, we confirm your identity using your Georgian ID or passport.',
    'identity_verification_card': 'Identity Verification',
    'identity_verification_card_desc':
        'Capture a document photo and take a selfie to confirm your identity.',
    'start_verification': 'Start verification',
    'connection_error': 'Connection Error',
    'connection_error_msg':
        'Could not load verification policy. Check your connection and try again.',
    'enrollment_complete': 'Enrollment Complete',
    'enrollment_failed': 'Enrollment Failed',

    // Enrollment - Document Entry
    'document_scan': 'Document Scan',
    'fallback_scan_subtitle': 'Fallback scan for identity verification',
    'policy': 'Policy',
    'strict_match': 'Strict match',
    'lenient_match': 'Lenient match',
    'first_name': 'First Name',
    'last_name': 'Last Name',
    'document_number': 'Document #',
    'date_of_birth': 'Date of Birth',
    'expiry_date': 'Expiry Date',
    'capture_document_photo': 'Capture document photo',
    'retake_document_photo': 'Retake document photo',
    'continue_btn': 'Continue',
    'session_missing_error':
        'Enrollment session missing. Please go back and rescan NFC.',
    'document_photo_required':
        'Document photo is required. Please capture a document photo.',
    'capture_error': 'Could not capture photo. Please try again.',

    // Enrollment - Document Camera
    'no_cameras_found': 'No cameras found',
    'camera_error': 'Camera error',
    'place_id_in_frame': 'Place the front of your ID in the frame',
    'ensure_good_lighting': 'Ensure good lighting and no glare',

    // Enrollment - Selfie Camera / Liveness
    'position_face_in_circle': 'Position your face in the circle',
    'look_straight_camera': 'Look straight at the camera',
    'turn_head_left': 'Slowly turn head LEFT',
    'turn_head_right': 'Now turn head RIGHT',
    'stay_still_look_center': 'Stay still & Look center',
    'no_face_detected': 'No face detected. Move closer.',
    'verification_complete': 'Verification complete!',
    'face_aligned_start': 'Face aligned. Tap Start to verify.',
    'center_face_to_start': 'Center your face to enable start',
    'start_verification_btn': 'Start Verification',
    'capture_failed': 'Capture failed',

    // Enrollment - NFC Scan
    'nfc_scan': 'NFC Scan',
    'nfc_unlock_subtitle': 'Unlock and read your passport chip',
    'hold_phone_near_chip': 'Hold phone near the document chip...',
    'chip_detected_auth': 'Chip detected. Authenticating...',
    'reading_document_1_3': 'Reading document data (1/3)...',
    'reading_personal_2_3': 'Reading personal data (2/3)...',
    'reading_photo_3_3': 'Reading photo (3/3)...',
    'ready_to_auth': 'Ready to Authenticate',
    'doc_num_label': 'Doc #',
    'start_scan': 'Start Scan',
    'scanning': 'Scanning...',
    'processing': 'Processing...',
    'verifying': 'Verifying...',
    'validating': 'Validating...',
    'start_nfc_scan': 'Start NFC Scan',
    'welcome_back': 'Welcome Back!',
    'registration_started': 'Registration Started',
    'tap_to_auth': 'Tap the button to authenticate with your document chip.',
    'edit_mrz_data': 'Edit MRZ Data',
    'nfc_scan_failed': 'NFC Scan Failed',
    'auth_failed': 'Authentication Failed',
    'nfc_error': 'NFC Error',
    'lost_connection_chip':
        'Lost connection to chip. Please hold the phone steadily.',
    'tag_lost': 'Tag lost. Please hold still.',
    'scan_failed_retry': 'Scan failed. Please try again.',
    'access_denied_mrz':
        'Unable to unlock chip. The MRZ data (Doc Number, DOB, Expiry) must match exactly.',
    'check_data': 'Check Data',
    'try_again': 'Try Again',
    'missing_personal_number': 'Missing Personal Number',
    'personal_number_not_found':
        'The Personal Number was not found on the document scan. Please enter it manually to continue.',
    'personal_number_required': 'Personal Number is required.',
    'correct_mrz_values':
        'Correct these values to match your physical document EXACTLY. They are keys to unlock the chip.',
    'dob_format': 'Date of Birth (DD-MM-YYYY)',
    'expiry_format': 'Expiry Date (DD-MM-YYYY)',
    'nationality_format': 'Nationality (e.g. GEO)',
    'save_retry': 'Save & Retry',

    // Enrollment - MRZ Scanner
    'align_document_frame': 'Align the document code within the frame',
    'passport': 'Passport',
    'id_card': 'ID Card',
    'document_expired': 'Document Expired',
    'document_expired_msg':
        'The scanned document has expired. Please use a valid document.',
    'citizenship_required': 'Citizenship Required',
    'citizenship_required_msg': 'Only Georgian citizens can register.',
    'detected_nationality': 'Detected Nationality',
    'try_another_document': 'Try Another Document',
    'go_back': 'Go Back',

    // Enrollment - Profile Creation
    'profile_details': 'Profile Details',
    'confirm_profile': 'Confirm Profile',
    'verify_details_region': 'Verify details and select region',
    'region_required': 'Region Required',
    'select_origin_region': 'Please select your origin region.',
    'verified_from_id':
        'Personal details verified from ID Document and cannot be changed.',
    'birth_date': 'Birth Date',
    'gender': 'Gender',
    'age': 'Age',
    'origin_region': 'Origin Region',
    'select_region': 'Select Region',
    'select_region_help':
        'Please select the region where your family is originally from.',
    'required': 'Required',

    'submit_vote': 'Submit Vote',
    'confirm_vote': 'Confirm Vote',
    'back_to_home': 'Back to Home',
    'your_vote': 'Your Vote',
    'vote_failed': 'Vote Submission Failed',
    'your_choice': 'Your Choice',
    'copy_to_clipboard': 'Copy',
    'copied': 'Copied!',

    // Errors
    'error_network': 'Network error. Please check your connection.',
    'error_server': 'Server error. Please try again later.',
    'error_unknown': 'An unexpected error occurred.',

    // Settings Detail
    'coming_soon': 'Coming Soon',
    'settings_title': 'Settings',

    // Notification Settings
    'master_switch': 'MASTER SWITCH',
    'enable_notifications': 'Enable Notifications',
    'allow_push_notifications': 'Allow ERTAD to send you push notifications',
    'categories': 'CATEGORIES',
    'new_polls': 'New Polls',
    'new_polls_subtitle': 'Stay alerted when new polls are live',
    'announcements': 'Announcements',
    'announcements_subtitle': 'Important news and updates from the team',
    'notification_system_note':
        'Note: You can also manage granular notification permissions in your system settings.',
    'failed_save_setting': 'Failed to save setting',

    // Help & Support
    'help_support': 'Help & Support',
    'how_can_we_help': 'How can we help you?',
    'submit_ticket_info':
        'Reach your group coordinators in chat or contact ERTAD support by email.',
    'quick_actions': 'Quick Actions',
    'create_new_ticket': 'Create New Ticket',
    'describe_issue_help': 'Describe your issue and get help',
    'my_tickets': 'My Tickets',
    'view_manage_tickets': 'View and manage your support tickets',
    'faq': 'Frequently Asked Questions',
    'faq_verify_identity_q': 'How do I verify my identity?',
    'faq_verify_identity_a':
        'Go to Settings > Verification and follow the steps to verify your identity using your ID document and face recognition.',
    'faq_vote_not_showing_q': 'Why is my vote not showing?',
    'faq_vote_not_showing_a':
        'Votes are recorded anonymously and protected by unlinkability guarantees. If a decision still fails to update after refreshing, message your group coordinator or email support.',
    'faq_change_region_q': 'How can I change my region?',
    'faq_change_region_a':
        'Message your group coordinator in group chat or email ERTAD support to request a group or region transfer.',
    'email_support': 'Email Support',

    // Tickets
    'no_tickets_yet': 'No Tickets Yet',
    'tickets_appear_here':
        'When you create support tickets, they will appear here.',
    'failed_load_tickets': 'Failed to load tickets',
    'create_ticket': 'Create Ticket',
    'ticket_created': 'Ticket Created',
    'ticket_submitted_success': 'Your ticket has been submitted successfully.',
    'support_response': 'Our support team will respond as soon as possible.',
    'category': 'Category',
    'priority': 'Priority',
    'subject': 'Subject',
    'subject_hint': 'Brief description of your issue',
    'enter_subject': 'Please enter a subject',
    'subject_min_chars': 'Subject must be at least 5 characters',
    'message_label': 'Message',
    'message_hint':
        'Describe your issue in detail. Include any relevant information that might help us assist you better.',
    'describe_issue': 'Please describe your issue',
    'provide_more_details':
        'Please provide more details (at least 20 characters)',
    'tip_include_steps':
        'Tip: Include steps to reproduce the issue and any error messages you\'ve seen for faster resolution.',
    'submit_ticket': 'Submit Ticket',
    'failed_create_ticket': 'Failed to create ticket',
    'response_sent': 'Response sent',
    'ticket_number': 'Ticket #',
    'ticket_details': 'Ticket Details',
    'ticket_closed_notice': 'This ticket has been closed.',
    'reply_hint': 'Type your reply...',
    'just_now': 'Just now',
    'message_type_critical': 'CRITICAL',
    'message_type_announcement': 'ANNOUNCEMENT',
    'message_type_alert': 'ALERT',
    'message_type_reminder': 'REMINDER',
    'message_type_info': 'INFO',

    'scan_qr_code': 'Scan QR Code',
    'or_enter_manually': 'or enter manually',
    'paste_clipboard': 'Paste from clipboard',
    'amount': 'Amount',
    'action_cannot_undone': 'This action cannot be undone.',
    'failed_send': 'Failed to send',
    'copy': 'Copy',
    'share': 'Share',
    // Voting - Referendum
    'referendum_title': 'Referendum',
    'vote_anonymous_warning':
        'Your vote is anonymous and cannot be changed after submission.',

    // Voting - Survey
    'survey_title': 'Survey',
    'no_questions': 'This survey has no questions.',
    'question_of': 'Question',
    'of': 'of',
    'single_choice': 'Single Choice',
    'multiple_choice': 'Multiple Choice',
    'text_response': 'Text Response',
    'rating_scale': 'Rating Scale',
    'ranked_choice': 'Ranked Choice',
    'select_all_apply': 'Select all that apply',
    'type_your_answer': 'Type your answer...',
    'response_anonymous':
        'Your response is anonymous and will only be shown in aggregate.',
    'tap_to_rank': 'Tap options to rank them',
    'your_ranking': 'Your ranking:',
    'available_options': 'Available options:',
    'tap_to_add': 'Tap to add:',
    'submit_survey': 'Submit Survey',
    'leave_survey': 'Leave Survey?',
    'progress_lost':
        'Your progress will be lost. Are you sure you want to leave?',
    'stay': 'Stay',
    'leave': 'Leave',
    'answered_questions': 'You have answered',
    'questions': 'questions.',
    'responses_anonymous':
        'Your responses are anonymous and cannot be traced back to you.',
    'cannot_change_answers': 'Once submitted, you cannot change your answers.',
    'review': 'Review',
    'submit': 'Submit',
    'survey_submitted': 'Survey Submitted!',
    'questions_answered': 'Questions Answered',
    'responses_protected':
        'Your responses are anonymous and protected by our privacy system.',
    'please_answer_required': 'Please answer required question',
    'you_selected': 'You selected:',
    'survey_already_submitted': 'Survey already submitted. Refreshing...',
    'failed_submit_survey': 'Failed to submit survey',
    'step_1_4_challenge': 'Step 1/4: Requesting challenge nonce...',
    'step_2_4_response_binding': 'Step 2/4: Sealing survey responses...',
    'step_3_4_attestation': 'Step 3/4: Issuing device attestation...',
    'step_4_4_submitting': 'Step 4/4: Submitting survey...',

    // Confirm Vote
    'you_are_voting_for': 'You are voting for:',
    'in_poll': 'in poll:',
    'vote_already_recorded': 'Vote already recorded. Refreshing...',
    'failed_submit_vote': 'Failed to submit vote',

    // Dashboard
    'no_polls_available': 'No polls available',
    'pull_to_refresh': 'Pull down to refresh',
    'no_messages_yet': 'No messages yet',
    'announcements_here':
        'Announcements and alerts for your region will appear here.',
    'no_recent_updates': 'No recent updates',
    'citizen_user': 'Citizen User',
    'enrolled': 'Enrolled',
    'security_privacy': 'Security & Privacy',
    'logout_confirm':
        'Are you sure you want to logout? You will need to re-enroll to vote again.',
    'failed_load_polls': 'Failed to load polls',
    'failed_load_messages': 'Failed to load messages',

    // Wave M1 Adaptive 5-Tab Shell & Privacy Hub
    'nav_status': 'Status',
    'nav_home': 'Home',
    'nav_tasks': 'Tasks',
    'nav_polls': 'Polls',
    'org_context_switch': 'Organization & Group',
    'inbox_title': 'Inbox',
    'inbox_filter_action': 'Needs action',
    'inbox_filter_unread': 'Unread',
    'inbox_filter_all': 'All',
    'inbox_empty_title': 'All caught up',
    'inbox_empty_body':
        'Event reminders, decisions, tasks and point notices will appear here.',
    'account_privacy_title': 'Account & Privacy',
    'privacy_title': 'Profile visibility & anonymity',
    'privacy_private': 'Anonymous',
    'privacy_private_desc':
        'Default · Only an anonymous code is shown in groups; your name stays hidden.',
    'privacy_optin': 'Public',
    'privacy_optin_desc':
        'Shows your chosen display name inside groups, chats, and lists.',
    'privacy_ballot_notice':
        'Anonymous ballots stay strictly unlinkable regardless of profile visibility.',
    'theme_mode': 'Appearance',
    'theme_system': 'System',
    'theme_light': 'Light',
    'theme_dark': 'Dark',
    'language_label': 'Language',
    'dev_persona_title': 'Dev Workspace Persona',
    'dev_persona_member': 'Member',
    'dev_persona_manager': 'Group Manager',
    'dev_persona_hint':
        'Development preview only; real permissions stay server-enforced.',
    'sessions_security': 'Sessions, 2FA & Passkeys',
    'notification_prefs': 'Notification Preferences',
    'support_tickets': 'Support & Help',
    'coming_in_m2_m3': 'Live database sync arrives in Wave M2/M3',
    'home_requires_action': 'Requires your action',
    'home_schedule_48h': 'Next 48 hours',
    'home_kpi_tasks': 'Open tasks',
    'home_kpi_polls': 'Live polls',
    'home_kpi_events': 'Events 48h',
    'home_kpi_inbox': 'Unread notices',
    'home_manager_bar': 'Group Manager Queue',
    'status_points_title': 'Contribution Points (Visible Scope)',
    'status_points_note':
        'Private history only — no public leaderboards, XP levels or cash exchange.',
    'status_memberships_title': 'Memberships & Privacy',
    'tasks_filter_tasks': 'Tasks',
    'tasks_filter_events': 'Events',
    'tasks_filter_calendar': 'Calendar',
    'tasks_pledge_notice':
        'Pledged commitments are shown separately from confirmed funds collected.',
    'messages_filter_all': 'All',
    'messages_filter_unread': 'Unread',
    'messages_filter_tasks': 'Task chats',
    'messages_filter_archived': 'Archived',
    'polls_filter_live': 'Live',
    'polls_filter_referendum': 'Referendums',
    'polls_filter_survey': 'Surveys',
    'polls_filter_ended': 'Ended',
    'votes_label': 'votes',
    'failed_send_status': 'Failed to send reply',
    'support': 'Support',
    'you': 'You',
    'personal_number': 'Personal number',
    'invalid_date_format': 'Invalid date format',
    'failed_load_ticket': 'Failed to load ticket',
  };

  // ============================================
  // GEORGIAN TRANSLATIONS
  // ============================================
  static const Map<String, String> _georgianTranslations = {
    'session_check_unavailable':
        'სესიის შემოწმება ვერ მოხერხდა. შეამოწმეთ კავშირი და სცადეთ ხელახლა.',
    'decision_unavailable_title': 'ხმის მიცემა ჯერ მიუწვდომელია',
    'decision_unavailable_body':
        'შეგიძლიათ გაეცნოთ კითხვებსა და ვარიანტებს. ხმა და პასუხები არ გაიგზავნება და არ შეინახება.',
    // Common
    'app_name': 'ERTAD',
    'app_subtitle': 'საქართველოს დემოკრატიის ინსტრუმენტები',
    'loading': 'იტვირთება...',
    'error': 'შეცდომა',
    'success': 'წარმატება',
    'cancel': 'გაუქმება',
    'confirm': 'დადასტურება',
    'save': 'შენახვა',
    'done': 'დასრულება',
    'next': 'შემდეგი',
    'back': 'უკან',
    'retry': 'თავიდან ცდა',
    'yes': 'დიახ',
    'no': 'არა',
    'ok': 'კარგი',

    // Bottom Navigation
    'nav_voting': 'კენჭისყრა',
    'nav_messages': 'შეტყობინებები',
    'nav_activity': 'აქტივობა',
    'nav_settings': 'პარამეტრები',

    // Dashboard / Voting
    'poll': 'კენჭისყრა',
    'poll_details': 'კენჭისყრის დეტალები',
    'review_vote': 'ხმის გადახედვა',
    'survey_responses': 'გამოკითხვის პასუხები',
    'search_by_title': 'ძიება სათაურით...',
    'live': 'მიმდინარე',
    'ended': 'დასრულებული',
    'elections': 'არჩევნები',
    'election': 'არჩევნები',
    'poll_ends': 'სრულდება',
    'req_participation': 'საჭირო აქტივობა',
    'survey': 'გამოკითხვა',
    'referendum': 'რეფერენდუმი',
    'active_polls': 'აქტიური კენჭისყრები',
    'no_active_polls': 'ამჟამად აქტიური კენჭისყრა არ არის',
    'no_activity': 'აქტივობა ჯერ არ არის',
    'no_search_results': 'ძიების შედეგები ვერ მოიძებნა.',
    'take_survey': 'გამოკითხვაში მონაწილეობა',
    'vote_now': 'ხმის მიცემა',
    'vote_on_referendum': 'რეფერენდუმში მონაწილეობა',

    'send': 'გაგზავნა',
    'confirmed': 'დადასტურებული',
    'pending': 'მოლოდინში',
    'failed': 'წარუმატებელი',
    'from': 'გამომგზავნი',
    'to': 'მიმღები',

    // Messages
    'messages': 'შეტყობინებები',
    'no_messages': 'შეტყობინებები ჯერ არ არის',
    'new_message': 'ახალი',

    // Activity
    'my_activity': 'ჩემი აქტივობა',
    'voting_history': 'კენჭისყრის ისტორია',
    'activity_detail': 'აქტივობის დეტალები',
    'voted_on': 'ხმის მიცემის თარიღი',
    'status': 'სტატუსი',
    'results_available_after_ends':
        'შედეგები ხელმისაწვდომი იქნება კენჭისყრის დასრულების შემდეგ.',
    'check_back_for_outcome':
        'შედეგების სანახავად დაბრუნდით ხმის მიცემის პერიოდის დასრულების შემდეგ.',
    'type': 'ტიპი',
    'results': 'შედეგები',
    'total_votes': 'ხმების ჯამი',
    'total': 'სულ',
    'ends_at': 'სრულდება',
    'activity_survey_submitted': 'გამოკითხვა გაგზავნილია',
    'survey_analyzed':
        'გმადლობთ მონაწილეობისთვის.\nგამოკითხვის შედეგებს გააანალიზებს უფლებამოსილი პერსონალი.',

    // Liveness Feedback
    'center_face': 'მოათავსეთ სახე ჩარჩოში',
    'face_lost': 'სახე დაკარგულია',
    'face_detected': 'სახე ნაპოვნია',
    'hold_steady': 'გაჩერდით...',
    'hold_still': 'არ იმოძრაოთ...',
    'move_left': 'გაიწიეთ მარცხნივ ←',
    'move_right': 'გაიწიეთ მარჯვნივ →',
    'move_up': 'აწიეთ მაღლა ↑',
    'move_down': 'დაუშვით დაბლა ↓',
    'move_closer': 'მიუახლოვდით',
    'move_back': 'გაიწიეთ უკან',
    'more_light': 'საჭიროა მეტი განათება',
    'blink_eyes': '👁️ დაახამხამეთ თვალები',
    'follow_instructions': 'მიჰყევით ინსტრუქციას',
    'blink_not_detected': 'ხამხამი ვერ დაფიქსირდა — სცადეთ უკეთესი განათება',
    'challenge_timeout': 'დრო ამოიწურა. გთხოვთ სცადოთ ხელახლა.',
    'verifying_identity': 'პირადობის დადასტურება...',
    'matching_id_photo': 'ID ფოტოსთან შედარება...',
    'identity_verified': '✓ პირადობა დადასტურებულია',
    'face_mismatch': 'სახე არ ემთხვევა',
    'max_attempts_exhausted': 'ცდების რაოდენობა ამოიწურა',
    'access_suspended': 'წვდომა შეჩერებულია',
    'session_expired': 'სესია ამოიწურა',
    'match_failed': 'შედარება ვერ მოხერხდა',
    'verification_failed': 'ვერიფიკაცია ვერ მოხერხდა',
    'step_ratio': 'ნაბიჯი',
    'try_again_with_attempts': 'ხელახლა ცდა',

    // NFC & Errors
    'unable_unlock_chip':
        'ჩიპის გახსნა ვერ მოხერხდა. MRZ მონაცემები ზუსტად უნდა ემთხვეოდეს.',
    'pn_required_prompt': 'შეიყვანეთ პირადი ნომერი ხელით.',
    'save_retry_btn': 'შენახვა და ხელახლა ცდა',

    'recent_activity': 'ბოლო აქტივობა',
    'm_ago': 'წუთის წინ',
    'h_ago': 'საათის წინ',
    'd_ago': 'დღის წინ',
    'yesterday': 'გუშინ',

    // Ticket Statuses
    'ticket_status_open': 'ღია',
    'ticket_status_inProgress': 'მუშაობაშია',
    'ticket_status_waitingUser': 'მომხმარებლის მოლოდინში',
    'ticket_status_resolved': 'გადაწყვეტილი',
    'ticket_status_closed': 'დახურული',

    // Ticket Priorities
    'ticket_priority_low': 'დაბალი',
    'ticket_priority_medium': 'საშუალო',
    'ticket_priority_high': 'მაღალი',
    'ticket_priority_urgent': 'სასწრაფო',

    // Ticket Categories
    'ticket_category_general': 'ზოგადი',
    'ticket_category_account': 'ანგარიში',
    'ticket_category_voting': 'კენჭისყრა',
    'ticket_category_technical': 'ტექნიკური ხარვეზი',
    'ticket_category_verification': 'ვერიფიკაცია',
    'ticket_category_other': 'სხვა',

    // Settings
    'settings': 'პარამეტრები',
    'profile': 'პროფილი',
    'language': 'ენა',
    'language_settings': 'ენის პარამეტრები',
    'select_language': 'აირჩიეთ ენა',
    'notifications': 'შეტყობინებები',
    'security': 'უსაფრთხოება',
    'privacy': 'კონფიდენციალურობა',
    'about': 'აპლიკაციის შესახებ',
    'help': 'დახმარება',
    'logout': 'გასვლა',
    'version': 'ვერსია',

    // Profile
    'profile_name': 'სახელი',
    'profile_region': 'რეგიონი',
    'profile_verified': 'ვერიფიცირებული',
    'profile_not_verified': 'არავერიფიცირებული',
    'edit_profile': 'პროფილის რედაქტირება',

    // Enrollment - Intro
    'welcome': 'კეთილი იყოს თქვენი მობრძანება',
    'get_started': 'დაწყება',
    'enrollment_title': 'პირადობის დადასტურება',
    'enrollment_subtitle':
        'დაადასტურეთ თქვენი პირადობა კენჭისყრაში მონაწილეობისთვის',
    'scan_document': 'დოკუმენტის სკანირება',
    'take_selfie': 'სელფის გადაღება',
    'verify_identity': 'პირადობის დადასტურება',
    'secure_enrollment': 'უსაფრთხო რეგისტრაცია',
    'secure_enrollment_desc':
        'თქვენი ხმის დასაცავად, ჩვენ ვადასტურებთ თქვენს პირადობას საქართველოს პირადობის მოწმობის ან პასპორტის გამოყენებით.',
    'identity_verification_card': 'პირადობის დადასტურება',
    'identity_verification_card_desc':
        'გადაიღეთ დოკუმენტის ფოტო და სელფი თქვენი პირადობის დასადასტურებლად.',
    'start_verification': 'დაწყება',
    'connection_error': 'კავშირის შეცდომა',
    'connection_error_msg':
        'ვერიფიკაციის პოლიტიკის ჩატვირთვა ვერ მოხერხდა. შეამოწმეთ კავშირი და სცადეთ ხელახლა.',
    'enrollment_complete': 'რეგისტრაცია დასრულებულია',
    'enrollment_failed': 'რეგისტრაცია ვერ მოხერხდა',

    // Enrollment - Document Entry
    'document_scan': 'დოკუმენტის სკანირება',
    'fallback_scan_subtitle': 'პირადობის დადასტურების სარეზერვო სკანირება',
    'policy': 'პოლიტიკა',
    'strict_match': 'მკაცრი შესაბამისობა',
    'lenient_match': 'მოქნილი შესაბამისობა',
    'first_name': 'სახელი',
    'last_name': 'გვარი',
    'document_number': 'დოკუმენტის №',
    'date_of_birth': 'დაბადების თარიღი',
    'expiry_date': 'მოქმედების ვადა',
    'capture_document_photo': 'დოკუმენტის ფოტოს გადაღება',
    'retake_document_photo': 'ფოტოს ხელახლა გადაღება',
    'continue_btn': 'გაგრძელება',
    'session_missing_error':
        'რეგისტრაციის სესია არ არის. გთხოვთ დაბრუნდეთ და ხელახლა დაასკანეროთ NFC.',
    'document_photo_required':
        'დოკუმენტის ფოტო აუცილებელია. გთხოვთ გადაიღოთ დოკუმენტის ფოტო.',
    'capture_error': 'ფოტოს გადაღება ვერ მოხერხდა. გთხოვთ სცადოთ ხელახლა.',

    // Enrollment - Document Camera
    'no_cameras_found': 'კამერა ვერ მოიძებნა',
    'camera_error': 'კამერის შეცდომა',
    'place_id_in_frame': 'მოათავსეთ პირადობის წინა მხარე ჩარჩოში',
    'ensure_good_lighting': 'უზრუნველყავით კარგი განათება და არ იყოს ბლიკი',

    // Enrollment - Selfie Camera / Liveness
    'position_face_in_circle': 'მოათავსეთ სახე წრეში',
    'look_straight_camera': 'შეხედეთ პირდაპირ კამერაში',
    'turn_head_left': 'ნელა მოაბრუნეთ თავი მარცხნივ',
    'turn_head_right': 'ახლა მოაბრუნეთ თავი მარჯვნივ',
    'stay_still_look_center': 'გაჩერდით და შეხედეთ ცენტრში',
    'no_face_detected': 'სახე ვერ მოიძებნა. მიუახლოვდით.',
    'verification_complete': 'ვერიფიკაცია დასრულებულია!',
    'face_aligned_start': 'სახე გასწორებულია. დააჭირეთ დაწყებას.',
    'center_face_to_start': 'გაასწორეთ სახე დასაწყებად',
    'start_verification_btn': 'ვერიფიკაციის დაწყება',
    'capture_failed': 'გადაღება ვერ მოხერხდა',

    // Enrollment - NFC Scan
    'nfc_scan': 'NFC სკანირება',
    'nfc_unlock_subtitle': 'თქვენი პასპორტის ჩიპის წაკითხვა',
    'hold_phone_near_chip': 'მიადეთ ტელეფონი დოკუმენტის ჩიპთან...',
    'chip_detected_auth': 'ჩიპი აღმოჩენილია. ავთენტიფიკაცია...',
    'reading_document_1_3': 'დოკუმენტის მონაცემების კითხვა (1/3)...',
    'reading_personal_2_3': 'პირადი მონაცემების კითხვა (2/3)...',
    'reading_photo_3_3': 'ფოტოს კითხვა (3/3)...',
    'ready_to_auth': 'მზად არის ავთენტიფიკაციისთვის',
    'doc_num_label': 'დოკ. №',
    'start_scan': 'სკანირების დაწყება',
    'scanning': 'სკანირება...',
    'processing': 'დამუშავება...',
    'verifying': 'ვერიფიკაცია...',
    'validating': 'ვალიდაცია...',
    'start_nfc_scan': 'NFC სკანირების დაწყება',
    'welcome_back': 'კეთილი იყოს თქვენი დაბრუნება!',
    'registration_started': 'რეგისტრაცია დაწყებულია',
    'tap_to_auth': 'დააჭირეთ ღილაკს დოკუმენტის ჩიპით ავთენტიფიკაციისთვის.',
    'edit_mrz_data': 'MRZ მონაცემების რედაქტირება',
    'nfc_scan_failed': 'NFC სკანირება ვერ მოხერხდა',
    'auth_failed': 'ავთენტიფიკაცია ვერ მოხერხდა',
    'nfc_error': 'NFC შეცდომა',
    'lost_connection_chip':
        'ჩიპთან კავშირი დაიკარგა. გთხოვთ მყარად დაიჭიროთ ტელეფონი.',
    'tag_lost': 'ტეგი დაიკარგა. გთხოვთ გაჩერდეთ.',
    'scan_failed_retry': 'სკანირება ვერ მოხერხდა. გთხოვთ სცადოთ ხელახლა.',
    'access_denied_mrz':
        'ჩიპის გახსნა ვერ მოხერხდა. MRZ მონაცემები (დოკ. ნომერი, დაბ. თარიღი, ვადა) ზუსტად უნდა ემთხვეოდეს.',
    'check_data': 'მონაცემების შემოწმება',
    'try_again': 'ხელახლა ცდა',
    'missing_personal_number': 'პირადი ნომერი არ არის',
    'personal_number_not_found':
        'პირადი ნომერი დოკუმენტის სკანირებისას ვერ მოიძებნა. გთხოვთ ხელით შეიყვანოთ.',
    'personal_number_required': 'პირადი ნომერი აუცილებელია.',
    'correct_mrz_values':
        'შეასწორეთ ეს მნიშვნელობები ზუსტად თქვენი ფიზიკური დოკუმენტის მიხედვით. ესენი ჩიპის გახსნის გასაღებებია.',
    'dob_format': 'დაბადების თარიღი (დდ-თთ-წწწწ)',
    'expiry_format': 'მოქმედების ვადა (დდ-თთ-წწწწ)',
    'nationality_format': 'მოქალაქეობა (მაგ. GEO)',
    'save_retry': 'შენახვა და ხელახლა ცდა',

    // Enrollment - MRZ Scanner
    'align_document_frame': 'გაასწორეთ დოკუმენტის კოდი ჩარჩოში',
    'passport': 'პასპორტი',
    'id_card': 'პირადობა',
    'document_expired': 'დოკუმენტს ვადა გაუვიდა',
    'document_expired_msg':
        'დასკანირებულ დოკუმენტს ვადა გაუვიდა. გთხოვთ გამოიყენოთ მოქმედი დოკუმენტი.',
    'citizenship_required': 'მოქალაქეობა აუცილებელია',
    'citizenship_required_msg':
        'მხოლოდ საქართველოს მოქალაქეებს შეუძლიათ რეგისტრაცია.',
    'detected_nationality': 'აღმოჩენილი მოქალაქეობა',
    'try_another_document': 'სხვა დოკუმენტის ცდა',
    'go_back': 'უკან დაბრუნება',

    // Enrollment - Profile Creation
    'profile_details': 'პროფილის დეტალები',
    'confirm_profile': 'პროფილის დადასტურება',
    'verify_details_region': 'დეტალების შემოწმება და რეგიონის არჩევა',
    'region_required': 'რეგიონი აუცილებელია',
    'select_origin_region': 'გთხოვთ აირჩიოთ თქვენი წარმოშობის რეგიონი.',
    'verified_from_id':
        'პირადი მონაცემები დადასტურებულია პირადობის მოწმობიდან და ვერ შეიცვლება.',
    'birth_date': 'დაბადების თარიღი',
    'gender': 'სქესი',
    'age': 'ასაკი',
    'origin_region': 'წარმოშობის რეგიონი',
    'select_region': 'რეგიონის არჩევა',
    'select_region_help':
        'გთხოვთ აირჩიოთ რეგიონი, საიდანაც თქვენი ოჯახი წარმოიშვა.',
    'required': 'აუცილებელია',

    'submit_vote': 'ხმის გაგზავნა',
    'confirm_vote': 'ხმის დადასტურება',
    'back_to_home': 'მთავარ გვერდზე დაბრუნება',
    'your_vote': 'თქვენი ხმა',
    'vote_failed': 'ხმის გაგზავნა ვერ მოხერხდა',
    'your_choice': 'თქვენი არჩევანი',
    'copy_to_clipboard': 'კოპირება',
    'copied': 'დაკოპირდა!',

    // Errors
    'error_network': 'ქსელის შეცდომა. შეამოწმეთ კავშირი.',
    'error_server': 'სერვერის შეცდომა. სცადეთ მოგვიანებით.',
    'error_unknown': 'მოხდა მოულოდნელი შეცდომა.',

    // Settings Detail
    'coming_soon': 'მალე',
    'settings_title': 'პარამეტრები',

    // Notification Settings
    'master_switch': 'მთავარი გადამრთველი',
    'enable_notifications': 'შეტყობინებების ჩართვა',
    'allow_push_notifications':
        'ნება მიეცით ERTAD-ს გამოგიგზავნოთ Push შეტყობინებები',
    'categories': 'კატეგორიები',
    'new_polls': 'ახალი კენჭისყრები',
    'new_polls_subtitle': 'მიიღეთ შეტყობინება ახალი კენჭისყრების შესახებ',
    'announcements': 'განცხადებები',
    'announcements_subtitle':
        'მნიშვნელოვანი სიახლეები და განახლებები გუნდისგან',
    'notification_system_note':
        'შენიშვნა: შეგიძლიათ მართოთ შეტყობინებების დეტალური პარამეტრები სისტემის პარამეტრებში.',
    'failed_save_setting': 'პარამეტრის შენახვა ვერ მოხერხდა',

    // Help & Support
    'help_support': 'დახმარება და მხარდაჭერა',
    'how_can_we_help': 'როგორ შეგვიძლია დაგეხმაროთ?',
    'submit_ticket_info':
        'დაუკავშირდით ჯგუფის კოორდინატორებს ჩათში ან მოგვწერეთ ERTAD-ის მხარდაჭერის ელფოსტაზე.',
    'quick_actions': 'სწრაფი ქმედებები',
    'create_new_ticket': 'ახალი ტიკეტის შექმნა',
    'describe_issue_help': 'აღწერეთ თქვენი პრობლემა და მიიღეთ დახმარება',
    'my_tickets': 'ჩემი ტიკეტები',
    'view_manage_tickets': 'იხილეთ და მართეთ თქვენი მხარდაჭერის ტიკეტები',
    'faq': 'ხშირად დასმული კითხვები',
    'faq_verify_identity_q': 'როგორ დავადასტურო პირადობა?',
    'faq_verify_identity_a':
        'გადადით პარამეტრები > ვერიფიკაცია და მიჰყევით ნაბიჯებს პირადობის მოწმობისა და სახის ამოცნობის გამოყენებით.',
    'faq_vote_not_showing_q': 'რატომ არ ჩანს ჩემი ხმა?',
    'faq_vote_not_showing_a':
        'ხმები იწერება ანონიმურად და დაცულია კავშირის გაწყვეტის გარანტიით. თუ განახლების შემდეგაც არ აისახა, მიწერეთ ჯგუფის კოორდინატორს ან მხარდაჭერას ელფოსტით.',
    'faq_change_region_q': 'როგორ შევცვალო რეგიონი?',
    'faq_change_region_a':
        'ჯგუფის ან რეგიონის შეცვლის მოთხოვნით მიწერეთ ჯგუფის კოორდინატორს ჩათში ან ERTAD-ის მხარდაჭერის ელფოსტაზე.',
    'email_support': 'ელფოსტით მხარდაჭერა',

    // Tickets
    'no_tickets_yet': 'ტიკეტები ჯერ არ არის',
    'tickets_appear_here':
        'მხარდაჭერის ტიკეტების შექმნის შემდეგ, ისინი აქ გამოჩნდება.',
    'failed_load_tickets': 'ტიკეტების ჩატვირთვა ვერ მოხერხდა',
    'create_ticket': 'ტიკეტის შექმნა',
    'ticket_created': 'ტიკეტი შეიქმნა',
    'ticket_submitted_success': 'თქვენი ტიკეტი წარმატებით გაიგზავნა.',
    'support_response': 'ჩვენი მხარდაჭერის გუნდი რაც შეიძლება მალე უპასუხებს.',
    'category': 'კატეგორია',
    'priority': 'პრიორიტეტი',
    'subject': 'თემა',
    'subject_hint': 'თქვენი პრობლემის მოკლე აღწერა',
    'enter_subject': 'გთხოვთ შეიყვანოთ თემა',
    'subject_min_chars': 'თემა უნდა იყოს მინიმუმ 5 სიმბოლო',
    'message_label': 'შეტყობინება',
    'message_hint':
        'დეტალურად აღწერეთ თქვენი პრობლემა. ჩართეთ ნებისმიერი რელევანტური ინფორმაცია, რომელიც დაგვეხმარება უკეთ.',
    'describe_issue': 'გთხოვთ აღწეროთ თქვენი პრობლემა',
    'provide_more_details': 'გთხოვთ მიაწოდოთ მეტი დეტალი (მინიმუმ 20 სიმბოლო)',
    'tip_include_steps':
        'რჩევა: ჩართეთ პრობლემის გამეორების ნაბიჯები და შეცდომის შეტყობინებები უფრო სწრაფი გადაწყვეტისთვის.',
    'submit_ticket': 'ტიკეტის გაგზავნა',
    'failed_create_ticket': 'ტიკეტის შექმნა ვერ მოხერხდა',
    'response_sent': 'პასუხი გაიგზავნა',
    'ticket_number': 'ტიკეტი #',
    'ticket_details': 'ტიკეტის დეტალები',
    'ticket_closed_notice': 'ეს ტიკეტი დახურულია.',
    'reply_hint': 'ჩაწერეთ პასუხი...',
    'just_now': 'ახლახან',
    'message_type_critical': 'კრიტიკული',
    'message_type_announcement': 'ანონსი',
    'message_type_alert': 'გაფრთხილება',
    'message_type_reminder': 'შეხსენება',
    'message_type_info': 'ინფორმაცია',

    'scan_qr_code': 'QR კოდის სკანირება',
    'or_enter_manually': 'ან შეიყვანეთ ხელით',
    'paste_clipboard': 'ბუფერიდან ჩასმა',
    'amount': 'თანხა',
    'action_cannot_undone': 'ეს ქმედება ვერ გაუქმდება.',
    'failed_send': 'გაგზავნა ვერ მოხერხდა',
    'copy': 'კოპირება',
    'share': 'გაზიარება',
    // Voting - Referendum
    'referendum_title': 'რეფერენდუმი',
    'vote_anonymous_warning':
        'თქვენი ხმა ანონიმურია და ვერ შეიცვლება გაგზავნის შემდეგ.',

    // Voting - Survey
    'survey_title': 'გამოკითხვა',
    'no_questions': 'ამ გამოკითხვას კითხვები არ აქვს.',
    'question_of': 'კითხვა',
    'of': '-დან',
    'single_choice': 'ერთი არჩევანი',
    'multiple_choice': 'მრავალი არჩევანი',
    'text_response': 'ტექსტური პასუხი',
    'rating_scale': 'შეფასების შკალა',
    'ranked_choice': 'რანჟირებული არჩევანი',
    'select_all_apply': 'აირჩიეთ ყველა შესაბამისი',
    'type_your_answer': 'შეიყვანეთ თქვენი პასუხი...',
    'response_anonymous':
        'თქვენი პასუხი ანონიმურია და მხოლოდ აგრეგირებული სახით გამოჩნდება.',
    'tap_to_rank': 'შეეხეთ ვარიანტებს მათ რანჟირებისთვის',
    'your_ranking': 'თქვენი რანჟირება:',
    'available_options': 'ხელმისაწვდომი ვარიანტები:',
    'tap_to_add': 'შეეხეთ დასამატებლად:',
    'submit_survey': 'გამოკითხვის გაგზავნა',
    'leave_survey': 'გამოკითხვის დატოვება?',
    'progress_lost':
        'თქვენი პროგრესი დაიკარგება. დარწმუნებული ხართ, რომ გსურთ გასვლა?',
    'stay': 'დარჩენა',
    'leave': 'გასვლა',
    'answered_questions': 'თქვენ უპასუხეთ',
    'questions': 'კითხვას.',
    'responses_anonymous':
        'თქვენი პასუხები ანონიმურია და ვერ მოხდება თქვენთან დაკავშირება.',
    'cannot_change_answers': 'გაგზავნის შემდეგ, ვერ შეცვლით პასუხებს.',
    'review': 'გადახედვა',
    'submit': 'გაგზავნა',
    'survey_submitted': 'გამოკითხვა გაიგზავნა!',
    'questions_answered': 'კითხვებზე პასუხგაცემული',
    'responses_protected':
        'თქვენი პასუხები ანონიმურია და დაცულია ჩვენი კონფიდენციალურობის სისტემით.',
    'please_answer_required': 'გთხოვთ უპასუხოთ სავალდებულო კითხვას',
    'you_selected': 'თქვენ აირჩიეთ:',
    'survey_already_submitted': 'გამოკითხვა უკვე გაგზავნილია. განახლება...',
    'failed_submit_survey': 'გამოკითხვის გაგზავნა ვერ მოხერხდა',
    'step_1_4_challenge': 'ნაბიჯი 1/4: გამოწვევის მოთხოვნა...',
    'step_2_4_response_binding':
        'ნაბიჯი 2/4: პასუხების კრიპტოგრაფიული დაფიქსირება...',
    'step_3_4_attestation': 'ნაბიჯი 3/4: მოწყობილობის ატესტაციის გაცემა...',
    'step_4_4_submitting': 'ნაბიჯი 4/4: გამოკითხვის გაგზავნა...',

    // Confirm Vote
    'you_are_voting_for': 'თქვენ ხმას აძლევთ:',
    'in_poll': 'კენჭისყრაში:',
    'vote_already_recorded': 'ხმა უკვე ჩაწერილია. განახლება...',
    'failed_submit_vote': 'ხმის გაგზავნა ვერ მოხერხდა',

    // Dashboard
    'no_polls_available': 'კენჭისყრები არ არის ხელმისაწვდომი',
    'pull_to_refresh': 'ჩამოწიეთ განახლებისთვის',
    'no_messages_yet': 'შეტყობინებები ჯერ არ არის',
    'announcements_here':
        'თქვენი რეგიონის განცხადებები და შეტყობინებები აქ გამოჩნდება.',
    'no_recent_updates': 'ბოლო განახლებები არ არის',
    'citizen_user': 'მოქალაქე',
    'enrolled': 'რეგისტრირებული',
    'security_privacy': 'უსაფრთხოება და კონფიდენციალურობა',
    'logout_confirm':
        'დარწმუნებული ხართ, რომ გსურთ გასვლა? ხმის მისაცემად ხელახლა რეგისტრაცია დაგჭირდებათ.',
    'failed_load_polls': 'კენჭისყრების ჩატვირთვა ვერ მოხერხდა',
    'failed_load_messages': 'შეტყობინებების ჩატვირთვა ვერ მოხერხდა',

    // Wave M1 Adaptive 5-Tab Shell & Privacy Hub
    'nav_status': 'სტატუსი',
    'nav_home': 'მთავარი',
    'nav_tasks': 'დავალებები',
    'nav_polls': 'კენჭისყრა',
    'org_context_switch': 'ორგანიზაცია და ჯგუფი',
    'inbox_title': 'ინბოქსი',
    'inbox_filter_action': 'რეაგირებას ითხოვს',
    'inbox_filter_unread': 'წაუკითხავი',
    'inbox_filter_all': 'ყველა',
    'inbox_empty_title': 'ყველა შეტყობინება წაკითხულია',
    'inbox_empty_body':
        'ღონისძიებების შეხსენებები, გადაწყვეტილებები, დავალებები და ქულები აქ გამოჩნდება.',
    'account_privacy_title': 'ანგარიში და ანონიმურობა',
    'privacy_title': 'პროფილის ხილვადობა და ანონიმურობა',
    'privacy_private': 'ანონიმური',
    'privacy_private_desc':
        'ნაგულისხმევი · ჯგუფებში ჩანს მხოლოდ ანონიმური კოდი, სახელი დაფარულია.',
    'privacy_optin': 'საჯარო',
    'privacy_optin_desc':
        'ჯგუფებში, ჩათსა და სიებში ჩანს თქვენი არჩეული სახელი.',
    'privacy_ballot_notice':
        'ანონიმური კენჭისყრის ბიულეტენი არასდროს უკავშირდება პროფილის ხილვადობას.',
    'theme_mode': 'თემა',
    'theme_system': 'სისტემური',
    'theme_light': 'ნათელი',
    'theme_dark': 'მუქი',
    'language_label': 'ენა',
    'dev_persona_title': 'Dev პერსონა (გადახედვა)',
    'dev_persona_member': 'წევრი',
    'dev_persona_manager': 'ჯგუფის მენეჯერი',
    'dev_persona_hint':
        'მხოლოდ დეველოპმენტის გადახედვა; რეალური უფლებები სერვერზე მოწმდება.',
    'sessions_security': 'სესიები, 2FA და Passkey',
    'notification_prefs': 'შეტყობინებების პარამეტრები',
    'support_tickets': 'მხარდაჭერა და დახმარება',
    'coming_in_m2_m3': 'ლაივ ბაზასთან სინქრონიზაცია ემატება M2/M3 ტალღაში',
    'home_requires_action': 'მოითხოვს თქვენს რეაგირებას',
    'home_schedule_48h': 'უახლოესი 48 საათი',
    'home_kpi_tasks': 'ღია დავალებები',
    'home_kpi_polls': 'აქტიური ხმები',
    'home_kpi_events': '48-სთ ივენთი',
    'home_kpi_inbox': 'წაუკითხავი',
    'home_manager_bar': 'ჯგუფის მენეჯერის რიგი',
    'status_points_title': 'კონტრიბუციის ქულები (ხილულ სკოპში)',
    'status_points_note':
        'მხოლოდ პრივატული ისტორია — ლიდერბორდების, XP-ს და ფულადი გადაცვლის გარეშე.',
    'status_memberships_title': 'წევრობები და კონფიდენციალურობა',
    'tasks_filter_tasks': 'დავალებები',
    'tasks_filter_events': 'ღონისძიებები',
    'tasks_filter_calendar': 'კალენდარი',
    'tasks_pledge_notice':
        'დაპირებული პლეჯები მკაფიოდ გამიჯნულია დადასტურებული შეგროვილი თანხისგან.',
    'messages_filter_all': 'ყველა',
    'messages_filter_unread': 'წაუკითხავი',
    'messages_filter_tasks': 'დავალების ჩათი',
    'messages_filter_archived': 'არქივი',
    'polls_filter_live': 'მიმდინარე',
    'polls_filter_referendum': 'რეფერენდუმი',
    'polls_filter_survey': 'გამოკითხვა',
    'polls_filter_ended': 'დასრულებული',
    'votes_label': 'ხმა',
    'failed_send_status': 'პასუხის გაგზავნა ვერ მოხერხდა',
    'support': 'მხარდაჭერა',
    'you': 'შენ',
    'personal_number': 'პირადი ნომერი',
    'invalid_date_format': 'თარიღის ფორმატი არასწორია',
    'failed_load_ticket': 'მიმართვის ჩატვირთვა ვერ მოხერხდა',
  };
}

/// Extension for easy access to translations
extension LocalizationExtension on BuildContext {
  LocalizationService get loc =>
      throw UnimplementedError('Use Provider.of<LocalizationService>(context)');

  String tr(String key) {
    try {
      // This will be accessed via Provider in the widget tree
      return key;
    } catch (e) {
      return key;
    }
  }
}
