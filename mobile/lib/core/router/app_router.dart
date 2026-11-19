import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../features/home/presentation/home_tab_screen.dart';
import '../../features/messages/presentation/messages_tab_screen.dart';
import '../../features/polls/presentation/polls_tab_screen.dart';
import '../../features/status/presentation/status_tab_screen.dart';
import '../../features/tasks/presentation/tasks_tab_screen.dart';
import '../../screens/auth/sign_in_screen.dart';
import '../shell/ertad_app_shell.dart';
import '../shell/shell_l10n.dart';
import '../widgets/ertad_ui.dart';

/// Builds a [GoRouter] managing the 5 persistent V1 tab branches via [StatefulShellRoute].
GoRouter createErtadRouter({String initialLocation = '/home'}) {
  final rootNavigatorKey = GlobalKey<NavigatorState>(debugLabel: 'rootNav');

  return GoRouter(
    navigatorKey: rootNavigatorKey,
    initialLocation: initialLocation,
    errorBuilder: (context, state) => ErtadSubpageScaffold(
      title: 'ERTAD',
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: ErtadEmptyState(
            icon: Icons.explore_off_outlined,
            tone: ErtadTone.primary,
            title: shellTr(
              context,
              'route_not_found_title',
              fallback: 'Page not found',
            ),
            body: shellTr(
              context,
              'route_not_found_body',
              fallback: 'This section is unavailable. Return to the main hub.',
            ),
            actionLabel: shellTr(context, 'go_home', fallback: 'Go to Home'),
            onAction: () => context.go('/home'),
          ),
        ),
      ),
    ),
    routes: [
      GoRoute(
        path: '/sign-in',
        builder: (context, state) => const SignInScreen(),
      ),
      StatefulShellRoute.indexedStack(
        builder: (context, state, navigationShell) {
          return ErtadAppShell(navigationShell: navigationShell);
        },
        branches: [
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/status',
                builder: (context, state) => StatusTabScreen(
                  onSwitchTab: (index) {
                    StatefulNavigationShell.of(context).goBranch(index);
                  },
                ),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/messages',
                builder: (context, state) => const MessagesTabScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/home',
                builder: (context, state) => HomeTabScreen(
                  onSwitchTab: (index) {
                    StatefulNavigationShell.of(context).goBranch(index);
                  },
                ),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/tasks',
                builder: (context, state) => const TasksTabScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/polls',
                builder: (context, state) => const PollsTabScreen(),
              ),
            ],
          ),
        ],
      ),
    ],
  );
}

