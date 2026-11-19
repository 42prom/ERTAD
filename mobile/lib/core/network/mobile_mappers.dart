import '../../models/poll.dart';

/// Maps a server Decision payload (/mobile/decisions/list) into [Poll] cleanly.
Poll decisionJsonToPoll(Map<String, dynamic> json) {
  final rawOptions = (json['options'] as List? ?? const []);
  final refLabels = json['referendumLabels'] is Map
      ? Map<String, dynamic>.from(json['referendumLabels'] as Map)
      : null;

  String resolveOptionLabel(String raw, int index) {
    if (refLabels != null) {
      final lower = raw.toLowerCase();
      if ((lower == 'yes' || index == 0) &&
          (refLabels['yes']?.toString() ?? '').trim().isNotEmpty) {
        return refLabels['yes'].toString();
      }
      if ((lower == 'no' || index == 1) &&
          (refLabels['no']?.toString() ?? '').trim().isNotEmpty) {
        return refLabels['no'].toString();
      }
      if ((lower == 'abstain' || index == 2) &&
          (refLabels['abstain']?.toString() ?? '').trim().isNotEmpty) {
        return refLabels['abstain'].toString();
      }
    }
    return raw;
  }

  final List<PollOption> options = [];
  for (int i = 0; i < rawOptions.length; i++) {
    final opt = rawOptions[i];
    if (opt is String) {
      options.add(
        PollOption(
          id: i.toString(),
          text: resolveOptionLabel(opt, i),
          displayOrder: i,
        ),
      );
    } else if (opt is Map) {
      final rawText =
          opt['text']?.toString() ?? opt['label']?.toString() ?? '';
      options.add(
        PollOption(
          id: opt['id']?.toString() ?? i.toString(),
          text: resolveOptionLabel(rawText, i),
          displayOrder: opt['displayOrder'] is int
              ? opt['displayOrder'] as int
              : i,
        ),
      );
    }
  }

  final rawQuestions = (json['questions'] as List?);
  List<SurveyQuestion>? questions;
  if (rawQuestions != null) {
    questions = [];
    for (int i = 0; i < rawQuestions.length; i++) {
      final q = Map<String, dynamic>.from(rawQuestions[i] as Map);
      final qOptsRaw = (q['options'] as List? ?? const []);
      final qOpts = <QuestionOption>[];
      for (int j = 0; j < qOptsRaw.length; j++) {
        final o = qOptsRaw[j];
        if (o is String) {
          qOpts.add(
            QuestionOption(id: j.toString(), optionText: o, displayOrder: j),
          );
        } else if (o is Map) {
          qOpts.add(
            QuestionOption.fromJson(Map<String, dynamic>.from(o)),
          );
        }
      }
      questions.add(
        SurveyQuestion(
          id: q['id']?.toString() ?? 'q$i',
          questionText: q['title']?.toString() ?? q['questionText']?.toString() ?? '',
          questionType: q['type']?.toString() ?? q['questionType']?.toString() ?? 'single_choice',
          required: q['required'] as bool? ?? true,
          displayOrder: i,
          config: <String, dynamic>{
            if (q['maxLength'] != null) 'maxLength': q['maxLength'],
            if (q['placeholder'] != null) 'placeholder': q['placeholder'],
            if (q['min'] != null) 'min': q['min'],
            if (q['max'] != null) 'max': q['max'],
            if (q['visibleIf'] != null) 'visibleIf': q['visibleIf'],
          },
          options: qOpts,
        ),
      );
    }
  }

  final kind = json['kind']?.toString() ?? 'poll';
  final privacy = json['privacy']?.toString() ?? 'named';
  final govMode = json['governanceMode']?.toString() ?? 'advisory';
  final hasVoted =
      json['voted'] == true ||
      json['participated'] == true ||
      json['myParticipation'] != null;
  final tags = <String>[
    privacy == 'anonymous' ? 'anonymous' : 'named',
    if (govMode == 'binding_review') 'binding' else 'advisory',
    if (json['unitName'] != null) json['unitName'].toString(),
  ];

  final desc = json['description']?.toString().trim();
  return Poll(
    id: json['id']?.toString() ?? '',
    title: json['title']?.toString() ?? '',
    description: desc,
    type: kind,
    options: options,
    questions: questions,
    tags: tags,
    endAt: json['closesAt']?.toString() ?? json['end_at']?.toString(),
    referendumQuestion:
        kind == 'referendum' && desc != null && desc.isNotEmpty ? desc : null,
    referendumThreshold: json['threshold'] != null
        ? (json['threshold'] as num).toDouble()
        : null,
    electionQuestion: kind == 'election' ? json['title']?.toString() : null,
    hasVoted: hasVoted,
    isBinding: govMode == 'binding_review',
    participationStatus: json['status']?.toString(),
  );
}

