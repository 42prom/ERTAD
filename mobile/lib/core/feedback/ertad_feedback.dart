import 'dart:async';
import 'dart:ui' as ui;

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../config/app_config.dart';
import '../network/mobile_api_client.dart';
import '../shell/shell_l10n.dart';
import '../theme/ertad_theme.dart';

enum ErtadFeedbackTone { info, success, warning, error }

@immutable
class ErtadFeedbackMessage {
  final int id;
  final String message;
  final ErtadFeedbackTone tone;
  final String? actionLabel;
  final VoidCallback? onAction;
  final String? diagnosticCode;

  const ErtadFeedbackMessage({
    required this.id,
    required this.message,
    this.tone = ErtadFeedbackTone.info,
    this.actionLabel,
    this.onAction,
    this.diagnosticCode,
  });
}

class ErtadFeedbackNotifier extends StateNotifier<List<ErtadFeedbackMessage>> {
  int _nextId = 1;
  final Map<int, Timer> _timers = <int, Timer>{};

  ErtadFeedbackNotifier() : super(const <ErtadFeedbackMessage>[]);

  void show(
    String message, {
    ErtadFeedbackTone tone = ErtadFeedbackTone.info,
    String? actionLabel,
    VoidCallback? onAction,
    String? diagnosticCode,
    Duration duration = const Duration(seconds: 4),
  }) {
    final id = _nextId++;
    final entry = ErtadFeedbackMessage(
      id: id,
      message: message,
      tone: tone,
      actionLabel: actionLabel,
      onAction: onAction,
      diagnosticCode: diagnosticCode,
    );
    state = <ErtadFeedbackMessage>[
      ...state.take(1),
      entry,
    ];
    _timers[id]?.cancel();
    _timers[id] = Timer(duration, () => dismiss(id));
  }

  void showSuccess(String message) => show(
    message,
    tone: ErtadFeedbackTone.success,
    duration: const Duration(seconds: 3),
  );

  void showWarning(
    String message, {
    String? actionLabel,
    VoidCallback? onAction,
  }) => show(
    message,
    tone: ErtadFeedbackTone.warning,
    actionLabel: actionLabel,
    onAction: onAction,
  );

  void showError(
    Object error, {
    bool georgian = true,
    String? retryLabel,
    VoidCallback? onRetry,
  }) {
    final mapped = ErtadErrorMapper.describe(error, georgian: georgian);
    show(
      mapped.message,
      tone: ErtadFeedbackTone.error,
      actionLabel: retryLabel,
      onAction: onRetry,
      diagnosticCode: mapped.diagnosticCode,
      duration: const Duration(seconds: 6),
    );
  }

  void dismiss(int id) {
    _timers.remove(id)?.cancel();
    state = state.where((m) => m.id != id).toList(growable: false);
  }

  @override
  void dispose() {
    for (final timer in _timers.values) {
      timer.cancel();
    }
    _timers.clear();
    super.dispose();
  }
}

final ertadFeedbackProvider =
    StateNotifierProvider<ErtadFeedbackNotifier, List<ErtadFeedbackMessage>>(
      (ref) => ErtadFeedbackNotifier(),
    );

@immutable
class MappedMobileError {
  final String message;
  final String? diagnosticCode;
  final bool isOffline;
  final bool requiresStepUp;

  const MappedMobileError({
    required this.message,
    this.diagnosticCode,
    this.isOffline = false,
    this.requiresStepUp = false,
  });
}

/// Maps HTTP/Dio/runtime failures into safe, consistent user-facing feedback.
class ErtadErrorMapper {
  ErtadErrorMapper._();

  static MappedMobileError describe(Object error, {bool georgian = true}) {
    if (error is MobileApiException) {
      final code = error.statusCode;
      if (code == 401) {
        return MappedMobileError(
          message: georgian
              ? 'სესია ამოიწურა — გთხოვ თავიდან გაიარო ავტორიზაცია.'
              : 'Session expired. Please reconnect your session.',
          diagnosticCode: 'ERT-401-${error.code}',
        );
      }
      if (code == 403) {
        return MappedMobileError(
          message: georgian
              ? 'ამ მოქმედებისთვის მიმდინარე არეალში უფლება არ გაქვს.'
              : 'Action not permitted in the current scope.',
          diagnosticCode: 'ERT-403-${error.code}',
        );
      }
      if (code == 428) {
        return MappedMobileError(
          message: georgian
              ? 'მგრძნობიარე მოქმედებისთვის საჭიროა დამატებითი დადასტურება.'
              : 'Additional verification is required to proceed.',
          diagnosticCode: 'ERT-428-${error.code}',
          requiresStepUp: true,
        );
      }
      if (code != null && code >= 500) {
        return MappedMobileError(
          message: georgian
              ? 'სერვერზე დროებითი შეფერხებაა. სცადე ცოტა ხანში.'
              : 'Temporary service issue. Please try again shortly.',
          diagnosticCode: 'ERT-$code-${error.code}',
        );
      }
      return MappedMobileError(
        message: error.message.isNotEmpty
            ? error.message
            : (georgian ? 'მოთხოვნა ვერ შესრულდა.' : 'Request could not complete.'),
        diagnosticCode: 'ERT-${code ?? 'ERR'}-${error.code}',
      );
    }

    if (error is DioException) {
      if (error.type == DioExceptionType.connectionError ||
          error.type == DioExceptionType.connectionTimeout ||
          error.type == DioExceptionType.receiveTimeout ||
          error.type == DioExceptionType.sendTimeout) {
        return MappedMobileError(
          message: georgian
              ? 'კავშირი ვერ მოხერხდა. შეამოწმე ინტერნეტი ან სცადე თავიდან.'
              : 'Connection unavailable. Check network and retry.',
          diagnosticCode: 'ERT-NET-${error.type.name.toUpperCase()}',
          isOffline: true,
        );
      }
    }

    return MappedMobileError(
      message: georgian
          ? 'დაფიქსირდა მოულოდნელი შეფერხება. სცადე თავიდან.'
          : 'An unexpected issue occurred. Please try again.',
      diagnosticCode: 'ERT-APP-${error.runtimeType}',
    );
  }
}

/// Overlay rendering unified floating toasts directly above the floating dock.
class ErtadFeedbackOverlay extends ConsumerWidget {
  final Widget child;
  final double bottomOffset;

  const ErtadFeedbackOverlay({
    super.key,
    required this.child,
    this.bottomOffset = 98,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final items = ref.watch(ertadFeedbackProvider);
    final safeBottom = MediaQuery.viewPaddingOf(context).bottom;

    return Stack(
      children: [
        child,
        if (items.isNotEmpty)
          Positioned(
            left: 14,
            right: 14,
            bottom: safeBottom + bottomOffset,
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 620),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: items
                      .map(
                        (item) => Padding(
                          padding: const EdgeInsets.only(top: 8),
                          child: _FeedbackToastCard(
                            item: item,
                            onDismiss: () => ref
                                .read(ertadFeedbackProvider.notifier)
                                .dismiss(item.id),
                          ),
                        ),
                      )
                      .toList(growable: false),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _FeedbackToastCard extends StatelessWidget {
  final ErtadFeedbackMessage item;
  final VoidCallback onDismiss;

  const _FeedbackToastCard({
    required this.item,
    required this.onDismiss,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final (IconData icon, Color accent) = switch (item.tone) {
      ErtadFeedbackTone.success => (Icons.check_circle_rounded, p.success),
      ErtadFeedbackTone.warning => (Icons.warning_amber_rounded, p.warning),
      ErtadFeedbackTone.error => (Icons.error_outline_rounded, p.danger),
      ErtadFeedbackTone.info => (Icons.info_outline_rounded, p.primary),
    };

    return Semantics(
      liveRegion: true,
      child: Dismissible(
        key: ValueKey<int>(item.id),
        direction: DismissDirection.horizontal,
        onDismissed: (_) => onDismiss(),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(20),
          child: BackdropFilter(
            filter: ui.ImageFilter.blur(sigmaX: 14, sigmaY: 14),
            child: Material(
              color: p.glassSurface,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(20),
                side: BorderSide(color: accent.withValues(alpha: 0.36)),
              ),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 8, 6, 8),
                child: Row(
                  children: [
                    Container(
                      width: 34,
                      height: 34,
                      decoration: BoxDecoration(
                        color: accent.withValues(alpha: 0.14),
                        shape: BoxShape.circle,
                      ),
                      child: Icon(icon, size: 19, color: accent),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            item.message,
                            style: Theme.of(context).textTheme.bodySmall
                                ?.copyWith(
                                  color: p.text,
                                  fontWeight: FontWeight.w500,
                                ),
                          ),
                          if (item.diagnosticCode != null) ...[
                            const SizedBox(height: 2),
                            InkWell(
                              onTap: () {
                                Clipboard.setData(
                                  ClipboardData(text: item.diagnosticCode!),
                                );
                              },
                              child: Text(
                                item.diagnosticCode!,
                                style: Theme.of(context).textTheme.labelSmall
                                    ?.copyWith(
                                      color: p.muted,
                                      fontFamily: 'monospace',
                                    ),
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                    if (item.actionLabel != null && item.onAction != null)
                      TextButton(
                        style: TextButton.styleFrom(
                          minimumSize: const Size(48, 48),
                          foregroundColor: accent,
                        ),
                        onPressed: () {
                          onDismiss();
                          item.onAction!.call();
                        },
                        child: Text(item.actionLabel!),
                      ),
                    IconButton(
                      tooltip: shellTr(context, 'close', fallback: 'Close'),
                      icon: Icon(Icons.close_rounded, size: 18, color: p.muted),
                      onPressed: onDismiss,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Safe confirmation dialog isolated from parent Navigator shadowing bugs.
Future<bool> showErtadConfirmDialog(
  BuildContext context, {
  required String title,
  required String message,
  required String cancelLabel,
  required String confirmLabel,
  IconData icon = Icons.help_outline_rounded,
  bool destructive = false,
}) async {
  final p = context.ertad;
  final accent = destructive ? p.danger : p.primary;

  final result = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      icon: Container(
        width: 48,
        height: 48,
        decoration: BoxDecoration(
          color: accent.withValues(alpha: 0.14),
          shape: BoxShape.circle,
        ),
        child: Icon(icon, color: accent, size: 24),
      ),
      title: Text(title),
      content: Text(
        message,
        textAlign: TextAlign.center,
        style: Theme.of(dialogContext).textTheme.bodyMedium?.copyWith(
          color: p.muted,
        ),
      ),
      actionsAlignment: MainAxisAlignment.end,
      actions: [
        TextButton(
          onPressed: () => Navigator.of(dialogContext).pop(false),
          child: Text(cancelLabel),
        ),
        FilledButton(
          style: FilledButton.styleFrom(
            backgroundColor: accent,
            foregroundColor: p.onPrimary,
          ),
          onPressed: () => Navigator.of(dialogContext).pop(true),
          child: Text(confirmLabel),
        ),
      ],
    ),
  );
  return result == true;
}

/// Signals user-initiated cancellation of an interactive confirmation prompt.
class ErtadCancelledException implements Exception {
  const ErtadCancelledException();
}

/// Executes an idempotent write action and handles 428 re-auth step-up cleanly.
Future<T> runWithStepUpConfirmation<T>(
  BuildContext context,
  MobileApiClient api, {
  required String actionTitle,
  required String actionBody,
  required String confirmLabel,
  required Future<T> Function(String idempotencyKey) run,
}) async {
  final key = api.newIdempotencyKey();
  try {
    return await run(key);
  } on MobileApiException catch (err) {
    if (err.statusCode != 428) rethrow;
    if (!context.mounted) throw const ErtadCancelledException();
    final ok = await showErtadConfirmDialog(
      context,
      title: actionTitle,
      message: actionBody,
      cancelLabel: shellTr(context, 'close', fallback: 'Cancel'),
      confirmLabel: confirmLabel,
      icon: Icons.verified_user_outlined,
    );
    if (!ok || !context.mounted) throw const ErtadCancelledException();
    if (AppConfig.devWorkspace) {
      await api.devStepUp();
    }
    return await run(key);
  }
}

/// Styled recoverable error card replacing raw Flutter red error boxes.
class ErtadCrashBoundaryCard extends StatelessWidget {
  final String message;

  const ErtadCrashBoundaryCard({super.key, required this.message});

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final hasDir = Directionality.maybeOf(context) != null;
    final card = Center(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Container(
          constraints: const BoxConstraints(maxWidth: 420),
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            color: p.surface,
            borderRadius: BorderRadius.circular(20),
            border: Border.all(color: p.danger.withValues(alpha: 0.35)),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.bug_report_outlined, color: p.danger, size: 32),
              const SizedBox(height: 10),
              Text(
                shellTr(
                  context,
                  'unexpected_view_error',
                  fallback: 'View could not render properly',
                ),
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 6),
              Text(
                message,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
        ),
      ),
    );
    return hasDir
        ? card
        : Directionality(textDirection: ui.TextDirection.ltr, child: card);
  }
}

