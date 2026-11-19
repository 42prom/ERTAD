import type { SurveyQuestion, SurveyAnswers } from "../api/decisions";

export function isSurveyQuestionVisible(
  question: SurveyQuestion,
  answers: SurveyAnswers,
): boolean {
  const rule = question.visibleIf;
  if (!rule) return true;
  const target = answers[rule.questionId];
  if (target === undefined) return false;
  if (Array.isArray(target)) {
    return target.map(String).includes(rule.equals);
  }
  return String(target) === rule.equals;
}

export function pruneHiddenSurveyAnswers(
  questions: SurveyQuestion[],
  answers: SurveyAnswers,
): SurveyAnswers {
  const next: SurveyAnswers = { ...answers };
  for (const q of questions) {
    if (!isSurveyQuestionVisible(q, next)) {
      delete next[q.id];
    }
  }
  return next;
}

export function newQuestion(
  type: SurveyQuestion["type"] = "single_choice",
  base?: SurveyQuestion,
): SurveyQuestion {
  if (base?.type === type) return { ...base };
  const common = {
    id: base?.id ?? crypto.randomUUID(),
    title: base?.title ?? "",
    required: base?.required ?? true,
    ...(base?.visibleIf ? { visibleIf: { ...base.visibleIf } } : {}),
  };
  if (type === "text") return { ...common, type, maxLength: 500 };
  if (type === "rating_scale") return { ...common, type, min: 1, max: 5 };
  return {
    ...common,
    type,
    options: base && "options" in base ? [...base.options] : ["", ""],
  };
}

export function validSurveyAnswers(
  questions: SurveyQuestion[],
  answers: SurveyAnswers,
) {
  if (!Object.keys(answers).length) return false;
  return questions.every((q) => {
    const visible = isSurveyQuestionVisible(q, answers);
    const a = answers[q.id];
    if (!visible) return a === undefined;
    if (a === undefined) return !q.required;
    if (q.type === "text")
      return (
        typeof a === "string" && a.trim().length > 0 && a.length <= q.maxLength
      );
    if (q.type === "rating_scale")
      return (
        typeof a === "number" && Number.isInteger(a) && a >= q.min && a <= q.max
      );
    if (q.type === "single_choice")
      return (
        typeof a === "number" &&
        Number.isInteger(a) &&
        a >= 0 &&
        a < q.options.length
      );
    return (
      Array.isArray(a) &&
      a.length > 0 &&
      new Set(a).size === a.length &&
      a.every((v) => Number.isInteger(v) && v >= 0 && v < q.options.length) &&
      (q.type !== "ranked_choice" || a.length === q.options.length)
    );
  });
}
