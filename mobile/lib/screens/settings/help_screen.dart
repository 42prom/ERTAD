import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../core/shell/account_privacy_sheet.dart';
import '../../core/shell/shell_l10n.dart';
import '../../core/theme/ertad_theme.dart';
import '../../core/widgets/ertad_ui.dart';
import '../../services/localization_service.dart';

class HelpScreen extends StatelessWidget {
  const HelpScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    return Consumer<LocalizationService>(
      builder: (context, loc, child) {
        return ErtadSubpageScaffold(
          title: loc.translate('help_support'),
          body: SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Unified Cobalt-Indigo Support Hero
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(22),
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      colors: [p.orbFill, p.orbHighlight],
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                    ),
                    borderRadius: BorderRadius.circular(22),
                  ),
                  child: Column(
                    children: [
                      const Icon(
                        Icons.support_agent_rounded,
                        size: 44,
                        color: Colors.white,
                      ),
                      const SizedBox(height: 10),
                      Text(
                        loc.translate('how_can_we_help'),
                        style: Theme.of(context).textTheme.headlineSmall
                            ?.copyWith(color: Colors.white),
                        textAlign: TextAlign.center,
                      ),
                      const SizedBox(height: 6),
                      Text(
                        loc.translate('submit_ticket_info'),
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: Colors.white.withValues(alpha: 0.90),
                        ),
                      ),
                    ],
                  ),
                ),

                const SizedBox(height: 20),

                ErtadSectionHeader(
                  icon: Icons.bolt_rounded,
                  title: loc.translate('quick_actions'),
                  tone: ErtadTone.primary,
                ),
                const SizedBox(height: 10),

                _ActionCard(
                  icon: Icons.forum_outlined,
                  title: shellTr(
                    context,
                    'help_ask_group',
                    fallback: 'Ask in group chat',
                  ),
                  subtitle: shellTr(
                    context,
                    'help_ask_group_desc',
                    fallback: 'Open Messages to contact your coordinator or group',
                  ),
                  tone: ErtadTone.primary,
                  onTap: () {
                    final router = GoRouter.maybeOf(context);
                    final nav = Navigator.of(context, rootNavigator: true);
                    if (nav.canPop()) nav.pop();
                    router?.go('/messages');
                  },
                ),

                const SizedBox(height: 10),

                _ActionCard(
                  icon: Icons.shield_outlined,
                  title: shellTr(
                    context,
                    'help_privacy_settings',
                    fallback: 'Privacy & appearance',
                  ),
                  subtitle: shellTr(
                    context,
                    'help_privacy_settings_desc',
                    fallback: 'Manage visibility level, language, and theme',
                  ),
                  tone: ErtadTone.success,
                  onTap: () {
                    final hostContext = Navigator.of(
                      context,
                      rootNavigator: true,
                    ).context;
                    final nav = Navigator.of(context);
                    if (nav.canPop()) nav.pop();
                    if (hostContext.mounted) {
                      showAccountPrivacySheet(hostContext);
                    }
                  },
                ),

                const SizedBox(height: 22),

                ErtadSectionHeader(
                  icon: Icons.quiz_outlined,
                  title: loc.translate('faq'),
                  tone: ErtadTone.secondary,
                ),
                const SizedBox(height: 10),

                _FaqItem(
                  question: loc.translate('faq_verify_identity_q'),
                  answer: loc.translate('faq_verify_identity_a'),
                ),
                _FaqItem(
                  question: loc.translate('faq_vote_not_showing_q'),
                  answer: loc.translate('faq_vote_not_showing_a'),
                ),
                _FaqItem(
                  question: loc.translate('faq_change_region_q'),
                  answer: loc.translate('faq_change_region_a'),
                ),

                const SizedBox(height: 16),

                ErtadSurfaceCard(
                  onTap: () async {
                    await Clipboard.setData(
                      const ClipboardData(text: 'support@ertad.local'),
                    );
                    if (!context.mounted) return;
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(
                        content: Text(
                          shellTr(
                            context,
                            'help_email_copied',
                            fallback: 'Support address copied',
                          ),
                        ),
                      ),
                    );
                  },
                  child: Row(
                    children: [
                      const ErtadIconCircle(
                        icon: Icons.email_outlined,
                        tone: ErtadTone.primary,
                        size: 44,
                        iconSize: 22,
                      ),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              loc.translate('email_support'),
                              style: Theme.of(context).textTheme.titleMedium,
                            ),
                            const SizedBox(height: 3),
                            Text(
                              'support@ertad.local · ${shellTr(context, 'help_tap_to_copy', fallback: 'Tap to copy email address')}',
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ],
                        ),
                      ),
                      Icon(Icons.copy_rounded, size: 18, color: p.muted),
                    ],
                  ),
                ),

                const SizedBox(height: 24),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _ActionCard extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final ErtadTone tone;
  final VoidCallback onTap;

  const _ActionCard({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.tone,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    return ErtadSurfaceCard(
      onTap: onTap,
      child: Row(
        children: [
          ErtadIconCircle(icon: icon, tone: tone, size: 46, iconSize: 24),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 3),
                Text(subtitle, style: Theme.of(context).textTheme.bodySmall),
              ],
            ),
          ),
          Icon(Icons.chevron_right_rounded, color: p.muted),
        ],
      ),
    );
  }
}

class _FaqItem extends StatefulWidget {
  final String question;
  final String answer;

  const _FaqItem({required this.question, required this.answer});

  @override
  State<_FaqItem> createState() => _FaqItemState();
}

class _FaqItemState extends State<_FaqItem> {
  bool _isExpanded = false;

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: ErtadSurfaceCard(
        onTap: () => setState(() => _isExpanded = !_isExpanded),
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    widget.question,
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontSize: 14,
                    ),
                  ),
                ),
                Icon(
                  _isExpanded
                      ? Icons.keyboard_arrow_up_rounded
                      : Icons.keyboard_arrow_down_rounded,
                  color: p.muted,
                ),
              ],
            ),
            if (_isExpanded) ...[
              const SizedBox(height: 10),
              Text(
                widget.answer,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  height: 1.5,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
