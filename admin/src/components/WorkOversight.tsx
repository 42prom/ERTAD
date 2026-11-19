import { useState, type FormEvent } from "react";
import Card from "./ui/Card";
import Button from "./ui/Button";
import Input from "./ui/Input";
import Textarea from "./ui/Textarea";
import Select from "./ui/Select";
import { useConsolePreferences } from "./useConsolePreferences";
import type {
  WorkDetail,
  WorkOverview,
  WorkTrackingAction,
  WorkWrite,
} from "../api/work";

export function WorkOverviewStats({ data }: { data: WorkOverview }) {
  const { language } = useConsolePreferences(),
    ka = language === "ka";
  return (
    <div
      className="task-overview"
      aria-label={ka ? "სამუშაოების შეჯამება" : "Work overview"}
    >
      {[
        [ka ? "მიმდინარე" : "Active", data.active],
        [ka ? "შეფერხებული" : "Blocked", data.blocked],
        [ka ? "ვადაგადაცილებული" : "Overdue", data.overdue],
        [ka ? "დასადასტურებელი" : "Needs review", data.needsReview],
        [ka ? "მისაღები" : "Offered", data.offered],
        ...(data.shortfalls !== undefined
          ? [[ka ? "რესურსის დეფიციტი" : "Resource shortfalls", data.shortfalls]]
          : []),
        ...(data.dueSoon !== undefined
          ? [[ka ? "48 სთ-ში იწურება" : "Due soon", data.dueSoon]]
          : []),
        [ka ? "გადახედვის ვადა გასულია" : "Review overdue", data.reviewDue],
      ].map(([label, value]) => (
        <div key={String(label)}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

export default function WorkOversight({
  detail,
  organizationId,
  locked,
  person,
  onWrite,
}: {
  detail: WorkDetail;
  organizationId: string;
  locked: boolean;
  person: (id: string) => string;
  onWrite: (input: WorkWrite) => Promise<void>;
}) {
  const { language } = useConsolePreferences(),
    ka = language === "ka",
    t = (ge: string, en: string) => (ka ? ge : en);
  const [mode, setMode] = useState<WorkTrackingAction | null>(null),
    [target, setTarget] = useState(""),
    [note, setNote] = useState("");
  const [coordinator, setCoordinator] = useState(
    detail.coordinators?.includes(detail.coordinatorId ?? "")
      ? detail.coordinatorId!
      : detail.actorId,
  );
  const [kind, setKind] = useState("dependency"),
    [date, setDate] = useState("");
  const [criteria, setCriteria] = useState(() =>
    detail.criteria?.length
      ? detail.criteria.map((c) => ({
          id: c.id,
          title: c.title,
          weight: c.weight,
        }))
      : [{ id: crypto.randomUUID(), title: "", weight: 1 }],
  );
  const open = detail.status === "open";
  const label = (op: WorkTrackingAction) =>
    ({
      coordinator: t("პასუხისმგებლის შეცვლა", "Change coordinator"),
      criteria: t("შესრულების კრიტერიუმები", "Completion criteria"),
      criterion_submit: t("შედეგის წარდგენა", "Submit result"),
      criterion_verify: t("შედეგის დადასტურება", "Verify result"),
      criterion_return: t("შესასწორებლად დაბრუნება", "Return result"),
      block: t("შეფერხების დაფიქსირება", "Report blocker"),
      resolve_block: t("შეფერხების მოგვარება", "Resolve blocker"),
      block_update: t("შეფერხების განახლება", "Update blocker"),
    })[op];
  function choose(op: WorkTrackingAction, id = "") {
    setMode(op);
    setTarget(id);
    setNote("");
    if (op === "block_update") {
      const b = detail.blockerRecords?.find((row) => row.id === id);
      if (b) {
        setCoordinator(
          detail.coordinators?.includes(b.ownerId) ? b.ownerId : detail.actorId,
        );
        const d = new Date(b.nextReviewAt);
        setDate(
          new Date(d.getTime() - d.getTimezoneOffset() * 60000)
            .toISOString()
            .slice(0, 16),
        );
      }
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!mode) return;
    void onWrite({
      organizationId,
      key: crypto.randomUUID(),
      id: detail.id,
      version: detail.version,
      operation: mode,
      note,
      ...(mode === "coordinator"
        ? { memberId: coordinator }
        : mode === "criteria"
          ? { criteria }
          : mode === "block"
            ? {
                kind,
                nextReviewAt: new Date(date).toISOString(),
                ...(detail.canManage ? { memberId: coordinator } : {}),
              }
            : mode === "block_update"
              ? {
                  blockerId: target,
                  memberId: coordinator,
                  nextReviewAt: new Date(date).toISOString(),
                }
              : mode === "resolve_block"
                ? { blockerId: target }
                : { criterionId: target }),
    });
  }
  const action = (op: WorkTrackingAction, id = "") => (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      disabled={locked}
      onClick={() => choose(op, id)}
    >
      {label(op)}
    </Button>
  );
  const dateLabel = (value: string) =>
    new Date(value).toLocaleString(ka ? "ka-GE" : "en-GB", { hour12: false });
  return (
    <>
      <Card>
        <h3 className="text-lg font-semibold">
          {t(
            "პასუხისმგებლობა და საერთო კონტროლი",
            "Responsibility and oversight",
          )}
        </h3>
        <p>
          {t("კოორდინატორი", "Coordinator")}:{" "}
          {detail.coordinatorId
            ? person(detail.coordinatorId)
            : t("არ არის მითითებული", "Not set")}
          {!detail.coordinatorActive && (
            <strong>
              {" "}
              ·{" "}
              {t("საჭიროა მოქმედი პასუხისმგებელი", "Active coordinator needed")}
            </strong>
          )}
        </p>
        {open && detail.canManage && action("coordinator")}
        {detail.overview && (
          <>
            <WorkOverviewStats data={detail.overview} />
            <p>
              {t("დასრულებული ბოლო დონის სამუშაოები", "Completed leaf tasks")}:{" "}
              {detail.overview.leafCompleted}/{detail.overview.leafTotal}
            </p>
            <p className="text-gray-600">
              {t(
                "მოიცავს ამ დავალებასა და შენთვის ხილულ ქვედავალებებს. საერთო პროცენტი სხვადასხვა სამუშაოს პროცენტების საშუალო არ არის.",
                "Includes this task and visible descendants. Percentages from different tasks are not averaged.",
              )}
            </p>
          </>
        )}
      </Card>
      {mode && (
        <Card>
          <form onSubmit={submit} className="review-form">
            <fieldset disabled={locked}>
              <h3 className="text-lg font-semibold">{label(mode)}</h3>
              {(mode === "coordinator" ||
                ((mode === "block" || mode === "block_update") &&
                  detail.canManage)) && (
                <Select
                  label={t("პასუხისმგებელი", "Responsible manager")}
                  required
                  value={coordinator}
                  options={(detail.coordinators ?? []).map((id) => ({
                    value: id,
                    label: person(id),
                  }))}
                  onChange={(e) => setCoordinator(e.target.value)}
                />
              )}
              {mode === "criteria" && (
                <>
                  <p>
                    {t(
                      "წონები განსაზღვრავს დადასტურებულ პროგრესს. პირველი მონაწილეობის ან წარდგენის შემდეგ კრიტერიუმები ფიქსირდება.",
                      "Weights determine verified progress. Criteria freeze after the first application, delegation or result submission.",
                    )}
                  </p>
                  {criteria.map((c, i) => (
                    <div key={c.id} className="task-criterion-fields">
                      <Input
                        label={t("კრიტერიუმი", "Criterion") + " " + (i + 1)}
                        minLength={3}
                        maxLength={160}
                        required
                        value={c.title}
                        onChange={(e) =>
                          setCriteria((rows) =>
                            rows.map((r) =>
                              r.id === c.id
                                ? { ...r, title: e.target.value }
                                : r,
                            ),
                          )
                        }
                      />
                      <Input
                        type="number"
                        label={t("წონა", "Weight") + " " + (i + 1)}
                        min={1}
                        max={100}
                        required
                        value={c.weight}
                        onChange={(e) =>
                          setCriteria((rows) =>
                            rows.map((r) =>
                              r.id === c.id
                                ? { ...r, weight: Number(e.target.value) }
                                : r,
                            ),
                          )
                        }
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={criteria.length === 1}
                        onClick={() =>
                          setCriteria((rows) =>
                            rows.filter((r) => r.id !== c.id),
                          )
                        }
                        aria-label={
                          t("კრიტერიუმის წაშლა", "Remove criterion") +
                          " " +
                          (i + 1)
                        }
                      >
                        {t("წაშლა", "Remove")}
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={criteria.length >= 10}
                    onClick={() =>
                      setCriteria((rows) => [
                        ...rows,
                        { id: crypto.randomUUID(), title: "", weight: 1 },
                      ])
                    }
                  >
                    {t("კრიტერიუმის დამატება", "Add criterion")}
                  </Button>
                </>
              )}
              {mode === "block" && (
                <>
                  <Select
                    label={t("შეფერხების ტიპი", "Blocker type")}
                    value={kind}
                    onChange={(e) => setKind(e.target.value)}
                    options={[
                      "people",
                      "resource",
                      "service",
                      "funding",
                      "dependency",
                      "other",
                    ].map((value, i) => ({
                      value,
                      label: ka
                        ? [
                            "ადამიანები",
                            "რესურსი",
                            "მომსახურება",
                            "დაფინანსება",
                            "დამოკიდებულება",
                            "სხვა",
                          ][i]
                        : [
                            "People",
                            "Resource",
                            "Service",
                            "Funding",
                            "Dependency",
                            "Other",
                          ][i],
                    }))}
                  />
                  <Input
                    type="datetime-local"
                    label={t("შემდეგი გადახედვა", "Next review")}
                    required
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </>
              )}
              {mode === "block_update" && (
                <Input
                  type="datetime-local"
                  label={t("შემდეგი გადახედვა", "Next review")}
                  required
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              )}
              {mode !== "criteria" && (
                <Textarea
                  label={t(
                    "მოსალოდნელი მოქმედება / მტკიცებულება",
                    "Next action / evidence",
                  )}
                  required={!["coordinator"].includes(mode)}
                  minLength={mode === "coordinator" ? undefined : 3}
                  maxLength={1000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              )}
              <p className="text-gray-600">
                {t(
                  "ჩაწერე მხოლოდ სამუშაოს ინფორმაცია. შენიშვნები დავალებაზე წვდომის მქონე პირებისთვის ჩანს.",
                  "Include operational information only. Notes are visible to people with task access.",
                )}
              </p>
              <div className="review-toolbar">
                <Button type="submit">
                  {t("შენახვა", "Save oversight change")}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setMode(null)}
                >
                  {t("დახურვა", "Dismiss")}
                </Button>
              </div>
            </fieldset>
          </form>
        </Card>
      )}
      <Card>
        <div className="flex flex-wrap justify-between gap-3">
          <h3 className="text-lg font-semibold">
            {t("დადასტურებული შედეგები", "Verified outcomes")}
          </h3>
          {open && detail.canSetCriteria && action("criteria")}
        </div>
        {detail.verifiedProgress != null ? (
          <>
            <p>
              {detail.verifiedProgress}% · {detail.criteriaVerified}/
              {detail.criteriaTotal}
            </p>
            <progress
              className="w-full"
              aria-label={t("დადასტურებული პროგრესი", "Verified progress")}
              max={100}
              value={detail.verifiedProgress}
            />
          </>
        ) : (
          <p>
            {t(
              "კრიტერიუმები ჯერ არ არის განსაზღვრული. მონაწილის პროცენტი თვითანგარიშია.",
              "No criteria configured. Participant percentages are self-reported.",
            )}
          </p>
        )}
        {(detail.criteria ?? []).map((c) => (
          <div key={c.id} className="border-t border-gray-200 py-4 space-y-2">
            <strong>{c.title}</strong>
            <p>
              {t("წონა", "Weight")}: {c.weight} ·{" "}
              {c.status === "verified"
                ? t("დადასტურებული", "Verified")
                : c.status === "submitted"
                  ? t("დასადასტურებელი", "Awaiting verification")
                  : t("შესასრულებელი", "Pending")}
            </p>
            {c.submissionNote && (
              <p className="whitespace-pre-wrap break-words">
                {c.submissionNote}
              </p>
            )}
            {c.reviewNote && (
              <p className="whitespace-pre-wrap break-words">{c.reviewNote}</p>
            )}
            <div className="review-toolbar">
              {open &&
                detail.canReport &&
                c.status === "pending" &&
                action("criterion_submit", c.id)}
              {open && detail.canVerify && c.status === "submitted" && (
                <>
                  {c.submittedBy !== detail.actorId &&
                    action("criterion_verify", c.id)}
                  {action("criterion_return", c.id)}
                </>
              )}
            </div>
          </div>
        ))}
      </Card>
      <Card>
        <div className="flex flex-wrap justify-between gap-3">
          <h3 className="text-lg font-semibold">
            {t("შეფერხებები და საჭირო ჩარევა", "Blockers and next actions")}
          </h3>
          {open && detail.canReport && action("block")}
        </div>
        <p className="text-gray-600">
          {t(
            "შეფერხების აღრიცხვა თანხის ან რესურსის მიღებას არ ადასტურებს.",
            "A blocker report does not confirm receipt of money or resources.",
          )}
        </p>
        {!detail.blockerRecords?.length && (
          <p>{t("შეფერხებები არ დაფიქსირებულა.", "No blockers reported.")}</p>
        )}
        {(detail.blockerRecords ?? []).map((b) => (
          <div key={b.id} className="border-t border-gray-200 py-4">
            <p className="whitespace-pre-wrap break-words">
              <strong>{b.reason}</strong>
            </p>
            <p>
              {person(b.ownerId)} · {dateLabel(b.nextReviewAt)} ·{" "}
              {b.resolvedAt ? t("მოგვარებული", "Resolved") : t("ღია", "Open")}
            </p>
            {!b.ownerActive && !b.resolvedAt && (
              <p>
                {t(
                  "პასუხისმგებლის უფლება აღარ მოქმედებს. ჩარევა საჭიროა.",
                  "The owner no longer has access. Intervention is needed.",
                )}
              </p>
            )}
            {b.resolution && <p>{b.resolution}</p>}
            {b.nextAction && <p>{b.nextAction}</p>}
            {open &&
              detail.canManage &&
              !b.resolvedAt &&
              action("block_update", b.id)}
            {open &&
              detail.canManage &&
              !b.resolvedAt &&
              action("resolve_block", b.id)}
          </div>
        ))}
      </Card>
    </>
  );
}
