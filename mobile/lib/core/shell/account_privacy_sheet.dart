import 'package:flutter/foundation.dart' show kReleaseMode;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../screens/auth/sign_in_screen.dart';
import '../../screens/enrollment/intro_screen.dart';
import '../../screens/settings/help_screen.dart';
import '../../services/localization_service.dart';
import '../state/shell_providers.dart';
import '../theme/ertad_theme.dart';
import '../widgets/ertad_ui.dart';
import 'org_context_sheet.dart';
import 'shell_l10n.dart';

/// Opens the universal Account, Privacy & Settings hub sheet.
Future<void> showAccountPrivacySheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => const AccountPrivacySheet(),
  );
}

class AccountPrivacySheet extends ConsumerWidget {
  const AccountPrivacySheet({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = context.ertad;
    final themeMode = ref.watch(themeModeProvider);
    final session = ref.watch(shellSessionProvider);
    final loc = maybeLocalizationOf(context);
    final currentLang = loc?.currentLanguage ?? AppLanguage.english;

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.78,
      minChildSize: 0.5,
      maxChildSize: 0.94,
      builder: (context, scrollController) {
        final bottomInset = MediaQuery.viewPaddingOf(context).bottom;
        return Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 640),
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 12, 8),
                  child: ErtadModalSheetHeader(
                    icon: Icons.shield_outlined,
                    title: shellTr(
                      context,
                      'account_privacy_title',
                      fallback: 'Account & Privacy',
                    ),
                    closeTooltip: shellTr(context, 'close', fallback: 'Close'),
                  ),
                ),
                Expanded(
                  child: ListView(
                    controller: scrollController,
                    padding: EdgeInsets.fromLTRB(16, 4, 16, 28 + bottomInset),
                    children: [

                // 0. Active Organization / Group Switcher (obvious, zero hidden tiny header tap)
                ErtadSurfaceCard(
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          ErtadIconCircle(
                            icon: session.m4AssuranceLevel ==
                                    'biometric_verified'
                                ? Icons.verified_user_rounded
                                : Icons.fingerprint_rounded,
                            tone: session.m4AssuranceLevel ==
                                    'biometric_verified'
                                ? ErtadTone.success
                                : ErtadTone.primary,
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  shellTr(
                                    context,
                                    'm4_assurance_title',
                                    fallback: 'Identity & device assurance',
                                  ),
                                  style: Theme.of(context).textTheme.titleSmall,
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  session.m4AssuranceLevel ==
                                          'biometric_verified'
                                      ? shellTr(
                                          context,
                                          'm4_verified_badge',
                                          fallback: 'eID biometric verified',
                                        )
                                      : shellTr(
                                          context,
                                          'm4_google_scoped_badge',
                                          fallback:
                                              'Google scoped · eID biometric verification pending',
                                        ),
                                  style: Theme.of(context).textTheme.bodySmall
                                      ?.copyWith(color: p.muted),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 10),
                      SizedBox(
                        width: double.infinity,
                        child: FilledButton.tonalIcon(
                          onPressed: () {
                            final nav = Navigator.of(
                              context,
                              rootNavigator: true,
                            );
                            nav.pop();
                            nav.push(
                              MaterialPageRoute<void>(
                                builder: (_) => const IntroScreen(),
                              ),
                            );
                          },
                          icon: const Icon(Icons.verified_outlined, size: 18),
                          label: Text(
                            session.m4AssuranceLevel == 'biometric_verified'
                                ? shellTr(
                                    context,
                                    'profile_reverify_cta',
                                    fallback: 'Biometric re-check / Re-verify',
                                  )
                                : shellTr(
                                    context,
                                    'm4_start_biometric',
                                    fallback: 'Start eID biometric verification',
                                  ),
                          ),
                        ),
                      ),
                      const SizedBox(height: 8),
                      SizedBox(
                        width: double.infinity,
                        child: OutlinedButton.icon(
                          onPressed: () {
                            final nav = Navigator.of(
                              context,
                              rootNavigator: true,
                            );
                            nav.pop();
                            nav.push(
                              MaterialPageRoute<void>(
                                builder: (_) => const SignInScreen(),
                              ),
                            );
                          },
                          icon: const Icon(Icons.login_rounded, size: 18),
                          label: Text(
                            shellTr(
                              context,
                              'open_signin_screen',
                              fallback: 'Google Sign-In / Switch account',
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                ErtadSurfaceCard(
                  onTap: () {
                    final hostContext = Navigator.of(
                      context,
                      rootNavigator: true,
                    ).context;
                    Navigator.of(context).pop();
                    showOrgContextSheet(hostContext);
                  },
                  padding: const EdgeInsets.all(14),
                  child: Row(
                    children: [
                      const ErtadIconCircle(
                        icon: Icons.groups_2_rounded,
                        tone: ErtadTone.primary,
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              shellTr(
                                context,
                                'org_context_switch',
                                fallback: 'Organization & Group',
                              ),
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                            const SizedBox(height: 2),
                            Text(
                              '${session.activeOrg.name} · ${session.activeOrg.unitName}',
                              style: Theme.of(context).textTheme.titleMedium,
                            ),
                          ],
                        ),
                      ),
                      Icon(Icons.chevron_right_rounded, color: p.muted),
                    ],
                  ),
                ),
                const SizedBox(height: 16),

                // 1. Privacy & Anonymity Disclosure Selector (Private default)
                Text(
                  shellTr(
                    context,
                    'privacy_title',
                    fallback: 'Profile visibility & anonymity',
                  ),
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 8),
                _PrivacyOptionTile(
                  level: PrivacyDisclosureLevel.privateHidden,
                  selected:
                      session.privacyLevel ==
                      PrivacyDisclosureLevel.privateHidden,
                  title: shellTr(
                    context,
                    'privacy_private',
                    fallback: 'Private (Default)',
                  ),
                  description: shellTr(
                    context,
                    'privacy_private_desc',
                    fallback:
                        'Only an anonymous ID is shown within groups; personal fields stay hidden.',
                  ),
                  icon: Icons.visibility_off_outlined,
                  onTap: () => ref
                      .read(shellSessionProvider.notifier)
                      .setPrivacyLevel(PrivacyDisclosureLevel.privateHidden),
                ),
                const SizedBox(height: 8),
                _PrivacyOptionTile(
                  level: PrivacyDisclosureLevel.sharedContextOptIn,
                  selected:
                      session.privacyLevel ==
                      PrivacyDisclosureLevel.sharedContextOptIn,
                  title: shellTr(
                    context,
                    'privacy_optin',
                    fallback: 'Shared-context Opt-in',
                  ),
                  description: shellTr(
                    context,
                    'privacy_optin_desc',
                    fallback:
                        'Shares your chosen display label only inside the selected group.',
                  ),
                  icon: Icons.badge_outlined,
                  onTap: () => ref
                      .read(shellSessionProvider.notifier)
                      .setPrivacyLevel(
                        PrivacyDisclosureLevel.sharedContextOptIn,
                      ),
                ),
                const SizedBox(height: 10),
                ErtadStateBanner(
                  icon: Icons.how_to_vote_outlined,
                  tone: ErtadTone.primary,
                  message: shellTr(
                    context,
                    'privacy_ballot_notice',
                    fallback:
                        'Anonymous ballots stay strictly unlinkable regardless of profile visibility.',
                  ),
                ),

                const SizedBox(height: 20),

                // 2. Appearance (System / Light / Dark)
                Text(
                  shellTr(context, 'theme_mode', fallback: 'Appearance'),
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 8),
                SegmentedButton<ThemeMode>(
                  showSelectedIcon: false,
                  segments: [
                    ButtonSegment<ThemeMode>(
                      value: ThemeMode.system,
                      label: FittedBox(
                        fit: BoxFit.scaleDown,
                        child: Text(
                          shellTr(context, 'theme_system', fallback: 'System'),
                          maxLines: 1,
                        ),
                      ),
                      icon: const Icon(Icons.brightness_auto_outlined, size: 18),
                    ),
                    ButtonSegment<ThemeMode>(
                      value: ThemeMode.light,
                      label: FittedBox(
                        fit: BoxFit.scaleDown,
                        child: Text(
                          shellTr(context, 'theme_light', fallback: 'Light'),
                          maxLines: 1,
                        ),
                      ),
                      icon: const Icon(Icons.light_mode_outlined, size: 18),
                    ),
                    ButtonSegment<ThemeMode>(
                      value: ThemeMode.dark,
                      label: FittedBox(
                        fit: BoxFit.scaleDown,
                        child: Text(
                          shellTr(context, 'theme_dark', fallback: 'Dark'),
                          maxLines: 1,
                        ),
                      ),
                      icon: const Icon(Icons.dark_mode_outlined, size: 18),
                    ),
                  ],
                  selected: <ThemeMode>{themeMode},
                  onSelectionChanged: (modes) {
                    if (modes.isNotEmpty) {
                      HapticFeedback.selectionClick();
                      ref
                          .read(themeModeProvider.notifier)
                          .setThemeMode(modes.first);
                    }
                  },
                ),

                const SizedBox(height: 16),

                // 3. Language Switch (KA / EN)
                if (loc != null) ...[
                  Text(
                    shellTr(context, 'language_label', fallback: 'Language'),
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 8),
                  SegmentedButton<AppLanguage>(
                    segments: const [
                      ButtonSegment<AppLanguage>(
                        value: AppLanguage.georgian,
                        label: Text('ქართული'),
                      ),
                      ButtonSegment<AppLanguage>(
                        value: AppLanguage.english,
                        label: Text('English'),
                      ),
                    ],
                    selected: <AppLanguage>{currentLang},
                    onSelectionChanged: (langs) {
                      if (langs.isNotEmpty) {
                        HapticFeedback.selectionClick();
                        loc.setLanguage(langs.first);
                      }
                    },
                  ),
                  const SizedBox(height: 16),
                ],

                // 3.5 Opt-in Parallel Notification Channels (Push / Telegram / WhatsApp / Viber)
                _NotificationChannelsSection(
                  channels: session.notificationChannels,
                  isLiveConnected: session.isLiveConnected,
                  onToggle: (channel, enabled, handle) async {
                    try {
                      await ref
                          .read(shellSessionProvider.notifier)
                          .updateNotificationChannel(
                            channel: channel,
                            enabled: enabled,
                            handle: handle,
                          );
                    } catch (_) {
                      // Non-blocking in offline/preview mode.
                    }
                  },
                ),
                const SizedBox(height: 16),

                // 4. Help & Support Entry Point
                ErtadSurfaceCard(
                  padding: EdgeInsets.zero,
                  child: ListTile(
                    minTileHeight: 54,
                    leading: Icon(Icons.help_outline, color: p.primary),
                    title: Text(
                      shellTr(context, 'help_support', fallback: 'Help'),
                    ),
                    trailing: const Icon(Icons.chevron_right_rounded),
                    onTap: () {
                      final nav = Navigator.of(context, rootNavigator: true);
                      nav.pop();
                      nav.push(
                        MaterialPageRoute<void>(
                          builder: (_) => const HelpScreen(),
                        ),
                      );
                    },
                  ),
                ),

                if (!kReleaseMode) ...[
                  const SizedBox(height: 16),
                  Text(
                    shellTr(
                      context,
                      'dev_persona_title',
                      fallback: 'Dev Workspace Persona',
                    ),
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  const SizedBox(height: 8),
                  SegmentedButton<DevPersona>(
                    segments: [
                      ButtonSegment<DevPersona>(
                        value: DevPersona.member,
                        label: Text(
                          shellTr(
                            context,
                            'dev_persona_member',
                            fallback: 'Member',
                          ),
                        ),
                      ),
                      ButtonSegment<DevPersona>(
                        value: DevPersona.groupManager,
                        label: Text(
                          shellTr(
                            context,
                            'dev_persona_manager',
                            fallback: 'Group Manager',
                          ),
                        ),
                      ),
                    ],
                    selected: <DevPersona>{session.devPersona},
                    onSelectionChanged: (personas) {
                      if (personas.isNotEmpty) {
                        HapticFeedback.selectionClick();
                        ref
                            .read(shellSessionProvider.notifier)
                            .setDevPersona(personas.first);
                      }
                    },
                  ),
                ],
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _PrivacyOptionTile extends StatelessWidget {
  final PrivacyDisclosureLevel level;
  final bool selected;
  final String title;
  final String description;
  final IconData icon;
  final VoidCallback onTap;

  const _PrivacyOptionTile({
    required this.level,
    required this.selected,
    required this.title,
    required this.description,
    required this.icon,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    return ErtadSurfaceCard(
      padding: const EdgeInsets.all(14),
      backgroundColor: selected ? p.primarySoft : p.surface,
      borderColor: selected ? p.primary : p.hairline,
      onTap: () {
        HapticFeedback.selectionClick();
        onTap();
      },
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 22, color: selected ? p.primary : p.muted),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 2),
                Text(description, style: Theme.of(context).textTheme.bodySmall),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Icon(
            selected
                ? Icons.check_circle_rounded
                : Icons.radio_button_unchecked_rounded,
            color: selected ? p.primary : p.muted,
          ),
        ],
      ),
    );
  }
}

class _NotificationChannelsSection extends StatelessWidget {
  final List<Map<String, dynamic>> channels;
  final bool isLiveConnected;
  final Future<void> Function(String channel, bool enabled, String? handle)
      onToggle;

  const _NotificationChannelsSection({
    required this.channels,
    required this.isLiveConnected,
    required this.onToggle,
  });

  static const _defaults = <Map<String, dynamic>>[
    {'channel': 'push', 'platformEnabled': false, 'enabled': false, 'handleHint': ''},
    {'channel': 'telegram', 'platformEnabled': false, 'enabled': false, 'handleHint': ''},
    {'channel': 'whatsapp', 'platformEnabled': false, 'enabled': false, 'handleHint': ''},
    {'channel': 'viber', 'platformEnabled': false, 'enabled': false, 'handleHint': ''},
  ];

  Future<String?> _promptHandle(BuildContext context, String label) async {
    final controller = TextEditingController();
    final res = await showDialog<String>(
      context: context,
      useRootNavigator: true,
      builder: (ctx) => AlertDialog(
        title: Text('$label · ${shellTr(ctx, 'notif_ch_enter_handle', fallback: 'Enter contact')}'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: InputDecoration(
            hintText: shellTr(ctx, 'notif_ch_handle_hint', fallback: '@username or +995...'),
            border: const OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: Text(shellTr(ctx, 'cancel', fallback: 'Cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(controller.text.trim()),
            child: Text(shellTr(ctx, 'save', fallback: 'Save')),
          ),
        ],
      ),
    );
    controller.dispose();
    return res;
  }

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final items = channels.isNotEmpty ? channels : _defaults;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          shellTr(
            context,
            'notif_channels_title',
            fallback: 'Notification channels (Opt-in)',
          ),
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 4),
        Text(
          shellTr(
            context,
            'notif_channels_subtitle',
            fallback:
                'Choose where to receive notifications alongside the app. Contact handles are stored encrypted.',
          ),
          style: Theme.of(context).textTheme.bodySmall?.copyWith(color: p.muted),
        ),
        const SizedBox(height: 8),
        ErtadSurfaceCard(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Column(
            children: items.map((ch) {
              final key = ch['channel']?.toString() ?? 'push';
              final enabled = ch['enabled'] == true;
              final platformEnabled = ch['platformEnabled'] == true;
              final hint = ch['handleHint']?.toString() ?? '';
              final (IconData icon, String label) = switch (key) {
                'telegram' => (
                    Icons.send_rounded,
                    shellTr(context, 'notif_ch_telegram', fallback: 'Telegram'),
                  ),
                'whatsapp' => (
                    Icons.chat_rounded,
                    shellTr(context, 'notif_ch_whatsapp', fallback: 'WhatsApp'),
                  ),
                'viber' => (
                    Icons.call_rounded,
                    shellTr(context, 'notif_ch_viber', fallback: 'Viber'),
                  ),
                _ => (
                    Icons.notifications_active_outlined,
                    shellTr(
                      context,
                      'notif_ch_push',
                      fallback: 'Push notifications',
                    ),
                  ),
              };
              final statusText = platformEnabled
                  ? shellTr(context, 'notif_ch_live', fallback: 'Active')
                  : shellTr(
                      context,
                      'notif_ch_pending_setup',
                      fallback: 'Integration not enabled yet',
                    );
              final subtitle =
                  hint.isNotEmpty ? '$hint · $statusText' : statusText;

              return SwitchListTile(
                dense: true,
                secondary: Icon(icon, color: enabled ? p.primary : p.muted),
                title: Text(label),
                subtitle: Text(
                  subtitle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(
                    context,
                  ).textTheme.bodySmall?.copyWith(color: p.muted),
                ),
                value: enabled,
                onChanged: !isLiveConnected
                    ? null
                    : (val) async {
                        String? handle;
                        if (val && key != 'push' && hint.isEmpty) {
                          handle = await _promptHandle(context, label);
                          if (handle == null || handle.isEmpty) return;
                        }
                        await onToggle(key, val, handle);
                      },
              );
            }).toList(growable: false),
          ),
        ),
      ],
    );
  }
}

