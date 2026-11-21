import ParticipationReward from "../components/ParticipationReward";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { CalendarDays, CalendarPlus, CheckCircle2, Copy, Plus } from "lucide-react";
import { eventsApi, type EventDetail, type EventWrite } from "../api/events";
import { downloadEventIcs } from "../utils/ics";
import { REALTIME_EVENT, type RealtimeSignal } from "../api/realtime";
import { workApi, type WorkUnit, type WorkWrite } from "../api/work";
import { demoApi } from "../api/demo";
import { useConsolePreferences } from "../components/useConsolePreferences";
import { useInboxTarget } from "../components/useInboxTarget";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import Select from "../components/ui/Select";
import Textarea from "../components/ui/Textarea";

const localTime = (value: string) =>
  new Date(
    new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60000,
  )
    .toISOString()
    .slice(0, 16);
export default function Events() {
  const { language } = useConsolePreferences(),
    t = useCallback(
      (ka: string, en: string) => (language === "ka" ? ka : en),
      [language],
    );
  const navigate = useNavigate();
  const [org, setOrg] = useState(""),
    [loadedUnits, setUnits] = useState<WorkUnit[]>([]),
    [demo, setDemo] = useState(false);
  const [loadedData, setData] = useState<Awaited<
      ReturnType<typeof eventsApi.list>
    > | null>(null),
    [loadedDetail, setDetail] = useState<EventDetail | null>(null);
  const [selected, setSelected] = useState(""),
    [status, setStatus] = useState("open"),
    [page, setPage] = useState(1),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("");
  useInboxTarget("event", org, setSelected);
  const [accessLoading, setAccessLoading] = useState(true),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false),
    [revision, setRevision] = useState(0);
  const [unitsKey, setUnitsKey] = useState("");
  const [listKey, setListKey] = useState("");
  const [detailKey, setDetailKey] = useState("");
  const unitsReqKey = JSON.stringify([org, revision]);
  const listReqKey = JSON.stringify([org, page, status, filter, revision]);
  const detailReqKey = JSON.stringify([org, selected, revision]);
  const listLoading = accessLoading || (!!org && listKey !== listReqKey);
  const detailLoading = !!org && !!selected && detailKey !== detailReqKey;
  const loading = listLoading || detailLoading;
  const data = listKey === listReqKey ? loadedData : null;
  const detail = selected && detailKey === detailReqKey ? loadedDetail : null;
  const units = unitsKey === unitsReqKey ? loadedUnits : [];
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  const [mode, setMode] = useState<
    | ""
    | "event"
    | "event_edit"
    | "event_clone"
    | "task"
    | "event_complete"
    | "event_cancel"
  >("");
  const [draft, setDraft] = useState({
    unitId: "",
    title: "",
    description: "",
    location: "",
    startsAt: "",
    endsAt: "",
    rule: "",
    capacity: 1,
    capacityLimit: "",
    checkinCode: "",
    note: "",
    cancelLinkedTasks: false,
  });
  const [pending, setPending] = useState<EventWrite | WorkWrite | null>(null),
    [busy, setBusy] = useState(false);
  const lock = useRef(false),
    focus = useRef<HTMLInputElement>(null),
    locked = busy || !!pending;
  const message = useCallback(
    (e: unknown) => {
      const code = (e as { response?: { status?: number } }).response?.status;
      return code === 403
        ? t(
            "ამ მოქმედების უფლება აღარ გაქვთ.",
            "You no longer have permission for this action.",
          )
        : code === 409
          ? t(
              "მდგომარეობა შეიცვალა. ღონისძიების დახურვამდე დაასრულეთ ან გააუქმეთ დაკავშირებული დავალებები.",
              "State changed. Finish or cancel linked tasks before closing the event.",
            )
          : code === 400
            ? t("შეამოწმეთ ველები და თარიღები.", "Check the fields and dates.")
            : t(
                "შედეგი ვერ დადასტურდა. ხელახლა სცადეთ.",
                "Could not confirm the result. Please retry.",
              );
    },
    [t],
  );
  const messageRef = useRef(message);
  useEffect(() => {
    messageRef.current = message;
  }, [message]);
  useEffect(() => {
    let live = true;
    demoApi
      .scenario()
      .then(() => {
        if (live) setDemo(true);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    workApi
      .contexts()
      .then((rows) => {
        if (live) {
          setOrg(rows[0]?.id ?? "");
          setAccessLoading(false);
        }
      })
      .catch((e) => {
        if (live) {
          setError(messageRef.current(e));
          setAccessLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [revision]);
  useEffect(() => {
    if (!org) return;
    let live = true;
    workApi
      .units(org)
      .then((u) => {
        if (live) setUnits(u);
      })
      .catch((e) => {
        if (live) {
          setError(messageRef.current(e));
          setUnits([]);
        }
      })
      .finally(() => {
        if (live) setUnitsKey(unitsReqKey);
      });
    return () => {
      live = false;
    };
  }, [org, revision, unitsReqKey]);
  useEffect(() => {
    if (!org) return;
    let live = true;
    eventsApi
      .list({ organizationId: org, page, status, search: filter })
      .then((list) => {
        if (live) setData(list);
      })
      .catch((e) => {
        if (live) {
          setError(messageRef.current(e));
          setData(null);
        }
      })
      .finally(() => {
        if (live) setListKey(listReqKey);
      });
    return () => {
      live = false;
    };
  }, [org, page, status, filter, revision, listReqKey]);
  useEffect(() => {
    if (!org || !selected) return;
    let live = true;
    eventsApi
      .detail(org, selected)
      .then((event) => {
        if (live) setDetail(event);
      })
      .catch((e) => {
        if (live) {
          setError(messageRef.current(e));
          setDetail(null);
        }
      })
      .finally(() => {
        if (live) setDetailKey(detailReqKey);
      });
    return () => {
      live = false;
    };
  }, [org, selected, revision, detailReqKey]);
  useEffect(() => {
    if (mode === "event" || mode === "event_edit" || mode === "task") {
      focus.current?.focus();
    }
  }, [mode]);
  const openTask = (id: string) =>
    navigate("/tasks", {
      state: { inbox: { source: "work", organizationId: org, id } },
    });
  async function send(input: EventWrite | WorkWrite, retry = false) {
    if (lock.current || (pending && !retry)) return;
    lock.current = true;
    setBusy(true);
    setPending(structuredClone(input));
    setError("");
    setSaved(false);
    try {
      if (demo) await demoApi.stepUp();
      const result =
        input.operation === "create"
          ? await workApi.write(input)
          : await eventsApi.write(input as EventWrite);
      setPending(null);
      setMode("");
      setSaved(true);
      if (input.operation === "create") {
        openTask(result.id);
      } else {
        setSelected(result.id);
        setRevision((x) => x + 1);
      }
      window.dispatchEvent(new Event("ertad-work-changed"));
    } catch (e) {
      const code = (e as { response?: { status?: number } }).response?.status;
      if (code && code >= 400 && code < 500) {
        setPending(null);
        if (code === 403 || code === 409) {
          setMode("");
          setDetail(null);
          setRevision((x) => x + 1);
        }
      }
      setError(message(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    const onRealtime = (event: Event) => {
      const sig = (event as CustomEvent<RealtimeSignal>).detail;
      if (
        sig?.topic === "event" &&
        !lock.current &&
        !mode &&
        !pending &&
        (!sig.organizationId || sig.organizationId === org)
      ) {
        setRevision((x) => x + 1);
      }
    };
    window.addEventListener(REALTIME_EVENT, onRealtime);
    return () => window.removeEventListener(REALTIME_EVENT, onRealtime);
  }, [org, mode, pending]);
  function begin(kind: "event" | "event_edit" | "event_clone" | "task") {
    setMode(kind);
    setError("");
    setSaved(false);
    const plus7Days = (iso: string) =>
      localTime(new Date(new Date(iso).getTime() + 7 * 86_400_000).toISOString());
    setDraft({
      unitId:
        (kind === "task" || kind === "event_edit") && detail
          ? detail.unitId
          : (units.find((u) => u.canCreate)?.id ?? ""),
      title:
        (kind === "event_edit" || kind === "event_clone") && detail
          ? detail.title
          : "",
      description: kind === "event_edit" && detail ? detail.description : "",
      location:
        (kind === "task" || kind === "event_edit") && detail
          ? detail.location
          : "",
      startsAt:
        kind === "event_clone" && detail
          ? plus7Days(detail.startsAt)
          : (kind === "task" || kind === "event_edit") && detail
            ? localTime(detail.startsAt)
            : "",
      endsAt:
        kind === "event_clone" && detail
          ? plus7Days(detail.endsAt)
          : (kind === "task" || kind === "event_edit") && detail
            ? localTime(detail.endsAt)
            : "",
      rule: "",
      capacity: 1,
      capacityLimit:
        kind === "event_edit" && detail?.capacityLimit != null
          ? String(detail.capacityLimit)
          : "",
      checkinCode: "",
      note: "",
      cancelLinkedTasks: false,
    });
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    const parsedCapacityLimit = draft.capacityLimit.trim()
      ? Number(draft.capacityLimit)
      : null;
    if (mode === "event")
      void send({
        operation: "event_create",
        organizationId: org,
        key: crypto.randomUUID(),
        unitId: draft.unitId,
        title: draft.title,
        description: draft.description,
        location: draft.location,
        startsAt: new Date(draft.startsAt).toISOString(),
        endsAt: new Date(draft.endsAt).toISOString(),
        contributionRuleId: draft.rule || null,
        ...(parsedCapacityLimit !== null
          ? { capacityLimit: parsedCapacityLimit }
          : {}),
      });
    else if (mode === "event_edit" && detail)
      void send({
        operation: "event_edit",
        organizationId: org,
        key: crypto.randomUUID(),
        id: detail.id,
        version: detail.version,
        title: draft.title,
        description: draft.description,
        location: draft.location,
        startsAt: new Date(draft.startsAt).toISOString(),
        endsAt: new Date(draft.endsAt).toISOString(),
        note: draft.note.trim(),
        ...(parsedCapacityLimit !== (detail.capacityLimit ?? null)
          ? { capacityLimit: parsedCapacityLimit }
          : {}),
      });
    else if (mode === "event_clone" && detail)
      void send({
        operation: "event_clone",
        organizationId: org,
        key: crypto.randomUUID(),
        id: detail.id,
        startsAt: new Date(draft.startsAt).toISOString(),
        endsAt: new Date(draft.endsAt).toISOString(),
      });
    else if (mode === "task" && detail)
      void send({
        operation: "create",
        organizationId: org,
        key: crypto.randomUUID(),
        eventId: detail.id,
        unitId: draft.unitId,
        title: draft.title,
        description: draft.description,
        location: draft.location,
        startsAt: new Date(draft.startsAt).toISOString(),
        deadline: new Date(draft.endsAt).toISOString(),
        capacity: draft.capacity,
        roleLabel: t("მონაწილე", "Participant"),
        priority: "normal",
      });
  }
  const date = (value: string) =>
    new Intl.DateTimeFormat(language === "ka" ? "ka-GE" : "en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      hour12: false,
    }).format(new Date(value));
  const statusLabel = (s: string) =>
    s === "open"
      ? t("მიმდინარე", "Open")
      : s === "completed"
        ? t("დასრულებული", "Completed")
        : t("გაუქმებული", "Cancelled");
  const reward = (offer: EventDetail["contributionOffer"]) =>
    offer
      ? `${offer.title || t("კონტრიბუცია", "Contribution")}: ${offer.amount} ${t("ქულა; თვის ლიმიტი", "points; monthly cap")} ${offer.memberMonthCap}`
      : t("ავტომატური ჯილდოს გარეშე", "No automatic reward");
  return (
    <div className="review-page task-page space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CalendarDays aria-hidden="true" />
            {t("ღონისძიებები", "Events")}
          </h1>
          <p className="text-gray-600 mt-2">
            {t(
              "საერთო დრო, ადგილი და მონაწილეობისა თუ დახმარების დავალებები.",
              "Shared time, place, and participation or support tasks.",
            )}
          </p>
        </div>
        {!mode && !selected && units.some((u) => u.canCreate) && (
          <Button disabled={locked || loading} onClick={() => begin("event")}>
            <Plus size={18} aria-hidden="true" />
            {t("ღონისძიების შექმნა", "Create event")}
          </Button>
        )}
      </div>
      {error && (
        <Card>
          <p role="alert">{error}</p>
          {!pending && (
            <Button
              variant="secondary"
              onClick={() => {
                setError("");
                setRevision((x) => x + 1);
              }}
            >
              {t("განახლება", "Reload")}
            </Button>
          )}
        </Card>
      )}
      {saved && (
        <p role="status">{t("ცვლილება შენახულია.", "Change saved.")}</p>
      )}
      {pending && !busy && (
        <Card>
          <p>
            {t(
              "მოთხოვნის შედეგი დასადასტურებელია.",
              "The request result is awaiting confirmation.",
            )}
          </p>
          <Button onClick={() => void send(pending, true)}>
            {t("იგივე მოთხოვნის გამეორება", "Retry same request")}
          </Button>
        </Card>
      )}
      {loading && <p role="status">{t("იტვირთება…", "Loading…")}</p>}
      {!loading && !org && !error && (
        <Card>
          {t("ღონისძიებებზე წვდომა არ გაქვთ.", "No event access is available.")}
        </Card>
      )}
      {(mode === "event" ||
        mode === "event_edit" ||
        mode === "event_clone" ||
        mode === "task") && (
        <Card>
          <form onSubmit={submit} className="space-y-4">
            <h2 className="text-xl font-semibold">
              {mode === "event"
                ? t("ახალი ღონისძიება", "New event")
                : mode === "event_edit"
                  ? t("ღონისძიების შეცვლა / გადადება", "Edit or reschedule event")
                  : mode === "event_clone"
                    ? t("ღონისძიების კლონირება ახალ თარიღზე", "Clone event schedule")
                    : t("ღონისძიების დავალება", "Event task")}
            </h2>
            <fieldset disabled={locked} className="space-y-4">
              {mode === "event_clone" ? (
                <p className="text-sm font-medium">{draft.title}</p>
              ) : (
                <>
                  <Input
                    ref={focus}
                    label={t("სათაური", "Title")}
                    required
                    minLength={3}
                    maxLength={160}
                    value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  />
                  <Textarea
                    label={t(
                      "აღწერა და ინსტრუქცია",
                      "Description and instructions",
                    )}
                    maxLength={3000}
                    value={draft.description}
                    onChange={(e) =>
                      setDraft({ ...draft, description: e.target.value })
                    }
                  />
                  {mode !== "event_edit" && (
                    <Select
                      label={t("პასუხისმგებელი ერთეული", "Responsible unit")}
                      required
                      value={draft.unitId}
                      onChange={(e) =>
                        setDraft({ ...draft, unitId: e.target.value, rule: "" })
                      }
                      options={[
                        { value: "", label: t("აირჩიეთ ერთეული", "Choose unit") },
                        ...units
                          .filter(
                            (u) =>
                              u.canCreate &&
                              (mode === "event" || u.id === detail?.unitId),
                          )
                          .map((u) => ({ value: u.id, label: u.name })),
                      ]}
                    />
                  )}
                </>
              )}
              <div className="grid gap-4 md:grid-cols-2">
                <Input
                  label={t("დაწყება", "Starts at")}
                  type="datetime-local"
                  required
                  value={draft.startsAt}
                  onChange={(e) =>
                    setDraft({ ...draft, startsAt: e.target.value })
                  }
                />
                <Input
                  label={
                    mode === "event" || mode === "event_edit" || mode === "event_clone"
                      ? t("დასრულება", "Ends at")
                      : t("შესრულების ვადა", "Completion deadline")
                  }
                  type="datetime-local"
                  required
                  min={draft.startsAt}
                  value={draft.endsAt}
                  onChange={(e) =>
                    setDraft({ ...draft, endsAt: e.target.value })
                  }
                />
              </div>
              {mode !== "event_clone" && (
                <Input
                  label={t(
                    "შეხვედრის ადგილი (არასავალდებულო)",
                    "Meeting place (optional)",
                  )}
                  maxLength={300}
                  value={draft.location}
                  onChange={(e) =>
                    setDraft({ ...draft, location: e.target.value })
                  }
                />
              )}
              {(mode === "event" || mode === "event_edit") && (
                <Input
                  label={t(
                    "RSVP ტევადობის ლიმიტი (არასავალდებულო)",
                    "RSVP capacity limit (optional)",
                  )}
                  type="number"
                  min={1}
                  max={5000}
                  placeholder={t("ულიმიტო", "Unlimited")}
                  value={draft.capacityLimit}
                  onChange={(e) =>
                    setDraft({ ...draft, capacityLimit: e.target.value })
                  }
                />
              )}
              {mode === "event" ? (
                <ParticipationReward key={draft.unitId} label={t("მონაწილეობის ჯილდო", "Verified participation reward")}
                  value={draft.rule || null} onChange={rule => setDraft({...draft, rule: rule ?? ""})}
                  options={units.find(u => u.id === draft.unitId)?.rewardOptions ?? []} />
              ) : mode === "event_edit" ? (
                <Textarea
                  label={t("ცვლილების მიზეზი", "Reason for amendment")}
                  required
                  minLength={3}
                  maxLength={1000}
                  value={draft.note}
                  onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                />
              ) : mode === "event_clone" ? null : (
                <Input
                  label={t("ადგილების რაოდენობა", "Capacity")}
                  type="number"
                  min={1}
                  max={100}
                  required
                  value={draft.capacity}
                  onChange={(e) =>
                    setDraft({ ...draft, capacity: Number(e.target.value) })
                  }
                />
              )}
              <p className="text-sm text-gray-600">
                {mode === "event_edit"
                  ? t(
                      "ღონისძიების შეცვლა არ ცვლის პასუხისმგებელ ერთეულს, ფიქსირებულ ჯილდოს, უკვე დადასტურებულ მონაწილეობას ან დაკავშირებული დავალებების ვადებს.",
                      "Amending the event keeps the unit, pinned reward offer, verified participation, and linked task deadlines unchanged.",
                    )
                  : t(
                      "ერთ ღონისძიებაში თითო წევრს ავტომატური ჯილდო ერთხელ ენიჭება, პირველი დადასტურებული შესრულებისთვის. დამატებითი დავალებები ქულებს აღარ ამატებს. შეთავაზება უცვლელია.",
                      "Each member earns the event offer once, on the first verified completion. Additional tasks do not add points. The offer is fixed.",
                    )}
              </p>
              <div className="flex flex-wrap gap-3">
                <Button type="submit">
                  {busy ? t("ინახება…", "Saving…") : t("შენახვა", "Save")}
                </Button>
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => setMode("")}
                >
                  {t("გაუქმება", "Cancel")}
                </Button>
              </div>
            </fieldset>
          </form>
        </Card>
      )}
      {selected && !mode && !detail && !loading && (
        <Button
          variant="secondary"
          disabled={locked}
          onClick={() => {
            setSelected("");
            setError("");
          }}
        >
          {t("ყველა ღონისძიება", "All events")}
        </Button>
      )}
      {detail && !mode && (
        <>
          <Button
            variant="secondary"
            disabled={locked}
            onClick={() => {
              setSelected("");
              setError("");
            }}
          >
            {t("ყველა ღონისძიება", "All events")}
          </Button>
          <Card>
            <h2 className="text-xl font-semibold break-words">
              {detail.title}
            </h2>
            <p className="mt-2">
              {statusLabel(detail.status)} · {date(detail.startsAt)} —{" "}
              {date(detail.endsAt)}
            </p>
            {detail.location && (
              <p className="mt-2 break-words">{detail.location}</p>
            )}
            <p className="whitespace-pre-wrap break-words mt-3">
              {detail.description}
            </p>
            <p className="mt-4">{reward(detail.contributionOffer)}</p>
            <p className="text-sm text-gray-600 mt-2">
              {t(
                "ჯილდო ერთხელ თითო წევრზე, პირველი დადასტურებული შესრულებისას. დაკავშირებული დავალებები განმეორებით ქულებს არ იძლევა.",
                "One award per member on the first verified completion. Linked tasks do not award duplicate points.",
              )}
            </p>
            <div className="flex flex-wrap gap-3 mt-4">
              <Button
                variant="secondary"
                type="button"
                disabled={locked}
                onClick={() => downloadEventIcs(detail)}
              >
                <CalendarPlus size={16} aria-hidden="true" />
                {t("კალენდარში დამატება (.ics)", "Add to calendar (.ics)")}
              </Button>
              {detail.canManage && (
                <Button
                  variant="secondary"
                  type="button"
                  disabled={locked}
                  onClick={() => begin("event_clone")}
                >
                  <Copy size={16} aria-hidden="true" />
                  {t("სერიის კლონირება", "Clone event")}
                </Button>
              )}
              {detail.canManage && detail.status === "open" && (
                <>
                  <Button
                    disabled={locked || new Date(detail.endsAt).getTime() <= now}
                    onClick={() => begin("task")}
                  >
                    {t("დავალების დამატება", "Add task")}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={locked}
                    onClick={() => begin("event_edit")}
                  >
                    {t("შეცვლა / გადადება", "Edit or reschedule")}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={locked}
                    onClick={() => {
                      setDraft((prev) => ({
                        ...prev,
                        note: "",
                        cancelLinkedTasks: false,
                      }));
                      setMode("event_complete");
                    }}
                  >
                    {t("ღონისძიების დასრულება", "Complete event")}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={locked}
                    onClick={() => {
                      setDraft((prev) => ({
                        ...prev,
                        note: "",
                        cancelLinkedTasks: false,
                      }));
                      setMode("event_cancel");
                    }}
                  >
                    {t("ღონისძიების გაუქმება", "Cancel event")}
                  </Button>
                </>
              )}
            </div>
            <div className="event-rsvp-box mt-4" aria-label={t("დასწრება და Check-in", "Attendance RSVP and check-in")}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <strong>{t("დასწრება (RSVP)", "Attendance (RSVP)")}</strong>
                  <p className="text-sm mt-1">
                    {t("მოდის", "Going")}: {detail.goingCount ?? 0}
                    {detail.capacityLimit ? ` / ${detail.capacityLimit}` : ""} ·{" "}
                    {t("მოლოდინის სია", "Waitlist")}: {detail.waitlistCount ?? 0} ·{" "}
                    {t("გაიარა Check-in", "Checked in")}: {detail.checkedInCount ?? 0}
                  </p>
                </div>
                {detail.status === "open" &&
                  new Date(detail.endsAt).getTime() > now && (
                    <div className="flex flex-wrap gap-2">
                      {(!detail.myRsvp || detail.myRsvp.status === "cancelled") && (
                        <Button
                          size="sm"
                          disabled={locked}
                          onClick={() =>
                            void send({
                              operation: "event_rsvp",
                              organizationId: org,
                              key: crypto.randomUUID(),
                              id: detail.id,
                              action: "rsvp",
                            })
                          }
                        >
                          {t("მოვდივარ (RSVP)", "Confirm attendance (RSVP)")}
                        </Button>
                      )}
                      {detail.myRsvp &&
                        ["going", "waitlist"].includes(detail.myRsvp.status) && (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={locked}
                            onClick={() =>
                              void send({
                                operation: "event_rsvp",
                                organizationId: org,
                                key: crypto.randomUUID(),
                                id: detail.id,
                                action: "cancel",
                              })
                            }
                          >
                            {t("ჯავშნის გაუქმება", "Cancel RSVP")}
                          </Button>
                        )}
                    </div>
                  )}
              </div>
              {detail.myRsvp && detail.myRsvp.status !== "cancelled" && (
                <p className="text-sm mt-2">
                  {t("თქვენი სტატუსი:", "Your RSVP status:")}{" "}
                  <span className="status-badge" data-status={detail.myRsvp.status === "checked_in" ? "approved" : "pending"}>
                    {detail.myRsvp.status === "checked_in"
                      ? t("დადასტურებული (Checked in)", "Checked in")
                      : detail.myRsvp.status === "going"
                        ? t("ადგილი დაჯავშნილია", "Going")
                        : t("მოლოდინის სიაში", "On waitlist")}
                  </span>
                  {detail.myRsvp.checkinCode && (
                    <>
                      {" · "}
                      {t("Check-in კოდი:", "Check-in code:")}{" "}
                      <code>{detail.myRsvp.checkinCode}</code>
                    </>
                  )}
                </p>
              )}
              {detail.canManage && detail.status === "open" && (
                <div className="flex flex-wrap items-end gap-2 mt-3 pt-3 border-t border-[var(--border)]">
                  <Input
                    label={t("მონაწილის Check-in კოდი", "Participant check-in code")}
                    maxLength={24}
                    value={draft.checkinCode}
                    disabled={locked}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        checkinCode: e.target.value,
                      }))
                    }
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={locked || draft.checkinCode.trim().length < 6}
                    onClick={() =>
                      void send({
                        operation: "event_checkin",
                        organizationId: org,
                        key: crypto.randomUUID(),
                        id: detail.id,
                        checkinCode: draft.checkinCode.trim(),
                      })
                    }
                  >
                    <CheckCircle2 size={15} aria-hidden="true" />
                    {t("Check-in დადასტურება", "Verify check-in")}
                  </Button>
                </div>
              )}
            </div>
            {detail.linkedSummary && (
              <p className="text-sm mt-3">
                {t("დაკავშირებული დავალებები:", "Linked tasks:")}{" "}
                {detail.linkedSummary.openTasks}{" "}
                {t("ღია", "open")} ·{" "}
                {detail.linkedSummary.completedTasks}{" "}
                {t("დასრულებული", "completed")} ·{" "}
                {detail.linkedSummary.cancelledTasks}{" "}
                {t("გაუქმებული", "cancelled")} ·{" "}
                {t("ჯილდოს მოთხოვნები:", "Reward claims:")}{" "}
                {detail.linkedSummary.claimsCount}
              </p>
            )}
          </Card>
          {!!detail.history?.length && (
            <Card>
              <h3 className="text-lg font-semibold">
                {t("ცვლილებების ისტორია", "Amendment & lifecycle history")}
              </h3>
              <ul className="divide-y divide-gray-200 mt-2">
                {detail.history.map((h) => (
                  <li key={h.version} className="py-2 text-sm">
                    <span className="font-medium">
                      #{h.version} ·{" "}
                      {h.action === "edit"
                        ? t("განახლება / გადადება", "Amended")
                        : h.action === "complete"
                          ? t("დასრულება", "Completed")
                          : t("გაუქმება", "Cancelled")}
                    </span>{" "}
                    · {date(h.createdAt)}
                    {h.note && <p className="mt-1 break-words">{h.note}</p>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card>
            <h3 className="text-lg font-semibold">
              {t(
                "თქვენთვის ხელმისაწვდომი დავალებები",
                "Tasks available to you",
              )}
            </h3>
            <p className="text-sm text-gray-600 my-2">
              {t(
                "ჩართვა, მასალები და შესრულების დადასტურება იხილეთ შესაბამის დავალებაში.",
                "Open a task to join, read materials and confirm completion.",
              )}
            </p>
            {!detail.tasks.length ? (
              <p>{t("დავალებები ჯერ არ არის.", "No tasks yet.")}</p>
            ) : (
              <ul className="divide-y divide-gray-200">
                {detail.tasks.map((task) => (
                  <li
                    key={task.id}
                    className="py-3 flex flex-wrap items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <p className="font-medium break-words">{task.title}</p>
                      <p className="text-sm text-gray-600">
                        {task.unitName} · {task.used}/{task.capacity} ·{" "}
                        {t("დადასტურებული", "Verified")}: {task.verified}
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      disabled={locked}
                      onClick={() => openTask(task.id)}
                    >
                      {t("დავალების გახსნა", "Open task")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
      {detail && (mode === "event_complete" || mode === "event_cancel") && (
        <Card>
          <h2 className="text-xl font-semibold">
            {mode === "event_complete"
              ? t("ღონისძიების დასრულება", "Complete event")
              : t("ღონისძიების გაუქმება", "Cancel event")}
          </h2>
          <p className="my-4">
            {t(
              "ჯერ ყველა დაკავშირებული დავალება უნდა დაიხუროს. არსებული შესრულება და მიღებული ქულები შენარჩუნდება.",
              "All linked tasks must be closed first. Existing completions and earned points are preserved.",
            )}
          </p>
          {mode === "event_cancel" &&
            detail.linkedSummary &&
            detail.linkedSummary.openTasks > 0 && (
              <div className="space-y-3 my-4">
                {detail.linkedSummary.verifiedOpenTasks > 0 ? (
                  <p role="alert">
                    {t(
                      "ღონისძიებას აქვს ღია დავალება უკვე დადასტურებული შესრულებით — ჯერ დაასრულეთ ის დავალება.",
                      "This event has an open task with verified participation — complete that task first before cancelling the event.",
                    )}
                  </p>
                ) : (
                  <label className="flex items-center gap-3 min-h-11">
                    <input
                      type="checkbox"
                      checked={draft.cancelLinkedTasks}
                      disabled={locked}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          cancelLinkedTasks: e.target.checked,
                        })
                      }
                    />
                    <span>
                      {t(
                        "ასევე გავაუქმო დაკავშირებული ღია დაუდასტურებელი დავალებები (",
                        "Also cancel linked open unverified tasks (",
                      )}
                      {detail.linkedSummary.cancellableOpenTasks})
                    </span>
                  </label>
                )}
              </div>
            )}
          {mode === "event_cancel" && (
            <div className="my-4">
              <Textarea
                label={t("გაუქმების მიზეზი", "Cancellation reason")}
                maxLength={1000}
                value={draft.note}
                disabled={locked}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              />
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            <Button
              disabled={
                locked ||
                (mode === "event_cancel" &&
                  draft.cancelLinkedTasks &&
                  draft.note.trim().length < 3)
              }
              onClick={() =>
                void send({
                  operation: mode,
                  organizationId: org,
                  key: crypto.randomUUID(),
                  id: detail.id,
                  version: detail.version,
                  note: draft.note.trim(),
                  ...(mode === "event_cancel" && draft.cancelLinkedTasks
                    ? { cancelLinkedTasks: true }
                    : {}),
                })
              }
            >
              {t("დადასტურება", "Confirm")}
            </Button>
            <Button
              variant="secondary"
              disabled={locked}
              onClick={() => setMode("")}
            >
              {t("უკან", "Back")}
            </Button>
          </div>
        </Card>
      )}
      {!selected && !mode && org && (
        <>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              setFilter(search);
              setPage(1);
            }}
          >
            <div className="flex-1 min-w-0">
              <Input
                label={t("ღონისძიების ძებნა", "Search events")}
                maxLength={80}
                value={search}
                disabled={locked}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div>
              <Select
                label={t("მდგომარეობა", "Status")}
                value={status}
                disabled={locked}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
                options={["open", "completed", "cancelled"].map((s) => ({
                  value: s,
                  label: statusLabel(s),
                }))}
              />
            </div>
            <Button type="submit" disabled={locked}>
              {t("ძებნა", "Search")}
            </Button>
            <Button
              variant="secondary"
              disabled={locked}
              onClick={() => {
                setSearch("");
                setFilter("");
                setStatus("open");
                setPage(1);
              }}
            >
              {t("გასუფთავება", "Reset")}
            </Button>
          </form>
          {data && (
            <>
              <p>
                {t("ღონისძიებების რაოდენობა", "Events")}: {data.total}
              </p>
              <div className="grid gap-4 lg:grid-cols-2">
                {data.items.map((item) => (
                  <Card key={item.id}>
                    <h2 className="font-semibold text-lg break-words">
                      {item.title}
                    </h2>
                    <p className="my-2">{date(item.startsAt)}</p>
                    <p className="break-words mb-3">{item.location}</p>
                    <Button
                      variant="secondary"
                      disabled={locked}
                      onClick={() => {
                        setSelected(item.id);
                        setError("");
                      }}
                    >
                      {t("ღონისძიების გახსნა", "Open event")}
                    </Button>
                  </Card>
                ))}
              </div>
              {!data.items.length && (
                <Card>
                  {filter
                    ? t("ძებნის შედეგი არ არის.", "No matching events.")
                    : t("ღონისძიებები ჯერ არ არის.", "No events yet.")}
                </Card>
              )}
              <div className="flex gap-3">
                <Button
                  variant="secondary"
                  disabled={locked || page <= 1}
                  onClick={() => setPage((x) => x - 1)}
                >
                  {t("წინა", "Previous")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={locked || page * data.pageSize >= data.total}
                  onClick={() => setPage((x) => x + 1)}
                >
                  {t("შემდეგი", "Next")}
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
