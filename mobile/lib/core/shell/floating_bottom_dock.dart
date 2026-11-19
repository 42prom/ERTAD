import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/ertad_theme.dart';
import 'shell_l10n.dart';

/// V1 5-tab icons-only frosted floating SafeArea bottom dock with raised center Home orb:
/// 0: Status | 1: Messages | 2: Home (center primary) | 3: Tasks | 4: Polls.
class FloatingBottomDock extends StatelessWidget {
  final int currentIndex;
  final ValueChanged<int> onTap;
  final ValueChanged<int>? onReselect;
  final int messagesBadge;
  final int tasksBadge;
  final int pollsBadge;

  const FloatingBottomDock({
    super.key,
    required this.currentIndex,
    required this.onTap,
    this.onReselect,
    this.messagesBadge = 0,
    this.tasksBadge = 0,
    this.pollsBadge = 0,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final items = <_DockTabSpec>[
      _DockTabSpec(
        semanticLabel: shellTr(context, 'nav_status', fallback: 'Status'),
        icon: Icons.verified_user_outlined,
        activeIcon: Icons.verified_user_rounded,
      ),
      _DockTabSpec(
        semanticLabel: shellTr(context, 'nav_messages', fallback: 'Messages'),
        icon: Icons.chat_bubble_outline_rounded,
        activeIcon: Icons.chat_bubble_rounded,
        badge: messagesBadge,
      ),
      _DockTabSpec(
        semanticLabel: shellTr(context, 'nav_home', fallback: 'Home'),
        icon: Icons.home_outlined,
        activeIcon: Icons.home_rounded,
        isCenterPrimary: true,
      ),
      _DockTabSpec(
        semanticLabel: shellTr(context, 'nav_tasks', fallback: 'Tasks'),
        icon: Icons.task_alt_outlined,
        activeIcon: Icons.task_alt_rounded,
        badge: tasksBadge,
      ),
      _DockTabSpec(
        semanticLabel: shellTr(context, 'nav_polls', fallback: 'Polls'),
        icon: Icons.how_to_vote_outlined,
        activeIcon: Icons.how_to_vote_rounded,
        badge: pollsBadge,
      ),
    ];

    return Material(
      color: Colors.transparent,
      child: SafeArea(
        top: false,
        minimum: const EdgeInsets.fromLTRB(20, 4, 20, 12),
        child: Center(
          heightFactor: 1,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: DecoratedBox(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(999),
                boxShadow: p.isDark
                    ? <BoxShadow>[
                        BoxShadow(
                          color: Colors.black.withValues(alpha: 0.45),
                          blurRadius: 22,
                          offset: const Offset(0, 8),
                        ),
                      ]
                    : <BoxShadow>[
                        BoxShadow(
                          color: p.primary.withValues(alpha: 0.14),
                          blurRadius: 24,
                          offset: const Offset(0, 10),
                        ),
                        BoxShadow(
                          color: const Color(0xFF0F172A).withValues(alpha: 0.06),
                          blurRadius: 10,
                          offset: const Offset(0, 4),
                        ),
                      ],
              ),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(999),
                child: BackdropFilter(
                  filter: ui.ImageFilter.blur(sigmaX: 16, sigmaY: 16),
                  child: Container(
                    height: 62,
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    decoration: BoxDecoration(
                      color: p.glassSurface,
                      borderRadius: BorderRadius.circular(999),
                      border: Border.all(
                        color: p.isDark
                            ? p.border.withValues(alpha: 0.28)
                            : p.surface.withValues(alpha: 0.9),
                        width: 1,
                      ),
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.center,
                      children: List.generate(items.length, (index) {
                        final spec = items[index];
                        final selected = currentIndex == index;
                        return Expanded(
                          child: _DockItem(
                            key: Key('dock_tab_$index'),
                            spec: spec,
                            selected: selected,
                            onPressed: () {
                              if (selected) {
                                HapticFeedback.lightImpact();
                                onReselect?.call(index);
                              } else {
                                HapticFeedback.selectionClick();
                                onTap(index);
                              }
                            },
                          ),
                        );
                      }),
                    ),
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

class _DockTabSpec {
  final String semanticLabel;
  final IconData icon;
  final IconData activeIcon;
  final bool isCenterPrimary;
  final int badge;

  const _DockTabSpec({
    required this.semanticLabel,
    required this.icon,
    required this.activeIcon,
    this.isCenterPrimary = false,
    this.badge = 0,
  });
}

class _DockItem extends StatefulWidget {
  final _DockTabSpec spec;
  final bool selected;
  final VoidCallback onPressed;

  const _DockItem({
    super.key,
    required this.spec,
    required this.selected,
    required this.onPressed,
  });

  @override
  State<_DockItem> createState() => _DockItemState();
}

class _DockItemState extends State<_DockItem> {
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final spec = widget.spec;
    final selected = widget.selected;
    final isCenter = spec.isCenterPrimary;
    final fgColor = selected ? p.primary : p.muted;

    return Semantics(
      button: true,
      selected: selected,
      label: spec.semanticLabel,
      child: Tooltip(
        message: spec.semanticLabel,
        child: GestureDetector(
          onTapDown: (_) => setState(() => _pressed = true),
          onTapCancel: () => setState(() => _pressed = false),
          onTapUp: (_) => setState(() => _pressed = false),
          onTap: widget.onPressed,
          behavior: HitTestBehavior.opaque,
          child: AnimatedScale(
            scale: _pressed ? 0.90 : 1.0,
            duration: const Duration(milliseconds: 110),
            curve: Curves.easeOut,
            child: SizedBox(
              height: 48,
              child: Center(
                child: isCenter && selected
                    ? AnimatedContainer(
                        duration: const Duration(milliseconds: 180),
                        curve: Curves.easeOutCubic,
                        width: 48,
                        height: 48,
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(999),
                          gradient: LinearGradient(
                            colors: [p.orbFill, p.orbHighlight],
                            begin: Alignment.topLeft,
                            end: Alignment.bottomRight,
                          ),
                          boxShadow: <BoxShadow>[
                            BoxShadow(
                              color: p.orbFill.withValues(alpha: 0.36),
                              blurRadius: 12,
                              offset: const Offset(0, 4),
                            ),
                          ],
                        ),
                        child: Icon(
                          spec.activeIcon,
                          size: 25,
                          color: p.onOrb,
                        ),
                      )
                    : AnimatedContainer(
                        duration: const Duration(milliseconds: 180),
                        curve: Curves.easeOutCubic,
                        width: 46,
                        height: 42,
                        decoration: BoxDecoration(
                          color: selected
                              ? p.primarySoft
                              : Colors.transparent,
                          borderRadius: BorderRadius.circular(999),
                          border: isCenter && !selected
                              ? Border.all(
                                  color: p.hairline.withValues(alpha: 0.7),
                                  width: 1,
                                )
                              : null,
                        ),
                        child: Center(
                          child: Stack(
                            clipBehavior: Clip.none,
                            children: [
                              Icon(
                                selected ? spec.activeIcon : spec.icon,
                                size: 24,
                                color: fgColor,
                              ),
                              if (spec.badge > 0)
                                Positioned(
                                  right: -8,
                                  top: -5,
                                  child: Container(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 4,
                                      vertical: 1,
                                    ),
                                    decoration: BoxDecoration(
                                      color: p.danger,
                                      borderRadius: BorderRadius.circular(999),
                                      border: Border.all(
                                        color: p.surface,
                                        width: 1.4,
                                      ),
                                    ),
                                    child: Text(
                                      spec.badge > 99 ? '99+' : '${spec.badge}',
                                      style: const TextStyle(
                                        color: Colors.white,
                                        fontSize: 9,
                                        fontWeight: FontWeight.w700,
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
        ),
      ),
    );
  }
}
