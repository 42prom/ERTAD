import {
  isSurveyQuestionVisible,
  newQuestion,
  pruneHiddenSurveyAnswers,
} from "./surveyModel";
import { ArrowUp, ArrowDown, Plus, Trash2 } from "lucide-react";
import Card from "./ui/Card";
import Button from "./ui/Button";
import Input from "./ui/Input";
import Select from "./ui/Select";
import Textarea from "./ui/Textarea";
import { useConsolePreferences } from "./useConsolePreferences";
import type {
  SurveyQuestion,
  SurveyAnswers,
  SurveyResult,
} from "../api/decisions";
const typeLabels = {
  single_choice: ["ერთი პასუხი", "Single choice"],
  multiple_choice: ["რამდენიმე პასუხი", "Multiple choice"],
  text: ["ტექსტური პასუხი", "Text response"],
  rating_scale: ["შეფასების სკალა", "Rating scale"],
  ranked_choice: ["პასუხების დალაგება", "Ranked choice"],
};

/** Adapted from the retained CreatePoll question cards and configuration controls. */
export function SurveyEditor({
  questions,
  onChange,
}: {
  questions: SurveyQuestion[];
  onChange: (questions: SurveyQuestion[]) => void;
}) {
  const { language } = useConsolePreferences();
  const t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const sanitizeRules = (list: SurveyQuestion[]) =>
    list.map((item, idx) => {
      if (!item.visibleIf) return item;
      const validTarget = list
        .slice(0, idx)
        .some((prev) => prev.id === item.visibleIf?.questionId);
      if (validTarget) return item;
      const copy = { ...item };
      delete copy.visibleIf;
      return copy;
    });
  const update = (index: number, q: SurveyQuestion) =>
    onChange(questions.map((current, i) => (i === index ? q : current)));
  const move = (index: number, delta: number) => {
    const next = [...questions];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    onChange(sanitizeRules(next));
  };
  return (
    <section className="survey-editor">
      <div className="review-toolbar survey-editor-heading">
        <h3>
          {t("გამოკითხვის კითხვები", "Survey questions")} · {questions.length}
          /20
        </h3>
        <Button
          type="button"
          variant="secondary"
          disabled={questions.length >= 20}
          onClick={() => onChange([...questions, newQuestion()])}
        >
          <Plus size={16} />
          {t("ახალი კითხვის დამატება", "Add another question")}
        </Button>
      </div>
      {questions.map((q, index) => (
        <Card key={q.id}>
          <details
            open
            className="survey-question-card"
            onInvalidCapture={(e) => {
              e.currentTarget.open = true;
            }}
          >
            <summary>
              <span>
                {t("კითხვა", "Question")} {index + 1} ·{" "}
                {typeLabels[q.type][language === "ka" ? 0 : 1]}
              </span>
              {q.title && (
                <span className="survey-question-title">{q.title}</span>
              )}
            </summary>
            <div className="review-toolbar">
              <h4>
                {t("კითხვა", "Question")} {index + 1}
              </h4>
              <Button
                type="button"
                variant="ghost"
                disabled={index === 0}
                aria-label={t("კითხვის ზემოთ გადატანა", "Move question up")}
                onClick={() => move(index, -1)}
              >
                <ArrowUp size={16} />
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={index === questions.length - 1}
                aria-label={t("კითხვის ქვემოთ გადატანა", "Move question down")}
                onClick={() => move(index, 1)}
              >
                <ArrowDown size={16} />
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={questions.length === 1}
                aria-label={t("კითხვის წაშლა", "Remove question")}
                onClick={() =>
                  onChange(sanitizeRules(questions.filter((_, i) => i !== index)))
                }
              >
                <Trash2 size={16} />
              </Button>
            </div>
            <div className="review-form">
              <Input
                label={`${t("კითხვა", "Question")} ${index + 1}`}
                value={q.title}
                required
                minLength={3}
                maxLength={300}
                onChange={(e) => update(index, { ...q, title: e.target.value })}
              />
              <Select
                label={t("კითხვის ტიპი", "Question type")}
                value={q.type}
                options={Object.entries(typeLabels).map(([value, labels]) => ({
                  value,
                  label: labels[language === "ka" ? 0 : 1],
                }))}
                onChange={(e) =>
                  update(
                    index,
                    newQuestion(e.target.value as SurveyQuestion["type"], q),
                  )
                }
              />
              <label className="review-confirm">
                <input
                  type="checkbox"
                  checked={q.required}
                  onChange={(e) =>
                    update(index, { ...q, required: e.target.checked })
                  }
                />
                {t("სავალდებულო პასუხი", "Required answer")}
              </label>
              {index > 0 && (() => {
                const earlier = questions.slice(0, index);
                const refQ = q.visibleIf
                  ? earlier.find((item) => item.id === q.visibleIf?.questionId)
                  : undefined;
                const defaultEquals = (target: SurveyQuestion) =>
                  target.type === "rating_scale"
                    ? String(target.min)
                    : "options" in target
                      ? "0"
                      : "";
                return (
                  <div className="review-toolbar">
                    <Select
                      label={t("პირობითი ჩვენება", "Conditional visibility")}
                      value={q.visibleIf?.questionId ?? ""}
                      options={[
                        {
                          value: "",
                          label: t("ყოველთვის ხილული", "Always visible"),
                        },
                        ...earlier.map((eq, ei) => ({
                          value: eq.id,
                          label: `${ei + 1}. ${eq.title || t("კითხვა", "Question")}`,
                        })),
                      ]}
                      onChange={(e) => {
                        const targetId = e.target.value;
                        if (!targetId) {
                          const nextQ = { ...q };
                          delete nextQ.visibleIf;
                          update(index, nextQ);
                          return;
                        }
                        const chosen = earlier.find((item) => item.id === targetId);
                        update(index, {
                          ...q,
                          visibleIf: {
                            questionId: targetId,
                            equals: chosen ? defaultEquals(chosen) : "0",
                          },
                        });
                      }}
                    />
                    {refQ && q.visibleIf && (
                      "options" in refQ ? (
                        <Select
                          label={t("როცა პასუხი უდრის", "When answer equals")}
                          value={q.visibleIf.equals}
                          options={refQ.options.map((opt, oi) => ({
                            value: String(oi),
                            label: opt || `${t("პასუხი", "Option")} ${oi + 1}`,
                          }))}
                          onChange={(e) =>
                            update(index, {
                              ...q,
                              visibleIf: {
                                questionId: refQ.id,
                                equals: e.target.value,
                              },
                            })
                          }
                        />
                      ) : refQ.type === "rating_scale" ? (
                        <Select
                          label={t("როცა პასუხი უდრის", "When answer equals")}
                          value={q.visibleIf.equals}
                          options={Array.from(
                            { length: Math.max(1, refQ.max - refQ.min + 1) },
                            (_, oi) => ({
                              value: String(refQ.min + oi),
                              label: String(refQ.min + oi),
                            }),
                          )}
                          onChange={(e) =>
                            update(index, {
                              ...q,
                              visibleIf: {
                                questionId: refQ.id,
                                equals: e.target.value,
                              },
                            })
                          }
                        />
                      ) : (
                        <Input
                          label={t("როცა პასუხი უდრის", "When answer equals")}
                          value={q.visibleIf.equals}
                          onChange={(e) =>
                            update(index, {
                              ...q,
                              visibleIf: {
                                questionId: refQ.id,
                                equals: e.target.value,
                              },
                            })
                          }
                        />
                      )
                    )}
                  </div>
                );
              })()}
              {"options" in q && (
                <>
                  {q.options.map((option, i) => (
                    <div key={i} className="decision-option-editor">
                      <Input
                        label={`${t("პასუხი", "Option")} ${index + 1}.${i + 1}`}
                        value={option}
                        required
                        maxLength={160}
                        onChange={(e) =>
                          update(index, {
                            ...q,
                            options: q.options.map((v, j) =>
                              j === i ? e.target.value : v,
                            ),
                          })
                        }
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={q.options.length <= 2}
                        aria-label={`${t("პასუხის წაშლა", "Remove option")} ${index + 1}.${i + 1}`}
                        onClick={() =>
                          update(index, {
                            ...q,
                            options: q.options.filter((_, j) => j !== i),
                          })
                        }
                      >
                        <Trash2 size={16} />
                      </Button>
                    </div>
                  ))}
                  <div className="review-toolbar">
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={q.options.length >= 8}
                      onClick={() =>
                        update(index, { ...q, options: [...q.options, ""] })
                      }
                    >
                      {t("პასუხის დამატება", "Add option")}
                    </Button>
                  </div>
                </>
              )}
              {q.type === "rating_scale" && (
                <div className="decision-options">
                  <Input
                    label={t("მინიმუმი", "Minimum")}
                    type="number"
                    min={0}
                    max={9}
                    required
                    value={q.min}
                    onChange={(e) =>
                      update(index, { ...q, min: Number(e.target.value) })
                    }
                  />
                  <Input
                    label={t("მაქსიმუმი", "Maximum")}
                    type="number"
                    min={q.min + 1}
                    max={10}
                    required
                    value={q.max}
                    onChange={(e) =>
                      update(index, { ...q, max: Number(e.target.value) })
                    }
                  />
                  <Input
                    label={t("მინიმუმის აღწერა", "Minimum label")}
                    maxLength={120}
                    value={q.minLabel ?? ""}
                    onChange={(e) =>
                      update(index, { ...q, minLabel: e.target.value })
                    }
                  />
                  <Input
                    label={t("მაქსიმუმის აღწერა", "Maximum label")}
                    maxLength={120}
                    value={q.maxLabel ?? ""}
                    onChange={(e) =>
                      update(index, { ...q, maxLabel: e.target.value })
                    }
                  />
                </div>
              )}
              {q.type === "text" && (
                <>
                  <Input
                    label={t("სიმბოლოების მაქსიმუმი", "Maximum characters")}
                    type="number"
                    min={1}
                    max={2000}
                    required
                    value={q.maxLength}
                    onChange={(e) =>
                      update(index, { ...q, maxLength: Number(e.target.value) })
                    }
                  />
                  <Input
                    label={t("პასუხის მინიშნება", "Response placeholder")}
                    maxLength={200}
                    value={q.placeholder ?? ""}
                    onChange={(e) =>
                      update(index, { ...q, placeholder: e.target.value })
                    }
                  />
                </>
              )}
              {q.type === "ranked_choice" && (
                <p>
                  {t(
                    "მონაწილე ყველა პასუხს ალაგებს. პირველი ადგილი იღებს პასუხების რაოდენობის ტოლ ქულას, შემდეგი — ერთით ნაკლებს.",
                    "Participants rank every option. First place receives as many points as there are options; each subsequent place receives one fewer.",
                  )}
                </p>
              )}
            </div>
          </details>
        </Card>
      ))}
      <Button
        type="button"
        variant="secondary"
        disabled={questions.length >= 20}
        onClick={() => onChange([...questions, newQuestion()])}
      >
        <Plus size={16} />
        {t("კითხვის დამატება", "Add question")}
      </Button>
    </section>
  );
}
export function SurveyResponse({
  questions,
  answers,
  onChange,
  disabled,
}: {
  questions: SurveyQuestion[];
  answers: SurveyAnswers;
  onChange: (answers: SurveyAnswers) => void;
  disabled: boolean;
}) {
  const { language } = useConsolePreferences();
  const t = (ka: string, en: string) => (language === "ka" ? ka : en);
  function update(id: string, value: SurveyAnswers[string] | undefined) {
    const next = { ...answers };
    if (value === undefined) delete next[id];
    else next[id] = value;
    onChange(pruneHiddenSurveyAnswers(questions, next));
  }
  const visibleQuestions = questions.filter((q) =>
    isSurveyQuestionVisible(q, answers),
  );
  return (
    <div className="survey-response">
      {visibleQuestions.map((q, index) => (
        <fieldset key={q.id} disabled={disabled} className="review-form">
          <legend>
            {index + 1}. {q.title}{" "}
            {q.required ? "*" : t("(არასავალდებულო)", "(optional)")}
          </legend>
          {q.type === "text" ? (
            <Textarea
              label={q.title}
              placeholder={q.placeholder}
              maxLength={q.maxLength}
              value={
                typeof answers[q.id] === "string" ? String(answers[q.id]) : ""
              }
              onChange={(e) =>
                update(q.id, e.target.value.trim() ? e.target.value : undefined)
              }
            />
          ) : q.type === "rating_scale" ? (
            <>
              {(q.minLabel || q.maxLabel) && (
                <p>
                  {q.min} — {q.minLabel || t("მინიმუმი", "Minimum")}; {q.max} —{" "}
                  {q.maxLabel || t("მაქსიმუმი", "Maximum")}
                </p>
              )}
              <Select
                label={q.title}
                value={answers[q.id] === undefined ? "" : String(answers[q.id])}
                options={[
                  { value: "", label: t("აირჩიე შეფასება", "Choose rating") },
                  ...Array.from(
                    { length: Math.max(0, Math.min(11, q.max - q.min + 1)) },
                    (_, i) => ({
                      value: String(q.min + i),
                      label: String(q.min + i),
                    }),
                  ),
                ]}
                onChange={(e) =>
                  update(
                    q.id,
                    e.target.value === "" ? undefined : Number(e.target.value),
                  )
                }
              />
            </>
          ) : q.type === "ranked_choice" ? (
            <>
              <p>
                {t(
                  "დაალაგე ყველა პასუხი: პირველი ყველაზე სასურველია. ქულები: N, N−1 … 1.",
                  "Rank every option, most preferred first. Points: N, N−1 … 1.",
                )}
              </p>
              {q.options.map((_, rank) => (
                <Select
                  key={rank}
                  label={`${q.title} — ${t("ადგილი", "Rank")} ${rank + 1}`}
                  value={
                    Array.isArray(answers[q.id])
                      ? String((answers[q.id] as number[])[rank] ?? -1)
                      : "-1"
                  }
                  options={[
                    { value: "-1", label: t("აირჩიე პასუხი", "Choose option") },
                    ...q.options.map((label, i) => ({
                      value: String(i),
                      label,
                    })),
                  ]}
                  onChange={(e) => {
                    const ranks = Array.isArray(answers[q.id])
                      ? [...(answers[q.id] as number[])]
                      : q.options.map(() => -1);
                    ranks[rank] = Number(e.target.value);
                    update(q.id, ranks);
                  }}
                />
              ))}
            </>
          ) : (
            q.options.map((option, i) => (
              <label key={i} className="decision-choice">
                <input
                  type={q.type === "single_choice" ? "radio" : "checkbox"}
                  name={q.id}
                  checked={
                    q.type === "single_choice"
                      ? answers[q.id] === i
                      : Array.isArray(answers[q.id]) &&
                        (answers[q.id] as number[]).includes(i)
                  }
                  onChange={() => {
                    if (q.type === "single_choice") update(q.id, i);
                    else {
                      const current = Array.isArray(answers[q.id])
                        ? (answers[q.id] as number[])
                        : [];
                      const next = current.includes(i)
                        ? current.filter((v) => v !== i)
                        : [...current, i].sort();
                      update(q.id, next.length ? next : undefined);
                    }
                  }}
                />
                {option}
              </label>
            ))
          )}
          {!q.required && answers[q.id] !== undefined && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => update(q.id, undefined)}
            >
              {t("პასუხის გასუფთავება", "Clear answer")}
            </Button>
          )}
        </fieldset>
      ))}
    </div>
  );
}
export function SurveyResults({ results }: { results: SurveyResult[] }) {
  const { language } = useConsolePreferences();
  const t = (ka: string, en: string) => (language === "ka" ? ka : en);
  return (
    <div className="survey-results">
      {results.map((q) => (
        <Card key={q.id}>
          <h4>{q.title}</h4>
          <p>
            {t("პასუხები", "Responses")}: {q.answered}
          </p>
          {q.average !== undefined && q.average !== null && (
            <p>
              {t("საშუალო შეფასება", "Average rating")}: {q.average}
            </p>
          )}
          {q.type === "ranked_choice" && (
            <p>
              {t("დალაგების ქულები: N, N−1 … 1", "Ranking points: N, N−1 … 1")}
            </p>
          )}
          {q.results?.map((r) => (
            <div className="decision-result" key={r.label}>
              <span>{r.label}</span>
              <strong>{r.votes}</strong>
              <progress
                aria-label={`${q.title}: ${r.label}`}
                value={r.votes}
                max={Math.max(...q.results!.map((v) => v.votes), 1)}
              />
            </div>
          ))}
          {q.texts && (
            <ul>
              {q.texts.map((text, i) => (
                <li key={i} className="decision-description">
                  {text}
                </li>
              ))}
            </ul>
          )}
          {q.truncated && (
            <p>
              {t(
                "ნაჩვენებია პირველი 25 ტექსტური პასუხი.",
                "Showing the first 25 text responses.",
              )}
            </p>
          )}
          {q.type === "text" && !q.texts && (
            <p>
              {t(
                "ტექსტური პასუხები მხოლოდ უფლებამოსილი მმართველისთვის ჩანს.",
                "Text responses are visible only to authorized managers.",
              )}
            </p>
          )}
        </Card>
      ))}
    </div>
  );
}
