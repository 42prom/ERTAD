import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/feedback/ertad_feedback.dart';
import '../../../core/shell/shell_l10n.dart';
import '../../../core/network/mobile_api_client.dart';
import '../../../core/state/offline_action_queue.dart';
import '../../../core/state/shell_providers.dart';
import '../../../core/theme/ertad_theme.dart';
import '../../../core/widgets/ertad_ui.dart';

const List<(String code, String emoji)> _reactionChoices = <(String, String)>[
  ('like', '👍'),
  ('confirm', '✅'),
  ('heart', '❤️'),
  ('eyes', '👀'),
  ('celebrate', '🎉'),
];

String _emojiForCode(String code) {
  for (final pair in _reactionChoices) {
    if (pair.$1 == code) return pair.$2;
  }
  return '👍';
}

/// Full-screen channel / direct conversation thread backed by /mobile/channels/*.
class ChannelThreadScreen extends ConsumerStatefulWidget {
  final String organizationId;
  final Map<String, dynamic> initialChannel;

  const ChannelThreadScreen({
    super.key,
    required this.organizationId,
    required this.initialChannel,
  });

  @override
  ConsumerState<ChannelThreadScreen> createState() =>
      _ChannelThreadScreenState();
}

class _ChannelThreadScreenState extends ConsumerState<ChannelThreadScreen> {
  final TextEditingController _composer = TextEditingController();
  final ScrollController _scroll = ScrollController();

  late Map<String, dynamic> _channel;
  List<Map<String, dynamic>> _messages = const [];
  bool _hasOlder = false;
  bool _loading = true;
  bool _loadingOlder = false;
  bool _sending = false;
  Map<String, dynamic>? _replyTarget;

  String get _channelId => _channel['id']?.toString() ?? '';
  String get _kind => (_channel['kind']?.toString() ?? 'group').toLowerCase();
  bool get _isDirect => _kind == 'direct';
  bool get _isMuted => _channel['muted'] == true;
  bool get _isBlocked => _channel['blocked'] == true;
  bool get _blockedByMe => _channel['blockedByMe'] == true;
  bool get _canPost => _channel['canPost'] == true && !_isBlocked;

  @override
  void initState() {
    super.initState();
    _channel = Map<String, dynamic>.from(widget.initialChannel);
    _loadThread(scrollToEnd: true);
  }

  @override
  void dispose() {
    _composer.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _loadThread({bool scrollToEnd = false}) async {
    final api = ref.read(mobileApiClientProvider);
    try {
      final res = await api.fetchChannelThread(
        organizationId: widget.organizationId,
        channelId: _channelId,
      );
      if (!mounted) return;
      final ch = res['channel'];
      final items = (res['items'] as List? ?? const [])
          .map((e) => Map<String, dynamic>.from(e as Map))
          .toList();
      setState(() {
        if (ch is Map) _channel = Map<String, dynamic>.from(ch);
        _messages = items;
        _hasOlder = res['hasOlder'] == true;
        _loading = false;
      });
      await _ackVisibleRead();
      if (scrollToEnd) _scrollBottom();
    } catch (err) {
      if (!mounted) return;
      setState(() => _loading = false);
      ref.read(ertadFeedbackProvider.notifier).showError(
        err,
        retryLabel: shellTr(context, 'retry', fallback: 'Retry'),
        onRetry: () => _loadThread(scrollToEnd: scrollToEnd),
      );
    }
  }

  Future<void> _loadOlder() async {
    if (_loadingOlder || !_hasOlder || _messages.isEmpty) return;
    final firstSeq = (_messages.first['seq'] as num?)?.toInt() ?? 0;
    if (firstSeq <= 1) return;
    setState(() => _loadingOlder = true);
    try {
      final api = ref.read(mobileApiClientProvider);
      final res = await api.fetchChannelThread(
        organizationId: widget.organizationId,
        channelId: _channelId,
        beforeSeq: firstSeq,
      );
      if (!mounted) return;
      final older = (res['items'] as List? ?? const [])
          .map((e) => Map<String, dynamic>.from(e as Map))
          .toList();
      setState(() {
        _messages = <Map<String, dynamic>>[...older, ..._messages];
        _hasOlder = res['hasOlder'] == true;
        _loadingOlder = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() => _loadingOlder = false);
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  Future<void> _ackVisibleRead() async {
    final lastSeq = (_channel['lastSeq'] as num?)?.toInt() ?? 0;
    final readSeq = (_channel['readSeq'] as num?)?.toInt() ?? 0;
    if (lastSeq <= readSeq || _channelId.isEmpty) return;
    try {
      await ref.read(mobileApiClientProvider).markChannelRead(
        organizationId: widget.organizationId,
        channelId: _channelId,
        seq: lastSeq,
      );
      if (!mounted) return;
      ref.read(shellSessionProvider.notifier).refreshWorkspace();
    } catch (_) {
      // Read ack is best-effort; unread count remains truthful on server.
    }
  }

  Future<void> _pickAndSendImage() async {
    if (_sending || !_canPost || _channelId.isEmpty) return;
    final picker = ImagePicker();
    final picked = await picker.pickImage(
      source: ImageSource.gallery,
      imageQuality: 82,
      maxWidth: 1600,
    );
    if (picked == null || !mounted) return;
    setState(() => _sending = true);
    final api = ref.read(mobileApiClientProvider);
    try {
      final bytes = await picked.readAsBytes();
      final lower = picked.path.toLowerCase();
      final contentType = lower.endsWith('.png') ? 'image/png' : 'image/jpeg';
      final uploaded = await api.uploadChannelAttachment(
        organizationId: widget.organizationId,
        channelId: _channelId,
        bytes: bytes,
        contentType: contentType,
      );
      final attachmentId = uploaded['id']?.toString();
      if (attachmentId == null || attachmentId.isEmpty) {
        throw StateError('Missing attachment id');
      }
      final caption = _composer.text.trim();
      final res = await api.postChannelMessage(
        organizationId: widget.organizationId,
        channelId: _channelId,
        body: caption.isEmpty ? '[Photo]' : caption,
        replyId: _replyTarget?['id']?.toString(),
        attachmentId: attachmentId,
      );
      if (!mounted) return;
      _composer.clear();
      setState(() {
        _sending = false;
        _replyTarget = null;
        if (res['message'] is Map) {
          _messages = <Map<String, dynamic>>[
            ..._messages,
            Map<String, dynamic>.from(res['message'] as Map),
          ];
        }
      });
      await _loadThread();
      _scrollBottom();
    } catch (err) {
      if (!mounted) return;
      setState(() => _sending = false);
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  Future<void> _previewAttachment(String attachmentId) async {
    try {
      final bytes = await ref
          .read(mobileApiClientProvider)
          .downloadChannelAttachment(
            organizationId: widget.organizationId,
            channelId: _channelId,
            attachmentId: attachmentId,
          );
      if (!mounted || bytes.isEmpty) return;
      await showDialog<void>(
        context: context,
        builder: (ctx) => Dialog(
          child: ClipRRect(
            borderRadius: BorderRadius.circular(16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 420),
                  child: Image.memory(bytes, fit: BoxFit.contain),
                ),
                TextButton(
                  onPressed: () => Navigator.of(ctx).pop(),
                  child: Text(shellTr(ctx, 'close', fallback: 'Close')),
                ),
              ],
            ),
          ),
        ),
      );
    } catch (err) {
      if (!mounted) return;
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  void _scrollBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOutCubic,
        );
      }
    });
  }

  Future<void> _sendMessage() async {
    final text = _composer.text.trim();
    if (text.isEmpty || _sending || !_canPost) return;
    setState(() => _sending = true);
    final api = ref.read(mobileApiClientProvider);
    final replyId = _replyTarget?['id']?.toString();
    try {
      await api.postChannelMessage(
        organizationId: widget.organizationId,
        channelId: _channelId,
        body: text,
        replyId: replyId,
      );
      if (!mounted) return;
      _composer.clear();
      setState(() {
        _replyTarget = null;
        _sending = false;
      });
      await _loadThread(scrollToEnd: true);
    } catch (err) {
      if (!mounted) return;
      final isNetworkFailure =
          err is MobileApiException && (err.statusCode == null || err.statusCode == 0);
      if (isNetworkFailure) {
        await OfflineActionQueue().enqueue(
          OfflineQueuedAction(
            idempotencyKey: api.newIdempotencyKey(),
            kind: 'channel_post',
            organizationId: widget.organizationId,
            payload: <String, dynamic>{
              'channelId': _channelId,
              'body': text,
              'replyId': ?replyId,
            },
            createdAtIso: DateTime.now().toUtc().toIso8601String(),
          ),
        );
        if (!mounted) return;
        _composer.clear();
        setState(() {
          _replyTarget = null;
          _sending = false;
        });
        ref.read(ertadFeedbackProvider.notifier).showWarning(
          shellTr(
            context,
            'offline_queued_notice',
            fallback: 'Offline — saved to queue and will send automatically once connected.',
          ),
        );
        return;
      }
      setState(() => _sending = false);
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  Future<void> _toggleMute() async {
    try {
      await ref.read(mobileApiClientProvider).setChannelMuted(
        organizationId: widget.organizationId,
        channelId: _channelId,
        muted: !_isMuted,
      );
      await _loadThread();
    } catch (err) {
      if (!mounted) return;
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  Future<void> _toggleBlock() async {
    if (!_isDirect) return;
    if (!_blockedByMe) {
      final confirmed = await showErtadConfirmDialog(
        context,
        title: shellTr(
          context,
          'msg_block_confirm_title',
          fallback: 'Block direct conversation?',
        ),
        message: shellTr(
          context,
          'msg_block_confirm_body',
          fallback:
              'Neither participant can send new messages until you unblock this chat.',
        ),
        confirmLabel: shellTr(context, 'msg_block', fallback: 'Block chat'),
        cancelLabel: shellTr(context, 'cancel_action', fallback: 'Cancel'),
        destructive: true,
      );
      if (!confirmed || !mounted) return;
    }
    try {
      await ref.read(mobileApiClientProvider).setDirectBlocked(
        organizationId: widget.organizationId,
        channelId: _channelId,
        blocked: !_blockedByMe,
      );
      await _loadThread();
      if (!mounted) return;
      ref.read(shellSessionProvider.notifier).refreshWorkspace();
    } catch (err) {
      if (!mounted) return;
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  Future<void> _toggleReaction(String messageId, String emoji) async {
    try {
      await ref.read(mobileApiClientProvider).reactChannelMessage(
        organizationId: widget.organizationId,
        channelId: _channelId,
        messageId: messageId,
        emoji: emoji,
      );
      await _loadThread();
    } catch (err) {
      if (!mounted) return;
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  Future<void> _removeOwn(String messageId) async {
    try {
      await ref.read(mobileApiClientProvider).removeChannelMessage(
        organizationId: widget.organizationId,
        channelId: _channelId,
        messageId: messageId,
      );
      await _loadThread();
    } catch (err) {
      if (!mounted) return;
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  Future<void> _reportMessage(String messageId) async {
    final categories = <(String id, String label)>[
      ('spam', shellTr(context, 'report_spam', fallback: 'Spam')),
      ('abuse', shellTr(context, 'report_abuse', fallback: 'Abuse')),
      ('privacy', shellTr(context, 'report_privacy', fallback: 'Privacy')),
      ('other', shellTr(context, 'report_other', fallback: 'Other')),
    ];
    final picked = await showModalBottomSheet<String>(
      context: context,
      useSafeArea: true,
      builder: (sheetCtx) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ErtadModalSheetHeader(
              icon: Icons.flag_outlined,
              title: shellTr(context, 'msg_report', fallback: 'Report'),
              closeTooltip: shellTr(context, 'close', fallback: 'Close'),
            ),
            const SizedBox(height: 8),
            for (final c in categories)
              ListTile(
                title: Text(c.$2),
                trailing: const Icon(Icons.chevron_right_rounded),
                onTap: () => Navigator.of(sheetCtx).pop(c.$1),
              ),
          ],
        ),
      ),
    );
    if (picked == null || !mounted) return;
    try {
      await ref.read(mobileApiClientProvider).reportChannelMessage(
        organizationId: widget.organizationId,
        channelId: _channelId,
        messageId: messageId,
        category: picked,
      );
      if (!mounted) return;
      ref.read(ertadFeedbackProvider.notifier).showSuccess(
        shellTr(
          context,
          'msg_reported_toast',
          fallback: 'Message reported for review',
        ),
      );
    } catch (err) {
      if (!mounted) return;
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  void _openMessageActions(Map<String, dynamic> msg) {
    final removed = msg['removed'] == true;
    final mine = msg['mine'] == true;
    final msgId = msg['id']?.toString() ?? '';
    if (msgId.isEmpty) return;

    showModalBottomSheet<void>(
      context: context,
      useSafeArea: true,
      builder: (sheetCtx) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ErtadModalSheetHeader(
              icon: Icons.chat_bubble_outline_rounded,
              title: '#${msg['seq'] ?? ''}',
              closeTooltip: shellTr(context, 'close', fallback: 'Close'),
            ),
            if (!removed && _canPost) ...[
              const SizedBox(height: 6),
              Wrap(
                spacing: 8,
                children: [
                  for (final r in _reactionChoices)
                    ActionChip(
                      label: Text(r.$2, style: const TextStyle(fontSize: 18)),
                      onPressed: () {
                        Navigator.of(sheetCtx).pop();
                        _toggleReaction(msgId, r.$1);
                      },
                    ),
                ],
              ),
              const SizedBox(height: 8),
              ListTile(
                leading: const Icon(Icons.reply_rounded),
                title: Text(shellTr(context, 'msg_reply', fallback: 'Reply')),
                onTap: () {
                  Navigator.of(sheetCtx).pop();
                  setState(() => _replyTarget = msg);
                },
              ),
            ],
            if (!removed && mine)
              ListTile(
                leading: Icon(
                  Icons.delete_outline_rounded,
                  color: context.ertad.danger,
                ),
                title: Text(
                  shellTr(context, 'msg_remove_own', fallback: 'Delete'),
                  style: TextStyle(color: context.ertad.danger),
                ),
                onTap: () {
                  Navigator.of(sheetCtx).pop();
                  _removeOwn(msgId);
                },
              ),
            if (!removed && !mine)
              ListTile(
                leading: Icon(
                  Icons.flag_outlined,
                  color: context.ertad.warning,
                ),
                title: Text(shellTr(context, 'msg_report', fallback: 'Report')),
                onTap: () {
                  Navigator.of(sheetCtx).pop();
                  _reportMessage(msgId);
                },
              ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = context.ertad;
    final title =
        _channel['title']?.toString() ??
        shellTr(context, 'nav_messages', fallback: 'Messages');
    final pinned = _channel['pinnedMessage'];

    return ErtadSubpageScaffold(
      title: title,
      actions: [
        IconButton(
          tooltip: _isMuted
              ? shellTr(context, 'msg_unmute', fallback: 'Unmute')
              : shellTr(context, 'msg_mute', fallback: 'Mute notifications'),
          onPressed: _toggleMute,
          icon: Icon(
            _isMuted
                ? Icons.notifications_off_rounded
                : Icons.notifications_none_rounded,
            color: _isMuted ? p.warning : null,
          ),
        ),
        if (_isDirect)
          IconButton(
            tooltip: _blockedByMe
                ? shellTr(context, 'msg_unblock', fallback: 'Unblock chat')
                : shellTr(context, 'msg_block', fallback: 'Block chat'),
            onPressed: _toggleBlock,
            icon: Icon(
              _blockedByMe
                  ? Icons.lock_open_rounded
                  : Icons.block_rounded,
              color: _blockedByMe ? p.warning : p.muted,
            ),
          ),
      ],
      body: Column(
        children: [
          if (pinned is Map) ...[
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
              child: ErtadStateBanner(
                icon: Icons.push_pin_rounded,
                tone: ErtadTone.primary,
                message: pinned['body']?.toString() ?? '',
              ),
            ),
          ],
          if (_isBlocked)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
              child: ErtadStateBanner(
                icon: Icons.block_rounded,
                tone: ErtadTone.warning,
                message: shellTr(
                  context,
                  'msg_blocked_banner',
                  fallback:
                      'Messaging is paused while this direct conversation is blocked.',
                ),
              ),
            )
          else if (!_canPost)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
              child: ErtadStateBanner(
                icon: Icons.lock_outline_rounded,
                tone: ErtadTone.neutral,
                message: shellTr(
                  context,
                  'msg_readonly_banner',
                  fallback:
                      'This channel is currently read-only for your membership.',
                ),
              ),
            ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : RefreshIndicator(
                    onRefresh: _loadThread,
                    child: ListView(
                      controller: _scroll,
                      padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
                      children: [
                        if (_hasOlder)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 12),
                            child: Center(
                              child: OutlinedButton.icon(
                                onPressed: _loadingOlder ? null : _loadOlder,
                                icon: _loadingOlder
                                    ? const SizedBox(
                                        width: 16,
                                        height: 16,
                                        child: CircularProgressIndicator(
                                          strokeWidth: 2,
                                        ),
                                      )
                                    : const Icon(Icons.history_rounded, size: 18),
                                label: Text(
                                  shellTr(
                                    context,
                                    'msg_load_older',
                                    fallback: 'Load older messages',
                                  ),
                                ),
                              ),
                            ),
                          ),
                        if (_messages.isEmpty)
                          ErtadEmptyState(
                            icon: Icons.chat_bubble_outline_rounded,
                            title: shellTr(
                              context,
                              'no_messages_yet',
                              fallback: 'No messages yet',
                            ),
                            body: title,
                            tone: ErtadTone.primary,
                          )
                        else
                          ..._messages.map((msg) => _buildBubble(context, msg)),
                      ],
                    ),
                  ),
          ),
          if (_canPost) _buildComposer(context),
        ],
      ),
    );
  }

  Widget _buildBubble(BuildContext context, Map<String, dynamic> msg) {
    final p = context.ertad;
    final mine = msg['mine'] == true;
    final removed = msg['removed'] == true;
    final seq = (msg['seq'] as num?)?.toInt() ?? 0;
    final replySeq = (msg['replySeq'] as num?)?.toInt();
    final authorTag = (msg['authorTag'] as num?)?.toInt();
    final reactions = (msg['reactions'] as List? ?? const [])
        .map((e) => Map<String, dynamic>.from(e as Map))
        .toList();

    final timeLabel = () {
      final raw = msg['createdAt']?.toString();
      if (raw == null || raw.isEmpty) return '#$seq';
      final dt = DateTime.tryParse(raw)?.toLocal();
      if (dt == null) return '#$seq';
      final hh = dt.hour.toString().padLeft(2, '0');
      final mm = dt.minute.toString().padLeft(2, '0');
      return '$hh:$mm';
    }();

    final senderLabel = mine
        ? shellTr(context, 'msg_you', fallback: 'You')
        : _isDirect
        ? (_channel['title']?.toString() ??
              shellTr(context, 'msg_participant', fallback: 'Member'))
        : '${shellTr(context, 'msg_participant', fallback: 'Member')} #${authorTag ?? seq}';

    final bubbleColor = removed
        ? p.elevated
        : mine
        ? p.primarySoft
        : p.surface;
    final borderColor = mine && !removed
        ? p.primary.withValues(alpha: 0.28)
        : p.hairline;

    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 340),
        child: Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: InkWell(
            borderRadius: BorderRadius.circular(18),
            onTap: removed ? null : () => _openMessageActions(msg),
            onLongPress: removed ? null : () => _openMessageActions(msg),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: bubbleColor,
                borderRadius: BorderRadius.only(
                  topLeft: const Radius.circular(18),
                  topRight: const Radius.circular(18),
                  bottomLeft: Radius.circular(mine ? 18 : 4),
                  bottomRight: Radius.circular(mine ? 4 : 18),
                ),
                border: Border.all(color: borderColor, width: 1),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Flexible(
                        child: Text(
                          senderLabel,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.labelMedium
                              ?.copyWith(
                                color: mine ? p.primary : p.muted,
                                fontWeight: FontWeight.w700,
                              ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        timeLabel,
                        style: Theme.of(
                          context,
                        ).textTheme.bodySmall?.copyWith(color: p.muted),
                      ),
                    ],
                  ),
                  if (replySeq != null && !removed) ...[
                    const SizedBox(height: 4),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 3,
                      ),
                      decoration: BoxDecoration(
                        color: p.background.withValues(alpha: 0.7),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        '${shellTr(context, 'msg_replying_to', fallback: 'Replying to #')}$replySeq',
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: p.primary,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ],
                  const SizedBox(height: 5),
                  Text(
                    removed
                        ? shellTr(
                            context,
                            'msg_removed_placeholder',
                            fallback: 'Message removed',
                          )
                        : (msg['body']?.toString() ?? ''),
                    style: removed
                        ? Theme.of(context).textTheme.bodySmall?.copyWith(
                            color: p.muted,
                            fontStyle: FontStyle.italic,
                          )
                        : Theme.of(context).textTheme.bodyMedium,
                  ),
                  if (!removed &&
                      (msg['attachmentId']?.toString().isNotEmpty ??
                          false)) ...[
                    const SizedBox(height: 8),
                    ActionChip(
                      avatar: Icon(
                        Icons.image_outlined,
                        size: 16,
                        color: p.primary,
                      ),
                      label: Text(
                        shellTr(
                          context,
                          'msg_view_attachment',
                          fallback: 'View attachment',
                        ),
                      ),
                      onPressed: () => _previewAttachment(
                        msg['attachmentId']!.toString(),
                      ),
                    ),
                  ],
                  if (reactions.isNotEmpty && !removed) ...[
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      children: reactions.map((r) {
                        final code = r['emoji']?.toString() ?? 'like';
                        final cnt = (r['count'] as num?)?.toInt() ?? 1;
                        final reacted = r['mine'] == true;
                        return InkWell(
                          borderRadius: BorderRadius.circular(999),
                          onTap: () => _toggleReaction(
                            msg['id']?.toString() ?? '',
                            code,
                          ),
                          child: Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 8,
                              vertical: 3,
                            ),
                            decoration: BoxDecoration(
                              color: reacted ? p.primarySoft : p.elevated,
                              borderRadius: BorderRadius.circular(999),
                              border: Border.all(
                                color: reacted ? p.primary : p.hairline,
                              ),
                            ),
                            child: Text(
                              '${_emojiForCode(code)} $cnt',
                              style: Theme.of(context).textTheme.labelMedium,
                            ),
                          ),
                        );
                      }).toList(),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildComposer(BuildContext context) {
    final p = context.ertad;
    final bottomInset = MediaQuery.viewPaddingOf(context).bottom;
    return Container(
      padding: EdgeInsets.fromLTRB(12, 8, 12, 10 + bottomInset),
      decoration: BoxDecoration(
        color: p.surface,
        border: Border(top: BorderSide(color: p.hairline, width: 1)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (_replyTarget != null) ...[
            Row(
              children: [
                Icon(Icons.reply_rounded, size: 16, color: p.primary),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    '${shellTr(context, 'msg_replying_to', fallback: 'Replying to #')}${_replyTarget!['seq']}: ${_replyTarget!['body'] ?? ''}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(
                      context,
                    ).textTheme.bodySmall?.copyWith(color: p.primary),
                  ),
                ),
                IconButton(
                  tooltip: shellTr(context, 'close', fallback: 'Close'),
                  onPressed: () => setState(() => _replyTarget = null),
                  icon: const Icon(Icons.close_rounded, size: 18),
                ),
              ],
            ),
          ],
          Row(
            children: [
              IconButton(
                tooltip: shellTr(
                  context,
                  'msg_attach_photo',
                  fallback: 'Attach photo',
                ),
                onPressed: _sending ? null : _pickAndSendImage,
                icon: Icon(Icons.photo_library_outlined, color: p.muted),
              ),
              Expanded(
                child: TextField(
                  controller: _composer,
                  minLines: 1,
                  maxLines: 4,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (_) => _sendMessage(),
                  decoration: InputDecoration(
                    hintText: shellTr(
                      context,
                      'msg_composer_hint',
                      fallback: 'Write a message...',
                    ),
                    filled: true,
                    fillColor: p.elevated,
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 14,
                      vertical: 11,
                    ),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(16),
                      borderSide: BorderSide(color: p.hairline),
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(16),
                      borderSide: BorderSide(color: p.hairline),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              IconButton.filled(
                tooltip: shellTr(context, 'msg_send', fallback: 'Send'),
                style: IconButton.styleFrom(
                  backgroundColor: p.primary,
                  foregroundColor: p.onOrb,
                  minimumSize: const Size(48, 48),
                ),
                onPressed: _sending ? null : _sendMessage,
                icon: _sending
                    ? SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: p.onOrb,
                        ),
                      )
                    : const Icon(Icons.send_rounded),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
