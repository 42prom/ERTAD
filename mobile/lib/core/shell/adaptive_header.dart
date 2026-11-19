import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/shell_providers.dart';
import '../theme/ertad_theme.dart';
import 'account_privacy_sheet.dart';
import 'inbox_sheet.dart';
import 'org_context_sheet.dart';
import 'shell_l10n.dart';

/// Clean frosted SafeArea header for plain members:
/// Group & connection switcher + concise page title + Inbox & Settings buttons.
class AdaptiveHeader extends ConsumerWidget {
  final String title;

  const AdaptiveHeader({super.key, required this.title});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = context.ertad;
    final session = ref.watch(shellSessionProvider);

    final Color privacyAccent = switch (session.privacyLevel) {
      PrivacyDisclosureLevel.privateHidden => p.success,
      PrivacyDisclosureLevel.sharedContextOptIn => p.warning,
    };

    return ClipRect(
      child: BackdropFilter(
        filter: ui.ImageFilter.blur(sigmaX: 16, sigmaY: 16),
        child: Container(
          decoration: BoxDecoration(
            color: p.glassSurface,
            border: Border(bottom: BorderSide(color: p.hairline, width: 1)),
          ),
          child: SafeArea(
            bottom: false,
            child: Center(
              child: ConstrainedBox(
                constraints: BoxConstraints(maxWidth: 640),
                child: Padding(
                  padding: EdgeInsets.fromLTRB(12, 6, 8, 6),
                  child: Row(
                    children: [
                      Semantics(
                        button: true,
                        label: shellTr(
                          context,
                          'org_context_switch',
                          fallback: 'Organization & Group',
                        ),
                        child: Tooltip(
                          message:
                              '${session.activeOrg.unitName} · ${session.activeOrg.name}',
                          child: InkWell(
                            borderRadius: BorderRadius.circular(14),
                            onTap: () {
                              HapticFeedback.selectionClick();
                              showOrgContextSheet(context);
                            },
                            child: SizedBox(
                              width: 48,
                              height: 48,
                              child: Center(
                                child: Stack(
                                  clipBehavior: Clip.none,
                                  children: [
                                    Container(
                                      width: 38,
                                      height: 38,
                                      decoration: BoxDecoration(
                                        color: privacyAccent.withValues(
                                          alpha: p.isDark ? 0.18 : 0.11,
                                        ),
                                        borderRadius: BorderRadius.circular(13),
                                        border: Border.all(
                                          color: privacyAccent.withValues(
                                            alpha: 0.30,
                                          ),
                                        ),
                                      ),
                                      child: Icon(
                                        Icons.groups_2_rounded,
                                        size: 19,
                                        color: privacyAccent,
                                      ),
                                    ),
                                    Positioned(
                                      right: -3,
                                      bottom: -3,
                                      child: session.m4AssuranceLevel ==
                                              'biometric_verified'
                                          ? Container(
                                              decoration: BoxDecoration(
                                                color: p.surface,
                                                shape: BoxShape.circle,
                                              ),
                                              padding: const EdgeInsets.all(1),
                                              child: Icon(
                                                Icons.verified_rounded,
                                                size: 15,
                                                color: p.primary,
                                              ),
                                            )
                                          : Container(
                                              width: 10,
                                              height: 10,
                                              decoration: BoxDecoration(
                                                color: session.isOffline
                                                    ? p.warning
                                                    : p.success,
                                                shape: BoxShape.circle,
                                                border: Border.all(
                                                  color: p.surface,
                                                  width: 1.6,
                                                ),
                                              ),
                                            ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                      SizedBox(width: 8),
                      Expanded(
                        child: Align(
                          alignment: Alignment.centerLeft,
                          child: AnimatedSwitcher(
                            duration: Duration(milliseconds: 160),
                            switchInCurve: Curves.easeOutCubic,
                            switchOutCurve: Curves.easeIn,
                            child: Text(
                              title,
                              key: ValueKey<String>(title),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: Theme.of(context).textTheme.titleLarge,
                            ),
                          ),
                        ),
                      ),
                      _HeaderActionButton(
                        tooltip: shellTr(
                          context,
                          'inbox_title',
                          fallback: 'Inbox',
                        ),
                        badgeCount: session.unreadInboxCount,
                        onPressed: () {
                          HapticFeedback.selectionClick();
                          showInboxSheet(context);
                        },
                        child: Icon(
                          Icons.notifications_none_rounded,
                          color: p.text,
                          size: 21,
                        ),
                      ),
                      SizedBox(width: 2),
                      _HeaderActionButton(
                        tooltip: shellTr(
                          context,
                          'account_privacy_title',
                          fallback: 'Account & Privacy',
                        ),
                        onPressed: () {
                          HapticFeedback.selectionClick();
                          showAccountPrivacySheet(context);
                        },
                        child: Icon(
                          Icons.tune_rounded,
                          color: p.text,
                          size: 20,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _HeaderActionButton extends StatelessWidget {
  final String tooltip;
  final int badgeCount;
  final VoidCallback onPressed;
  final Widget child;

  const _HeaderActionButton({
    required this.tooltip,
    this.badgeCount = 0,
    required this.onPressed,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    return Semantics(
      button: true,
      label: tooltip,
      child: IconButton(
        tooltip: tooltip,
        constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
        onPressed: onPressed,
        icon: Stack(
          clipBehavior: Clip.none,
          children: [
            Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                color: p.elevated,
                borderRadius: BorderRadius.circular(13),
                border: Border.all(color: p.hairline),
              ),
              child: Center(child: child),
            ),
            if (badgeCount > 0)
              Positioned(
                right: -4,
                top: -4,
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 5,
                    vertical: 1,
                  ),
                  decoration: BoxDecoration(
                    color: p.danger,
                    borderRadius: BorderRadius.circular(999),
                    border: Border.all(color: p.surface, width: 1.5),
                  ),
                  child: Text(
                    badgeCount > 99 ? '99+' : '$badgeCount',
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 10,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
