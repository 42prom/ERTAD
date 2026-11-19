import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../core/shell/shell_l10n.dart';
import '../../core/theme/ertad_theme.dart';
import '../../core/widgets/ertad_ui.dart';
import '../../models/verification_models.dart';
import '../../services/interfaces/i_api_service.dart';
import '../../services/localization_service.dart';
import '../../services/service_locator.dart';
import '../../widgets/ui_components.dart';
import 'document_entry_screen.dart';
import 'mrz_scanner_screen.dart';

/// Clean ERTAD-styled biometric verification entry screen:
/// Inherits app language automatically (zero duplicate language switcher),
/// presenting a crisp 3-step icon guide.
class IntroScreen extends StatefulWidget {
  const IntroScreen({super.key});

  @override
  State<IntroScreen> createState() => _IntroScreenState();
}

class _IntroScreenState extends State<IntroScreen> {
  final IApiService _api = ServiceLocator.apiService;
  bool _loading = false;

  VerificationPolicy _builtInFirstPartyPolicy() {
    return VerificationPolicy.fromJson(<String, dynamic>{
      'nfc': <String, dynamic>{
        'provider': 'on_device_georgia',
        'requireNfc': true,
        'requireGeorgianCitizen': true,
        'requirePersonalNumber': true,
        'allowSkipDocumentWhenNfcHasPortrait': true,
      },
      'documentScanner': <String, dynamic>{
        'provider': 'on_device_ocr_mrz',
        'requireDocumentPhotoScan': false,
        'strictness': 'strict',
      },
      'liveness': <String, dynamic>{
        'provider': '3d_face_detector',
        'minScore': 0.85,
        'retryLimit': 3,
      },
      'faceMatch': <String, dynamic>{
        'provider': 'custom_biometric_matcher',
        'minScore': 0.80,
      },
      'env': <String, dynamic>{'allowMocks': false},
    });
  }

  Future<void> _start() async {
    HapticFeedback.selectionClick();
    setState(() => _loading = true);

    try {
      VerificationPolicy policy;
      try {
        policy = await _api.fetchVerificationPolicy();
      } catch (_) {
        policy = _builtInFirstPartyPolicy();
      }

      if (!mounted) return;

      if (policy.documentScanner.provider == 'manual') {
        Navigator.of(context).push(
          MaterialPageRoute(
            builder: (_) =>
                DocumentEntryScreen(policy: policy, enrollmentSessionId: null),
          ),
        );
      } else {
        Navigator.of(context).push(
          MaterialPageRoute(builder: (_) => MrzScannerScreen(policy: policy)),
        );
      }
    } catch (_) {
      if (!mounted) return;
      final loc = Provider.of<LocalizationService>(context, listen: false);
      ERTADErrorDialog.show(
        context,
        title: loc.translate('connection_error'),
        message: loc.translate('connection_error_msg'),
      );
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final isKa =
        (maybeLocalizationOf(context)?.currentLanguage ??
            AppLanguage.georgian) ==
        AppLanguage.georgian;

    return Scaffold(
      backgroundColor: p.background,
      appBar: AppBar(
        title: Text(
          shellTr(context, 'profile_verify_cta', fallback: 'Verify identity'),
        ),
        backgroundColor: Colors.transparent,
        elevation: 0,
      ),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: Column(
              children: [
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
                    children: [
                      Center(
                        child: Image.asset(
                          p.isDark
                              ? 'assets/images/splash_logo_dark.png'
                              : 'assets/images/splash_logo.png',
                          height: 110,
                          fit: BoxFit.contain,
                        ),
                      ),
                      const SizedBox(height: 20),
                      Text(
                        isKa
                            ? '3 მარტივი ნაბიჯი'
                            : '3 quick steps',
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.headlineSmall
                            ?.copyWith(fontWeight: FontWeight.w800),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        isKa
                            ? 'დაადასტურე ვინაობა ჩათების, დავალებებისა და კენჭისყრის გასახსნელად.'
                            : 'Confirm your identity to unlock chats, tasks, and voting.',
                        textAlign: TextAlign.center,
                        style: Theme.of(
                          context,
                        ).textTheme.bodyMedium?.copyWith(color: p.muted),
                      ),
                      const SizedBox(height: 20),
                      ErtadSurfaceCard(
                        padding: const EdgeInsets.all(14),
                        child: Column(
                          children: [
                            _StepRow(
                              step: '1',
                              icon: Icons.badge_outlined,
                              title: isKa ? 'ID ბარათის სკანი' : 'Scan ID card',
                              subtitle: isKa
                                  ? 'მიმართე კამერა ბარათის უკანა მხარეს'
                                  : 'Point camera at the back of your ID',
                            ),
                            Divider(height: 20, color: p.hairline),
                            _StepRow(
                              step: '2',
                              icon: Icons.nfc_rounded,
                              title: isKa ? 'NFC ჩიპის წაკითხვა' : 'Tap NFC chip',
                              subtitle: isKa
                                  ? 'მიადე ID ბარათი ტელეფონის უკანა მხარეს'
                                  : 'Hold ID card against the back of your phone',
                            ),
                            Divider(height: 20, color: p.hairline),
                            _StepRow(
                              step: '3',
                              icon: Icons.face_retouching_natural_rounded,
                              title: isKa ? 'სახის შემოწმება' : 'Face check',
                              subtitle: isKa
                                  ? '3-წამიანი ცოცხალი სკანი კამერით'
                                  : 'Quick 3-second liveness check',
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
                  child: SizedBox(
                    width: double.infinity,
                    child: FilledButton.icon(
                      onPressed: _loading ? null : _start,
                      style: FilledButton.styleFrom(
                        minimumSize: const Size(double.infinity, 54),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(16),
                        ),
                      ),
                      icon: _loading
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Colors.white,
                              ),
                            )
                          : const Icon(Icons.fingerprint_rounded, size: 20),
                      label: Text(
                        isKa ? 'დაწყება' : 'Start verification',
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _StepRow extends StatelessWidget {
  final String step;
  final IconData icon;
  final String title;
  final String subtitle;

  const _StepRow({
    required this.step,
    required this.icon,
    required this.title,
    required this.subtitle,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    return Row(
      children: [
        ErtadIconCircle(
          icon: icon,
          tone: ErtadTone.primary,
          size: 42,
          iconSize: 20,
          radius: 13,
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '$step. $title',
                style: Theme.of(context).textTheme.titleSmall,
              ),
              const SizedBox(height: 2),
              Text(
                subtitle,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: p.muted),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
