import type { ComposerDraft } from "./decisionDraft";
import type { FormEvent } from "react";
import { Plus, X } from "lucide-react";
import Card from "./ui/Card";
import Input from "./ui/Input";
import Textarea from "./ui/Textarea";
import Select from "./ui/Select";
import Button from "./ui/Button";
import { useConsolePreferences } from "./useConsolePreferences";
import { SurveyEditor, SurveyResponse } from "./SurveyFields";
import type {
  DecisionContext,
  DecisionGovernanceMode,
  DecisionKind,
  DecisionPrivacy,
} from "../api/decisions";

/** Authoring layout covering multi-unit audiences/exclusions, schedule window, privacy mode, and preview. */
export default function DecisionComposer({
  draft,
  onChange,
  audiences,
  estimate,
  policyFloor,
  editing,
  locked,
  demo,
  password,
  onPassword,
  onSubmit,
  onCancel,
}: {
  draft: ComposerDraft;
  onChange: (draft: ComposerDraft) => void;
  audiences: DecisionContext[];
  estimate?: {
    electorateCount: number;
    meetsAnonymousFloor: boolean;
    anonymousMinElectorate?: number;
    policyMinElectorate?: number;
  } | null;
  policyFloor?: number;
  editing: boolean;
  locked: boolean;
  demo: boolean;
  password: string;
  onPassword: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}) {
  const { language } = useConsolePreferences();
  const t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const set = (value: Partial<ComposerDraft>) =>
    onChange({ ...draft, ...value });

  const toggleIncluded = (id: string, checked: boolean) => {
    if (id === draft.unitId) return;
    const nextIncluded = checked
      ? [...new Set([...draft.includedUnitIds, id])]
      : draft.includedUnitIds.filter((u) => u !== id);
    const nextExcluded = draft.excludedUnitIds.filter(
      (u) => !nextIncluded.includes(u),
    );
    set({ includedUnitIds: nextIncluded, excludedUnitIds: nextExcluded });
  };

  const toggleExcluded = (id: string, checked: boolean) => {
    if (id === draft.unitId) return;
    const nextExcluded = checked
      ? [...new Set([...draft.excludedUnitIds, id])]
      : draft.excludedUnitIds.filter((u) => u !== id);
    const nextIncluded = draft.includedUnitIds.filter(
      (u) => !nextExcluded.includes(u),
    );
    set({ includedUnitIds: nextIncluded, excludedUnitIds: nextExcluded });
  };

  const basePolicyFloor = estimate?.policyMinElectorate ?? policyFloor;
  const effectiveFloor =
    estimate?.anonymousMinElectorate ??
    (draft.privacy === "anonymous" ? draft.anonymousMinElectorate : undefined) ??
    basePolicyFloor;
  const invalidCustomFloor =
    draft.privacy === "anonymous" &&
    draft.anonymousMinElectorate !== undefined &&
    (!Number.isInteger(draft.anonymousMinElectorate) ||
      draft.anonymousMinElectorate < (basePolicyFloor ?? 2) ||
      draft.anonymousMinElectorate > 1000);
  const belowAnonFloor =
    draft.privacy === "anonymous" &&
    (invalidCustomFloor ||
      (!!estimate && !estimate.meetsAnonymousFloor));

  return (
    <form onSubmit={onSubmit} className="decision-composer">
      <fieldset disabled={locked} className="decision-composer-grid">
        <div className="decision-composer-main">
          <Card>
            <h3>{t("ძირითადი ინფორმაცია", "Basic information")}</h3>
            <div className="review-form">
              <Select
                label={t("პულის ტიპი", "Poll type")}
                value={draft.kind}
                options={[
                  { value: "poll", label: t("პული / კენჭისყრა", "Poll") },
                  { value: "election", label: t("არჩევნები", "Election") },
                  {
                    value: "referendum",
                    label: t("რეფერენდუმი", "Referendum"),
                  },
                  { value: "survey", label: t("გამოკითხვა", "Survey") },
                ]}
                onChange={(e) => {
                  const kind = e.target.value as DecisionKind;
                  set({
                    kind,
                    options:
                      kind === "referendum"
                        ? ["Yes", "No", "Abstain"]
                        : kind === "survey"
                          ? []
                          : draft.kind === "poll" || draft.kind === "election"
                            ? draft.options
                            : ["", ""],
                  });
                }}
              />
              <Input
                label={t("სათაური", "Title")}
                value={draft.title}
                required
                minLength={3}
                maxLength={160}
                onChange={(e) => set({ title: e.target.value })}
              />
              <Textarea
                label={t("აღწერა", "Description")}
                value={draft.description}
                rows={3}
                maxLength={3000}
                onChange={(e) => set({ description: e.target.value })}
              />
            </div>
          </Card>

          {draft.kind === "survey" ? (
            <SurveyEditor
              questions={draft.questions}
              onChange={(questions) => set({ questions })}
            />
          ) : (
            <Card>
              <h3>
                {draft.kind === "referendum"
                  ? t("რეფერენდუმის პირობები", "Referendum configuration")
                  : draft.kind === "election"
                    ? t("კანდიდატები", "Candidates")
                    : t("პასუხები", "Options")}
              </h3>
              {draft.kind === "referendum" ? (
                <div className="review-form">
                  <p>
                    {t(
                      "პასუხები: ვეთანხმები, არ ვეთანხმები, თავს ვიკავებ.",
                      "Responses: Yes, No, Abstain.",
                    )}
                  </p>
                  <Input
                    label={t(
                      "მხარდაჭერის ზღვარი (%)",
                      "Approval threshold (%)",
                    )}
                    type="number"
                    min={50}
                    max={100}
                    required
                    value={draft.threshold}
                    onChange={(e) => set({ threshold: Number(e.target.value) })}
                  />
                  <div className="grid gap-3 md:grid-cols-3">
                    <Input
                      label={t(
                        "თანხმობის ტექსტი (არასავალდებულო)",
                        "Custom Yes wording",
                      )}
                      maxLength={80}
                      value={draft.yesLabel}
                      onChange={(e) => set({ yesLabel: e.target.value })}
                    />
                    <Input
                      label={t(
                        "უარის ტექსტი (არასავალდებულო)",
                        "Custom No wording",
                      )}
                      maxLength={80}
                      value={draft.noLabel}
                      onChange={(e) => set({ noLabel: e.target.value })}
                    />
                    <Input
                      label={t(
                        "თავშეკავების ტექსტი (არასავალდებულო)",
                        "Custom Abstain wording",
                      )}
                      maxLength={80}
                      value={draft.abstainLabel}
                      onChange={(e) => set({ abstainLabel: e.target.value })}
                    />
                  </div>
                  <p>
                    {t(
                      "ზღვარი ითვლება „ვეთანხმები“ და „არ ვეთანხმები“ პასუხებიდან. თავის შეკავება მონაწილეობასა და კვორუმში ითვლება. ფრე მიღებას არ ნიშნავს.",
                      "The threshold uses Yes and No answers. Abstentions count toward participation and quorum. A tie does not pass.",
                    )}
                  </p>
                  <p>
                    {t(
                      "შედეგი ავტომატურად არ ცვლის უფლებებს და არ ანაცვლებს დამოუკიდებელ დამტკიცებას.",
                      "The result does not automatically change authority or replace independent approval.",
                    )}
                  </p>
                </div>
              ) : (
                <div className="review-form">
                  {draft.kind === "election" && (
                    <p>
                      {t(
                        "თითო მონაწილე ირჩევს ერთ კანდიდატს. შედეგი აჩვენებს ხმების განაწილებას; თანამდებობაზე დანიშვნას დამოუკიდებელი დამტკიცება სჭირდება.",
                        "Each participant selects one candidate. Results show vote totals; appointment requires independent approval.",
                      )}
                    </p>
                  )}
                  {draft.options.map((option, index) => (
                    <div className="decision-option-editor" key={index}>
                      <Input
                        label={`${draft.kind === "election" ? t("კანდიდატი", "Candidate") : t("პასუხი", "Option")} ${index + 1}`}
                        value={option}
                        required
                        maxLength={160}
                        onChange={(e) =>
                          set({
                            options: draft.options.map((v, i) =>
                              i === index ? e.target.value : v,
                            ),
                          })
                        }
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={draft.options.length <= 2}
                        aria-label={`${draft.kind === "election" ? t("კანდიდატის წაშლა", "Remove candidate") : t("პასუხის წაშლა", "Remove option")} ${index + 1}`}
                        onClick={() =>
                          set({
                            options: draft.options.filter(
                              (_, i) => i !== index,
                            ),
                          })
                        }
                      >
                        <X size={16} />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={draft.options.length >= 8}
                    onClick={() => set({ options: [...draft.options, ""] })}
                  >
                    <Plus size={16} />
                    {draft.kind === "election"
                      ? t("კანდიდატის დამატება", "Add candidate")
                      : t("პასუხის დამატება", "Add option")}
                  </Button>
                </div>
              )}
            </Card>
          )}
        </div>

        <aside className="decision-composer-settings">
          <Card>
            <h3>{t("აუდიტორია", "Audience")}</h3>
            <div className="review-form">
              <Select
                label={t(
                  "მთავარი ერთეული — რეგიონი ან ჯგუფი",
                  "Audience — region or group",
                )}
                value={draft.unitId}
                disabled={editing}
                required
                options={audiences.map((a) => ({ value: a.id, label: a.name }))}
                onChange={(e) => {
                  const primary = e.target.value;
                  set({
                    unitId: primary,
                    includedUnitIds: primary
                      ? [
                          primary,
                          ...draft.includedUnitIds.filter((id) => id !== primary),
                        ]
                      : [],
                    excludedUnitIds: draft.excludedUnitIds.filter(
                      (id) => id !== primary,
                    ),
                  });
                }}
              />
              {audiences.length > 1 && (
                <details>
                  <summary>
                    {t(
                      "დამატებითი ერთეულები და გამორიცხვები",
                      "Multi-unit inclusions & exclusions",
                    )}
                  </summary>
                  <div className="space-y-2 mt-2">
                    <p className="text-xs opacity-80">
                      {t("დამატებით ჩართული ერთეულები:", "Additional included units:")}
                    </p>
                    {audiences
                      .filter((a) => a.id !== draft.unitId)
                      .map((a) => (
                        <label key={`inc-${a.id}`} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={draft.includedUnitIds.includes(a.id)}
                            onChange={(e) => toggleIncluded(a.id, e.target.checked)}
                          />
                          <span>{a.name}</span>
                        </label>
                      ))}
                    <p className="text-xs opacity-80 mt-2">
                      {t("გამორიცხული ქვეერთეულები:", "Excluded sub-units:")}
                    </p>
                    {audiences
                      .filter((a) => a.id !== draft.unitId)
                      .map((a) => (
                        <label key={`exc-${a.id}`} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={draft.excludedUnitIds.includes(a.id)}
                            onChange={(e) => toggleExcluded(a.id, e.target.checked)}
                          />
                          <span>{a.name}</span>
                        </label>
                      ))}
                  </div>
                </details>
              )}
              {estimate && (
                <p role="status" className="text-sm font-medium">
                  {t("სავარაუდო აუდიტორია:", "Estimated electorate:")}{" "}
                  {estimate.electorateCount}
                  {draft.privacy === "anonymous" &&
                    (estimate.meetsAnonymousFloor
                      ? ` · ${
                          effectiveFloor !== undefined
                            ? t(
                                `აკმაყოფილებს ანონიმურობის ზღვარს (≥ ${effectiveFloor})`,
                                `Meets anonymity floor (≥ ${effectiveFloor})`,
                              )
                            : t(
                                "აკმაყოფილებს ანონიმურობის ზღვარს",
                                "Meets anonymity floor",
                              )
                        }`
                      : ` · ${
                          effectiveFloor !== undefined
                            ? t(
                                `ანონიმურობის ზღვარზე ნაკლებია (< ${effectiveFloor})`,
                                `Below anonymity floor (< ${effectiveFloor})`,
                              )
                            : t(
                                "ანონიმურობის ზღვარზე ნაკლებია",
                                "Below anonymity floor",
                              )
                        }`)}
                </p>
              )}
              <p>
                {t(
                  "აირჩიე მთელი სტრუქტურა, რეგიონი ან ჯგუფი შენი უფლებების ფარგლებში. სია ფიქსირდება გამოქვეყნებისას.",
                  "Choose the whole structure, a region or group within your permissions. Eligible members freeze on publication.",
                )}
              </p>
            </div>
          </Card>

          <Card>
            <h3>{t("ვადა და წესები", "Schedule and rules")}</h3>
            <div className="review-form">
              <Input
                label={t(
                  "გახსნის დრო (არასავალდებულო, დაგეგმილი)",
                  "Opens at (optional scheduled opening)",
                )}
                type="datetime-local"
                value={draft.opensAt}
                max={draft.deadline}
                onChange={(e) => set({ opensAt: e.target.value })}
              />
              <Input
                label={t(
                  "დასრულება (ადგილობრივი დრო)",
                  "Closes at (local time)",
                )}
                type="datetime-local"
                required
                min={draft.opensAt || undefined}
                value={draft.deadline}
                onChange={(e) => set({ deadline: e.target.value })}
              />
              <Input
                label={t("კვორუმი (%)", "Quorum (%)")}
                type="number"
                min={1}
                max={100}
                required
                value={draft.quorum}
                onChange={(e) => set({ quorum: Number(e.target.value) })}
              />
              <Select
                label={t("მმართველობის სტატუსი", "Governance contract")}
                value={draft.governanceMode}
                options={[
                  {
                    value: "advisory",
                    label: t("საკონსულტაციო შედეგი", "Advisory result"),
                  },
                  {
                    value: "binding_review",
                    label: t(
                      "სავალდებულო (საჭიროებს დამოუკიდებელ განხილვას)",
                      "Binding (requires independent review execution)",
                    ),
                  },
                ]}
                onChange={(e) =>
                  set({
                    governanceMode: e.target.value as DecisionGovernanceMode,
                  })
                }
              />
              <p>
                {t(
                  "ერთი წევრი — ერთი წარდგენა; შედეგები არ ცვლის უფლებებს ავტომატურად.",
                  "One member, one submission; results never silently grant permissions or appoint positions.",
                )}
              </p>
            </div>
          </Card>

          <Card>
            <h3>{t("კონფიდენციალურობა", "Privacy")}</h3>
            <div className="review-form">
              <Select
                label={t("ხმის მიცემის რეჟიმი", "Participation privacy")}
                value={draft.privacy}
                options={[
                  {
                    value: "named",
                    label: t("სახელობითი (დაკავშირებული)", "Named (linked to account)"),
                  },
                  {
                    value: "anonymous",
                    label:
                      effectiveFloor !== undefined
                        ? t(
                            `ანონიმური (განცალკევებული ბიულეტენი, მინ. ${effectiveFloor})`,
                            `Anonymous (unlinkable ballot, k ≥ ${effectiveFloor})`,
                          )
                        : t(
                            "ანონიმური (განცალკევებული ბიულეტენი)",
                            "Anonymous (unlinkable ballot)",
                          ),
                  },
                ]}
                onChange={(e) =>
                  set({ privacy: e.target.value as DecisionPrivacy })
                }
              />
              {draft.privacy === "anonymous" && (
                <Input
                  label={
                    basePolicyFloor !== undefined
                      ? t(
                          `მინიმალური ამომრჩეველი (k, ≥ ${basePolicyFloor})`,
                          `Minimum electorate (k, ≥ ${basePolicyFloor})`,
                        )
                      : t("მინიმალური ამომრჩეველი (k)", "Minimum electorate (k)")
                  }
                  type="number"
                  min={basePolicyFloor ?? 2}
                  max={1000}
                  step={1}
                  value={draft.anonymousMinElectorate ?? basePolicyFloor ?? ""}
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    const parsed = raw ? Number(raw) : undefined;
                    set({
                      anonymousMinElectorate:
                        parsed !== undefined && Number.isFinite(parsed)
                          ? parsed
                          : undefined,
                    });
                  }}
                />
              )}
              <p className="decision-privacy">
                {draft.privacy === "anonymous"
                  ? effectiveFloor !== undefined
                    ? t(
                        `ანონიმური რეჟიმი — ბიულეტენი არ უკავშირდება მომხმარებელს; გამოკითხვის თავისუფალი ტექსტი დაფარულია და საჭიროა ≥ ${effectiveFloor} ამომრჩეველი.`,
                        `Anonymous mode — ballot content is unlinkable to accounts; free text is redacted and requires ≥ ${effectiveFloor} eligible members.`,
                      )
                    : t(
                        "ანონიმური რეჟიმი — ბიულეტენი არ უკავშირდება მომხმარებელს; გამოკითხვის თავისუფალი ტექსტი დაფარულია.",
                        "Anonymous mode — ballot content is unlinkable to accounts; free text is redacted.",
                      )
                  : t(
                      "არაანონიმური რეჟიმი — პასუხები ანგარიშთან დაკავშირებულად ინახება.",
                      "Named mode — responses are stored with the account.",
                    )}
              </p>
            </div>
          </Card>
        </aside>

        <Card className="decision-composer-actions">
          <details className="decision-preview">
            <summary>{t("წინასწარი ნახვა", "Preview")}</summary>
            <div className="review-form">
              <p>
                {t(
                  "მონაწილის ფორმის წინასწარი ნახვა",
                  "Participant form preview",
                )}
              </p>
              <h3>{draft.title || t("სათაური", "Title")}</h3>
              {draft.description && <p>{draft.description}</p>}
              <p>
                {draft.privacy === "anonymous"
                  ? t(
                      "ანონიმური რეჟიმი — არჩევანი არ უკავშირდება თქვენს ანგარიშს.",
                      "Anonymous mode — ballot choices are never linked to your account.",
                    )
                  : t(
                      "არაანონიმური რეჟიმი — პასუხები ანგარიშთან დაკავშირებულად ინახება.",
                      "Named mode — responses are stored with the account.",
                    )}
              </p>
              {draft.kind === "survey" ? (
                <SurveyResponse
                  questions={draft.questions}
                  answers={{}}
                  onChange={() => {}}
                  disabled
                />
              ) : (
                <fieldset disabled className="review-form">
                  <legend>
                    {draft.kind === "election"
                      ? t("აირჩიე ერთი კანდიდატი", "Choose one candidate")
                      : t("აირჩიე ერთი პასუხი", "Choose one option")}
                  </legend>
                  {draft.options.map((option, index) => (
                    <label className="decision-choice" key={index}>
                      <input type="radio" name="preview-choice" />
                      {draft.kind === "referendum"
                        ? [
                            draft.yesLabel.trim() || t("ვეთანხმები", "Yes"),
                            draft.noLabel.trim() || t("არ ვეთანხმები", "No"),
                            draft.abstainLabel.trim() ||
                              t("თავს ვიკავებ", "Abstain"),
                          ][index]
                        : option}
                    </label>
                  ))}
                </fieldset>
              )}
            </div>
          </details>
          {!demo && (
            <Input
              label={t("პაროლი", "Password")}
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => onPassword(e.target.value)}
            />
          )}
          <div className="review-toolbar">
            <Button
              type="submit"
              disabled={!draft.unitId || belowAnonFloor}
            >
              {t("დრაფტის შენახვა", "Save draft")}
            </Button>
            <Button type="button" variant="secondary" onClick={onCancel}>
              {t("გაუქმება", "Cancel")}
            </Button>
          </div>
        </Card>
      </fieldset>
    </form>
  );
}
