import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/shell/adaptive_header.dart';
import '../../core/shell/ertad_app_shell.dart';
import '../../core/theme/ertad_theme.dart';
import '../../features/home/presentation/home_tab_screen.dart';
import '../../features/messages/presentation/messages_tab_screen.dart';
import '../../features/polls/presentation/polls_tab_screen.dart';
import '../../features/status/presentation/status_tab_screen.dart';
import '../../features/tasks/presentation/tasks_tab_screen.dart';
import '../../services/notification_service.dart';
import '../../widgets/bottom_nav.dart';

/// Authenticated workspace container exposing the universal 5-tab Flagship shell.
class DashboardScreen extends StatefulWidget {
  final int initialIndex;

  const DashboardScreen({super.key, this.initialIndex = 2});

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  late int _currentIndex = widget.initialIndex;

  @override
  void initState() {
    super.initState();
    NotificationService().registerDevice();
  }

  void _selectTab(int index) {
    if (_currentIndex == index) return;
    setState(() => _currentIndex = index);
  }

  @override
  Widget build(BuildContext context) {
    bool hasScope = true;
    try {
      ProviderScope.containerOf(context, listen: false);
    } catch (_) {
      hasScope = false;
    }

    final body = _DashboardScaffold(
      currentIndex: _currentIndex,
      onSelectTab: _selectTab,
    );
    return hasScope ? body : ProviderScope(child: body);
  }
}

class _DashboardScaffold extends StatelessWidget {
  final int currentIndex;
  final ValueChanged<int> onSelectTab;

  const _DashboardScaffold({
    required this.currentIndex,
    required this.onSelectTab,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    return Scaffold(
      backgroundColor: p.background,
      body: Column(
        children: [
          AdaptiveHeader(
            title: ErtadAppShell.titleForIndex(context, currentIndex),
          ),
          Expanded(
            child: IndexedStack(
              index: currentIndex,
              children: [
                const StatusTabScreen(),
                const MessagesTabScreen(),
                HomeTabScreen(onSwitchTab: onSelectTab),
                const TasksTabScreen(),
                const PollsTabScreen(),
              ],
            ),
          ),
        ],
      ),
      bottomNavigationBar: BottomNav(
        currentIndex: currentIndex,
        onTap: onSelectTab,
      ),
    );
  }
}
