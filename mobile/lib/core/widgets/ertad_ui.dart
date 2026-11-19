import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:shimmer/shimmer.dart';

import '../theme/ertad_theme.dart';

enum ErtadTone { neutral, primary, secondary, success, warning, danger }

/// Tonal 1px-hairline card following ERTAD 2026 visual grammar.
class ErtadSurfaceCard extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;
  final VoidCallback? onTap;
  final Color? backgroundColor;
  final Color? borderColor;
  final double radius;
  final bool elevatedShadow;

  const ErtadSurfaceCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.onTap,
    this.backgroundColor,
    this.borderColor,
    this.radius = 20,
    this.elevatedShadow = true,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(radius),
      side: BorderSide(color: borderColor ?? p.hairline, width: 1),
    );

    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(radius),
        boxShadow: elevatedShadow ? p.cardShadow : const <BoxShadow>[],
      ),
      child: Material(
        color: backgroundColor ?? p.surface,
        shape: shape,
        clipBehavior: Clip.antiAlias,
        child: onTap == null
            ? Padding(padding: padding, child: child)
            : InkWell(
                onTap: onTap,
                child: Padding(padding: padding, child: child),
              ),
      ),
    );
  }
}

Color ertadToneColor(ErtadPalette p, ErtadTone tone) => switch (tone) {
  ErtadTone.primary => p.primary,
  ErtadTone.secondary => p.secondary,
  ErtadTone.success => p.success,
  ErtadTone.warning => p.warning,
  ErtadTone.danger => p.danger,
  ErtadTone.neutral => p.muted,
};

Color ertadToneSoftColor(ErtadPalette p, ErtadTone tone) => switch (tone) {
  ErtadTone.primary => p.primarySoft,
  ErtadTone.secondary => p.secondarySoft,
  ErtadTone.success => p.success.withValues(alpha: p.isDark ? 0.16 : 0.10),
  ErtadTone.warning => p.warning.withValues(alpha: p.isDark ? 0.16 : 0.11),
  ErtadTone.danger => p.danger.withValues(alpha: p.isDark ? 0.16 : 0.10),
  ErtadTone.neutral => p.elevated,
};

/// High-contrast WCAG AA semantic badge/pill.
class ErtadStatusPill extends StatelessWidget {
  final String label;
  final IconData? icon;
  final ErtadTone tone;

  const ErtadStatusPill({
    super.key,
    required this.label,
    this.icon,
    this.tone = ErtadTone.neutral,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final fg = ertadToneColor(p, tone);
    final bg = ertadToneSoftColor(p, tone);

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: fg.withValues(alpha: 0.25), width: 1),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 14, color: fg),
            const SizedBox(width: 5),
          ],
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                color: fg,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Responsive wrapper limiting content width to 640dp on tablet/wide viewports.
class ErtadResponsiveContainer extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;
  final bool shrinkWrapHeight;

  const ErtadResponsiveContainer({
    super.key,
    required this.child,
    this.padding = EdgeInsets.zero,
    this.shrinkWrapHeight = false,
  });

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.topCenter,
      heightFactor: shrinkWrapHeight ? 1.0 : null,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 640),
        child: Padding(padding: padding, child: child),
      ),
    );
  }
}

/// Standardized empty / filtered-empty / error / unavailable panel with optional Retry.
class ErtadEmptyState extends StatelessWidget {
  final IconData icon;
  final String title;
  final String body;
  final String? actionLabel;
  final VoidCallback? onAction;
  final ErtadTone tone;

  const ErtadEmptyState({
    super.key,
    required this.icon,
    required this.title,
    required this.body,
    this.actionLabel,
    this.onAction,
    this.tone = ErtadTone.neutral,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final accent = ertadToneColor(p, tone);

    return SizedBox(
      width: double.infinity,
      child: ErtadSurfaceCard(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Container(
              width: 52,
              height: 52,
              decoration: BoxDecoration(
                color: accent.withValues(alpha: 0.12),
                shape: BoxShape.circle,
              ),
              child: Icon(icon, size: 26, color: accent),
            ),
            const SizedBox(height: 14),
            Text(
              title,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 6),
            Text(
              body,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall,
            ),
            if (actionLabel != null && onAction != null) ...[
              const SizedBox(height: 16),
              FilledButton(onPressed: onAction, child: Text(actionLabel!)),
            ],
          ],
        ),
      ),
    );
  }
}

/// Reusable non-blocking offline or warning banner with accessible touch target.
class ErtadStateBanner extends StatelessWidget {
  final IconData icon;
  final String message;
  final ErtadTone tone;
  final String? actionLabel;
  final VoidCallback? onAction;

  const ErtadStateBanner({
    super.key,
    required this.icon,
    required this.message,
    this.tone = ErtadTone.warning,
    this.actionLabel,
    this.onAction,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final fg = switch (tone) {
      ErtadTone.danger => p.danger,
      ErtadTone.warning => p.warning,
      ErtadTone.success => p.success,
      _ => p.primary,
    };

    return Semantics(
      liveRegion: true,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: fg.withValues(alpha: p.isDark ? 0.16 : 0.10),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: fg.withValues(alpha: 0.30)),
        ),
        child: Row(
          children: [
            Icon(icon, size: 18, color: fg),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                message,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: p.text),
              ),
            ),
            if (actionLabel != null && onAction != null)
              TextButton(
                style: TextButton.styleFrom(
                  minimumSize: const Size(48, 48),
                  foregroundColor: fg,
                ),
                onPressed: onAction,
                child: Text(actionLabel!),
              ),
          ],
        ),
      ),
    );
  }
}

/// Tonal shimmer placeholders tuned for both light and dark themes.
class ErtadSkeletonList extends StatelessWidget {
  final int count;

  const ErtadSkeletonList({super.key, this.count = 3});

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    return Shimmer.fromColors(
      baseColor: p.elevated,
      highlightColor: p.surface,
      child: Column(
        children: List.generate(
          count,
          (i) => Padding(
            padding: EdgeInsets.only(bottom: i == count - 1 ? 0 : 12),
            child: Container(
              height: 92,
              decoration: BoxDecoration(
                color: p.elevated,
                borderRadius: BorderRadius.circular(20),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Tonal rounded square/circle icon container for rich icon-driven cards.
class ErtadIconCircle extends StatelessWidget {
  final IconData icon;
  final ErtadTone tone;
  final double size;
  final double iconSize;
  final double radius;

  const ErtadIconCircle({
    super.key,
    required this.icon,
    this.tone = ErtadTone.primary,
    this.size = 40,
    this.iconSize = 20,
    this.radius = 12,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: ertadToneSoftColor(p, tone),
        borderRadius: BorderRadius.circular(radius),
      ),
      child: Icon(icon, size: iconSize, color: ertadToneColor(p, tone)),
    );
  }
}

/// Unified section header with semantic icon, title, and optional trailing label/action.
class ErtadSectionHeader extends StatelessWidget {
  final IconData icon;
  final String title;
  final ErtadTone tone;
  final Widget? trailing;

  const ErtadSectionHeader({
    super.key,
    required this.icon,
    required this.title,
    this.tone = ErtadTone.primary,
    this.trailing,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 2),
      child: Row(
        children: [
          Icon(icon, size: 18, color: ertadToneColor(p, tone)),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.titleMedium,
            ),
          ),
          if (trailing != null) ...[const SizedBox(width: 8), trailing!],
        ],
      ),
    );
  }
}

/// Compact 2x2 grid metric card inspired by flagship cards without V2 XP/ranks.
class ErtadMetricTile extends StatelessWidget {
  final String label;
  final String value;
  final String? sublabel;
  final IconData icon;
  final IconData? subIcon;
  final ErtadTone tone;
  final VoidCallback? onTap;

  const ErtadMetricTile({
    super.key,
    required this.label,
    required this.value,
    this.sublabel,
    required this.icon,
    this.subIcon,
    this.tone = ErtadTone.primary,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final accent = ertadToneColor(p, tone);

    return ErtadSurfaceCard(
      onTap: onTap,
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(
                    context,
                  ).textTheme.labelMedium?.copyWith(color: p.muted),
                ),
              ),
              const SizedBox(width: 6),
              ErtadIconCircle(
                icon: icon,
                tone: tone,
                size: 30,
                iconSize: 17,
                radius: 10,
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context).textTheme.headlineSmall?.copyWith(
              fontWeight: FontWeight.w800,
              letterSpacing: -0.5,
            ),
          ),
          if (sublabel != null) ...[
            const SizedBox(height: 6),
            Row(
              children: [
                if (subIcon != null) ...[
                  Icon(subIcon, size: 14, color: accent),
                  const SizedBox(width: 4),
                ],
                Expanded(
                  child: Text(
                    sublabel!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      color: accent,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

/// Circular progress ring summary card cherry-picked for active focus & turnout.
class ErtadProgressRingCard extends StatelessWidget {
  final double progress;
  final String centerLabel;
  final String title;
  final String subtitle;
  final String? badgeText;
  final ErtadTone tone;
  final VoidCallback? onTap;

  const ErtadProgressRingCard({
    super.key,
    required this.progress,
    required this.centerLabel,
    required this.title,
    required this.subtitle,
    this.badgeText,
    this.tone = ErtadTone.primary,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final accent = ertadToneColor(p, tone);

    return ErtadSurfaceCard(
      onTap: onTap,
      backgroundColor: p.isDark
          ? p.surface
          : p.elevated.withValues(alpha: 0.68),
      padding: const EdgeInsets.all(14),
      child: Row(
        children: [
          Container(
            width: 52,
            height: 52,
            decoration: BoxDecoration(
              color: p.surface,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: p.hairline),
            ),
            child: Stack(
              alignment: Alignment.center,
              children: [
                SizedBox(
                  width: 36,
                  height: 36,
                  child: CircularProgressIndicator(
                    value: progress.clamp(0.0, 1.0),
                    strokeWidth: 4,
                    strokeCap: StrokeCap.round,
                    backgroundColor: p.hairline,
                    valueColor: AlwaysStoppedAnimation<Color>(accent),
                  ),
                ),
                Text(
                  centerLabel,
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    fontWeight: FontWeight.w700,
                    color: p.text,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                    ),
                    if (badgeText != null) ...[
                      const SizedBox(width: 8),
                      ErtadStatusPill(label: badgeText!, tone: tone),
                    ],
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  subtitle,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Timeline item with vertical hairline connector for activity & contribution history.
class ErtadTimelineTile extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final String? badgeLabel;
  final String? trailingValue;
  final String? timeLabel;
  final ErtadTone tone;
  final bool isLast;
  final VoidCallback? onTap;

  const ErtadTimelineTile({
    super.key,
    required this.icon,
    required this.title,
    required this.subtitle,
    this.badgeLabel,
    this.trailingValue,
    this.timeLabel,
    this.tone = ErtadTone.primary,
    this.isLast = false,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final accent = ertadToneColor(p, tone);

    final row = IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Column(
            children: [
              ErtadIconCircle(
                icon: icon,
                tone: tone,
                size: 32,
                iconSize: 16,
                radius: 999,
              ),
              if (!isLast)
                Expanded(
                  child: Container(
                    width: 2,
                    margin: const EdgeInsets.symmetric(vertical: 4),
                    color: p.hairline,
                  ),
                ),
            ],
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Padding(
              padding: EdgeInsets.only(bottom: isLast ? 0 : 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(
                            context,
                          ).textTheme.titleMedium?.copyWith(fontSize: 14),
                        ),
                      ),
                      if (trailingValue != null) ...[
                        const SizedBox(width: 8),
                        Text(
                          trailingValue!,
                          style: Theme.of(context).textTheme.labelMedium
                              ?.copyWith(
                                color: accent,
                                fontWeight: FontWeight.w700,
                              ),
                        ),
                      ],
                      if (onTap != null) ...[
                        const SizedBox(width: 4),
                        Icon(
                          Icons.chevron_right_rounded,
                          size: 18,
                          color: p.muted,
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 3),
                  Text(
                    subtitle,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  if (badgeLabel != null || timeLabel != null) ...[
                    const SizedBox(height: 6),
                    Row(
                      children: [
                        if (badgeLabel != null)
                          ErtadStatusPill(label: badgeLabel!, tone: tone),
                        if (badgeLabel != null && timeLabel != null)
                          const SizedBox(width: 8),
                        if (timeLabel != null)
                          Text(
                            timeLabel!,
                            style: Theme.of(context).textTheme.labelSmall
                                ?.copyWith(
                                  color: p.muted,
                                  fontFamily: 'monospace',
                                ),
                          ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
    );

    if (onTap == null) return row;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 2, horizontal: 2),
          child: row,
        ),
      ),
    );
  }
}

/// Standardized bottom-sheet top chrome with drag handle, icon, title, and 48dp X button.
class ErtadModalSheetHeader extends StatelessWidget {
  final String title;
  final IconData? icon;
  final ErtadTone tone;
  final String closeTooltip;

  const ErtadModalSheetHeader({
    super.key,
    required this.title,
    this.icon,
    this.tone = ErtadTone.primary,
    this.closeTooltip = 'Close',
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Center(
          child: Container(
            width: 38,
            height: 4,
            decoration: BoxDecoration(
              color: p.hairline,
              borderRadius: BorderRadius.circular(999),
            ),
          ),
        ),
        const SizedBox(height: 10),
        Row(
          children: [
            if (icon != null) ...[
              ErtadIconCircle(
                icon: icon!,
                tone: tone,
                size: 36,
                iconSize: 19,
                radius: 11,
              ),
              const SizedBox(width: 10),
            ],
            Expanded(
              child: Text(
                title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  fontSize: 18,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            IconButton(
              tooltip: closeTooltip,
              style: IconButton.styleFrom(
                backgroundColor: p.elevated,
                minimumSize: const Size(48, 48),
              ),
              icon: Icon(Icons.close_rounded, color: p.text, size: 20),
              onPressed: () => Navigator.of(context).pop(),
            ),
          ],
        ),
      ],
    );
  }
}

/// Unified subpage scaffold enforcing consistent Back/Close chrome and palette.
class ErtadSubpageScaffold extends StatelessWidget {
  final String title;
  final String? subtitle;
  final Widget body;
  final List<Widget>? actions;
  final Widget? bottomBar;
  final bool closeStyle;
  final Future<bool> Function()? onCloseRequested;

  const ErtadSubpageScaffold({
    super.key,
    required this.title,
    required this.body,
    this.subtitle,
    this.actions,
    this.bottomBar,
    this.closeStyle = false,
    this.onCloseRequested,
  });

  Future<void> _handleExit(BuildContext context) async {
    final nav = Navigator.of(context);
    if (onCloseRequested != null) {
      final allow = await onCloseRequested!();
      if (!allow) return;
    }
    if (nav.canPop()) {
      nav.pop();
    } else if (context.mounted) {
      GoRouter.maybeOf(context)?.go('/home');
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    return PopScope(
      canPop: onCloseRequested == null,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) {
          _handleExit(context);
        }
      },
      child: Scaffold(
        backgroundColor: p.background,
        appBar: AppBar(
          backgroundColor: p.surface,
          surfaceTintColor: Colors.transparent,
          elevation: 0,
          scrolledUnderElevation: 0,
          bottom: PreferredSize(
            preferredSize: const Size.fromHeight(1),
            child: Container(height: 1, color: p.hairline),
          ),
          leading: IconButton(
            tooltip: closeStyle ? 'Close' : 'Back',
            icon: Icon(
              closeStyle ? Icons.close_rounded : Icons.arrow_back_rounded,
              color: p.text,
            ),
            onPressed: () => _handleExit(context),
          ),
          title: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(
                  context,
                ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
              ),
              if (subtitle != null)
                Text(
                  subtitle!,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
            ],
          ),
          actions: actions,
        ),
        body: SafeArea(
          top: false,
          child: ErtadResponsiveContainer(child: body),
        ),
        bottomNavigationBar: bottomBar == null
            ? null
            : Container(
                decoration: BoxDecoration(
                  color: p.surface,
                  border: Border(top: BorderSide(color: p.hairline)),
                ),
                child: SafeArea(
                  top: false,
                  child: ErtadResponsiveContainer(
                    shrinkWrapHeight: true,
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                    child: bottomBar!,
                  ),
                ),
              ),
      ),
    );
  }
}

/// Consistent horizontal filter chip strip shared across Polls, Messages, and Tasks tabs.
class ErtadTabFilterBar extends StatelessWidget {
  final List<String> labels;
  final int selectedIndex;
  final ValueChanged<int> onSelected;
  final Widget? trailing;

  const ErtadTabFilterBar({
    super.key,
    required this.labels,
    required this.selectedIndex,
    required this.onSelected,
    this.trailing,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: List.generate(labels.length, (i) {
                return Padding(
                  padding: EdgeInsets.only(
                    right: i == labels.length - 1 ? 0 : 8,
                  ),
                  child: ChoiceChip(
                    label: Text(labels[i]),
                    selected: selectedIndex == i,
                    onSelected: (_) => onSelected(i),
                  ),
                );
              }),
            ),
          ),
        ),
        if (trailing != null) ...[const SizedBox(width: 8), trailing!],
      ],
    );
  }
}

/// Descriptor for a single segment inside [ErtadCategoryBar].
@immutable
class ErtadCategoryItem {
  final String label;
  final int badgeCount;

  const ErtadCategoryItem({required this.label, this.badgeCount = 0});
}

/// Horizontally scrollable tonal segmented category bar with crisp, non-shrinking labels.
class ErtadCategoryBar extends StatelessWidget {
  final List<ErtadCategoryItem> items;
  final int selectedIndex;
  final ValueChanged<int> onSelected;

  const ErtadCategoryBar({
    super.key,
    required this.items,
    required this.selectedIndex,
    required this.onSelected,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;

    final textScale = MediaQuery.textScalerOf(context).scale(1.0);
    final fitEvenly = items.length <= 3 && textScale <= 1.3;

    Widget buildButton(int i, {required bool flushSegment}) {
      final cat = items[i];
      final selected = i == selectedIndex;
      final labelRow = Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            cat.label,
            maxLines: 1,
            softWrap: false,
            style: Theme.of(context).textTheme.labelMedium?.copyWith(
              color: selected ? p.primary : p.muted,
              fontWeight: selected ? FontWeight.w700 : FontWeight.w600,
            ),
          ),
          if (cat.badgeCount > 0) ...[
            const SizedBox(width: 6),
            Container(
              width: 7,
              height: 7,
              decoration: BoxDecoration(
                color: selected ? p.primary : p.danger,
                shape: BoxShape.circle,
              ),
            ),
          ],
        ],
      );

      return Material(
        color: selected ? p.surface : Colors.transparent,
        borderRadius: BorderRadius.circular(12),
        elevation: selected ? 1.5 : 0,
        shadowColor: Colors.black.withValues(alpha: 0.08),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () => onSelected(i),
          child: Container(
            constraints: const BoxConstraints(minHeight: 42),
            padding: EdgeInsets.symmetric(
              horizontal: flushSegment ? 6 : 14,
              vertical: 8,
            ),
            child: Center(
              child: flushSegment
                  ? FittedBox(fit: BoxFit.scaleDown, child: labelRow)
                  : labelRow,
            ),
          ),
        ),
      );
    }

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: p.elevated,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: p.hairline, width: 1),
      ),
      child: fitEvenly
          ? Row(
              children: [
                for (int i = 0; i < items.length; i++) ...[
                  Expanded(child: buildButton(i, flushSegment: true)),
                  if (i < items.length - 1) const SizedBox(width: 4),
                ],
              ],
            )
          : SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              physics: const BouncingScrollPhysics(),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (int i = 0; i < items.length; i++) ...[
                    buildButton(i, flushSegment: false),
                    if (i < items.length - 1) const SizedBox(width: 4),
                  ],
                ],
              ),
            ),
    );
  }
}

/// Standardized tab scroll view with unified header/dock clearance and Pull-to-Refresh.
class ErtadTabScrollView extends StatelessWidget {
  final ScrollController? controller;
  final Future<void> Function() onRefresh;
  final List<Widget> children;

  const ErtadTabScrollView({
    super.key,
    this.controller,
    required this.onRefresh,
    required this.children,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final padding = MediaQuery.viewPaddingOf(context);
    final topReserve = padding.top + 80;
    final bottomReserve = padding.bottom + 124;

    return RefreshIndicator(
      color: p.primary,
      edgeOffset: topReserve - 8,
      onRefresh: onRefresh,
      child: ListView(
        controller: controller,
        physics: const AlwaysScrollableScrollPhysics(),
        padding: EdgeInsets.fromLTRB(16, topReserve, 16, bottomReserve),
        children: [
          ErtadResponsiveContainer(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: children,
            ),
          ),
        ],
      ),
    );
  }
}

/// Safe text-input dialog whose [TextEditingController] lives inside a [StatefulWidget]
/// so it is never disposed while the dialog exit animation is still running.
Future<String?> showErtadTextInputDialog(
  BuildContext context, {
  required String title,
  required String hintText,
  required String cancelLabel,
  required String confirmLabel,
  String? destructiveLabel,
  String? destructiveValue,
  TextInputType keyboardType = TextInputType.text,
  TextCapitalization textCapitalization = TextCapitalization.none,
  bool uppercaseResult = false,
}) {
  return showDialog<String>(
    context: context,
    useRootNavigator: true,
    builder: (_) => _ErtadTextInputDialog(
      title: title,
      hintText: hintText,
      cancelLabel: cancelLabel,
      confirmLabel: confirmLabel,
      destructiveLabel: destructiveLabel,
      destructiveValue: destructiveValue,
      keyboardType: keyboardType,
      textCapitalization: textCapitalization,
      uppercaseResult: uppercaseResult,
    ),
  );
}

class _ErtadTextInputDialog extends StatefulWidget {
  final String title;
  final String hintText;
  final String cancelLabel;
  final String confirmLabel;
  final String? destructiveLabel;
  final String? destructiveValue;
  final TextInputType keyboardType;
  final TextCapitalization textCapitalization;
  final bool uppercaseResult;

  const _ErtadTextInputDialog({
    required this.title,
    required this.hintText,
    required this.cancelLabel,
    required this.confirmLabel,
    this.destructiveLabel,
    this.destructiveValue,
    required this.keyboardType,
    required this.textCapitalization,
    required this.uppercaseResult,
  });

  @override
  State<_ErtadTextInputDialog> createState() => _ErtadTextInputDialogState();
}

class _ErtadTextInputDialogState extends State<_ErtadTextInputDialog> {
  final TextEditingController _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final raw = _controller.text.trim();
    Navigator.of(context).pop(widget.uppercaseResult ? raw.toUpperCase() : raw);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      content: TextField(
        controller: _controller,
        autofocus: true,
        keyboardType: widget.keyboardType,
        textCapitalization: widget.textCapitalization,
        textInputAction: TextInputAction.done,
        onSubmitted: (_) => _submit(),
        decoration: InputDecoration(
          hintText: widget.hintText,
          border: const OutlineInputBorder(),
        ),
      ),
      actions: [
        if (widget.destructiveLabel != null && widget.destructiveValue != null)
          TextButton(
            onPressed: () => Navigator.of(context).pop(widget.destructiveValue),
            child: Text(
              widget.destructiveLabel!,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ),
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(widget.cancelLabel),
        ),
        FilledButton(
          onPressed: _submit,
          child: Text(widget.confirmLabel),
        ),
      ],
    );
  }
}
