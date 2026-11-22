import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../config/app_config.dart';
import '../../models/poll.dart';
import '../../services/storage_service.dart';
import '../network/mobile_api_client.dart';
import '../network/mobile_mappers.dart';
import 'offline_action_queue.dart';

/// User-controlled profile visibility mode within a visible scope.
/// Private is always the strict V1 default.
enum PrivacyDisclosureLevel { privateHidden, sharedContextOptIn }

/// Dev-only persona switch used during M1-M3 UI/UX construction before M4 auth.
enum DevPersona { member, groupManager }

@immutable
class OrgContextSummary {
  final String id;
  final String name;
  final String unitName;
  final String roleLabel;

  const OrgContextSummary({
    required this.id,
    required this.name,
    required this.unitName,
    required this.roleLabel,
  });
}

@immutable
class ShellSessionState {
  final List<OrgContextSummary> organizations;
  final String activeOrgId;
  final PrivacyDisclosureLevel privacyLevel;
  final String? optInDisplayName;
  final DevPersona devPersona;
  final bool hasManagerAuthority;
  final List<MobileDevPersonaInfo> devPersonas;
  final int unreadInboxCount;
  final int unreadMessagesCount;
  final int pendingActionsCount;
  final int openWorkCount;
  final int upcomingEvents48h;
  final int openDecisionsCount;
  final int pendingReviewsCount;
  final int pendingOfflineActionsCount;
  final List<Map<String, dynamic>> urgentItems;
  final List<Poll> livePolls;
  final List<Poll> historyPolls;
  final List<Map<String, dynamic>> liveWorkItems;
  final List<Map<String, dynamic>> myWorkItems;
  final List<Map<String, dynamic>> historyWorkItems;
  final List<Map<String, dynamic>> reviewWorkItems;
  final List<Map<String, dynamic>> pendingReviews;
  final List<Map<String, dynamic>> liveEvents;
  final List<Map<String, dynamic>> liveChannels;
  final List<Map<String, dynamic>> liveInboxItems;
  final String contributionBalance;
  final List<Map<String, dynamic>> contributionEntries;
  final bool isOffline;
  final bool isLiveConnected;
  final bool isLoading;
  final String m4AssuranceLevel;
  final bool m4SodCscaVerified;
  final bool m4RequireDeviceAttestation;
  final bool m4DeviceTrusted;
  final bool m4NeedsSelfieReauth;
  final bool canCreateWork;
  final bool canCreateChannel;
  final bool canCreateDecision;
  final Map<String, dynamic>? referralSummary;
  final List<Map<String, dynamic>> notificationChannels;
  final Map<String, dynamic>? memberProfile;

  const ShellSessionState({
    required this.organizations,
    required this.activeOrgId,
    this.privacyLevel = PrivacyDisclosureLevel.privateHidden,
    this.optInDisplayName,
    this.devPersona = DevPersona.member,
    this.hasManagerAuthority = false,
    this.devPersonas = const [],
    this.unreadInboxCount = 0,
    this.unreadMessagesCount = 0,
    this.pendingActionsCount = 0,
    this.openWorkCount = 0,
    this.upcomingEvents48h = 0,
    this.openDecisionsCount = 0,
    this.pendingReviewsCount = 0,
    this.pendingOfflineActionsCount = 0,
    this.urgentItems = const [],
    this.livePolls = const [],
    this.historyPolls = const [],
    this.liveWorkItems = const [],
    this.myWorkItems = const [],
    this.historyWorkItems = const [],
    this.reviewWorkItems = const [],
    this.pendingReviews = const [],
    this.liveEvents = const [],
    this.liveChannels = const [],
    this.liveInboxItems = const [],
    this.contributionBalance = '0',
    this.contributionEntries = const [],
    this.isOffline = false,
    this.isLiveConnected = false,
    this.isLoading = false,
    this.m4AssuranceLevel = 'google_scoped',
    this.m4SodCscaVerified = false,
    this.m4RequireDeviceAttestation = true,
    this.m4DeviceTrusted = true,
    this.m4NeedsSelfieReauth = false,
    this.canCreateWork = false,
    this.canCreateChannel = false,
    this.canCreateDecision = false,
    this.referralSummary,
    this.notificationChannels = const [],
    this.memberProfile,
  });

  OrgContextSummary get activeOrg => organizations.firstWhere(
    (o) => o.id == activeOrgId,
    orElse: () => organizations.first,
  );

  bool get isGroupManager =>
      hasManagerAuthority || devPersona == DevPersona.groupManager;

  ShellSessionState copyWith({
    List<OrgContextSummary>? organizations,
    String? activeOrgId,
    PrivacyDisclosureLevel? privacyLevel,
    String? optInDisplayName,
    bool clearOptInDisplayName = false,
    DevPersona? devPersona,
    bool? hasManagerAuthority,
    List<MobileDevPersonaInfo>? devPersonas,
    int? unreadInboxCount,
    int? unreadMessagesCount,
    int? pendingActionsCount,
    int? openWorkCount,
    int? upcomingEvents48h,
    int? openDecisionsCount,
    int? pendingReviewsCount,
    int? pendingOfflineActionsCount,
    List<Map<String, dynamic>>? urgentItems,
    List<Poll>? livePolls,
    List<Poll>? historyPolls,
    List<Map<String, dynamic>>? liveWorkItems,
    List<Map<String, dynamic>>? myWorkItems,
    List<Map<String, dynamic>>? historyWorkItems,
    List<Map<String, dynamic>>? reviewWorkItems,
    List<Map<String, dynamic>>? pendingReviews,
    List<Map<String, dynamic>>? liveEvents,
    List<Map<String, dynamic>>? liveChannels,
    List<Map<String, dynamic>>? liveInboxItems,
    String? contributionBalance,
    List<Map<String, dynamic>>? contributionEntries,
    bool? isOffline,
    bool? isLiveConnected,
    bool? isLoading,
    String? m4AssuranceLevel,
    bool? m4SodCscaVerified,
    bool? m4RequireDeviceAttestation,
    bool? m4DeviceTrusted,
    bool? m4NeedsSelfieReauth,
    bool? canCreateWork,
    bool? canCreateChannel,
    bool? canCreateDecision,
    Map<String, dynamic>? referralSummary,
    List<Map<String, dynamic>>? notificationChannels,
    Map<String, dynamic>? memberProfile,
  }) {
    return ShellSessionState(
      organizations: organizations ?? this.organizations,
      activeOrgId: activeOrgId ?? this.activeOrgId,
      privacyLevel: privacyLevel ?? this.privacyLevel,
      optInDisplayName: clearOptInDisplayName
          ? null
          : (optInDisplayName ?? this.optInDisplayName),
      devPersona: devPersona ?? this.devPersona,
      hasManagerAuthority: hasManagerAuthority ?? this.hasManagerAuthority,
      devPersonas: devPersonas ?? this.devPersonas,
      unreadInboxCount: unreadInboxCount ?? this.unreadInboxCount,
      unreadMessagesCount: unreadMessagesCount ?? this.unreadMessagesCount,
      pendingActionsCount: pendingActionsCount ?? this.pendingActionsCount,
      openWorkCount: openWorkCount ?? this.openWorkCount,
      upcomingEvents48h: upcomingEvents48h ?? this.upcomingEvents48h,
      openDecisionsCount: openDecisionsCount ?? this.openDecisionsCount,
      pendingReviewsCount: pendingReviewsCount ?? this.pendingReviewsCount,
      pendingOfflineActionsCount:
          pendingOfflineActionsCount ?? this.pendingOfflineActionsCount,
      urgentItems: urgentItems ?? this.urgentItems,
      livePolls: livePolls ?? this.livePolls,
      historyPolls: historyPolls ?? this.historyPolls,
      liveWorkItems: liveWorkItems ?? this.liveWorkItems,
      myWorkItems: myWorkItems ?? this.myWorkItems,
      historyWorkItems: historyWorkItems ?? this.historyWorkItems,
      reviewWorkItems: reviewWorkItems ?? this.reviewWorkItems,
      pendingReviews: pendingReviews ?? this.pendingReviews,
      liveEvents: liveEvents ?? this.liveEvents,
      liveChannels: liveChannels ?? this.liveChannels,
      liveInboxItems: liveInboxItems ?? this.liveInboxItems,
      contributionBalance: contributionBalance ?? this.contributionBalance,
      contributionEntries: contributionEntries ?? this.contributionEntries,
      isOffline: isOffline ?? this.isOffline,
      isLiveConnected: isLiveConnected ?? this.isLiveConnected,
      isLoading: isLoading ?? this.isLoading,
      m4AssuranceLevel: m4AssuranceLevel ?? this.m4AssuranceLevel,
      m4SodCscaVerified: m4SodCscaVerified ?? this.m4SodCscaVerified,
      m4RequireDeviceAttestation:
          m4RequireDeviceAttestation ?? this.m4RequireDeviceAttestation,
      m4DeviceTrusted: m4DeviceTrusted ?? this.m4DeviceTrusted,
      m4NeedsSelfieReauth: m4NeedsSelfieReauth ?? this.m4NeedsSelfieReauth,
      canCreateWork: canCreateWork ?? this.canCreateWork,
      canCreateChannel: canCreateChannel ?? this.canCreateChannel,
      canCreateDecision: canCreateDecision ?? this.canCreateDecision,
      referralSummary: referralSummary ?? this.referralSummary,
      notificationChannels: notificationChannels ?? this.notificationChannels,
      memberProfile: memberProfile ?? this.memberProfile,
    );
  }
}

/// Manages light/dark/system theme preference safely in SharedPreferences.
class ThemeModeNotifier extends StateNotifier<ThemeMode> {
  static const String _prefKey = 'app_theme_mode';

  ThemeModeNotifier() : super(ThemeMode.system) {
    _load();
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_prefKey);
    if (raw == 'light') {
      state = ThemeMode.light;
    } else if (raw == 'dark') {
      state = ThemeMode.dark;
    } else {
      state = ThemeMode.system;
    }
  }

  Future<void> setThemeMode(ThemeMode mode) async {
    state = mode;
    final prefs = await SharedPreferences.getInstance();
    final value = switch (mode) {
      ThemeMode.light => 'light',
      ThemeMode.dark => 'dark',
      ThemeMode.system => 'system',
    };
    await prefs.setString(_prefKey, value);
  }
}

final themeModeProvider = StateNotifierProvider<ThemeModeNotifier, ThemeMode>(
  (ref) => ThemeModeNotifier(),
);

final mobileApiClientProvider = Provider<MobileApiClient>(
  (ref) => MobileApiClient(),
);

/// Manages shared workspace context, privacy disclosure and live server sync.
class ShellSessionNotifier extends StateNotifier<ShellSessionState> {
  final MobileApiClient _api;
  bool _refreshing = false;

  ShellSessionNotifier(this._api, {bool autoConnect = false})
    : super(
        const ShellSessionState(
          organizations: <OrgContextSummary>[
            OrgContextSummary(
              id: 'org-tbilisi-saburtalo',
              name: 'ERTAD',
              unitName: 'Saburtalo Group',
              roleLabel: 'Member',
            ),
          ],
          activeOrgId: 'org-tbilisi-saburtalo',
        ),
      ) {
    if (autoConnect) {
      connectDevSession();
    }
  }

  static String _modeToWire(PrivacyDisclosureLevel level) {
    return switch (level) {
      PrivacyDisclosureLevel.privateHidden => 'private_hidden',
      PrivacyDisclosureLevel.sharedContextOptIn => 'shared_context_opt_in',
    };
  }

  static PrivacyDisclosureLevel _wireToMode(String? raw) {
    return switch (raw) {
      'shared_context_opt_in' => PrivacyDisclosureLevel.sharedContextOptIn,
      _ => PrivacyDisclosureLevel.privateHidden,
    };
  }

  /// Connects using a local development persona session and loads real database state.
  Future<void> connectDevSession({DevPersona? targetPersona}) async {
    state = state.copyWith(isLoading: true, isOffline: false);
    try {
      final fetched = await _api.fetchDevPersonas();
      if (!fetched.enabled || fetched.personas.isEmpty) {
        state = state.copyWith(
          isLoading: false,
          isOffline: false,
          isLiveConnected: false,
        );
        return;
      }

      final desired = targetPersona ?? state.devPersona;
      final wireKind =
          desired == DevPersona.groupManager ? 'group_manager' : 'member';
      final chosen = fetched.personas.firstWhere(
        (p) => p.roleKind == wireKind,
        orElse: () => fetched.personas.first,
      );

      await _api.devLogin(chosen.id);
      state = state.copyWith(
        devPersonas: fetched.personas,
        devPersona: chosen.roleKind == 'group_manager'
            ? DevPersona.groupManager
            : DevPersona.member,
      );
      await refreshWorkspace();
    } catch (e) {
      debugPrint('[ShellSession] connectDevSession failed: $e');
      state = state.copyWith(
        isLoading: false,
        isOffline: true,
        isLiveConnected: false,
      );
    }
  }

  /// Reloads single-round-trip bootstrap + domain snapshots from the database API.
  Future<void> refreshWorkspace() async {
    if (_refreshing) return;
    _refreshing = true;
    try {
      final boot = await _api.fetchWorkspaceBootstrap();
      final workOrgs = (boot['work'] as List? ?? const []);
      final decOrgs = (boot['decisions'] as List? ?? const []);
      final chOrgs = (boot['channels'] as List? ?? const []);
      final unitsOrgs = (boot['units'] as List? ?? const []);
      final sourceOrgs = unitsOrgs.isNotEmpty
          ? unitsOrgs
          : workOrgs.isNotEmpty
          ? workOrgs
          : decOrgs.isNotEmpty
          ? decOrgs
          : chOrgs;

      final List<OrgContextSummary> parsedOrgs = sourceOrgs.map((raw) {
        final m = Map<String, dynamic>.from(raw as Map);
        return OrgContextSummary(
          id: m['id']?.toString() ?? '',
          name: m['name']?.toString() ?? 'ERTAD',
          unitName: state.devPersonas.isNotEmpty
              ? state.devPersonas.first.unitName
              : 'Group',
          roleLabel: state.isGroupManager ? 'Group Manager' : 'Member',
        );
      }).where((o) => o.id.isNotEmpty).toList();

      final orgId = parsedOrgs.isNotEmpty
          ? (parsedOrgs.any((o) => o.id == state.activeOrgId)
                ? state.activeOrgId
                : parsedOrgs.first.id)
          : state.activeOrgId;

      final summary = Map<String, dynamic>.from(boot['summary'] as Map? ?? const {});
      final inbox = Map<String, dynamic>.from(boot['inbox'] as Map? ?? const {});
      final urgent = (summary['urgent'] as List? ?? const [])
          .map((e) => Map<String, dynamic>.from(e as Map))
          .toList();
      final bool hasServerManager =
          ((boot['reviews'] as List?)?.isNotEmpty ?? false) ||
          (((summary['pendingReviews'] as num?)?.toInt() ?? 0) > 0);
      final bool effectiveManager =
          hasServerManager || state.devPersona == DevPersona.groupManager;

      int unreadCh = 0;
      for (final rawCh in chOrgs) {
        if (rawCh is Map && rawCh['unread'] is num) {
          unreadCh += (rawCh['unread'] as num).toInt();
        }
      }

      PrivacyDisclosureLevel privacyLevel = state.privacyLevel;
      String? displayName = state.optInDisplayName;
      List<Poll> polls = state.livePolls;
      List<Poll> historyPolls = state.historyPolls;
      List<Map<String, dynamic>> workItems = state.liveWorkItems;
      List<Map<String, dynamic>> myWork = state.myWorkItems;
      List<Map<String, dynamic>> historyWork = state.historyWorkItems;
      List<Map<String, dynamic>> reviewWork = effectiveManager
          ? state.reviewWorkItems
          : const [];
      List<Map<String, dynamic>> reviewsList = effectiveManager
          ? state.pendingReviews
          : const [];
      List<Map<String, dynamic>> events = state.liveEvents;
      List<Map<String, dynamic>> channels = state.liveChannels;
      List<Map<String, dynamic>> inboxItems = state.liveInboxItems;
      String pointsBalance = state.contributionBalance;
      List<Map<String, dynamic>> pointsEntries = state.contributionEntries;
      bool canCreateWork = false;
      bool canCreateChannel = false;
      bool canCreateDecision = false;
      int liveInboxUnread = (inbox['unread'] as num?)?.toInt() ?? 0;

      if (orgId.isNotEmpty && !orgId.startsWith('org-')) {
        final priv = await _api.fetchPrivacy(orgId);
        privacyLevel = _wireToMode(priv['disclosureMode']?.toString());
        displayName = priv['displayName']?.toString();

        final results = await Future.wait([
          _api.fetchDecisions(organizationId: orgId, view: 'open'),
          _api.fetchWorkItems(organizationId: orgId, view: 'open'),
          _api.fetchEvents(organizationId: orgId, status: 'open'),
          _api.fetchChannels(
            organizationId: orgId,
            view: 'active',
            kind: 'member_all',
          ),
          _api.fetchInbox(organizationId: orgId, view: 'all'),
          _api
              .fetchDecisions(organizationId: orgId, view: 'closed')
              .catchError((_) => <Map<String, dynamic>>[]),
          _api
              .fetchWorkItems(organizationId: orgId, view: 'mine')
              .catchError((_) => <Map<String, dynamic>>[]),
          _api
              .fetchWorkItems(organizationId: orgId, view: 'completed')
              .catchError((_) => <Map<String, dynamic>>[]),
          _api
              .fetchContributionPoints(organizationId: orgId)
              .catchError((_) => const <String, dynamic>{}),
          _api
              .fetchWorkUnits(organizationId: orgId)
              .catchError((_) => <Map<String, dynamic>>[]),
          _api
              .fetchChannelUnits(organizationId: orgId)
              .catchError((_) => <Map<String, dynamic>>[]),
          _api
              .fetchDecisionAudiences(organizationId: orgId)
              .catchError((_) => <Map<String, dynamic>>[]),
          if (effectiveManager) ...[
            _api
                .fetchWorkItems(organizationId: orgId, view: 'needs_review')
                .catchError((_) => <Map<String, dynamic>>[]),
            _api
                .fetchReviews(organizationId: orgId, view: 'pending')
                .catchError((_) => <Map<String, dynamic>>[]),
          ],
        ]);
        polls = (results[0] as List<Map<String, dynamic>>)
            .map(decisionJsonToPoll)
            .toList();
        workItems = results[1] as List<Map<String, dynamic>>;
        events = results[2] as List<Map<String, dynamic>>;
        channels = results[3] as List<Map<String, dynamic>>;
        final inboxPayload = results[4] as Map<String, dynamic>;
        historyPolls = (results[5] as List<Map<String, dynamic>>)
            .map(decisionJsonToPoll)
            .toList();
        myWork = results[6] as List<Map<String, dynamic>>;
        historyWork = results[7] as List<Map<String, dynamic>>;
        final ptsPayload = results[8] as Map<String, dynamic>;
        canCreateWork = (results[9] as List<Map<String, dynamic>>).isNotEmpty;
        canCreateChannel =
            (results[10] as List<Map<String, dynamic>>).isNotEmpty;
        canCreateDecision =
            (results[11] as List<Map<String, dynamic>>).isNotEmpty;
        if (effectiveManager && results.length >= 14) {
          reviewWork = results[12] as List<Map<String, dynamic>>;
          reviewsList = results[13] as List<Map<String, dynamic>>;
        }
        if (ptsPayload['balance'] != null) {
          pointsBalance = ptsPayload['balance'].toString();
        }
        pointsEntries = (ptsPayload['entries'] as List? ?? const [])
            .map((e) => Map<String, dynamic>.from(e as Map))
            .toList();

        inboxItems = (inboxPayload['items'] as List? ?? const [])
            .map((e) => Map<String, dynamic>.from(e as Map))
            .toList();
        if (inboxPayload['unread'] is num) {
          liveInboxUnread = (inboxPayload['unread'] as num).toInt();
        }
        int channelUnreadSum = 0;
        for (final ch in channels) {
          final muted = ch['muted'] == true;
          if (!muted) {
            channelUnreadSum +=
                ((ch['unreadCount'] ?? ch['unread']) as num?)?.toInt() ?? 0;
          }
        }
        unreadCh = channelUnreadSum;
      }

      final bool hasLiveDomainSnapshot =
          orgId.isNotEmpty && !orgId.startsWith('org-');
      final votedPollIds = <String>{
        for (final poll in polls)
          if (poll.hasVoted) poll.id,
      };
      final actedEventIds = <String>{
        for (final ev in events)
          if (ev['myRsvp'] is Map &&
              const {'going', 'checked_in'}
                  .contains((ev['myRsvp'] as Map)['status']?.toString()))
            ev['id']?.toString() ?? '',
      };
      final actedWorkIds = <String>{
        for (final w in [...workItems, ...myWork])
          if (const {'applied', 'reserved', 'submitted', 'verified'}
              .contains(w['myStatus']?.toString()))
            w['id']?.toString() ?? '',
      };
      final filteredUrgent = hasLiveDomainSnapshot
          ? urgent.where((item) {
              final kind = (item['kind']?.toString() ?? '').toLowerCase();
              final id = item['id']?.toString() ?? '';
              if (kind == 'decision' && votedPollIds.contains(id)) return false;
              if (kind == 'event' && actedEventIds.contains(id)) return false;
              if (kind == 'work' && actedWorkIds.contains(id)) return false;
              return true;
            }).toList(growable: false)
          : urgent;

      final int derivedOpenDecisions = hasLiveDomainSnapshot
          ? polls.where((p) => p.isActive && !p.hasVoted).length
          : (summary['openDecisions'] as num?)?.toInt() ?? 0;
      final int derivedOpenWork = hasLiveDomainSnapshot
          ? workItems
                .where((w) => !actedWorkIds.contains(w['id']?.toString() ?? ''))
                .length
          : (summary['openWork'] as num?)?.toInt() ?? 0;

      state = state.copyWith(
        organizations: parsedOrgs.isNotEmpty ? parsedOrgs : state.organizations,
        activeOrgId: orgId,
        privacyLevel: privacyLevel,
        optInDisplayName: displayName,
        clearOptInDisplayName: displayName == null,
        unreadInboxCount: liveInboxUnread,
        unreadMessagesCount: unreadCh,
        pendingActionsCount: filteredUrgent.length,
        openWorkCount: derivedOpenWork,
        upcomingEvents48h: (summary['upcomingEvents48h'] as num?)?.toInt() ?? 0,
        openDecisionsCount: derivedOpenDecisions,
        pendingReviewsCount: (summary['pendingReviews'] as num?)?.toInt() ?? 0,
        hasManagerAuthority:
            hasServerManager ||
            canCreateWork ||
            canCreateChannel ||
            canCreateDecision,
        canCreateWork: canCreateWork,
        canCreateChannel: canCreateChannel,
        canCreateDecision: canCreateDecision,
        urgentItems: filteredUrgent,
        livePolls: polls,
        historyPolls: historyPolls,
        liveWorkItems: workItems,
        myWorkItems: myWork,
        historyWorkItems: historyWork,
        reviewWorkItems: reviewWork,
        pendingReviews: reviewsList,
        liveEvents: events,
        liveChannels: channels,
        liveInboxItems: inboxItems,
        contributionBalance: pointsBalance,
        contributionEntries: pointsEntries,
        isOffline: false,
        isLiveConnected: true,
        isLoading: false,
      );
      try {
        String? deviceId;
        try {
          deviceId = await StorageService().getOrCreateInstallationId();
        } catch (_) {}
        final m4 = await _api.fetchM4Status(deviceId: deviceId);
        state = state.copyWith(
          m4AssuranceLevel:
              m4['assuranceLevel']?.toString() ?? state.m4AssuranceLevel,
          m4SodCscaVerified: m4['sodCscaVerified'] == true,
          m4RequireDeviceAttestation: m4['requireDeviceAttestation'] != false,
          m4DeviceTrusted: m4['deviceTrusted'] != false,
          m4NeedsSelfieReauth: m4['needsSelfieReauth'] == true,
        );
      } catch (_) {
        // M4 status enrichment is non-blocking for offline/legacy paths.
      }
      if (orgId.isNotEmpty && !orgId.startsWith('org-')) {
        try {
          final refSum = await _api.fetchReferralSummary(organizationId: orgId);
          state = state.copyWith(referralSummary: refSum);
        } catch (_) {
          // Referral summary enrichment is non-blocking.
        }
        try {
          final chList = await _api.fetchNotificationChannels();
          state = state.copyWith(notificationChannels: chList);
        } catch (_) {
          // Notification channel enrichment is non-blocking.
        }
        try {
          final prof = await _api.fetchMemberProfile();
          state = state.copyWith(memberProfile: prof);
        } catch (_) {
          // Profile enrichment is non-blocking.
        }
      }
      await OfflineActionQueue().flushDetailed(_api);
      final qCount = await OfflineActionQueue().count();
      state = state.copyWith(pendingOfflineActionsCount: qCount);
      await _persistOfflineSnapshot(orgId);
    } catch (_) {
      await _restoreOfflineSnapshotIfEmpty(state.activeOrgId);
      final qCount = await OfflineActionQueue().count().catchError(
        (_) => state.pendingOfflineActionsCount,
      );
      state = state.copyWith(
        isLoading: false,
        isOffline: true,
        pendingOfflineActionsCount: qCount,
      );
    } finally {
      _refreshing = false;
    }
  }

  Future<void> refreshOfflineQueueCount() async {
    try {
      final count = await OfflineActionQueue().count();
      state = state.copyWith(pendingOfflineActionsCount: count);
    } catch (_) {}
  }

  Future<OfflineFlushResult> syncOfflineQueue() async {
    final res = await OfflineActionQueue().flushDetailed(_api);
    state = state.copyWith(pendingOfflineActionsCount: res.remaining);
    if (res.flushed > 0) {
      await refreshWorkspace();
    }
    return res;
  }

  Future<void> _persistOfflineSnapshot(String orgId) async {
    if (orgId.isEmpty || orgId.startsWith('org-')) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      final payload = jsonEncode(<String, dynamic>{
        'work': state.liveWorkItems.take(25).toList(growable: false),
        'myWork': state.myWorkItems.take(25).toList(growable: false),
        'events': state.liveEvents.take(25).toList(growable: false),
        'channels': state.liveChannels.take(25).toList(growable: false),
        'balance': state.contributionBalance,
      });
      await prefs.setString('ertad_offline_cache_$orgId', payload);
    } catch (_) {
      // Cache persistence is best-effort only.
    }
  }

  Future<void> _restoreOfflineSnapshotIfEmpty(String orgId) async {
    if (orgId.isEmpty) return;
    if (state.liveWorkItems.isNotEmpty ||
        state.liveEvents.isNotEmpty ||
        state.liveChannels.isNotEmpty) {
      return;
    }
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString('ertad_offline_cache_$orgId');
      if (raw == null || raw.isEmpty) return;
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return;
      List<Map<String, dynamic>> readList(String k) {
        final v = decoded[k];
        if (v is! List) return const [];
        return v.whereType<Map>().map(Map<String, dynamic>.from).toList();
      }
      state = state.copyWith(
        liveWorkItems: readList('work'),
        myWorkItems: readList('myWork'),
        liveEvents: readList('events'),
        liveChannels: readList('channels'),
        contributionBalance:
            decoded['balance']?.toString() ?? state.contributionBalance,
      );
    } catch (_) {
      // Ignore corrupt cache entries safely.
    }
  }

  void selectOrganization(String orgId) {
    if (state.organizations.any((o) => o.id == orgId)) {
      state = state.copyWith(activeOrgId: orgId);
      if (state.isLiveConnected) {
        refreshWorkspace();
      }
    }
  }

  Future<void> setPrivacyLevel(
    PrivacyDisclosureLevel level, {
    String? displayName,
  }) async {
    state = state.copyWith(
      privacyLevel: level,
      optInDisplayName: displayName,
      clearOptInDisplayName: level == PrivacyDisclosureLevel.privateHidden,
    );
    if (state.isLiveConnected && !state.activeOrgId.startsWith('org-')) {
      try {
        final updated = await _api.updatePrivacy(
          organizationId: state.activeOrgId,
          disclosureMode: _modeToWire(level),
          displayName: displayName,
        );
        state = state.copyWith(
          privacyLevel: _wireToMode(updated['disclosureMode']?.toString()),
          optInDisplayName: updated['displayName']?.toString(),
          clearOptInDisplayName: updated['displayName'] == null,
        );
      } catch (_) {
        // Keep optimistic UI state; server remains source of truth on next refresh.
      }
    }
  }

  Future<void> signOut() async {
    await _api.logout();
    try {
      await OfflineActionQueue().clear();
      final prefs = await SharedPreferences.getInstance();
      for (final key in prefs.getKeys().toList()) {
        if (key.startsWith('ertad_offline_cache_') ||
            key.startsWith('ertad_vote_receipt_')) {
          await prefs.remove(key);
        }
      }
    } catch (_) {}
    state = const ShellSessionState(
      organizations: <OrgContextSummary>[
        OrgContextSummary(
          id: 'org-tbilisi-saburtalo',
          name: 'ERTAD',
          unitName: 'Saburtalo Group',
          roleLabel: 'Member',
        ),
      ],
      activeOrgId: 'org-tbilisi-saburtalo',
      devPersona: DevPersona.member,
      hasManagerAuthority: false,
      canCreateWork: false,
      canCreateChannel: false,
      canCreateDecision: false,
      m4DeviceTrusted: true,
      m4NeedsSelfieReauth: false,
      isLiveConnected: false,
    );
  }

  Future<void> setDevPersona(DevPersona persona) async {
    state = state.copyWith(devPersona: persona);
    if (AppConfig.devWorkspace) {
      await connectDevSession(targetPersona: persona);
    }
  }

  Future<void> markInboxEntryRead({
    required String source,
    required String id,
    required int version,
  }) async {
    if (!state.isLiveConnected || state.activeOrgId.startsWith('org-')) return;
    await _api.markInboxRead(
      organizationId: state.activeOrgId,
      source: source,
      id: id,
      version: version,
    );
    await refreshWorkspace();
  }

  Future<Map<String, dynamic>?> openDirectChat(String peerId) async {
    if (!state.isLiveConnected || state.activeOrgId.startsWith('org-')) {
      return null;
    }
    final ch = await _api.openDirectChannel(
      organizationId: state.activeOrgId,
      peerId: peerId,
    );
    await refreshWorkspace();
    return ch;
  }

  Future<Map<String, dynamic>?> openDirectChatMulti(
    List<String> peerIds, {
    String? title,
  }) async {
    if (!state.isLiveConnected ||
        state.activeOrgId.startsWith('org-') ||
        peerIds.isEmpty) {
      return null;
    }
    if (peerIds.length == 1 && (title == null || title.trim().isEmpty)) {
      return openDirectChat(peerIds.first);
    }
    final ch = await _api.openDirectChannel(
      organizationId: state.activeOrgId,
      peerIds: peerIds,
      title: title,
    );
    await refreshWorkspace();
    return ch;
  }

  Future<Map<String, dynamic>?> addMembersToDirectChat(
    String channelId,
    List<String> peerIds,
  ) async {
    if (!state.isLiveConnected ||
        state.activeOrgId.startsWith('org-') ||
        peerIds.isEmpty) {
      return null;
    }
    final ch = await _api.addDirectChannelMembers(
      organizationId: state.activeOrgId,
      channelId: channelId,
      peerIds: peerIds,
    );
    await refreshWorkspace();
    return ch;
  }

  Future<Map<String, dynamic>> redeemReferralCode(String code) async {
    final orgId = state.activeOrgId;
    final res = await _api.redeemReferralCode(
      organizationId: orgId,
      code: code,
    );
    state = state.copyWith(referralSummary: res);
    await refreshWorkspace();
    return res;
  }

  Future<void> updateNotificationChannel({
    required String channel,
    required bool enabled,
    String? handle,
  }) async {
    final updated = await _api.updateNotificationChannel(
      channel: channel,
      enabled: enabled,
      handle: handle,
    );
    state = state.copyWith(notificationChannels: updated);
  }

  Future<void> updateMemberPhone({String? phone, bool clear = false}) async {
    final updated = await _api.updateMemberPhone(phone: phone, clear: clear);
    state = state.copyWith(memberProfile: updated);
  }

  void updateCounts({int? inbox, int? messages, int? pendingActions}) {
    state = state.copyWith(
      unreadInboxCount: inbox ?? state.unreadInboxCount,
      unreadMessagesCount: messages ?? state.unreadMessagesCount,
      pendingActionsCount: pendingActions ?? state.pendingActionsCount,
    );
  }
}

final shellSessionProvider =
    StateNotifierProvider<ShellSessionNotifier, ShellSessionState>(
      (ref) => ShellSessionNotifier(
        ref.read(mobileApiClientProvider),
        autoConnect: AppConfig.devWorkspace,
      ),
    );

/// One-shot segment requests from Status/Home summary cards to Tasks/Polls tabs.
final tasksSegmentRequestProvider = StateProvider<int?>((ref) => null);
final pollsSegmentRequestProvider = StateProvider<int?>((ref) => null);
