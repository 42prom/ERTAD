import 'package:flutter/material.dart';

import '../core/theme/ertad_theme.dart';
import '../core/theme/generated_tokens.dart';

/// Legacy compatibility shim delegating themes to [ErtadTheme] while retaining
/// compile-time static token constants referenced by legacy settings screens.
class AppTheme {
  AppTheme._();

  static const Color facebookBlue = Color(0xFF2563EB);
  static const Color darkBackground = Color(0xFF121212);
  static const Color darkSurface = Color(0xFF1E1E1E);
  static const Color darkCard = Color(0xFF2C2C2C);

  // Ensure generated tokens stay aligned with legacy static fallback constants.
  static int get _tokenCheck => mobileDarkTokens['background']!;

  static ThemeData get lightTheme => ErtadTheme.lightTheme;

  static ThemeData get darkTheme {
    assert(_tokenCheck == darkBackground.toARGB32());
    return ErtadTheme.darkTheme;
  }
}
