import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb, kReleaseMode;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:google_sign_in/google_sign_in.dart';

import '../../core/feedback/ertad_feedback.dart';
import '../../core/shell/shell_l10n.dart';
import '../../core/state/shell_providers.dart';
import '../../core/theme/ertad_theme.dart';
import '../../core/widgets/ertad_ui.dart';

/// Flagship ERTAD Sign-In screen:
/// - Primary: Continue with Google (Google OIDC hybrid assurance)
/// - Dev-only (!kReleaseMode): 1-tap Quick Login (Member / Group Manager)
class SignInScreen extends ConsumerStatefulWidget {
  const SignInScreen({super.key});

  @override
  ConsumerState<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends ConsumerState<SignInScreen> {
  bool _busy = false;

  Future<void> _signInWithGoogle() async {
    if (_busy) return;
    HapticFeedback.selectionClick();
    setState(() => _busy = true);
    try {
      final notifier = ref.read(shellSessionProvider.notifier);
      if (!kReleaseMode) {
        await notifier.connectDevSession();
      }
      final api = ref.read(mobileApiClientProvider);

      String? serverClientId;
      bool oidcEnabled = false;
      try {
        final cfg = await api.fetchGoogleOidcConfig();
        oidcEnabled = cfg['enabled'] == true;
        final androidId = cfg['androidClientId']?.toString().trim() ?? '';
        final iosId = cfg['iosClientId']?.toString().trim() ?? '';
        serverClientId = (!kIsWeb && Platform.isIOS && iosId.isNotEmpty)
            ? iosId
            : (androidId.isNotEmpty ? androidId : null);
      } catch (_) {
        // Non-blocking in offline/dev preview.
      }

      String? idToken;
      if (oidcEnabled || kReleaseMode) {
        final googleSignIn = GoogleSignIn(
          scopes: const ['email', 'openid'],
          serverClientId: serverClientId,
        );
        final account = await googleSignIn.signIn();
        if (account == null) {
          return; // User cancelled Google picker
        }
        final auth = await account.authentication;
        idToken = auth.idToken;
        if (idToken == null || idToken.isEmpty) {
          throw Exception('Google ID token unavailable — check OAuth Client ID.');
        }
      } else if (!kReleaseMode) {
        idToken = 'dev-google-sub:${DateTime.now().millisecondsSinceEpoch}';
      }

      if (idToken != null && idToken.isNotEmpty) {
        await api.bindGoogleIdentity(idToken);
      }
      await notifier.refreshWorkspace();
      if (!mounted) return;
      ref.read(ertadFeedbackProvider.notifier).showSuccess(
        shellTr(
          context,
          'signin_google_success',
          fallback: 'Signed in with Google',
        ),
      );
      if (GoRouter.maybeOf(context) != null) {
        context.go('/home');
      } else {
        Navigator.of(context).pop();
      }
    } catch (err) {
      if (!mounted) return;
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _quickLogin(DevPersona persona) async {
    if (_busy || kReleaseMode) return;
    HapticFeedback.selectionClick();
    setState(() => _busy = true);
    try {
      await ref.read(shellSessionProvider.notifier).setDevPersona(persona);
      if (!mounted) return;
      if (GoRouter.maybeOf(context) != null) {
        context.go('/home');
      } else {
        Navigator.of(context).pop();
      }
    } catch (err) {
      if (!mounted) return;
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final logoWidth = (MediaQuery.sizeOf(context).width * 0.72).clamp(
      200.0,
      340.0,
    );

    return Scaffold(
      backgroundColor: p.background,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(24, 28, 24, 28),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Image.asset(
                    'assets/images/splash_logo.png',
                    width: logoWidth,
                    fit: BoxFit.contain,
                  ),
                  const SizedBox(height: 20),
                  Text(
                    'ERTAD',
                    style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                      letterSpacing: 2.5,
                      color: p.primary,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    shellTr(
                      context,
                      'signin_subtitle',
                      fallback:
                          'Sign in with Google, then verify your eID biometrics for full voting and participation.',
                    ),
                    textAlign: TextAlign.center,
                    style: Theme.of(
                      context,
                    ).textTheme.bodyMedium?.copyWith(color: p.muted),
                  ),
                  const SizedBox(height: 28),
                  ErtadSurfaceCard(
                    padding: const EdgeInsets.all(18),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        FilledButton.icon(
                          onPressed: _busy ? null : _signInWithGoogle,
                          style: FilledButton.styleFrom(
                            minimumSize: const Size(double.infinity, 52),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(14),
                            ),
                          ),
                          icon: _busy
                              ? const SizedBox(
                                  width: 18,
                                  height: 18,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    color: Colors.white,
                                  ),
                                )
                              : const Icon(Icons.login_rounded, size: 20),
                          label: Text(
                            shellTr(
                              context,
                              'signin_with_google',
                              fallback: 'Continue with Google',
                            ),
                          ),
                        ),
                        if (!kReleaseMode) ...[
                          const SizedBox(height: 18),
                          Row(
                            children: [
                              Expanded(child: Divider(color: p.hairline)),
                              Padding(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 10,
                                ),
                                child: Text(
                                  shellTr(
                                    context,
                                    'signin_quick_dev',
                                    fallback: 'Quick Login (Dev)',
                                  ),
                                  style: Theme.of(context).textTheme.labelSmall
                                      ?.copyWith(color: p.muted),
                                ),
                              ),
                              Expanded(child: Divider(color: p.hairline)),
                            ],
                          ),
                          const SizedBox(height: 12),
                          Row(
                            children: [
                              Expanded(
                                child: OutlinedButton.icon(
                                  onPressed: _busy
                                      ? null
                                      : () => _quickLogin(DevPersona.member),
                                  style: OutlinedButton.styleFrom(
                                    minimumSize: const Size(0, 46),
                                    shape: RoundedRectangleBorder(
                                      borderRadius: BorderRadius.circular(12),
                                    ),
                                  ),
                                  icon: const Icon(
                                    Icons.person_outline_rounded,
                                    size: 18,
                                  ),
                                  label: Text(
                                    shellTr(
                                      context,
                                      'dev_persona_member',
                                      fallback: 'Member',
                                    ),
                                  ),
                                ),
                              ),
                              const SizedBox(width: 10),
                              Expanded(
                                child: OutlinedButton.icon(
                                  onPressed: _busy
                                      ? null
                                      : () => _quickLogin(
                                          DevPersona.groupManager,
                                        ),
                                  style: OutlinedButton.styleFrom(
                                    minimumSize: const Size(0, 46),
                                    shape: RoundedRectangleBorder(
                                      borderRadius: BorderRadius.circular(12),
                                    ),
                                  ),
                                  icon: const Icon(
                                    Icons.shield_outlined,
                                    size: 18,
                                  ),
                                  label: Text(
                                    shellTr(
                                      context,
                                      'dev_persona_manager',
                                      fallback: 'Manager',
                                    ),
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ],
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
