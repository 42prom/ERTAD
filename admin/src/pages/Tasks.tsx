import ParticipationReward from "../components/ParticipationReward";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Plus, ArrowLeft, ClipboardList, Copy, Download, Kanban, List, CalendarRange } from "lucide-react";
import { downloadSafeCsv } from "../utils/safeCsv";
import { REALTIME_EVENT, type RealtimeSignal } from "../api/realtime";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import Textarea from "../components/ui/Textarea";
import Select from "../components/ui/Select";
import WorkOversight, { WorkOverviewStats } from "../components/WorkOversight";
import WorkNeeds from "../components/WorkNeeds";
import WorkFunding from "../components/WorkFunding";
import TaskConversation from "../components/TaskConversation";
import TaskEvidence from "../components/TaskEvidence";
import TaskRecognition from "../components/TaskRecognition";
import TaskMaterials from "../components/TaskMaterials";
import TaskDefinitionEditor, {
  TaskDefinitionChanges,
} from "../components/TaskDefinitionEditor";
import { useInboxTarget } from "../components/useInboxTarget";
import type { WorkOverview } from "../api/work";
import { useConsolePreferences } from "../components/useConsolePreferences";
import { demoApi } from "../api/demo";
import {
  workApi,
  type WorkAction,
  type WorkContext,
  type WorkDefinition,
  type WorkDetail,
  type WorkItem,
  type WorkPage,
  type WorkUnit,
  type WorkWrite,
} from "../api/work";

export default function Tasks() {
  const [scopeUnit, setScopeUnit] = useState(""),
    [overview, setOverview] = useState<WorkOverview | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const { language } = useConsolePreferences(),
    ka = language === "ka",
    t = (ge: string, en: string) => (ka ? ge : en);
  const [contexts, setContexts] = useState<WorkContext[] | null>(null),
    [org, setOrg] = useState(""),
    [units, setUnits] = useState<WorkUnit[]>([]);
  const [view, setView] = useState("open"),
    [displayMode, setDisplayMode] = useState<"list" | "board" | "timeline">("list"),
    [page, setPage] = useState(1),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("");
  const [data, setData] = useState<WorkPage | null>(null),
    [selected, setSelected] = useState(""),
    [detail, setDetail] = useState<WorkDetail | null>(null);
  useInboxTarget("work", org, setSelected);
  const [revision, setRevision] = useState(0),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(false);
  const [demo, setDemo] = useState(false),
    [people, setPeople] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<"create" | "delegate" | "edit" | null>(
      null,
    ),
    [draft, setDraft] = useState<WorkDefinition>({
      unitId: "",
      title: "",
      description: "",
      roleLabel: "",
      priority: "normal",
      capacity: 1,
      deadline: "",
    });
  const [action, setAction] = useState<{
      operation: WorkAction;
      memberId?: string;
    } | null>(null),
    [note, setNote] = useState(""),
    [amount, setAmount] = useState(1);
  const [roleNeed, setRoleNeed] = useState("");
  const [pending, setPending] = useState<WorkWrite | null>(null),
    [busy, setBusy] = useState(false);
  const lock = useRef(false),
    generation = useRef(0),
    locked = busy || !!pending;
  const label = (value: string) =>
    (
      ({
        edit: t("დავალება განახლდა", "Task updated"),
        materials: t("მასალების განახლება", "Materials updated"),
        qualification_define: t(
          "კვალიფიკაციის დამატება",
          "Qualification defined",
        ),
        qualification_claim: t(
          "კვალიფიკაციის წარდგენა",
          "Qualification claimed",
        ),
        qualification_verify: t(
          "კვალიფიკაციის დადასტურება",
          "Qualification verified",
        ),
        qualification_reject: t(
          "კვალიფიკაციის უარყოფა",
          "Qualification rejected",
        ),
        qualification_revoke: t(
          "კვალიფიკაციის გაუქმება",
          "Qualification revoked",
        ),
        need_create: t("საჭიროების დამატება", "Need created"),
        need_cancel: t("საჭიროების გაუქმება", "Need cancelled"),
        provision_offer: t("რესურსის შეთავაზება", "Provision pledged"),
        provision_confirm: t("მიღების დადასტურება", "Provision confirmed"),
        provision_withdraw: t("შეთავაზების გამოთხოვა", "Provision withdrawn"),
        provision_return: t("რესურსის დაბრუნება", "Provision returned"),
        provision_reject: t("შეთავაზების უარყოფა", "Provision rejected"),
        offered: t("მისაღები", "Offered"),
        blocked: t("შეფერხებული", "Blocked"),
        overdue: t("ვადაგადაცილებული", "Overdue"),
        needs_review: t("დასადასტურებელი", "Needs review"),
        shortfalls: t("რესურსის დეფიციტი", "Resource shortfalls"),
        coordinator: t("პასუხისმგებლის შეცვლა", "Coordinator changed"),
        criteria: t("კრიტერიუმების განსაზღვრა", "Criteria configured"),
        criterion_submit: t("შედეგის წარდგენა", "Result submitted"),
        criterion_verify: t("შედეგის დადასტურება", "Result verified"),
        criterion_return: t("შედეგის დაბრუნება", "Result returned"),
        block: t("შეფერხება", "Blocker reported"),
        resolve_block: t("შეფერხების მოგვარება", "Blocker resolved"),
        block_update: t(
          "შემდეგი მოქმედების განახლება",
          "Blocker action updated",
        ),
        open: t("მიმდინარე", "Open"),
        completed: t("დასრულებული", "Completed"),
        cancelled: t("გაუქმებული", "Cancelled"),
        mine: t("ჩემი მონაწილეობა", "My participation"),
        inbox: t("შეტყობინებები", "Inbox"),
        applied: t("კანდიდატი", "Applied"),
        reserved: t("რეზერვი", "Reserved"),
        assigned: t("დანიშნული", "Assigned"),
        in_progress: t("მუშაობს", "In progress"),
        submitted: t("დასადასტურებელი", "Submitted"),
        verified: t("დადასტურებული", "Verified"),
        withdrawn: t("გასული", "Withdrawn"),
        rejected: t("უარყოფილი", "Rejected"),
        no_show: t("არ გამოცხადდა", "No-show"),
        low: t("დაბალი", "Low"),
        normal: t("ჩვეულებრივი", "Normal"),
        high: t("მაღალი", "High"),
        urgent: t("სასწრაფო", "Urgent"),
        create: t("შექმნა", "Create"),
        delegate: t("ქვედა ერთეულზე გადაცემა", "Delegate"),
        accept: t("მიღება", "Accept"),
        decline: t("მიღებაზე უარი", "Decline"),
        cancel: t("გაუქმება", "Cancel"),
        complete: t("დავალების დასრულება", "Complete task"),
        apply: t("მონაწილეობის სურვილი", "Volunteer"),
        reserve: t("რეზერვში გადაყვანა", "Reserve"),
        assign: t("დანიშვნა", "Assign"),
        reject: t("კანდიდატის უარყოფა", "Reject"),
        withdraw: t("მონაწილეობიდან გასვლა", "Withdraw"),
        start: t("მუშაობის დაწყება", "Start work"),
        progress: t("პროგრესის განახლება", "Update progress"),
        submit: t("შესრულების წარდგენა", "Submit completion"),
        return: t("შესასწორებლად დაბრუნება", "Return for changes"),
        verify: t("შესრულების დადასტურება", "Verify completion"),
      }) as Record<string, string>
    )[value] ?? value;
  const person = (id: string) =>
    people[id] ??
    (id === detail?.actorId
      ? t("მე", "Me")
      : t("წევრი ", "Member ") + id.slice(0, 8));
  const failure = (e: unknown) => {
    const status = (e as { response?: { status?: number } }).response?.status;
    return status === 403
      ? t("წვდომა არ გაქვს ან უფლება გაუქმდა.", "Access denied or revoked.")
      : status === 409
        ? t(
            "ჩანაწერი შეიცვალა ან ეს მოქმედება აღარ არის შესაძლებელი. განაახლე დეტალები.",
            "The record changed or this action is no longer available. Refresh details.",
          )
        : status === 400
          ? t(
              "შეამოწმე ველები, ვადა და მოქმედების მიზეზი.",
              "Check the fields, deadline and reason.",
            )
          : t(
              "შედეგი ვერ დადასტურდა. ხელახლა სცადე იგივე მოთხოვნა.",
              "Could not confirm the result. Retry the same request.",
            );
  };
  useEffect(() => {
    let live = true;
    workApi
      .contexts()
      .then((rows) => {
        if (live) {
          setContexts(rows);
          setOrg(rows[0]?.id ?? "");
        }
      })
      .catch(() => {
        if (live) {
          setContexts([]);
          setError(
            t("წვდომის ჩატვირთვა ვერ მოხერხდა.", "Could not load access."),
          );
        }
      });
    demoApi
      .scenario()
      .then((s) => {
        if (live) {
          setDemo(true);
          setPeople(
            Object.fromEntries(s.accounts.map((a) => [a.memberId, a.label])),
          );
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const readScope1Key = JSON.stringify([
    org,
    view,
    page,
    filter,
    selected,
    scopeUnit,
  ]);
  const [readScope1, setReadScope1] = useState(readScope1Key);
  // Reconcile scope before committing children, so previous-scope records cannot flash.
  if (readScope1 !== readScope1Key) {
    setReadScope1(readScope1Key);
    setLoading(true);
    setData(null);
    setDetail(null);
    setOverview(null);
  }
  useEffect(() => {
    const seq = ++generation.current;
    if (!org) return;
    Promise.all([
      workApi.units(org),
      workApi.list({
        organizationId: org,
        view,
        page,
        search: filter,
        unitId: scopeUnit || undefined,
      }),
      selected ? workApi.detail(org, selected) : Promise.resolve(null),
      selected
        ? Promise.resolve(null)
        : workApi.overview(org, scopeUnit || undefined),
    ])
      .then(([u, list, d, summary]) => {
        if (seq === generation.current) {
          setUnits(u);
          setData(list);
          setDetail(d);
          setOverview(summary);
        }
      })
      .catch((e) => {
        if (seq === generation.current) {
          setError(failure(e));
          setData(null);
          setDetail(null);
          setOverview(null);
        }
      })
      .finally(() => {
        if (seq === generation.current) setLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [org, view, page, filter, selected, revision, scopeUnit]);
  useEffect(() => {
    const onRealtime = (event: Event) => {
      const sig = (event as CustomEvent<RealtimeSignal>).detail;
      if (
        sig?.topic === "work" &&
        !lock.current &&
        !editing &&
        !action &&
        !pending &&
        (!sig.organizationId || sig.organizationId === org)
      ) {
        setRevision((r) => r + 1);
      }
    };
    window.addEventListener(REALTIME_EVENT, onRealtime);
    return () => window.removeEventListener(REALTIME_EVENT, onRealtime);
  }, [org, editing, action, pending]);
  async function send(input: WorkWrite) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setPending(input);
    setError("");
    setNotice("");
    try {
      if (demo) await demoApi.stepUp();
      const result = await workApi.write(input);
      setPending(null);
      setEditing(null);
      setAction(null);
      setSelected(result.id);
      setRevision((x) => x + 1);
      setNotice(t("ცვლილება შენახულია.", "Change saved."));
      window.dispatchEvent(new Event("ertad-work-changed"));
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      if (status && status >= 400 && status < 500) {
        setPending(null);
        if (status === 403 || status === 409) {
          setDetail(null);
          setAction(null);
          setEditing(null);
          setRevision((x) => x + 1);
        }
      }
      setError(failure(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function begin(mode: "create" | "delegate", template?: WorkDetail | null) {
    setRoleNeed("");
    setAction(null);
    setEditing(mode);
    setError("");
    const source = mode === "delegate" ? detail : template;
    setSelected("");
    setDraft({
      unitId:
        mode === "delegate"
          ? (units.find((u) => u.parentId === detail?.unitId && u.canCreate)
              ?.id ?? "")
          : template && units.some((u) => u.id === template.unitId && u.canCreate)
            ? template.unitId
            : (units.find((u) => u.canCreate)?.id ?? ""),
      title: source
        ? mode === "create"
          ? `${source.title} (${t("ასლი", "Copy")})`
          : source.title
        : "",
      description: source?.description ?? "",
      roleLabel: source?.roleLabel ?? t("მონაწილე", "Participant"),
      contributionRuleId:
        source?.contributionOffer?.ruleId ?? null,
      location: source?.location ?? "",
      startsAt:
        mode === "delegate" && detail?.startsAt
          ? new Date(
              new Date(detail.startsAt).getTime() -
                new Date(detail.startsAt).getTimezoneOffset() * 60000,
            )
              .toISOString()
              .slice(0, 16)
          : "",
      priority: source?.priority ?? "normal",
      capacity: source?.capacity ?? 1,
      deadline:
        mode === "delegate" && detail
          ? new Date(
              new Date(detail.deadline).getTime() -
                new Date(detail.deadline).getTimezoneOffset() * 60000,
            )
              .toISOString()
              .slice(0, 16)
          : "",
    });
  }
  function choose(operation: WorkAction, memberId?: string) {
    setEditing(null);
    setAction({ operation, memberId });
    setNote("");
    setRoleNeed("");
    setAmount(operation === "accept" ? (detail?.capacity ?? 1) : 0);
  }
  function saveDefinition(e: FormEvent) {
    e.preventDefault();
    if (!editing || !draft.deadline) return;
    const definition = {
      ...draft,
      deadline: new Date(draft.deadline).toISOString(),
      startsAt: draft.startsAt ? new Date(draft.startsAt).toISOString() : null,
    };
    if (editing === "delegate" && detail)
      void send({
        organizationId: org,
        key: crypto.randomUUID(),
        operation: "delegate",
        ...(roleNeed ? { needId: roleNeed } : {}),
        id: detail.id,
        version: detail.version,
        note: "",
        ...definition,
      });
    else
      void send({
        organizationId: org,
        key: crypto.randomUUID(),
        operation: "create",
        ...definition,
      });
  }
  const open = detail?.status === "open",
    active = detail?.status === "open" || detail?.status === "offered",
    expired = !!detail && new Date(detail.deadline).getTime() <= now;
  const actionButton = (op: WorkAction, memberId?: string) => (
    <Button
      key={op}
      type="button"
      size="sm"
      variant="secondary"
      disabled={locked}
      onClick={() => choose(op, memberId)}
    >
      {label(op)}
    </Button>
  );
  function rows(items: WorkItem[]) {
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th className="p-3">{t("დავალება", "Task")}</th>
              <th className="p-3">{t("ერთეული", "Unit")}</th>
              <th className="p-3">{t("სტატუსი", "Status")}</th>
              <th className="p-3">{t("კონტროლი", "Oversight")}</th>
              <th className="p-3">{t("ადგილები", "Capacity")}</th>
              <th className="p-3">{t("ვადა", "Deadline")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((w) => (
              <tr key={w.id} className="border-t border-gray-200">
                <td className="p-3">
                  <Button
                    variant="ghost"
                    disabled={locked}
                    onClick={() => {
                      setSelected(w.id);
                      setEditing(null);
                      setAction(null);
                      setError("");
                    }}
                  >
                    {w.title}
                    {w.unread > 0 && ` (${w.unread})`}
                  </Button>
                </td>
                <td className="p-3">{w.unitName}</td>
                <td className="p-3">{label(w.status)}</td>
                <td className="p-3">
                  <span>{w.coordinatorId ? person(w.coordinatorId) : "—"}</span>
                  <br />
                  {w.verifiedProgress != null ? (
                    <span>
                      {t("დადასტურებული", "Verified")}: {w.verifiedProgress}%
                    </span>
                  ) : (
                    <span>—</span>
                  )}
                  {!!w.blockers && (
                    <p>
                      {t("შეფერხებები", "Blockers")}: {w.blockers}
                    </p>
                  )}
                </td>
                <td className="p-3">
                  {w.used}/{w.capacity}
                </td>
                <td className="p-3">
                  {new Date(w.deadline).toLocaleString(ka ? "ka-GE" : "en-GB", {
                    hour12: false,
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const selectedReward = units
    .find((u) => u.id === draft.unitId)
    ?.rewardOptions?.find((r) => r.id === draft.contributionRuleId);
  return (
    <div className="review-page task-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {t("დავალებები", "Tasks")}
          </h1>
          <p className="text-gray-600">
            {t(
              "შექმნა, იერარქიული გადაცემა და დადასტურებული შესრულება.",
              "Create, delegate through the hierarchy and verify completion.",
            )}
          </p>
        </div>
        {units.some((u) => u.canCreate) && (
          <Button
            disabled={locked || loading || editing === "edit"}
            onClick={() => begin("create")}
          >
            <Plus size={18} />
            {t("ახალი დავალება", "New task")}
          </Button>
        )}
      </div>
      {error && (
        <div role="alert" className="text-red-600">
          {error}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {pending && (
        <Card>
          <p>
            {t(
              "მოთხოვნის პასუხი მოლოდინშია. განმეორება დუბლიკატს არ შექმნის.",
              "The request is awaiting confirmation. Retrying will not create a duplicate.",
            )}
          </p>
          <Button disabled={busy} onClick={() => void send(pending)}>
            {t("ხელახლა ცდა", "Retry request")}
          </Button>
        </Card>
      )}
      {contexts?.length === 0 && !error && (
        <Card>
          {t(
            "დავალებებზე წვდომა ჯერ არ გაქვს.",
            "You do not have task access yet.",
          )}
        </Card>
      )}
      {editing === "edit" && detail && (
        <TaskDefinitionEditor
          detail={detail}
          organizationId={org}
          locked={locked}
          onWrite={send}
          onCancel={() => setEditing(null)}
        />
      )}
      {editing && editing !== "edit" && (
        <Card>
          <h2 className="text-xl font-semibold mb-4">
            {editing === "create"
              ? t("დავალების შექმნა", "Create task")
              : t("დავალების გადაცემა", "Delegate task")}
          </h2>
          <form onSubmit={saveDefinition} className="space-y-4">
            <fieldset disabled={locked} className="space-y-4">
              {editing === "delegate" &&
                detail?.needs?.some(
                  (n) => n.kind === "people" && !n.cancelled,
                ) && (
                  <Select
                    label={t("გადასაცემი როლი", "Delegated role")}
                    required
                    value={roleNeed}
                    onChange={(e) => setRoleNeed(e.target.value)}
                    options={[
                      { value: "", label: t("აირჩიეთ როლი", "Choose a role") },
                      ...detail.needs
                        .filter((n) => n.kind === "people" && !n.cancelled)
                        .map((n) => ({ value: n.id, label: n.title })),
                    ]}
                  />
                )}
              <Select
                label={t("პასუხისმგებელი ერთეული", "Responsible unit")}
                required
                value={draft.unitId}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    unitId: e.target.value,
                    contributionRuleId:
                      editing === "delegate" ? draft.contributionRuleId : null,
                  })
                }
                options={[
                  { value: "", label: t("აირჩიე ერთეული", "Choose a unit") },
                  ...units
                    .filter(
                      (u) =>
                        u.canCreate &&
                        (editing === "create" || u.parentId === detail?.unitId),
                    )
                    .map((u) => ({ value: u.id, label: u.name })),
                ]}
              />
              <Input
                label={t("სათაური", "Title")}
                required
                minLength={3}
                maxLength={160}
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
              <Textarea
                label={t(
                  "აღწერა და მოსალოდნელი შედეგი",
                  "Description and expected outcome",
                )}
                maxLength={3000}
                value={draft.description}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
              />
              <Input
                label={t(
                  "შეხვედრის ადგილი (არასავალდებულო)",
                  "Meeting place (optional)",
                )}
                maxLength={300}
                value={draft.location ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, location: e.target.value })
                }
              />
              <Input
                label={t(
                  "დაწყების დრო (არასავალდებულო)",
                  "Start time (optional)",
                )}
                type="datetime-local"
                max={draft.deadline || undefined}
                value={draft.startsAt ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, startsAt: e.target.value })
                }
              />
              {editing === "create" ? (
                <>
                  <ParticipationReward key={draft.unitId} label={t("მონაწილეობის ჯილდო", "Participation reward")}
                    value={draft.contributionRuleId ?? null}
                    onChange={contributionRuleId => setDraft({...draft, contributionRuleId})}
                    options={units.find(u => u.id === draft.unitId)?.rewardOptions ?? []} />
                  <p className="text-sm">
                    {t(
                      "ქულები ჩაირიცხება მხოლოდ დამოუკიდებლად დადასტურებული შესრულებისთვის, მოქმედი თვიური ზღვრის ფარგლებში.",
                      "Points are awarded only after independent confirmation, within the applicable monthly cap.",
                    )}
                    {selectedReward && (
                      <>
                        {" "}
                        {t("წევრის თვიური ზღვარი", "Member monthly cap")}:{" "}
                        {selectedReward.memberMonthCap}.
                      </>
                    )}
                  </p>
                </>
              ) : (
                <p>
                  {t(
                    "გადაცემულ დავალებას ზედა დავალების ჯილდოს პირობები უნარჩუნდება.",
                    "Delegated work keeps the parent task's reward offer.",
                  )}
                </p>
              )}
              <details className="border rounded-lg p-3">
                <summary className="cursor-pointer py-2">
                  {t("დამატებითი პარამეტრები", "Additional options")}
                </summary>
                <Input
                  label={t("მონაწილის როლი", "Participant role")}
                  required
                  maxLength={100}
                  value={draft.roleLabel}
                  onChange={(e) =>
                    setDraft({ ...draft, roleLabel: e.target.value })
                  }
                />
                <Select
                  label={t("პრიორიტეტი", "Priority")}
                  value={draft.priority}
                  options={["low", "normal", "high", "urgent"].map((p) => ({
                    value: p,
                    label: label(p),
                  }))}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      priority: e.target.value as WorkDefinition["priority"],
                    })
                  }
                />
              </details>
              <div className="grid gap-4 md:grid-cols-3">
                <Input
                  label={t("ადგილების რაოდენობა", "Number of places")}
                  type="number"
                  min={1}
                  max={
                    editing === "delegate" && detail
                      ? detail.capacity - detail.used
                      : 100
                  }
                  required
                  value={draft.capacity}
                  onChange={(e) =>
                    setDraft({ ...draft, capacity: Number(e.target.value) })
                  }
                />
                <Input
                  label={t("დასრულების ვადა", "Deadline")}
                  type="datetime-local"
                  required
                  value={draft.deadline}
                  onChange={(e) =>
                    setDraft({ ...draft, deadline: e.target.value })
                  }
                />
              </div>
              <p className="text-sm text-gray-600">
                {t(
                  "წევრები ჯერ თავად გამოთქვამენ მონაწილეობის სურვილს. დანიშვნას ხელმძღვანელი ადასტურებს.",
                  "Members volunteer first. A manager then assigns available places.",
                )}
              </p>
              <div className="flex gap-3">
                <Button type="submit">{t("შენახვა", "Save task")}</Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setEditing(null)}
                >
                  {t("დახურვა", "Dismiss")}
                </Button>
              </div>
            </fieldset>
          </form>
        </Card>
      )}
      {loading && <p role="status">{t("იტვირთება…", "Loading…")}</p>}
      {detail && !editing && (
        <>
          <Button
            variant="ghost"
            disabled={locked}
            onClick={() => {
              setSelected("");
              setAction(null);
            }}
          >
            <ArrowLeft size={18} />
            {t("სიაში დაბრუნება", "Back to list")}
          </Button>
          <Card>
            <div className="flex flex-wrap justify-between gap-3">
              <h2 className="text-xl font-bold">{detail.title}</h2>
              <span>
                {label(detail.status)} · {label(detail.priority)}
              </span>
            </div>
            <TaskConversation
              key={detail.id}
              organizationId={org}
              workId={detail.id}
              version={detail.version}
              demo={demo}
              disabled={locked}
            />
            {detail.contributionOffer && (
              <p className="mt-3">
                {t(
                  "დადასტურებული მონაწილეობისთვის ქულები",
                  "Points for verified participation",
                )}
                : {detail.contributionOffer.amount} ·{" "}
                {detail.contributionOffer.title} ·{" "}
                {t("თვიური ზღვარი", "Monthly cap")}:{" "}
                {detail.contributionOffer.memberMonthCap}
              </p>
            )}
            {!detail.contributionOffer && (
              <p className="mt-3">
                {t(
                  "ამ დავალებაზე ავტომატური ქულები გათვალისწინებული არ არის.",
                  "This task has no automatic points award.",
                )}
              </p>
            )}
            <TaskMaterials
              key={detail.id + "-materials-" + detail.version}
              detail={detail}
              organizationId={org}
              locked={locked}
              onWrite={send}
            />
            <TaskEvidence
              key={detail.id + "-material-files"}
              organizationId={org}
              workId={detail.id}
              version={detail.version}
              disabled={locked}
              material
            />
            <TaskEvidence
              key={detail.id + "-evidence"}
              organizationId={org}
              workId={detail.id}
              version={detail.version}
              disabled={locked}
            />
            <p className="mt-3 whitespace-pre-wrap break-words">
              {detail.description}
            </p>
            {detail.event && (
              <p className="mt-3 rounded-lg border border-gray-200 p-3 break-words">
                {t("ღონისძიება", "Event")}: {detail.event.title}.{" "}
                {t(
                  "ამ ღონისძიებაში ავტომატური ჯილდო ერთხელ ენიჭება თითო წევრს, პირველი დადასტურებული შესრულებისთვის. დამატებითი დავალებები ქულებს არ ამატებს.",
                  "This event awards each member once, on the first verified completion. Additional tasks do not add points.",
                )}
              </p>
            )}
            <p className="mt-3 text-gray-600">
              {detail.unitName} · {detail.roleLabel}
            </p>
            {detail.location && (
              <p className="break-words">
                {t("შეხვედრის ადგილი", "Meeting place")}: {detail.location}
              </p>
            )}
            {detail.startsAt && (
              <p>
                {t("დაწყება", "Starts")}:{" "}
                {new Date(detail.startsAt).toLocaleString(
                  ka ? "ka-GE" : "en-GB",
                  { hour12: false },
                )}
              </p>
            )}
            <p>
              {t("ვადა", "Deadline")}:{" "}
              {new Date(detail.deadline).toLocaleString(
                ka ? "ka-GE" : "en-GB",
                { hour12: false },
              )}
              {expired && active && (
                <strong className="text-red-600">
                  {" "}
                  · {t("დაგვიანებულია", "Overdue")}
                </strong>
              )}
            </p>
            <p>
              {t("გამოყოფილი ადგილები", "Allocated places")}: {detail.used}/
              {detail.capacity} ·{" "}
              {t("აქ დადასტურებული შესრულება", "Verified here")}:{" "}
              {detail.verified}
            </p>
            <div className="flex flex-wrap gap-2 mt-4">
              {detail.canManage && open && (
                <Button
                  variant="secondary"
                  disabled={locked}
                  onClick={() => {
                    setAction(null);
                    setError("");
                    setEditing("edit");
                  }}
                >
                  {t("დავალების რედაქტირება", "Edit task")}
                </Button>
              )}
              {units.some((u) => u.canCreate) && (
                <Button
                  variant="secondary"
                  disabled={locked}
                  onClick={() => begin("create", detail)}
                >
                  <Copy size={16} aria-hidden="true" />
                  {t("დუბლირება", "Duplicate task")}
                </Button>
              )}
              {detail.canManage &&
                detail.status === "offered" &&
                !expired &&
                actionButton("accept")}
              {detail.canManage &&
                detail.status === "offered" &&
                actionButton("decline")}
              {detail.canManage &&
                open &&
                !expired &&
                detail.used < detail.capacity &&
                units.some(
                  (u) => u.parentId === detail.unitId && u.canCreate,
                ) && (
                  <Button
                    variant="secondary"
                    disabled={locked}
                    onClick={() => begin("delegate")}
                  >
                    {label("delegate")}
                  </Button>
                )}
              {detail.canManage && open && actionButton("complete")}
              {detail.canManage && active && actionButton("cancel")}
              {detail.canParticipate &&
                open &&
                !expired &&
                !detail.assignments.some(
                  (a) => a.memberId === detail.actorId,
                ) &&
                actionButton("apply")}
              {!!detail.unread && (
                <Button
                  variant="ghost"
                  disabled={locked}
                  onClick={() => {
                    void workApi
                      .ack(org, detail.id, detail.version)
                      .then(() => {
                        setRevision((x) => x + 1);
                        window.dispatchEvent(new Event("ertad-inbox-changed"));
                      })
                      .catch((e) => setError(failure(e)));
                  }}
                >
                  {t("წაკითხულად მონიშვნა", "Mark read")}
                </Button>
              )}
              <Button
                variant="ghost"
                disabled={locked}
                onClick={() => {
                  setAction(null);
                  setRevision((x) => x + 1);
                }}
              >
                {t("განახლება", "Refresh")}
              </Button>
            </div>
          </Card>
          {detail.criteria && (
            <details
              key={detail.id + "-oversight"}
              open={!!detail.criteria.length || !!detail.blockers}
              className="space-y-3"
            >
              <summary className="cursor-pointer py-3">
                {t("კრიტერიუმები და დაბრკოლებები", "Criteria and blockers")}
              </summary>
              <WorkOversight
                key={detail.id + ":" + detail.version}
                detail={detail}
                organizationId={org}
                locked={locked}
                person={person}
                onWrite={send}
              />
            </details>
          )}
          {detail.needs && (
            <details
              key={detail.id + "-needs"}
              open={!!detail.needs.length}
              className="space-y-3"
            >
              <summary className="cursor-pointer py-3">
                {t(
                  "დამატებითი როლები და რესურსები",
                  "Additional roles and resources",
                )}
              </summary>
              <WorkNeeds
                key={"needs:" + detail.id + ":" + detail.version}
                detail={detail}
                organizationId={org}
                locked={locked}
                person={person}
                onWrite={send}
              />
            </details>
          )}
          {detail.needs && (
            <details key={detail.id + "-funding"} className="space-y-3">
              <summary className="cursor-pointer py-3">
                {t(
                  "დაფინანსება (საჭიროების შემთხვევაში)",
                  "Funding (when needed)",
                )}
              </summary>
              <WorkFunding
                key={"funding:" + detail.id}
                detail={detail}
                organizationId={org}
                demo={demo}
                people={people}
              />
            </details>
          )}
          {action && (
            <Card>
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send({
                    organizationId: org,
                    key: crypto.randomUUID(),
                    id: detail.id,
                    version: detail.version,
                    ...action,
                    note,
                    ...(action.operation === "apply" && roleNeed
                      ? { needId: roleNeed }
                      : {}),
                    ...(action.operation === "accept"
                      ? { capacity: amount }
                      : action.operation === "progress"
                        ? { progress: amount }
                        : {}),
                  });
                }}
              >
                <fieldset disabled={locked} className="space-y-4">
                  <h3 className="text-lg font-semibold">
                    {label(action.operation)}
                    {action.memberId && ` · ${person(action.memberId)}`}
                  </h3>
                  {action.operation === "apply" &&
                    detail.needs?.some(
                      (n) => n.kind === "people" && !n.cancelled,
                    ) && (
                      <Select
                        label={t("სასურველი როლი", "Requested role")}
                        required
                        value={roleNeed}
                        onChange={(e) => setRoleNeed(e.target.value)}
                        options={[
                          {
                            value: "",
                            label: t("აირჩიეთ როლი", "Choose a role"),
                          },
                          ...detail.needs
                            .filter((n) => n.kind === "people" && !n.cancelled)
                            .map((n) => ({ value: n.id, label: n.title })),
                        ]}
                      />
                    )}
                  {action.operation === "verify" && (
                    <p>
                      {t(
                        "დაადასტურე მხოლოდ შემოწმებული შესრულება. შეიქმნება უცვლელი აქტივობის ჩანაწერი.",
                        "Verify only checked completion. This creates an immutable Activity entry.",
                      )}
                    </p>
                  )}
                  {["accept", "progress"].includes(action.operation) && (
                    <Input
                      type="number"
                      label={
                        action.operation === "accept"
                          ? t("მისაღები ადგილები", "Accepted places")
                          : t("პროგრესი (%)", "Progress (%)")
                      }
                      required
                      min={action.operation === "accept" ? 1 : 0}
                      max={
                        action.operation === "accept" ? detail.capacity : 100
                      }
                      value={amount}
                      onChange={(e) => setAmount(Number(e.target.value))}
                    />
                  )}
                  <Textarea
                    label={t("შენიშვნა / მიზეზი", "Note / reason")}
                    required={[
                      "decline",
                      "cancel",
                      "reject",
                      "return",
                      "no_show",
                      "progress",
                    ].includes(action.operation)}
                    minLength={
                      [
                        "decline",
                        "cancel",
                        "reject",
                        "return",
                        "no_show",
                        "progress",
                      ].includes(action.operation)
                        ? 3
                        : undefined
                    }
                    maxLength={1000}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <div className="flex gap-3">
                    <Button type="submit">
                      {t("დადასტურება", "Confirm action")}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setAction(null)}
                    >
                      {t("დახურვა", "Dismiss")}
                    </Button>
                  </div>
                </fieldset>
              </form>
            </Card>
          )}
          <Card>
            <h3 className="text-lg font-semibold mb-3">
              {t("მონაწილეები და პროგრესი", "Participants and progress")}
            </h3>
            {!detail.assignments.length ? (
              <p>
                {t(
                  "მონაწილეობის სურვილი ჯერ არავის დაუფიქსირებია.",
                  "No volunteers yet.",
                )}
              </p>
            ) : (
              detail.assignments.map((a) => (
                <div
                  key={a.memberId}
                  className="border-t border-gray-200 py-4 space-y-2"
                >
                  <div className="flex flex-wrap justify-between gap-2">
                    <strong>{person(a.memberId)}</strong>
                    <span>
                      {label(a.status)} · {a.progress}%
                    </span>
                  </div>
                  <progress
                    aria-label={person(a.memberId)}
                    className="w-full"
                    max={100}
                    value={a.progress}
                  />
                  {a.reviewRoute && a.status !== "verified" && (
                    <p className="text-sm text-gray-600">
                      {a.reviewRoute === "higher"
                        ? t(
                            "ადასტურებს ზედა იერარქიის დამოუკიდებელი შემმოწმებელი",
                            "Confirmed by an independent reviewer in the upper hierarchy",
                          )
                        : t(
                            "ადასტურებს ამ ერთეულის უფლებამოსილი დამოუკიდებელი შემმოწმებელი",
                            "Confirmed by an authorized independent reviewer for this unit",
                          )}
                      {a.reviewUnitName ? ` · ${a.reviewUnitName}` : ""}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {open &&
                      detail.canManage &&
                      !expired &&
                      ["applied", "reserved"].includes(a.status) &&
                      actionButton("assign", a.memberId)}
                    {open &&
                      detail.canManage &&
                      !expired &&
                      a.status === "applied" &&
                      actionButton("reserve", a.memberId)}
                    {open &&
                      detail.canManage &&
                      ["applied", "reserved"].includes(a.status) &&
                      actionButton("reject", a.memberId)}
                    {open &&
                      detail.canManage &&
                      ["assigned", "in_progress"].includes(a.status) &&
                      actionButton("no_show", a.memberId)}
                    {open &&
                      a.canReview === true &&
                      a.status === "submitted" &&
                      a.memberId !== detail.actorId &&
                      actionButton("verify", a.memberId)}
                    {open &&
                      a.canReview === true &&
                      a.status === "submitted" &&
                      actionButton("return", a.memberId)}
                    {open &&
                      detail.canParticipate &&
                      a.memberId === detail.actorId && (
                        <>
                          {a.status === "assigned" && actionButton("start")}
                          {a.status === "in_progress" && (
                            <>
                              {actionButton("progress")}
                              {actionButton("submit")}
                            </>
                          )}
                          {[
                            "applied",
                            "reserved",
                            "assigned",
                            "in_progress",
                            "submitted",
                          ].includes(a.status) && actionButton("withdraw")}
                        </>
                      )}
                  </div>
                </div>
              ))
            )}
          </Card>
          <TaskRecognition
            key={`${org}:${detail.id}`}
            organizationId={org}
            workId={detail.id}
            version={detail.version}
            demo={demo}
            people={people}
          />
          {!!detail.children.length && (
            <Card>
              <h3 className="text-lg font-semibold mb-3">
                {t("ქვედა ერთეულებზე გადაცემული", "Delegated work")}
              </h3>
              {rows(detail.children)}
            </Card>
          )}
          <Card>
            <h3 className="text-lg font-semibold mb-3">
              {t("მოძრაობის ისტორია", "Movement history")}
            </h3>
            <p className="text-sm text-gray-600">
              {t(
                "ბოლო 100 ჩანაწერი. მონაწილე ხედავს საკუთარ და დავალების საერთო მოვლენებს.",
                "Latest 100 events. Participants see their own and shared task events.",
              )}
            </p>
            <ol className="space-y-3 mt-4">
              {detail.events.map((e) => (
                <li key={e.version} className="border-t border-gray-200 pt-3">
                  <strong>{label(e.action)}</strong> · {person(e.actorId)} ·{" "}
                  {e.details?.title && <span>{e.details.title} · </span>}
                  {e.details?.coordinatorId && (
                    <span>{person(e.details.coordinatorId)} · </span>
                  )}
                  <time dateTime={e.at}>
                    {new Date(e.at).toLocaleString(ka ? "ka-GE" : "en-GB", {
                      hour12: false,
                    })}
                  </time>
                  {e.subjectId && <span> · {person(e.subjectId)}</span>}
                  {e.progress !== null && <span> · {e.progress}%</span>}
                  {e.note && (
                    <p className="whitespace-pre-wrap break-words">{e.note}</p>
                  )}
                  {e.action === "edit" &&
                    e.details?.before &&
                    e.details?.after && (
                      <TaskDefinitionChanges
                        before={e.details.before}
                        after={e.details.after}
                      />
                    )}
                </li>
              ))}
            </ol>
          </Card>
        </>
      )}
      {!selected && !editing && org && (
        <>
          {overview && <WorkOverviewStats data={overview} />}
          <Select
            label={t("ერთეული და მისი დაქვემდებარება", "Unit and descendants")}
            value={scopeUnit}
            onChange={(e) => {
              setScopeUnit(e.target.value);
              setPage(1);
            }}
            options={[
              {
                value: "",
                label: t("ყველა ხელმისაწვდომი ერთეული", "All permitted units"),
              },
              ...units.map((u) => ({ value: u.id, label: u.name })),
            ]}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div
              className="review-tabs"
              aria-label={t("დავალებების ფილტრები", "Task filters")}
            >
              {[
                "open",
                "offered",
                "blocked",
                "overdue",
                "needs_review",
                "shortfalls",
                "mine",
                "inbox",
                "completed",
                "cancelled",
              ].map((v) => (
                <Button
                  key={v}
                  variant={view === v ? "primary" : "secondary"}
                  aria-pressed={view === v}
                  aria-current={view === v ? "page" : undefined}
                  onClick={() => {
                    setView(v);
                    setPage(1);
                  }}
                >
                  {label(v)}
                </Button>
              ))}
            </div>
            <div
              className="task-display-toggle"
              role="group"
              aria-label={t("ჩვენების რეჟიმი", "Display layout")}
            >
              <Button
                type="button"
                size="sm"
                variant={displayMode === "list" ? "primary" : "secondary"}
                aria-pressed={displayMode === "list"}
                onClick={() => setDisplayMode("list")}
              >
                <List size={15} aria-hidden="true" />
                {t("ცხრილი", "List")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={displayMode === "board" ? "primary" : "secondary"}
                aria-pressed={displayMode === "board"}
                onClick={() => setDisplayMode("board")}
              >
                <Kanban size={15} aria-hidden="true" />
                {t("დაფა", "Board")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={displayMode === "timeline" ? "primary" : "secondary"}
                aria-pressed={displayMode === "timeline"}
                onClick={() => setDisplayMode("timeline")}
              >
                <CalendarRange size={15} aria-hidden="true" />
                {t("ვადები", "Timeline")}
              </Button>
            </div>
          </div>
          <form
            className="flex items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              setFilter(search);
              setPage(1);
            }}
          >
            <Input
              label={t("დავალების ძებნა", "Search tasks")}
              maxLength={80}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Button type="submit" variant="secondary">
              {t("ძებნა", "Search")}
            </Button>
            {workApi.report && (
              <Button
                type="button"
                variant="secondary"
                disabled={locked}
                onClick={() => {
                  const reportView = [
                    "open",
                    "offered",
                    "completed",
                    "cancelled",
                    "blocked",
                    "overdue",
                    "needs_review",
                    "shortfalls",
                  ].includes(view)
                    ? view
                    : "all";
                  void workApi
                    .report({
                      organizationId: org,
                      view: reportView,
                      search: filter,
                      ...(scopeUnit ? { unitId: scopeUnit } : {}),
                    })
                    .then((report) => {
                      downloadSafeCsv(
                        `ertad-tasks-${reportView}.csv`,
                        [
                          "Title",
                          "Unit",
                          "Status",
                          "Priority",
                          "Capacity",
                          "Used",
                          "Verified",
                          "Overdue",
                          "Blocked",
                          "Shortfalls",
                          "Deadline",
                        ],
                        report.items.map((item) => [
                          item.title,
                          item.unitName,
                          item.status,
                          item.priority,
                          item.capacity,
                          item.used,
                          item.verified,
                          item.overdue ? "yes" : "no",
                          item.blocked ? "yes" : "no",
                          item.shortfalls,
                          item.deadline,
                        ]),
                      );
                      setNotice(
                        report.truncated
                          ? t(
                              "ექსპორტირებულია პირველი 250 ჩანაწერი (პირადი მონაცემების გარეშე).",
                              "Exported the first 250 task records without personal data.",
                            )
                          : t(
                              "სამუშაო ანგარიში ჩამოიტვირთა პირადი მონაცემების გარეშე.",
                              "Privacy-safe task report downloaded.",
                            ),
                      );
                    })
                    .catch((e) => setError(failure(e)));
                }}
              >
                <Download size={16} aria-hidden="true" />
                {t("ანგარიშის ექსპორტი", "Export report")}
              </Button>
            )}
          </form>
          {data && (
            <Card>
              {!data.items.length ? (
                <div className="py-8 text-center">
                  <ClipboardList className="mx-auto mb-3" />
                  <p>
                    {t(
                      "ამ ფილტრით დავალებები არ მოიძებნა.",
                      "No tasks match this filter.",
                    )}
                  </p>
                </div>
              ) : displayMode === "board" ? (
                <div className="task-board-grid" aria-label={t("კანბანის დაფა", "Task board")}>
                  {[
                    {
                      key: "offered",
                      heading: t("მისაღები", "Offered"),
                      items: data.items.filter((w) => w.status === "offered"),
                    },
                    {
                      key: "active",
                      heading: t("აქტიური", "Active"),
                      items: data.items.filter(
                        (w) =>
                          w.status === "open" &&
                          !(w.pendingReview && w.pendingReview > 0) &&
                          !(w.blockers && w.blockers > 0),
                      ),
                    },
                    {
                      key: "attention",
                      heading: t("განხილვა / შეფერხება", "Review & Blocked"),
                      items: data.items.filter(
                        (w) =>
                          w.status === "open" &&
                          ((w.pendingReview && w.pendingReview > 0) ||
                            (w.blockers && w.blockers > 0)),
                      ),
                    },
                    {
                      key: "done",
                      heading: t("დასრულებული / გაუქმებული", "Closed"),
                      items: data.items.filter((w) =>
                        ["completed", "cancelled"].includes(w.status),
                      ),
                    },
                  ].map((col) => (
                    <div key={col.key} className="task-board-column">
                      <h3 className="text-sm font-semibold mb-2">
                        {col.heading} ({col.items.length})
                      </h3>
                      <div className="space-y-2">
                        {col.items.map((w) => (
                          <div key={w.id} className="task-board-card">
                            <div className="flex items-center justify-between gap-2 text-xs">
                              <span className="status-badge" data-status={w.priority === "urgent" ? "rejected" : "pending"}>
                                {label(w.priority)}
                              </span>
                              <small>{w.used}/{w.capacity}</small>
                            </div>
                            <strong className="block text-sm mt-1 break-words">{w.title}</strong>
                            <small className="block text-xs mt-1">{w.unitName}</small>
                            <small className="block text-xs mt-1">
                              {new Date(w.deadline).toLocaleString(ka ? "ka-GE" : "en-GB", { hour12: false })}
                            </small>
                            <div className="mt-2">
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={locked}
                                onClick={() => {
                                  setSelected(w.id);
                                  setEditing(null);
                                  setAction(null);
                                  setError("");
                                }}
                              >
                                {t("გახსნა", "Open")}
                              </Button>
                            </div>
                          </div>
                        ))}
                        {!col.items.length && (
                          <p className="text-xs opacity-60">{t("ცარიელია", "Empty")}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : displayMode === "timeline" ? (
                <div className="task-timeline-list space-y-3" aria-label={t("ვადების განრიგი", "Timeline view")}>
                  {[...data.items]
                    .sort(
                      (a, b) =>
                        new Date(a.deadline).getTime() - new Date(b.deadline).getTime(),
                    )
                    .map((w) => {
                      const dl = new Date(w.deadline).getTime();
                      const isOverdue = dl <= now && ["open", "offered"].includes(w.status);
                      const isSoon = !isOverdue && dl - now <= 48 * 3600_000;
                      return (
                        <div key={w.id} className="task-timeline-row">
                          <div className="min-w-0">
                            <span
                              className="status-badge"
                              data-status={
                                isOverdue
                                  ? "rejected"
                                  : isSoon
                                    ? "pending"
                                    : "approved"
                              }
                            >
                              {isOverdue
                                ? t("ვადაგადაცილებული", "Overdue")
                                : isSoon
                                  ? t("48 სთ-ში", "Due within 48h")
                                  : label(w.status)}
                            </span>
                            <strong className="ml-2 break-words">{w.title}</strong>
                            <p className="text-xs opacity-75 mt-1">
                              {w.unitName} · {w.used}/{w.capacity} ·{" "}
                              {new Date(w.deadline).toLocaleString(ka ? "ka-GE" : "en-GB", {
                                hour12: false,
                              })}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={locked}
                            onClick={() => {
                              setSelected(w.id);
                              setEditing(null);
                              setAction(null);
                              setError("");
                            }}
                          >
                            {t("გახსნა", "Open")}
                          </Button>
                        </div>
                      );
                    })}
                </div>
              ) : (
                rows(data.items)
              )}
              <div className="flex justify-between items-center gap-3 mt-4">
                <Button
                  variant="ghost"
                  disabled={page === 1 || loading}
                  onClick={() => setPage((p) => p - 1)}
                >
                  {t("წინა", "Previous")}
                </Button>
                <span>
                  {page} · {t("სულ", "Total")}: {data.total}
                </span>
                <Button
                  variant="ghost"
                  disabled={page * 25 >= data.total || loading}
                  onClick={() => setPage((p) => p + 1)}
                >
                  {t("შემდეგი", "Next")}
                </Button>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
