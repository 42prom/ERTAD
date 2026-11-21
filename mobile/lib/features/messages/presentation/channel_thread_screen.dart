import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/feedback/ertad_feedback.dart';
import '../../../core/network/mobile_api_client.dart';
import '../../../core/shell/shell_l10n.dart';
import '../../../core/state/offline_action_queue.dart';
import '../../../core/state/shell_providers.dart';
import '../../../core/theme/ertad_theme.dart';
import '../../../core/widgets/ertad_ui.dart';
import 'direct_peers_sheet.dart';

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
  final Map<int, GlobalKey> _messageKeys = <int, GlobalKey>{};
  final Map<String, Uint8List> _attachmentBytesCache = <String, Uint8List>{};
  final Map<String, Future<Uint8List>> _attachmentLoadFutures =
      <String, Future<Uint8List>>{};

  bool _hasOlder = false;
  bool _loading = true;
  bool _loadingOlder = false;
  bool _sending = false;
  Map<String, dynamic>? _replyTarget;
  int? _highlightedSeq;

  Uint8List? _stagedImageBytes;
  String _stagedImageContentType = 'image/jpeg';

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

  GlobalKey _keyForSeq(int seq) =>
      _messageKeys.putIfAbsent(seq, () => GlobalKey());

  Future<Uint8List> _getAttachmentBytes(String attachmentId) {
    final cached = _attachmentBytesCache[attachmentId];
    if (cached != null) return Future<Uint8List>.value(cached);
    return _attachmentLoadFutures.putIfAbsent(attachmentId, () async {
      final bytes = await ref
          .read(mobileApiClientProvider)
          .downloadChannelAttachment(
            organizationId: widget.organizationId,
            channelId: _channelId,
            attachmentId: attachmentId,
          );
      if (bytes.isNotEmpty) {
        _attachmentBytesCache[attachmentId] = bytes;
      }
      return bytes;
    });
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

  Future<void> _pickImageForComposer() async {
    if (_sending || !_canPost || _channelId.isEmpty) return;
    final picker = ImagePicker();
    final picked = await picker.pickImage(
      source: ImageSource.gallery,
      imageQuality: 82,
      maxWidth: 1600,
    );
    if (picked == null || !mounted) return;
    final bytes = await picked.readAsBytes();
    if (!mounted || bytes.isEmpty) return;
    final lower = picked.path.toLowerCase();
    final contentType = lower.endsWith('.png') ? 'image/png' : 'image/jpeg';
    setState(() {
      _stagedImageBytes = bytes;
      _stagedImageContentType = contentType;
    });
  }

  Future<void> _openFullPhotoViewer(Uint8List bytes) async {
    if (!mounted || bytes.isEmpty) return;
    await showDialog<void>(
      context: context,
      barrierColor: Colors.black87,
      builder: (ctx) => Dialog.fullscreen(
        backgroundColor: Colors.black,
        child: Stack(
          children: [
            Center(
              child: InteractiveViewer(
                minScale: 0.8,
                maxScale: 4.5,
                child: Image.memory(bytes, fit: BoxFit.contain),
              ),
            ),
            SafeArea(
              child: Align(
                alignment: Alignment.topRight,
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: IconButton.filledTonal(
                    tooltip: shellTr(ctx, 'close', fallback: 'Close'),
                    onPressed: () => Navigator.of(ctx).pop(),
                    icon: const Icon(Icons.close_rounded),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _previewAttachment(String attachmentId) async {
    try {
      final bytes = await _getAttachmentBytes(attachmentId);
      if (!mounted || bytes.isEmpty) return;
      await _openFullPhotoViewer(bytes);
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

  void _scrollToSeq(int targetSeq) {
    final key = _messageKeys[targetSeq];
    final ctx = key?.currentContext;
    setState(() => _highlightedSeq = targetSeq);
    if (ctx != null) {
      Scrollable.ensureVisible(
        ctx,
        duration: const Duration(milliseconds: 260),
        curve: Curves.easeOutCubic,
        alignment: 0.35,
      );
    }
    Future<void>.delayed(const Duration(milliseconds: 1400), () {
      if (mounted && _highlightedSeq == targetSeq) {
        setState(() => _highlightedSeq = null);
      }
    });
  }

  Future<void> _sendMessage() async {
    final text = _composer.text.trim();
    final stagedBytes = _stagedImageBytes;
    if ((text.isEmpty && stagedBytes == null) || _sending || !_canPost) return;

    setState(() => _sending = true);
    final api = ref.read(mobileApiClientProvider);
    final replyId = _replyTarget?['id']?.toString();

    try {
      String? attachmentId;
      if (stagedBytes != null) {
        final uploaded = await api.uploadChannelAttachment(
          organizationId: widget.organizationId,
          channelId: _channelId,
          bytes: stagedBytes,
          contentType: _stagedImageContentType,
        );
        attachmentId = uploaded['id']?.toString();
        if (attachmentId == null || attachmentId.isEmpty) {
          throw StateError('Missing attachment id');
        }
        _attachmentBytesCache[attachmentId] = stagedBytes;
      }

      await api.postChannelMessage(
        organizationId: widget.organizationId,
        channelId: _channelId,
        body: text.isEmpty ? '[Photo]' : text,
        replyId: replyId,
        attachmentId: attachmentId,
      );
      if (!mounted) return;
      _composer.clear();
      setState(() {
        _replyTarget = null;
        _stagedImageBytes = null;
        _sending = false;
      });
      await _loadThread(scrollToEnd: true);
    } catch (err) {
      if (!mounted) return;
      final isNetworkFailure =
          err is MobileApiException &&
          (err.statusCode == null || err.statusCode == 0);
      if (isNetworkFailure && stagedBytes == null && text.isNotEmpty) {
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
        await ref
            .read(shellSessionProvider.notifier)
            .refreshOfflineQueueCount();
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
            fallback:
                'Offline — saved to queue and will send automatically once connected.',
          ),
        );
        return;
      }
      setState(() => _sending = false);
      ref.read(ertadFeedbackProvider.notifier).showError(err);
    }
  }

  Future<void> _addParticipantsToDirectChat() async {
    if (!_isDirect || _channelId.isEmpty) return;
    final participants = (_channel['participants'] as List? ?? const [])
        .whereType<Map>()
        .map((p) => p['memberId']?.toString() ?? '')
        .where((id) => id.isNotEmpty)
        .toSet();
    final peer = _channel['peer'];
    if (peer is Map) {
      final pid = peer['memberId']?.toString() ?? '';
      if (pid.isNotEmpty) participants.add(pid);
    }

    final updated = await showDirectPeersSheet(
      context,
      existingChannelId: _channelId,
      existingMemberIds: participants,
    );
    if (updated != null && mounted) {
      setState(() => _channel = Map<String, dynamic>.from(updated));
      ref.read(ertadFeedbackProvider.notifier).showSuccess(
        shellTr(
          context,
          'msg_participants_added',
          fallback: 'Participants added to chat',
        ),
      );
      await _loadThread();
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
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
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

  String _resolveSenderLabel(BuildContext context, Map<String, dynamic> msg) {
    if (msg['mine'] == true) {
      return shellTr(context, 'msg_you', fallback: 'You');
    }
    final authorLabel = msg['authorLabel']?.toString().trim() ?? '';
    if (authorLabel.isNotEmpty) return authorLabel;
    final authorCode = msg['authorCode']?.toString().trim() ?? '';
    if (authorCode.isNotEmpty) {
      return '${shellTr(context, 'msg_participant', fallback: 'Member')} #$authorCode';
    }
    if (_isDirect && (_channel['isMultiDirect'] != true)) {
      return _channel['title']?.toString() ??
          shellTr(context, 'msg_participant', fallback: 'Member');
    }
    final authorTag = (msg['authorTag'] as num?)?.toInt();
    final seq = (msg['seq'] as num?)?.toInt() ?? 0;
    return '${shellTr(context, 'msg_participant', fallback: 'Member')} #${authorTag ?? seq}';
  }

  Map<String, dynamic>? _resolveReplyInfo(Map<String, dynamic> msg) {
    final preview = msg['replyPreview'];
    if (preview is Map) {
      return Map<String, dynamic>.from(preview);
    }
    final replySeq = (msg['replySeq'] as num?)?.toInt();
    if (replySeq == null) return null;
    for (final candidate in _messages) {
      if ((candidate['seq'] as num?)?.toInt() == replySeq) {
        final att = candidate['attachment'];
        return <String, dynamic>{
          'seq': replySeq,
          'removed': candidate['removed'] == true,
          'mine': candidate['mine'] == true,
          'authorLabel': candidate['authorLabel'],
          'authorCode': candidate['authorCode'],
          'body': candidate['body']?.toString() ?? '',
          'hasAttachment':
              (att is Map && (att['id']?.toString() ?? '').isNotEmpty) ||
              (candidate['attachmentId']?.toString() ?? '').isNotEmpty,
        };
      }
    }
    return <String, dynamic>{'seq': replySeq};
  }

  void _openMessageActions(Map<String, dynamic> msg) {
    final removed = msg['removed'] == true;
    final mine = msg['mine'] == true;
    final msgId = msg['id']?.toString() ?? '';
    if (msgId.isEmpty) return;
    final sender = _resolveSenderLabel(context, msg);
    final body = msg['body']?.toString() ?? '';

    showModalBottomSheet<void>(
      context: context,
      useSafeArea: true,
      builder: (sheetCtx) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ErtadModalSheetHeader(
              icon: Icons.chat_bubble_outline_rounded,
              title: sender,
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
            if (!removed && body.isNotEmpty && body != '[Photo]')
              ListTile(
                leading: const Icon(Icons.copy_rounded),
                title: Text(
                  shellTr(context, 'msg_copy_text', fallback: 'Copy text'),
                ),
                onTap: () async {
                  Navigator.of(sheetCtx).pop();
                  await Clipboard.setData(ClipboardData(text: body));
                  if (!mounted) return;
                  ref.read(ertadFeedbackProvider.notifier).showSuccess(
                    shellTr(
                      context,
                      'msg_text_copied',
                      fallback: 'Text copied',
                    ),
                  );
                },
              ),
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
    final participantCount =
        (_channel['participantCount'] as num?)?.toInt() ?? 0;
    final subtitle = _isDirect && participantCount > 2
        ? '$participantCount ${shellTr(context, 'msg_members_count_suffix', fallback: 'participants')}'
        : null;

    return ErtadSubpageScaffold(
      title: title,
      subtitle: subtitle,
      actions: [
        if (_isDirect && !_isBlocked)
          IconButton(
            tooltip: shellTr(
              context,
              'msg_add_participants',
              fallback: 'Add participant',
            ),
            onPressed: _addParticipantsToDirectChat,
            icon: const Icon(Icons.person_add_alt_1_rounded),
          ),
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
        if (_isDirect && (_channel['isMultiDirect'] != true))
          IconButton(
            tooltip: _blockedByMe
                ? shellTr(context, 'msg_unblock', fallback: 'Unblock chat')
                : shellTr(context, 'msg_block', fallback: 'Block chat'),
            onPressed: _toggleBlock,
            icon: Icon(
              _blockedByMe ? Icons.lock_open_rounded : Icons.block_rounded,
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
                      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
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
                                    : const Icon(
                                        Icons.history_rounded,
                                        size: 18,
                                      ),
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

  Widget _buildReplyQuoteCard(
    BuildContext context,
    Map<String, dynamic> replyInfo, {
    required bool inBubble,
  }) {
    final p = context.ertad;
    final replySeq = (replyInfo['seq'] as num?)?.toInt();
    final isRemoved = replyInfo['removed'] == true;
    final isMine = replyInfo['mine'] == true;
    final hasAttachment = replyInfo['hasAttachment'] == true;
    final rawAuthor = replyInfo['authorLabel']?.toString().trim() ?? '';
    final rawCode = replyInfo['authorCode']?.toString().trim() ?? '';
    final authorText = isMine
        ? shellTr(context, 'msg_you', fallback: 'You')
        : rawAuthor.isNotEmpty
        ? rawAuthor
        : rawCode.isNotEmpty
        ? '${shellTr(context, 'msg_participant', fallback: 'Member')} #$rawCode'
        : replySeq != null
        ? '#$replySeq'
        : shellTr(context, 'msg_participant', fallback: 'Member');

    final rawBody = (replyInfo['body']?.toString() ?? '').trim();
    final snippetText = isRemoved
        ? shellTr(
            context,
            'msg_removed_placeholder',
            fallback: 'Message removed',
          )
        : (rawBody.isEmpty || rawBody == '[Photo]') && hasAttachment
        ? shellTr(context, 'msg_photo_label', fallback: '📷 Photo')
        : hasAttachment && rawBody.isNotEmpty
        ? '📷 $rawBody'
        : rawBody.isNotEmpty
        ? rawBody
        : '${shellTr(context, 'msg_replying_to', fallback: 'Replying to #')}${replySeq ?? ''}';

    final card = Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: inBubble
            ? p.background.withValues(alpha: 0.72)
            : p.elevated.withValues(alpha: 0.9),
        borderRadius: BorderRadius.circular(10),
        border: Border(
          left: BorderSide(color: p.primary, width: 3.5),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            authorText,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: p.primary,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            snippetText,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: p.text.withValues(alpha: 0.85),
              fontStyle: isRemoved ? FontStyle.italic : FontStyle.normal,
            ),
          ),
        ],
      ),
    );

    if (!inBubble || replySeq == null) return card;
    return InkWell(
      borderRadius: BorderRadius.circular(10),
      onTap: () => _scrollToSeq(replySeq),
      child: card,
    );
  }

  Widget _buildInlineAttachment(
    BuildContext context, {
    required String attachmentId,
    required String mediaType,
    required int? bytesCount,
  }) {
    final p = context.ertad;
    final isPdf = mediaType == 'application/pdf';
    if (isPdf) {
      final sizeText = bytesCount != null
          ? ' (${(bytesCount / 1024).ceil()} KB)'
          : '';
      return Padding(
        padding: const EdgeInsets.only(top: 6),
        child: ActionChip(
          avatar: Icon(
            Icons.picture_as_pdf_outlined,
            size: 16,
            color: p.primary,
          ),
          label: Text('PDF$sizeText'),
          onPressed: () => _previewAttachment(attachmentId),
        ),
      );
    }

    final cachedBytes = _attachmentBytesCache[attachmentId];
    if (cachedBytes != null && cachedBytes.isNotEmpty) {
      return Padding(
        padding: const EdgeInsets.only(top: 6),
        child: GestureDetector(
          onTap: () => _openFullPhotoViewer(cachedBytes),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(14),
            child: ConstrainedBox(
              constraints: const BoxConstraints(
                maxHeight: 240,
                minHeight: 110,
                maxWidth: 280,
              ),
              child: Image.memory(
                cachedBytes,
                fit: BoxFit.cover,
              ),
            ),
          ),
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: FutureBuilder<Uint8List>(
        future: _getAttachmentBytes(attachmentId),
        builder: (context, snapshot) {
          if (snapshot.hasData && snapshot.data!.isNotEmpty) {
            final imgBytes = snapshot.data!;
            return GestureDetector(
              onTap: () => _openFullPhotoViewer(imgBytes),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(14),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(
                    maxHeight: 240,
                    minHeight: 110,
                    maxWidth: 280,
                  ),
                  child: Image.memory(
                    imgBytes,
                    fit: BoxFit.cover,
                  ),
                ),
              ),
            );
          }
          if (snapshot.hasError) {
            return ActionChip(
              avatar: Icon(Icons.image_outlined, size: 16, color: p.primary),
              label: Text(
                shellTr(
                  context,
                  'msg_view_attachment',
                  fallback: 'View photo',
                ),
              ),
              onPressed: () {
                setState(() => _attachmentLoadFutures.remove(attachmentId));
              },
            );
          }
          return Container(
            width: 220,
            height: 150,
            decoration: BoxDecoration(
              color: p.elevated,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: p.hairline),
            ),
            child: const Center(
              child: SizedBox(
                width: 24,
                height: 24,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _buildBubble(BuildContext context, Map<String, dynamic> msg) {
    final p = context.ertad;
    final mine = msg['mine'] == true;
    final removed = msg['removed'] == true;
    final seq = (msg['seq'] as num?)?.toInt() ?? 0;
    final isHighlighted = _highlightedSeq != null && _highlightedSeq == seq;
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

    final senderLabel = _resolveSenderLabel(context, msg);
    final replyInfo = removed ? null : _resolveReplyInfo(msg);

    final attMap = msg['attachment'] is Map ? msg['attachment'] as Map : null;
    final attId =
        attMap?['id']?.toString() ?? msg['attachmentId']?.toString() ?? '';
    final hasAttachment = !removed && attId.isNotEmpty;
    final mediaType = attMap?['mediaType']?.toString() ?? 'image/png';
    final attBytesCount = (attMap?['bytes'] as num?)?.toInt();

    final rawBody = msg['body']?.toString() ?? '';
    final hideDummyPhotoText =
        !removed &&
        rawBody.trim() == '[Photo]' &&
        (hasAttachment || mediaType.startsWith('image/'));
    final displayBody = removed
        ? shellTr(
            context,
            'msg_removed_placeholder',
            fallback: 'Message removed',
          )
        : hideDummyPhotoText
        ? ''
        : rawBody.trim() == '[Photo]'
        ? shellTr(context, 'msg_photo_label', fallback: '📷 Photo')
        : rawBody;

    final bubbleColor = isHighlighted
        ? p.primary.withValues(alpha: 0.22)
        : removed
        ? p.elevated
        : mine
        ? p.primarySoft
        : p.surface;
    final borderColor = isHighlighted
        ? p.primary
        : mine && !removed
        ? p.primary.withValues(alpha: 0.28)
        : p.hairline;

    return Align(
      key: _keyForSeq(seq),
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 340),
        child: Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: InkWell(
            borderRadius: BorderRadius.circular(18),
            onTap: removed ? null : () => _openMessageActions(msg),
            onLongPress: removed ? null : () => _openMessageActions(msg),
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 220),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: bubbleColor,
                borderRadius: BorderRadius.only(
                  topLeft: const Radius.circular(18),
                  topRight: const Radius.circular(18),
                  bottomLeft: Radius.circular(mine ? 18 : 4),
                  bottomRight: Radius.circular(mine ? 4 : 18),
                ),
                border: Border.all(
                  color: borderColor,
                  width: isHighlighted ? 1.6 : 1,
                ),
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
                  if (replyInfo != null) ...[
                    const SizedBox(height: 6),
                    _buildReplyQuoteCard(context, replyInfo, inBubble: true),
                  ],
                  if (hasAttachment)
                    _buildInlineAttachment(
                      context,
                      attachmentId: attId,
                      mediaType: mediaType,
                      bytesCount: attBytesCount,
                    ),
                  if (displayBody.isNotEmpty) ...[
                    const SizedBox(height: 5),
                    Text(
                      displayBody,
                      style: removed
                          ? Theme.of(context).textTheme.bodySmall?.copyWith(
                              color: p.muted,
                              fontStyle: FontStyle.italic,
                            )
                          : Theme.of(context).textTheme.bodyMedium,
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
    // ErtadSubpageScaffold already wraps body in SafeArea(top: false, bottom: true).
    // Do NOT add MediaQuery.viewPaddingOf(context).bottom here or it doubles the bottom gap.
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      decoration: BoxDecoration(
        color: p.surface,
        border: Border(top: BorderSide(color: p.hairline, width: 1)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (_replyTarget != null) ...[
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                children: [
                  Expanded(
                    child: _buildReplyQuoteCard(
                      context,
                      <String, dynamic>{
                        'seq': _replyTarget!['seq'],
                        'removed': _replyTarget!['removed'] == true,
                        'mine': _replyTarget!['mine'] == true,
                        'authorLabel': _replyTarget!['authorLabel'],
                        'authorCode': _replyTarget!['authorCode'],
                        'body': _replyTarget!['body'],
                        'hasAttachment': _replyTarget!['attachment'] != null,
                      },
                      inBubble: false,
                    ),
                  ),
                  const SizedBox(width: 4),
                  IconButton(
                    tooltip: shellTr(context, 'close', fallback: 'Close'),
                    onPressed: () => setState(() => _replyTarget = null),
                    icon: const Icon(Icons.close_rounded, size: 19),
                  ),
                ],
              ),
            ),
          ],
          if (_stagedImageBytes != null) ...[
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: p.elevated,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: p.hairline),
                ),
                child: Row(
                  children: [
                    ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      child: Image.memory(
                        _stagedImageBytes!,
                        width: 52,
                        height: 52,
                        fit: BoxFit.cover,
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            shellTr(
                              context,
                              'msg_photo_staged',
                              fallback: 'Photo ready to send',
                            ),
                            style: Theme.of(context).textTheme.labelMedium
                                ?.copyWith(fontWeight: FontWeight.w700),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            '${(_stagedImageBytes!.length / 1024).ceil()} KB',
                            style: Theme.of(
                              context,
                            ).textTheme.bodySmall?.copyWith(color: p.muted),
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      tooltip: shellTr(context, 'close', fallback: 'Close'),
                      onPressed: _sending
                          ? null
                          : () => setState(() => _stagedImageBytes = null),
                      icon: const Icon(Icons.close_rounded, size: 19),
                    ),
                  ],
                ),
              ),
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
                onPressed: _sending ? null : _pickImageForComposer,
                icon: Icon(
                  Icons.photo_library_outlined,
                  color: _stagedImageBytes != null ? p.primary : p.muted,
                ),
              ),
              Expanded(
                child: TextField(
                  controller: _composer,
                  minLines: 1,
                  maxLines: 4,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (_) => _sendMessage(),
                  decoration: InputDecoration(
                    hintText: _stagedImageBytes != null
                        ? shellTr(
                            context,
                            'msg_caption_hint',
                            fallback: 'Add a caption to photo (optional)...',
                          )
                        : shellTr(
                            context,
                            'msg_composer_hint',
                            fallback: 'Write a message...',
                          ),
                    filled: true,
                    fillColor: p.elevated,
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 14,
                      vertical: 10,
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
                  minimumSize: const Size(46, 46),
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
