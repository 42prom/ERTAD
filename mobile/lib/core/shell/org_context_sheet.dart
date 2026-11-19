import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';

import '../../models/verification_models.dart';
import '../../screens/enrollment/intro_screen.dart';
import '../../services/storage_service.dart';
import '../../widgets/region_selection_sheet.dart';
import '../feedback/ertad_feedback.dart';
import '../state/shell_providers.dart';
import '../theme/ertad_theme.dart';
import '../widgets/ertad_ui.dart';
import 'shell_l10n.dart';

/// Opens the clean, icon-driven My Profile modal sheet.
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
  String? _localFullName;
  String? _localBirthDate;
  String? _localRegionCode;

  @override
  void initState() {
    super.initState();
    _loadLocalIdentity();
  }

  Future<void> _loadLocalIdentity() async {
    try {
      final storage = StorageService();
      final first = (await storage.getFirstName() ?? '').trim();
      final last = (await storage.getLastName() ?? '').trim();
      final dob = await storage.getBirthDate();
      final regions = await storage.getRegionCodes();
      if (!mounted) return;
      final fullName = [first, last].where((s) => s.isNotEmpty).join(' ');
      String? dobFormatted;
      if (dob != null) {
        final dd = dob.day.toString().padLeft(2, '0');
        final mm = dob.month.toString().padLeft(2, '0');
        dobFormatted = '$dd.$mm.${dob.year}';
      }
      final regionCode = regions.isNotEmpty ? regions.first : null;
      if (fullName.isNotEmpty || dobFormatted != null || regionCode != null) {
        setState(() {
          _localFullName = fullName.isNotEmpty ? fullName : null;
          _localBirthDate = dobFormatted;
          _localRegionCode = regionCode;
        });
      }
    } catch (_) {
      // Local on-device identity enrichment is best-effort only.
    }
  }

  Future<void> _pickRegion() async {
    HapticFeedback.selectionClick();
    final selected = await showModalBottomSheet<Region>(
      context: context,
      useRootNavigator: true,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => RegionSelectionSheet(
        selectedCode: _localRegionCode,
      ),
    );
    if (selected != null) {
      await StorageService().saveRegionCodes([selected.code]);
      if (!mounted) return;
      HapticFeedback.lightImpact();
      setState(() => _localRegionCode = selected.code);
    }
  }

  Future<void> _editPhoneDialog({required bool hasPhone}) async {
    final action = await showErtadTextInputDialog(
      context,
      title: shellTr(context, 'profile_phone_title', fallback: 'Phone Number'),
      hintText: shellTr(
        context,
        'profile_phone_hint',
        fallback: '+995 5XX XX XX XX',
      ),
      cancelLabel: shellTr(context, 'cancel', fallback: 'Cancel'),
      confirmLabel: shellTr(context, 'save', fallback: 'Save'),
      destructiveLabel:
          hasPhone ? shellTr(context, 'delete', fallback: 'Remove') : null,
      destructiveValue: hasPhone ? '__CLEAR__' : null,
      keyboardType: TextInputType.phone,
    );
    if (!mounted || action == null) return;
    try {
      if (action == '__CLEAR__') {
        await ref
            .read(shellSessionProvider.notifier)
            .updateMemberPhone(clear: true);
        if (!mounted) return;
        HapticFeedback.lightImpact();
        ref.read(ertadFeedbackProvider.notifier).showSuccess(
              shellTr(
                context,
                'profile_phone_cleared',
                fallback: 'Phone number removed',
              ),
            );
      } else if (action.length >= 7) {
        await ref
            .read(shellSessionProvider.notifier)
            .updateMemberPhone(phone: action);
        if (!mounted) return;
        HapticFeedback.lightImpact();
        ref.read(ertadFeedbackProvider.notifier).showSuccess(
              shellTr(
                context,
                'profile_phone_saved',
                fallback: 'Phone number saved',
              ),
            );
      } else {
        ref.read(ertadFeedbackProvider.notifier).showWarning(
              shellTr(
                context,
                'profile_phone_error',
                fallback: 'Please enter a valid phone number',
              ),
            );
      }
    } catch (_) {
      if (!mounted) return;
      ref.read(ertadFeedbackProvider.notifier).showWarning(
            shellTr(
              context,
              'profile_phone_error',
              fallback: 'Please enter a valid phone number',
            ),
          );
    }
  }

  Future<void> _enterReferralDialog() async {
    final code = await showErtadTextInputDialog(
      context,
      title: shellTr(context, 'ref_enter_code_title', fallback: 'Referrer code'),
      hintText: shellTr(
        context,
        'ref_enter_code_hint',
        fallback: 'ERTAD-P-XXXX-XXXX',
      ),
      cancelLabel: shellTr(context, 'cancel', fallback: 'Cancel'),
      confirmLabel: shellTr(context, 'ref_apply_code', fallback: 'Apply'),
      textCapitalization: TextCapitalization.characters,
      uppercaseResult: true,
    );
    if (!mounted || code == null || code.isEmpty) return;
    try {
      await ref.read(shellSessionProvider.notifier).redeemReferralCode(code);
      if (!mounted) return;
      HapticFeedback.mediumImpact();
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
              fallback: 'Could not apply code.',
            ),
          );
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
    final googleLinked = prof?['googleLinked'] == true;
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
                      : Icons.person_rounded,
                  title: shellTr(
                    context,
                    'profile_sheet_title',
                    fallback: 'My Profile',
                  ),
                  closeTooltip: shellTr(context, 'close', fallback: 'Close'),
                ),
                const SizedBox(height: 12),

                // 1. Clean Identity & Compact Verification Chips Card
                ErtadSurfaceCard(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          ErtadIconCircle(
                            icon: isVerified
                                ? Icons.verified_rounded
                                : Icons.person_rounded,
                            tone: isVerified
                                ? ErtadTone.success
                                : ErtadTone.primary,
                            size: 46,
                            iconSize: 22,
                            radius: 15,
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
                                const SizedBox(height: 3),
                                Text(
                                  isVerified
                                      ? shellTr(
                                          context,
                                          'profile_verified_status',
                                          fallback: 'Verified',
                                        )
                                      : shellTr(
                                          context,
                                          'profile_unverified_status',
                                          fallback: 'Unverified',
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
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          _StatusChip(
                            icon: Icons.public_rounded,
                            label: citizenship.isNotEmpty ? citizenship : 'GE',
                            active: citizenship.isNotEmpty,
                          ),
                          _StatusChip(
                            icon: Icons.badge_outlined,
                            label: 'eID',
                            active: nfcOk,
                          ),
                          _StatusChip(
                            icon: Icons.g_mobiledata_rounded,
                            label: 'Google',
                            active: googleLinked,
                          ),
                        ],
                      ),
                      const SizedBox(height: 14),
                      SizedBox(
                        width: double.infinity,
                        child: isVerified
                            ? OutlinedButton.icon(
                                onPressed: () {
                                  HapticFeedback.selectionClick();
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
                                    fallback: 'Biometric re-check',
                                  ),
                                ),
                              )
                            : FilledButton.icon(
                                onPressed: () {
                                  HapticFeedback.selectionClick();
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
                                    'profile_verify_cta',
                                    fallback: 'Verify identity',
                                  ),
                                ),
                              ),
                      ),
                    ],
                  ),
                ),

                const SizedBox(height: 12),

                // 2. Personal Details (on-device encrypted eID + server region/group)
                ErtadSurfaceCard(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 12,
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (_localFullName != null) ...[
                        _ProfileInfoRow(
                          icon: Icons.badge_outlined,
                          label: shellTr(
                            context,
                            'profile_full_name',
                            fallback: 'Full name',
                          ),
                          value: _localFullName!,
                        ),
                        Divider(height: 16, color: p.hairline),
                      ],
                      if (_localBirthDate != null) ...[
                        _ProfileInfoRow(
                          icon: Icons.cake_outlined,
                          label: shellTr(
                            context,
                            'profile_birth_date',
                            fallback: 'Date of birth',
                          ),
                          value: _localBirthDate!,
                        ),
                        Divider(height: 16, color: p.hairline),
                      ],
                      InkWell(
                        borderRadius: BorderRadius.circular(10),
                        onTap: _pickRegion,
                        child: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 2),
                          child: Row(
                            children: [
                              Expanded(
                                child: _ProfileInfoRow(
                                  icon: Icons.location_on_outlined,
                                  label: shellTr(
                                    context,
                                    'profile_region_group',
                                    fallback: 'Region / Group',
                                  ),
                                  value: _localRegionCode != null
                                      ? '${resolveGeorgianRegionLabel(_localRegionCode!)} · ${session.activeOrg.unitName}'
                                      : session.activeOrg.unitName,
                                ),
                              ),
                              const SizedBox(width: 4),
                              Icon(
                                Icons.edit_outlined,
                                size: 15,
                                color: p.muted,
                              ),
                            ],
                          ),
                        ),
                      ),
                      if (_localFullName != null || _localBirthDate != null) ...[
                        const SizedBox(height: 8),
                        Row(
                          children: [
                            Icon(
                              Icons.lock_outline_rounded,
                              size: 13,
                              color: p.muted,
                            ),
                            const SizedBox(width: 5),
                            Expanded(
                              child: Text(
                                shellTr(
                                  context,
                                  'profile_device_only_hint',
                                  fallback: 'Stored on this device only',
                                ),
                                style: Theme.of(context).textTheme.labelSmall
                                    ?.copyWith(color: p.muted),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ],
                  ),
                ),

                const SizedBox(height: 12),

                // 3. Phone Number & Personal Referral Card (clear action button)
                ErtadSurfaceCard(
                  padding: EdgeInsets.zero,
                  child: Column(
                    children: [
                      ListTile(
                        minTileHeight: 60,
                        leading: Icon(Icons.phone_outlined, color: p.primary),
                        title: Text(
                          hasPhone && phoneHint.isNotEmpty
                              ? phoneHint
                              : shellTr(
                                  context,
                                  'profile_phone_title',
                                  fallback: 'Phone Number',
                                ),
                          style: hasPhone && phoneHint.isNotEmpty
                              ? Theme.of(context).textTheme.titleSmall
                                  ?.copyWith(fontFamily: 'monospace')
                              : null,
                        ),
                        subtitle: hasPhone
                            ? null
                            : Text(
                                shellTr(
                                  context,
                                  'profile_val_not_set',
                                  fallback: 'Not set',
                                ),
                                style: Theme.of(context).textTheme.bodySmall,
                              ),
                        trailing: FilledButton.tonal(
                          style: FilledButton.styleFrom(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 12,
                              vertical: 6,
                            ),
                            minimumSize: const Size(0, 34),
                            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                          ),
                          onPressed: () {
                            HapticFeedback.selectionClick();
                            _editPhoneDialog(hasPhone: hasPhone);
                          },
                          child: Text(
                            hasPhone
                                ? shellTr(
                                    context,
                                    'profile_edit_phone',
                                    fallback: 'Edit',
                                  )
                                : '+ ${shellTr(context, 'profile_add_phone', fallback: 'Add')}',
                            style: const TextStyle(fontSize: 12),
                          ),
                        ),
                        onTap: () {
                          HapticFeedback.selectionClick();
                          _editPhoneDialog(hasPhone: hasPhone);
                        },
                      ),
                      if (personalCode.isNotEmpty) ...[
                        Divider(height: 1, color: p.hairline),
                        ListTile(
                          minTileHeight: 56,
                          leading: Icon(
                            Icons.qr_code_2_rounded,
                            color: p.primary,
                          ),
                          title: Text(
                            personalCode,
                            style: Theme.of(context).textTheme.titleSmall
                                ?.copyWith(
                                  fontFamily: 'monospace',
                                  fontWeight: FontWeight.w700,
                                  color: p.primary,
                                ),
                          ),
                          subtitle: Text(
                            shellTr(
                              context,
                              'profile_referral_title',
                              fallback: 'My personal referral code',
                            ),
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                          trailing: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              IconButton(
                                tooltip: shellTr(
                                  context,
                                  'copy',
                                  fallback: 'Copy',
                                ),
                                onPressed: () {
                                  HapticFeedback.lightImpact();
                                  Clipboard.setData(
                                    ClipboardData(text: personalCode),
                                  );
                                  ref
                                      .read(ertadFeedbackProvider.notifier)
                                      .showSuccess(
                                        shellTr(
                                          context,
                                          'profile_code_copied',
                                          fallback: 'Code copied',
                                        ),
                                      );
                                },
                                icon: const Icon(Icons.copy_rounded, size: 18),
                              ),
                              IconButton(
                                tooltip: shellTr(
                                  context,
                                  'profile_share_invite',
                                  fallback: 'Share',
                                ),
                                onPressed: () {
                                  HapticFeedback.selectionClick();
                                  SharePlus.instance.share(
                                    ShareParams(text: 'ERTAD · $personalCode'),
                                  );
                                },
                                icon: const Icon(Icons.share_rounded, size: 18),
                              ),
                            ],
                          ),
                        ),
                        Divider(height: 1, color: p.hairline),
                        ListTile(
                          minTileHeight: 50,
                          leading: Icon(
                            Icons.account_tree_outlined,
                            color: p.muted,
                          ),
                          title: Text(
                            invitedBy != null
                                ? '${shellTr(context, 'ref_invited_by', fallback: 'Invited by')}: ${invitedBy['displayLabel'] ?? invitedBy['code'] ?? ''}'
                                : shellTr(
                                    context,
                                    'ref_enter_code_title',
                                    fallback: 'Have a referrer code?',
                                  ),
                            style: Theme.of(context).textTheme.bodyMedium,
                          ),
                          trailing: invitedBy == null && session.isLiveConnected
                              ? Icon(
                                  Icons.add_rounded,
                                  size: 20,
                                  color: p.primary,
                                )
                              : null,
                          onTap: invitedBy == null && session.isLiveConnected
                              ? () {
                                  HapticFeedback.selectionClick();
                                  _enterReferralDialog();
                                }
                              : null,
                        ),
                      ],
                    ],
                  ),
                ),

                // 3. Only show group switcher if member belongs to >1 organizations
                if (session.organizations.length > 1) ...[
                  const SizedBox(height: 14),
                  Text(
                    shellTr(
                      context,
                      'profile_groups_section',
                      fallback: 'Organization & Group',
                    ),
                    style: Theme.of(
                      context,
                    ).textTheme.labelMedium?.copyWith(color: p.muted),
                  ),
                  const SizedBox(height: 8),
                  ...session.organizations.map((org) {
                    final selected = org.id == session.activeOrgId;
                    return Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: ErtadSurfaceCard(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 14,
                          vertical: 12,
                        ),
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
                            const SizedBox(width: 10),
                            Expanded(
                              child: Text(
                                '${org.name} · ${org.unitName}',
                                style: Theme.of(context).textTheme.titleSmall,
                              ),
                            ),
                          ],
                        ),
                      ),
                    );
                  }),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool active;

  const _StatusChip({
    required this.icon,
    required this.label,
    required this.active,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final fg = active ? p.success : p.muted;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: active ? p.success.withValues(alpha: 0.12) : p.elevated,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: active ? p.success.withValues(alpha: 0.35) : p.hairline,
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(active ? Icons.check_circle_rounded : icon, size: 15, color: fg),
          const SizedBox(width: 5),
          Text(
            label,
            style: Theme.of(context).textTheme.labelMedium?.copyWith(
                  color: fg,
                  fontWeight: FontWeight.w600,
                ),
          ),
        ],
      ),
    );
  }
}

class _ProfileInfoRow extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;

  const _ProfileInfoRow({
    required this.icon,
    required this.label,
    required this.value,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    return Row(
      children: [
        Icon(icon, size: 18, color: p.primary),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            label,
            style: Theme.of(
              context,
            ).textTheme.bodySmall?.copyWith(color: p.muted),
          ),
        ),
        const SizedBox(width: 8),
        Flexible(
          child: Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.end,
            style: Theme.of(
              context,
            ).textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
          ),
        ),
      ],
    );
  }
}
