import 'package:flutter/material.dart';

import 'generated_tokens.dart';

/// Semantic color palette exposed via [ThemeExtension] for ERTAD mobile UI.
@immutable
class ErtadPalette extends ThemeExtension<ErtadPalette> {
  final Color background;
  final Color surface;
  final Color elevated;
  final Color text;
  final Color muted;
  final Color border;
  final Color primary;
  final Color onPrimary;
  final Color focus;
  final Color success;
  final Color warning;
  final Color danger;
  final bool isDark;

  const ErtadPalette({
    required this.background,
    required this.surface,
    required this.elevated,
    required this.text,
    required this.muted,
    required this.border,
    required this.primary,
    required this.onPrimary,
    required this.focus,
    required this.success,
    required this.warning,
    required this.danger,
    required this.isDark,
  });

  /// Constructs a palette directly from generated token integer maps.
  factory ErtadPalette.fromTokens(
    Map<String, int> tokens, {
    required bool isDark,
  }) {
    return ErtadPalette(
      background: Color(tokens['background']!),
      surface: Color(tokens['surface']!),
      elevated: Color(tokens['elevated']!),
      text: Color(tokens['text']!),
      muted: Color(tokens['muted']!),
      border: Color(tokens['border']!),
      primary: Color(tokens['primary']!),
      onPrimary: Color(tokens['onPrimary']!),
      focus: Color(tokens['focus']!),
      success: Color(tokens['success']!),
      warning: Color(tokens['warning']!),
      danger: Color(tokens['danger']!),
      isDark: isDark,
    );
  }

  /// Hairline divider/border color tuned for subtle 1px card strokes.
  Color get hairline => border.withValues(alpha: isDark ? 0.30 : 0.22);

  /// Soft primary tint for active filter chips and dock pill highlights.
  Color get primarySoft => primary.withValues(alpha: isDark ? 0.18 : 0.10);

  /// Refined 2026 indigo-violet accent complementing the cobalt primary.
  Color get secondary =>
      isDark ? const Color(0xFFB4A7FF) : const Color(0xFF4B41E1);

  /// Soft secondary tint for multi-accent icons and metric badges.
  Color get secondarySoft => secondary.withValues(alpha: isDark ? 0.18 : 0.10);

  /// Vibrant cobalt-indigo gradient anchor for center Home orb & hero actions.
  Color get orbFill => isDark ? const Color(0xFF425BF0) : primary;

  Color get orbHighlight =>
      isDark ? const Color(0xFF635BFF) : const Color(0xFF4B41E1);

  Color get onOrb => Colors.white;

  /// Frosted translucent surface for sticky header and floating pill dock.
  Color get glassSurface => surface.withValues(alpha: isDark ? 0.84 : 0.88);

  /// Subtle daylight depth without heavy outlines.
  List<BoxShadow> get cardShadow => isDark
      ? const <BoxShadow>[]
      : <BoxShadow>[
          BoxShadow(
            color: const Color(0xFF0F172A).withValues(alpha: 0.045),
            blurRadius: 16,
            offset: const Offset(0, 4),
          ),
        ];

  @override
  ErtadPalette copyWith({
    Color? background,
    Color? surface,
    Color? elevated,
    Color? text,
    Color? muted,
    Color? border,
    Color? primary,
    Color? onPrimary,
    Color? focus,
    Color? success,
    Color? warning,
    Color? danger,
    bool? isDark,
  }) {
    return ErtadPalette(
      background: background ?? this.background,
      surface: surface ?? this.surface,
      elevated: elevated ?? this.elevated,
      text: text ?? this.text,
      muted: muted ?? this.muted,
      border: border ?? this.border,
      primary: primary ?? this.primary,
      onPrimary: onPrimary ?? this.onPrimary,
      focus: focus ?? this.focus,
      success: success ?? this.success,
      warning: warning ?? this.warning,
      danger: danger ?? this.danger,
      isDark: isDark ?? this.isDark,
    );
  }

  @override
  ErtadPalette lerp(covariant ThemeExtension<ErtadPalette>? other, double t) {
    if (other is! ErtadPalette) return this;
    return ErtadPalette(
      background: Color.lerp(background, other.background, t)!,
      surface: Color.lerp(surface, other.surface, t)!,
      elevated: Color.lerp(elevated, other.elevated, t)!,
      text: Color.lerp(text, other.text, t)!,
      muted: Color.lerp(muted, other.muted, t)!,
      border: Color.lerp(border, other.border, t)!,
      primary: Color.lerp(primary, other.primary, t)!,
      onPrimary: Color.lerp(onPrimary, other.onPrimary, t)!,
      focus: Color.lerp(focus, other.focus, t)!,
      success: Color.lerp(success, other.success, t)!,
      warning: Color.lerp(warning, other.warning, t)!,
      danger: Color.lerp(danger, other.danger, t)!,
      isDark: t < 0.5 ? isDark : other.isDark,
    );
  }
}

/// Offline-first Material 3 semantic themes built from generated mobile tokens.
class ErtadTheme {
  ErtadTheme._();

  static final ErtadPalette lightPalette = ErtadPalette.fromTokens(
    mobileLightTokens,
    isDark: false,
  );

  static final ErtadPalette darkPalette = ErtadPalette.fromTokens(
    mobileDarkTokens,
    isDark: true,
  );

  // Offline system font stack with bundled-OS Georgian & Latin support.
  static const List<String> _fontFallback = <String>[
    'Noto Sans Georgian',
    'SF Pro Text',
    'Roboto',
    'sans-serif',
  ];

  static ThemeData get lightTheme => _buildTheme(lightPalette);

  static ThemeData get darkTheme => _buildTheme(darkPalette);

  static ThemeData _buildTheme(ErtadPalette palette) {
    final brightness = palette.isDark ? Brightness.dark : Brightness.light;
    final baseText =
        (palette.isDark ? ThemeData.dark() : ThemeData.light()).textTheme;

    final colorScheme = ColorScheme(
      brightness: brightness,
      primary: palette.primary,
      onPrimary: palette.onPrimary,
      primaryContainer: palette.primarySoft,
      onPrimaryContainer: palette.text,
      secondary: palette.focus,
      onSecondary: palette.onPrimary,
      secondaryContainer: palette.elevated,
      onSecondaryContainer: palette.text,
      error: palette.danger,
      onError: palette.onPrimary,
      surface: palette.surface,
      onSurface: palette.text,
      surfaceContainerHighest: palette.elevated,
      onSurfaceVariant: palette.muted,
      outline: palette.border,
      outlineVariant: palette.hairline,
    );

    final textTheme = baseText
        .apply(
          bodyColor: palette.text,
          displayColor: palette.text,
          fontFamilyFallback: _fontFallback,
        )
        .copyWith(
          headlineSmall: baseText.headlineSmall?.copyWith(
            fontWeight: FontWeight.w700,
            letterSpacing: -0.3,
            fontFamilyFallback: _fontFallback,
          ),
          titleLarge: baseText.titleLarge?.copyWith(
            fontWeight: FontWeight.w700,
            letterSpacing: -0.2,
            fontFamilyFallback: _fontFallback,
          ),
          titleMedium: baseText.titleMedium?.copyWith(
            fontWeight: FontWeight.w600,
            fontFamilyFallback: _fontFallback,
          ),
          bodyMedium: baseText.bodyMedium?.copyWith(
            height: 1.4,
            fontFamilyFallback: _fontFallback,
          ),
          bodySmall: baseText.bodySmall?.copyWith(
            color: palette.muted,
            height: 1.35,
            fontFamilyFallback: _fontFallback,
          ),
          labelMedium: baseText.labelMedium?.copyWith(
            fontWeight: FontWeight.w600,
            fontFamilyFallback: _fontFallback,
          ),
        );

    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: colorScheme,
      primaryColor: palette.primary,
      scaffoldBackgroundColor: palette.background,
      cardColor: palette.surface,
      dividerColor: palette.hairline,
      textTheme: textTheme,
      extensions: <ThemeExtension<dynamic>>[palette],
      appBarTheme: AppBarTheme(
        backgroundColor: palette.background,
        foregroundColor: palette.text,
        elevation: 0,
        scrolledUnderElevation: 0,
        surfaceTintColor: Colors.transparent,
        titleTextStyle: textTheme.titleLarge?.copyWith(color: palette.text),
      ),
      cardTheme: CardThemeData(
        color: palette.surface,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(18),
          side: BorderSide(color: palette.hairline, width: 1),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: palette.primary,
          foregroundColor: palette.onPrimary,
          minimumSize: const Size(48, 48),
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
          ),
        ),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: palette.primary,
          foregroundColor: palette.onPrimary,
          elevation: 0,
          minimumSize: const Size(48, 48),
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
          ),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: palette.text,
          minimumSize: const Size(48, 48),
          side: BorderSide(color: palette.hairline),
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
          ),
        ),
      ),
      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(
          minimumSize: const Size(48, 48),
          foregroundColor: palette.text,
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: palette.elevated,
        hintStyle: TextStyle(color: palette.muted),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide(color: palette.hairline),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide(color: palette.hairline),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide(color: palette.focus, width: 1.5),
        ),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 16,
          vertical: 14,
        ),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: palette.surface,
        surfaceTintColor: Colors.transparent,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
        ),
      ),
      chipTheme: ChipThemeData(
        backgroundColor: palette.elevated,
        selectedColor: palette.primarySoft,
        side: BorderSide(color: palette.hairline),
        labelStyle: textTheme.labelMedium?.copyWith(color: palette.text),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: palette.surface,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(22),
          side: BorderSide(color: palette.hairline, width: 1),
        ),
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: palette.elevated,
        contentTextStyle: TextStyle(color: palette.text),
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(14),
          side: BorderSide(color: palette.hairline),
        ),
      ),
    );
  }
}

/// Convenience accessor for [ErtadPalette] from any [BuildContext].
extension ErtadThemeContext on BuildContext {
  ErtadPalette get ertad {
    final ext = Theme.of(this).extension<ErtadPalette>();
    if (ext != null) return ext;
    return Theme.of(this).brightness == Brightness.dark
        ? ErtadTheme.darkPalette
        : ErtadTheme.lightPalette;
  }
}

