import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../feedback/ertad_feedback.dart';
import '../state/shell_providers.dart';
import '../theme/ertad_theme.dart';
import 'adaptive_header.dart';
import 'floating_bottom_dock.dart';
import 'shell_l10n.dart';
import 'tab_scroll_registry.dart';

/// Shared universal iOS & Android adaptive scaffold hosting the 5 primary tabs
/// with frosted header/footer, smooth branch fade, scroll-to-top, and unified feedback.
class ErtadAppShell extends ConsumerWidget {
  final StatefulNavigationShell navigationShell;

  const ErtadAppShell({super.key, required this.navigationShell});

  static String titleForIndex(BuildContext context, int index) {
    return switch (index) {
      0 => shellTr(context, 'nav_status', fallback: 'Status'),
      1 => shellTr(context, 'nav_messages', fallback: 'Messages'),
      2 => shellTr(context, 'nav_home', fallback: 'Home'),
      3 => shellTr(context, 'nav_tasks', fallback: 'Tasks'),
      4 => shellTr(context, 'nav_polls', fallback: 'Polls'),
      _ => 'ERTAD',
    };
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = context.ertad;
    final session = ref.watch(shellSessionProvider);
    final scrollRegistry = ref.watch(tabScrollRegistryProvider);
    final idx = navigationShell.currentIndex;
    final overlayStyle = SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: p.isDark ? Brightness.light : Brightness.dark,
      statusBarBrightness: p.isDark ? Brightness.dark : Brightness.light,
      systemNavigationBarColor: Colors.transparent,
      systemNavigationBarDividerColor: Colors.transparent,
      systemNavigationBarIconBrightness:
          p.isDark ? Brightness.light : Brightness.dark,
      systemNavigationBarContrastEnforced: false,
      systemStatusBarContrastEnforced: false,
    );

    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: overlayStyle,
      child: Scaffold(
        backgroundColor: p.background,
        extendBody: true,
        extendBodyBehindAppBar: true,
      body: ErtadFeedbackOverlay(
        child: Stack(
          children: [
            TweenAnimationBuilder<double>(
              key: ValueKey<int>(idx),
              tween: Tween<double>(begin: 0.94, end: 1.0),
              duration: const Duration(milliseconds: 170),
              curve: Curves.easeOutCubic,
              builder: (context, value, child) {
                return Opacity(
                  opacity: value,
                  child: Transform.translate(
                    offset: Offset(0, (1.0 - value) * 48),
                    child: child,
                  ),
                );
              },
              child: navigationShell,
            ),
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: AdaptiveHeader(title: titleForIndex(context, idx)),
            ),
          ],
        ),
      ),
      bottomNavigationBar: FloatingBottomDock(
        currentIndex: idx,
        messagesBadge: session.unreadMessagesCount,
        tasksBadge: session.openWorkCount + session.upcomingEvents48h,
        pollsBadge: session.openDecisionsCount,
        onReselect: (tabIdx) => scrollRegistry.scrollToTop(tabIdx),
        onTap: (target) {
          navigationShell.goBranch(
            target,
            initialLocation: target == navigationShell.currentIndex,
          );
        },
      ),
      ),
    );
  }
}
