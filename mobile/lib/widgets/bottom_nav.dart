import 'package:flutter/material.dart';

import '../core/shell/floating_bottom_dock.dart';

/// Universal 5-tab SafeArea dock wrapper shared by legacy routes and the router shell.
class BottomNav extends StatelessWidget {
  final int currentIndex;
  final ValueChanged<int> onTap;
  final int messagesBadge;
  final int tasksBadge;
  final int pollsBadge;

  const BottomNav({
    super.key,
    required this.currentIndex,
    required this.onTap,
    this.messagesBadge = 0,
    this.tasksBadge = 0,
    this.pollsBadge = 0,
  });

  @override
  Widget build(BuildContext context) {
    return FloatingBottomDock(
      currentIndex: currentIndex,
      onTap: onTap,
      messagesBadge: messagesBadge,
      tasksBadge: tasksBadge,
      pollsBadge: pollsBadge,
    );
  }
}
