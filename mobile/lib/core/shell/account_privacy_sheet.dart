import 'package:flutter/foundation.dart' show kReleaseMode;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../screens/auth/sign_in_screen.dart';
import '../../screens/settings/help_screen.dart';
import '../../services/localization_service.dart';
import '../state/shell_providers.dart';
import '../theme/ertad_theme.dart';
import '../widgets/ertad_ui.dart';
import 'shell_l10n.dart';

/// Opens the clean, compact Settings & Privacy sheet.
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
                    icon: Icons.tune_rounded,
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
                      // 1. Compact Visibility Toggle (Anonymous | Public)
                      Text(
                        shellTr(
                          context,
                          'privacy_title',
                          fallback: 'Profile visibility',
                        ),
                        style: Theme.of(context).textTheme.labelLarge
                            ?.copyWith(color: p.muted),
                      ),
                      const SizedBox(height: 8),
                      SegmentedButton<PrivacyDisclosureLevel>(
                        showSelectedIcon: false,
                        segments: [
                          ButtonSegment<PrivacyDisclosureLevel>(
                            value: PrivacyDisclosureLevel.privateHidden,
                            icon: const Icon(Icons.visibility_off_outlined, size: 17),
                            label: Text(
                              shellTr(
                                context,
                                'privacy_private',
                                fallback: 'Anonymous',
                              ),
                            ),
                          ),
                          ButtonSegment<PrivacyDisclosureLevel>(
                            value: PrivacyDisclosureLevel.sharedContextOptIn,
                            icon: const Icon(Icons.badge_outlined, size: 17),
                            label: Text(
                              shellTr(
                                context,
                                'privacy_optin',
                                fallback: 'Public',
                              ),
                            ),
                          ),
                        ],
                        selected: <PrivacyDisclosureLevel>{session.privacyLevel},
                        onSelectionChanged: (sel) {
                          if (sel.isEmpty) return;
                          HapticFeedback.selectionClick();
                          ref
                              .read(shellSessionProvider.notifier)
                              .setPrivacyLevel(sel.first);
                        },
                      ),
                      const SizedBox(height: 6),
                      Text(
                        session.privacyLevel ==
                                PrivacyDisclosureLevel.privateHidden
                            ? shellTr(
                                context,
                                'privacy_private_desc',
                                fallback:
                                    'Only an anonymous code is shown in groups.',
                              )
                            : shellTr(
                                context,
                                'privacy_optin_desc',
                                fallback:
                                    'Your chosen name is visible in groups and chats.',
                              ),
                        style: Theme.of(
                          context,
                        ).textTheme.bodySmall?.copyWith(color: p.muted),
                      ),

                      const SizedBox(height: 18),

                      // 2. Opt-in Parallel Notification Channels (Push / Telegram / WhatsApp / Viber)
                      _NotificationChannelsSection(
                        channels: session.notificationChannels,
                        isLiveConnected: session.isLiveConnected,
                        onToggle: (channel, enabled, handle) async {
                          HapticFeedback.selectionClick();
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

                      const SizedBox(height: 18),

                      // 3. Appearance & Language (compact icon-driven controls)
                      Text(
                        shellTr(context, 'theme_mode', fallback: 'Theme'),
                        style: Theme.of(context).textTheme.labelLarge
                            ?.copyWith(color: p.muted),
                      ),
                      const SizedBox(height: 8),
                      SegmentedButton<ThemeMode>(
                        showSelectedIcon: false,
                        segments: [
                          ButtonSegment<ThemeMode>(
                            value: ThemeMode.system,
                            icon: const Icon(Icons.brightness_auto_outlined, size: 17),
                            label: Text(
                              shellTr(context, 'theme_system', fallback: 'Auto'),
                            ),
                          ),
                          ButtonSegment<ThemeMode>(
                            value: ThemeMode.light,
                            icon: const Icon(Icons.light_mode_outlined, size: 17),
                            label: Text(
                              shellTr(context, 'theme_light', fallback: 'Light'),
                            ),
                          ),
                          ButtonSegment<ThemeMode>(
                            value: ThemeMode.dark,
                            icon: const Icon(Icons.dark_mode_outlined, size: 17),
                            label: Text(
                              shellTr(context, 'theme_dark', fallback: 'Dark'),
                            ),
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
                      if (loc != null) ...[
                        const SizedBox(height: 12),
                        SegmentedButton<AppLanguage>(
                          showSelectedIcon: false,
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
                      ],

                      const SizedBox(height: 18),

                      // 4. Account & Help (unified clean list)
                      ErtadSurfaceCard(
                        padding: EdgeInsets.zero,
                        child: Column(
                          children: [
                            ListTile(
                              minTileHeight: 52,
                              leading: Icon(Icons.login_rounded, color: p.primary),
                              title: Text(
                                shellTr(
                                  context,
                                  'open_signin_screen',
                                  fallback: 'Google Sign-In / Switch account',
                                ),
                              ),
                              trailing: Icon(
                                Icons.chevron_right_rounded,
                                color: p.muted,
                              ),
                              onTap: () {
                                HapticFeedback.selectionClick();
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
                            ),
                            Divider(height: 1, color: p.hairline),
                            ListTile(
                              minTileHeight: 52,
                              leading: Icon(
                                Icons.help_outline_rounded,
                                color: p.primary,
                              ),
                              title: Text(
                                shellTr(
                                  context,
                                  'help_support',
                                  fallback: 'Help',
                                ),
                              ),
                              trailing: Icon(
                                Icons.chevron_right_rounded,
                                color: p.muted,
                              ),
                              onTap: () {
                                HapticFeedback.selectionClick();
                                final nav = Navigator.of(
                                  context,
                                  rootNavigator: true,
                                );
                                nav.pop();
                                nav.push(
                                  MaterialPageRoute<void>(
                                    builder: (_) => const HelpScreen(),
                                  ),
                                );
                              },
                            ),
                          ],
                        ),
                      ),

                      if (!kReleaseMode) ...[
                        const SizedBox(height: 18),
                        Text(
                          shellTr(
                            context,
                            'dev_persona_title',
                            fallback: 'Dev Workspace Persona',
                          ),
                          style: Theme.of(context).textTheme.labelSmall
                              ?.copyWith(color: p.muted),
                        ),
                        const SizedBox(height: 8),
                        SegmentedButton<DevPersona>(
                          showSelectedIcon: false,
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
        title: Text(
          '$label · ${shellTr(ctx, 'notif_ch_enter_handle', fallback: 'Enter contact')}',
        ),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: InputDecoration(
            hintText: shellTr(
              ctx,
              'notif_ch_handle_hint',
              fallback: '@username or +995...',
            ),
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
            fallback: 'Notification channels',
          ),
          style: Theme.of(
            context,
          ).textTheme.labelLarge?.copyWith(color: p.muted),
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
                    shellTr(context, 'notif_ch_push', fallback: 'Push'),
                  ),
              };
              final statusText = platformEnabled
                  ? shellTr(context, 'notif_ch_live', fallback: 'Active')
                  : shellTr(
                      context,
                      'notif_ch_pending_setup',
                      fallback: 'Off',
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
