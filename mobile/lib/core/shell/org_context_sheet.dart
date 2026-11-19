import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';

import '../../screens/auth/sign_in_screen.dart';
import '../../screens/enrollment/intro_screen.dart';
import '../feedback/ertad_feedback.dart';
import '../state/shell_providers.dart';
import '../theme/ertad_theme.dart';
import '../widgets/ertad_ui.dart';
import 'account_privacy_sheet.dart';
import 'shell_l10n.dart';

/// Opens modal My Profile, Verified Identity Data, Encrypted Phone, Personal Referral & Group hub.
Future<void> showOrgContextSheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => const OrgContextSheet(),
  );
}

class OrgContextSheet extends ConsumerStatefulWidget {
  const OrgContextSheet({super.key});

  @override
  ConsumerState<OrgContextSheet> createState() => _OrgContextSheetState();
}

class _OrgContextSheetState extends ConsumerState<OrgContextSheet> {
  final TextEditingController _refCodeController = TextEditingController();
  final TextEditingController _phoneController = TextEditingController();
  bool _redeeming = false;
  bool _savingPhone = false;

  @override
  void dispose() {
    _refCodeController.dispose();
    _phoneController.dispose();
    super.dispose();
  }

  Future<void> _redeemCode() async {
    final code = _refCodeController.text.trim().toUpperCase();
    if (code.isEmpty || _redeeming) return;
    setState(() => _redeeming = true);
    try {
      await ref.read(shellSessionProvider.notifier).redeemReferralCode(code);
      if (!mounted) return;
      _refCodeController.clear();
      ref.read(ertadFeedbackProvider.notifier).showSuccess(
            shellTr(
              context,
              'ref_code_applied',
              fallback: 'Referrer linked successfully',
            ),
          );
    } catch (_) {
      if (!mounted) return;
      ref.read(ertadFeedbackProvider.notifier).showWarning(
            shellTr(
              context,
              'ref_code_error',
              fallback: 'Could not apply code — check format or already linked.',
            ),
          );
    } finally {
      if (mounted) setState(() => _redeeming = false);
    }
  }

  Future<void> _savePhone({bool clear = false}) async {
    if (_savingPhone) return;
    final phone = _phoneController.text.trim();
    if (!clear && phone.length < 7) {
      ref.read(ertadFeedbackProvider.notifier).showWarning(
            shellTr(
              context,
              'profile_phone_error',
              fallback: 'Please enter a valid phone number',
            ),
          );
      return;
    }
    setState(() => _savingPhone = true);
    try {
      await ref
          .read(shellSessionProvider.notifier)
          .updateMemberPhone(phone: clear ? null : phone, clear: clear);
      if (!mounted) return;
      _phoneController.clear();
      ref.read(ertadFeedbackProvider.notifier).showSuccess(
            clear
                ? shellTr(
                    context,
                    'profile_phone_cleared',
                    fallback: 'Phone number removed',
                  )
                : shellTr(
                    context,
                    'profile_phone_saved',
                    fallback: 'Phone number saved',
                  ),
          );
    } catch (_) {
      if (!mounted) return;
      ref.read(ertadFeedbackProvider.notifier).showWarning(
            shellTr(
              context,
              'profile_phone_error',
              fallback: 'Please enter a valid phone number',
            ),
          );
    } finally {
      if (mounted) setState(() => _savingPhone = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final session = ref.watch(shellSessionProvider);
    final notifier = ref.read(shellSessionProvider.notifier);
    final isVerified = session.m4AssuranceLevel == 'biometric_verified';
    final displayTitle =
        session.privacyLevel == PrivacyDisclosureLevel.sharedContextOptIn &&
                (session.optInDisplayName?.trim().isNotEmpty ?? false)
            ? session.optInDisplayName!.trim()
            : shellTr(
                context,
                'profile_anonymous_member',
                fallback: 'Anonymous member',
              );

    final prof = session.memberProfile;
    final citizenship = prof?['citizenshipCountry']?.toString().trim() ?? '';
    final nfcOk = prof?['sodCscaVerified'] == true || session.m4SodCscaVerified;
    final hasTemplate = prof?['hasStoredTemplate'] == true;
    final googleLinked = prof?['googleLinked'] == true;
    final verifiedAtRaw = prof?['verifiedAt']?.toString() ?? '';
    final verifiedDate =
        verifiedAtRaw.length >= 10 ? verifiedAtRaw.substring(0, 10) : '';
    final hasPhone = prof?['hasPhone'] == true;
    final phoneHint = prof?['phoneHint']?.toString() ?? '';

    final refSummary = session.referralSummary;
    final personalCode = refSummary?['personalCode']?.toString() ?? '';
    final invitedBy = refSummary?['invitedBy'] is Map
        ? Map<String, dynamic>.from(refSummary!['invitedBy'] as Map)
        : null;

    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(
          16,
          12,
          16,
          20 + MediaQuery.viewInsetsOf(context).bottom,
        ),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 640),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ErtadModalSheetHeader(
                  icon: isVerified
                      ? Icons.verified_user_rounded
                      : Icons.person_outline_rounded,
                  title: shellTr(
                    context,
                    'profile_sheet_title',
                    fallback: 'My Profile',
                  ),
                  closeTooltip: shellTr(context, 'close', fallback: 'Close'),
                ),
                const SizedBox(height: 12),

                // 1. Member Profile, Verified Identity Details & Actions
                ErtadSurfaceCard(
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          ErtadIconCircle(
                            icon: isVerified
                                ? Icons.verified_rounded
                                : Icons.fingerprint_rounded,
                            tone: isVerified
                                ? ErtadTone.success
                                : ErtadTone.primary,
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    Flexible(
                                      child: Text(
                                        displayTitle,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: Theme.of(
                                          context,
                                        ).textTheme.titleMedium,
                                      ),
                                    ),
                                    if (isVerified) ...[
                                      const SizedBox(width: 6),
                                      Icon(
                                        Icons.verified_rounded,
                                        size: 16,
                                        color: p.primary,
                                      ),
                                    ],
                                  ],
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  isVerified
                                      ? shellTr(
                                          context,
                                          'profile_verified_status',
                                          fallback: 'Verified · eID biometrics',
                                        )
                                      : shellTr(
                                          context,
                                          'profile_unverified_status',
                                          fallback:
                                              'Biometric verification required',
                                        ),
                                  style: Theme.of(context).textTheme.bodySmall
                                      ?.copyWith(
                                        color: isVerified
                                            ? p.success
                                            : p.warning,
                                        fontWeight: FontWeight.w600,
                                      ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      // Verified eID Details Box
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: p.elevated,
                          borderRadius: BorderRadius.circular(14),
                          border: Border.all(color: p.hairline),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              shellTr(
                                context,
                                'profile_verified_data_title',
                                fallback: 'Verification Details',
                              ),
                              style: Theme.of(context).textTheme.labelMedium
                                  ?.copyWith(color: p.muted),
                            ),
                            const SizedBox(height: 8),
                            _ProfileInfoRow(
                              label: shellTr(
                                context,
                                'profile_field_citizenship',
                                fallback: 'Citizenship',
                              ),
                              value: citizenship.isNotEmpty
                                  ? citizenship
                                  : '—',
                            ),
                            _ProfileInfoRow(
                              label: shellTr(
                                context,
                                'profile_field_nfc',
                                fallback: 'eID Chip (NFC/SOD)',
                              ),
                              value: nfcOk
                                  ? shellTr(
                                      context,
                                      'profile_val_confirmed',
                                      fallback: 'Verified',
                                    )
                                  : shellTr(
                                      context,
                                      'status_pending',
                                      fallback: 'Pending',
                                    ),
                              highlight: nfcOk,
                            ),
                            _ProfileInfoRow(
                              label: shellTr(
                                context,
                                'profile_field_template',
                                fallback: 'Biometric Template',
                              ),
                              value: hasTemplate
                                  ? shellTr(
                                      context,
                                      'profile_val_encrypted',
                                      fallback: 'Encrypted (AES-256)',
                                    )
                                  : '—',
                              highlight: hasTemplate,
                            ),
                            _ProfileInfoRow(
                              label: shellTr(
                                context,
                                'profile_field_google',
                                fallback: 'Google Account',
                              ),
                              value: googleLinked
                                  ? shellTr(
                                      context,
                                      'profile_val_linked',
                                      fallback: 'Linked',
                                    )
                                  : shellTr(
                                      context,
                                      'profile_val_not_set',
                                      fallback: 'Not set',
                                    ),
                              highlight: googleLinked,
                            ),
                            if (verifiedDate.isNotEmpty)
                              _ProfileInfoRow(
                                label: shellTr(
                                  context,
                                  'profile_field_verified_at',
                                  fallback: 'Verified Date',
                                ),
                                value: verifiedDate,
                              ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 12),
                      // Always show biometric verification / re-verification CTA
                      SizedBox(
                        width: double.infinity,
                        child: isVerified
                            ? FilledButton.tonalIcon(
                                onPressed: () {
                                  final nav = Navigator.of(
                                    context,
                                    rootNavigator: true,
                                  );
                                  nav.pop();
                                  nav.push(
                                    MaterialPageRoute<void>(
                                      builder: (_) => const IntroScreen(),
                                    ),
                                  );
                                },
                                icon: const Icon(
                                  Icons.fingerprint_rounded,
                                  size: 18,
                                ),
                                label: Text(
                                  shellTr(
                                    context,
                                    'profile_reverify_cta',
                                    fallback: 'Biometric re-check / Re-verify',
                                  ),
                                ),
                              )
                            : FilledButton.icon(
                                onPressed: () {
                                  final nav = Navigator.of(
                                    context,
                                    rootNavigator: true,
                                  );
                                  nav.pop();
                                  nav.push(
                                    MaterialPageRoute<void>(
                                      builder: (_) => const IntroScreen(),
                                    ),
                                  );
                                },
                                icon: const Icon(
                                  Icons.verified_outlined,
                                  size: 18,
                                ),
                                label: Text(
                                  shellTr(
                                    context,
                                    'profile_verify_cta',
                                    fallback: 'Verify identity',
                                  ),
                                ),
                              ),
                      ),
                      const SizedBox(height: 8),
                      // Always show Google Sign-In / Switch Account button
                      SizedBox(
                        width: double.infinity,
                        child: OutlinedButton.icon(
                          onPressed: () {
                            final nav = Navigator.of(
                              context,
                              rootNavigator: true,
                            );
                            nav.pop();
                            nav.push(
                              MaterialPageRoute<void>(
                                builder: (_) => const SignInScreen(),
                              ),
                            );
                          },
                          icon: const Icon(Icons.login_rounded, size: 18),
                          label: Text(
                            shellTr(
                              context,
                              'open_signin_screen',
                              fallback: 'Google Sign-In / Switch account',
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(height: 8),
                      SizedBox(
                        width: double.infinity,
                        child: TextButton.icon(
                          onPressed: () {
                            final hostContext = Navigator.of(
                              context,
                              rootNavigator: true,
                            ).context;
                            Navigator.of(context).pop();
                            showAccountPrivacySheet(hostContext);
                          },
                          icon: const Icon(Icons.tune_rounded, size: 17),
                          label: Text(
                            shellTr(
                              context,
                              'profile_open_privacy',
                              fallback: 'Privacy & profile settings',
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),

                const SizedBox(height: 14),

                // 2. Encrypted Personal Phone Number Card
                ErtadSurfaceCard(
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Icon(
                            Icons.phone_outlined,
                            size: 18,
                            color: p.primary,
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              shellTr(
                                context,
                                'profile_phone_title',
                                fallback: 'Phone Number',
                              ),
                              style: Theme.of(context).textTheme.titleSmall,
                            ),
                          ),
                          if (hasPhone)
                            IconButton(
                              tooltip: shellTr(
                                context,
                                'delete',
                                fallback: 'Remove',
                              ),
                              onPressed: _savingPhone
                                  ? null
                                  : () => _savePhone(clear: true),
                              icon: Icon(
                                Icons.delete_outline_rounded,
                                size: 18,
                                color: p.danger,
                              ),
                            ),
                        ],
                      ),
                      if (hasPhone && phoneHint.isNotEmpty) ...[
                        const SizedBox(height: 4),
                        Text(
                          phoneHint,
                          style: Theme.of(context).textTheme.titleMedium
                              ?.copyWith(
                                fontFamily: 'monospace',
                                color: p.primary,
                                fontWeight: FontWeight.w700,
                              ),
                        ),
                      ],
                      const SizedBox(height: 8),
                      Row(
                        children: [
                          Expanded(
                            child: TextField(
                              controller: _phoneController,
                              keyboardType: TextInputType.phone,
                              decoration: InputDecoration(
                                isDense: true,
                                hintText: shellTr(
                                  context,
                                  'profile_phone_hint',
                                  fallback: '+995 5XX XX XX XX',
                                ),
                                border: const OutlineInputBorder(),
                                contentPadding: const EdgeInsets.symmetric(
                                  horizontal: 10,
                                  vertical: 10,
                                ),
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          FilledButton(
                            onPressed:
                                (_savingPhone || !session.isLiveConnected)
                                    ? null
                                    : () => _savePhone(),
                            child: _savingPhone
                                ? const SizedBox(
                                    width: 16,
                                    height: 16,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                    ),
                                  )
                                : Text(
                                    shellTr(
                                      context,
                                      'save',
                                      fallback: 'Save',
                                    ),
                                  ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 6),
                      Text(
                        shellTr(
                          context,
                          'profile_phone_note',
                          fallback:
                              'Stored encrypted on the server and never shown to other members.',
                        ),
                        style: Theme.of(
                          context,
                        ).textTheme.bodySmall?.copyWith(color: p.muted),
                      ),
                    ],
                  ),
                ),

                if (personalCode.isNotEmpty) ...[
                  const SizedBox(height: 14),
                  // 3. Personal Referral Code & Upline Card
                  ErtadSurfaceCard(
                    padding: const EdgeInsets.all(14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          shellTr(
                            context,
                            'profile_referral_title',
                            fallback: 'My personal referral code',
                          ),
                          style: Theme.of(context).textTheme.labelMedium
                              ?.copyWith(color: p.muted),
                        ),
                        const SizedBox(height: 6),
                        Row(
                          children: [
                            Expanded(
                              child: SelectableText(
                                personalCode,
                                style: Theme.of(context).textTheme.titleMedium
                                    ?.copyWith(
                                      fontFamily: 'monospace',
                                      fontWeight: FontWeight.w700,
                                      color: p.primary,
                                    ),
                              ),
                            ),
                            IconButton(
                              tooltip: shellTr(
                                context,
                                'copy',
                                fallback: 'Copy',
                              ),
                              onPressed: () {
                                Clipboard.setData(
                                  ClipboardData(text: personalCode),
                                );
                                ref
                                    .read(ertadFeedbackProvider.notifier)
                                    .showSuccess(
                                      shellTr(
                                        context,
                                        'profile_code_copied',
                                        fallback:
                                            'Personal referral code copied',
                                      ),
                                    );
                              },
                              icon: const Icon(Icons.copy_rounded, size: 18),
                            ),
                            FilledButton.tonalIcon(
                              onPressed: () {
                                SharePlus.instance.share(
                                  ShareParams(text: 'ERTAD · $personalCode'),
                                );
                              },
                              icon: const Icon(Icons.share_rounded, size: 16),
                              label: Text(
                                shellTr(
                                  context,
                                  'profile_share_invite',
                                  fallback: 'Share',
                                ),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 4),
                        Text(
                          shellTr(
                            context,
                            'profile_referral_hint',
                            fallback:
                                'Personal invite code — signup and biometric verification points follow organization rules.',
                          ),
                          style: Theme.of(
                            context,
                          ).textTheme.bodySmall?.copyWith(color: p.muted),
                        ),
                        const SizedBox(height: 10),
                        if (invitedBy != null)
                          Row(
                            children: [
                              Icon(
                                Icons.account_tree_outlined,
                                size: 16,
                                color: p.muted,
                              ),
                              const SizedBox(width: 6),
                              Expanded(
                                child: Text(
                                  '${shellTr(context, 'ref_invited_by', fallback: 'Invited by')}: ${invitedBy['displayLabel'] ?? invitedBy['code'] ?? ''}',
                                  style: Theme.of(context).textTheme.bodySmall,
                                ),
                              ),
                            ],
                          )
                        else if (session.isLiveConnected) ...[
                          Text(
                            shellTr(
                              context,
                              'ref_enter_code_title',
                              fallback: 'Have a referrer code?',
                            ),
                            style: Theme.of(
                              context,
                            ).textTheme.labelSmall?.copyWith(color: p.muted),
                          ),
                          const SizedBox(height: 6),
                          Row(
                            children: [
                              Expanded(
                                child: TextField(
                                  controller: _refCodeController,
                                  textCapitalization:
                                      TextCapitalization.characters,
                                  decoration: InputDecoration(
                                    isDense: true,
                                    hintText: shellTr(
                                      context,
                                      'ref_enter_code_hint',
                                      fallback: 'ERTAD-P-XXXX-XXXX',
                                    ),
                                    border: const OutlineInputBorder(),
                                    contentPadding: const EdgeInsets.symmetric(
                                      horizontal: 10,
                                      vertical: 10,
                                    ),
                                  ),
                                ),
                              ),
                              const SizedBox(width: 8),
                              FilledButton(
                                onPressed: _redeeming ? null : _redeemCode,
                                child: _redeeming
                                    ? const SizedBox(
                                        width: 16,
                                        height: 16,
                                        child: CircularProgressIndicator(
                                          strokeWidth: 2,
                                        ),
                                      )
                                    : Text(
                                        shellTr(
                                          context,
                                          'ref_apply_code',
                                          fallback: 'Apply',
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

                const SizedBox(height: 16),
                Text(
                  shellTr(
                    context,
                    'profile_groups_section',
                    fallback: 'Organization & Group',
                  ),
                  style: Theme.of(
                    context,
                  ).textTheme.labelLarge?.copyWith(color: p.muted),
                ),
                const SizedBox(height: 8),

                // 4. Organization & Group Scope Selector
                ...session.organizations.map((org) {
                  final selected = org.id == session.activeOrgId;
                  return Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: ErtadSurfaceCard(
                      backgroundColor: selected ? p.primarySoft : p.surface,
                      borderColor: selected ? p.primary : p.hairline,
                      onTap: () {
                        HapticFeedback.selectionClick();
                        notifier.selectOrganization(org.id);
                        Navigator.of(context).pop();
                      },
                      child: Row(
                        children: [
                          Icon(
                            selected
                                ? Icons.radio_button_checked_rounded
                                : Icons.radio_button_off_rounded,
                            color: selected ? p.primary : p.muted,
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  '${org.name} · ${org.unitName}',
                                  style: Theme.of(context).textTheme.titleMedium,
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  switch (org.roleLabel) {
                                    'Group Manager' => shellTr(
                                        context,
                                        'dev_persona_manager',
                                        fallback: 'Group Manager',
                                      ),
                                    'Member' => shellTr(
                                        context,
                                        'dev_persona_member',
                                        fallback: 'Member',
                                      ),
                                    _ => org.roleLabel,
                                  },
                                  style: Theme.of(context).textTheme.bodySmall,
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  );
                }),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ProfileInfoRow extends StatelessWidget {
  final String label;
  final String value;
  final bool highlight;

  const _ProfileInfoRow({
    required this.label,
    required this.value,
    this.highlight = false,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Expanded(
            child: Text(
              label,
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(color: p.muted),
            ),
          ),
          const SizedBox(width: 8),
          Text(
            value,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: highlight ? p.success : p.text,
                  fontWeight: FontWeight.w600,
                ),
          ),
        ],
      ),
    );
  }
}
