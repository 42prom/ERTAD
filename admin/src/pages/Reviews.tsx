import { apiErrorStatus } from "../api/errors";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams, useLocation, useNavigate } from "react-router-dom";
import { useInboxTarget } from "../components/useInboxTarget";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import Select from "../components/ui/Select";
import { useConsolePreferences } from "../components/useConsolePreferences";
import { authApi } from "../api/client";
import { demoApi, type DemoPerson } from "../api/demo";
import { membershipChangeLabel } from "../components/membershipChangeLabel";
import PositionComparison from "../components/PositionComparison";
import {
  reviewApi,
  type Proposal,
  type ReviewContext,
  type ReviewDecision,
  type ReviewDetail,
  type ReviewList,
  type ReviewNotification,
} from "../api/reviews";

const copy = {
  en: {
    title: "Requests and notifications",
    intro:
      "Review membership and position requests within your permitted scope.",
    pending: "Needs my decision",
    mine: "My requests",
    history: "History",
    notifications: "Notifications",
    loading: "Loading…",
    empty: "No requests in this view.",
    filtered: "No requests match these filters.",
    unavailable:
      "No review access is assigned to this account. An administrator role alone does not grant membership authority.",
    error: "Could not load requests. Check your connection and retry.",
    denied: "Access is unavailable or has been revoked.",
    conflict:
      "This request changed, expired, or is no longer eligible. Refresh its details.",
    failed:
      "The outcome could not be confirmed. Retry the same submission to check it safely.",
    retry: "Retry",
    refresh: "Refresh",
    reset: "Reset filters",
    search: "Search unit or position",
    status: "Status",
    all: "All statuses",
    approved: "Approved",
    rejected: "Rejected",
    expired: "Expired",
    requestPending: "Pending",
    unit: "Unit / position",
    requester: "Requester reference",
    created: "Created",
    deadline: "Decision deadline",
    details: "Details",
    previous: "Previous",
    next: "Next",
    total: "Matching requests",
    page: "Page",
    create: "Propose position",
    target: "Existing member reference",
    position: "Position",
    reason: "Operational reason (10–1000 characters)",
    until: "Membership valid until",
    expires: "Decision deadline",
    password: "Confirm with your password",
    submit: "Submit request",
    cancel: "Cancel",
    close: "Close details",
    approve: "Approve",
    reject: "Reject",
    decisionReason: "Decision reason (10–1000 characters)",
    decision: "Decision",
    duration: "Valid until",
    version: "Permission bundle version",
    targetHint:
      "Use an authorized reference for an existing member in this organization. This form does not register or search for people.",
    noIdentity:
      "References are opaque identifiers; legal identity is not disclosed.",
    noDecision:
      "This request cannot be decided by this account or is no longer pending.",
    confirm: "I have reviewed the proposed change and its duration.",
    saved: "Request submitted.",
    decided: "Decision saved.",
    read: "Mark as read",
    unread: "Unread",
    readStatus: "Read",
    notificationEmpty: "No notifications are currently visible.",
    recent: "Latest 50 permitted notifications",
    busy: "Saving…",
    invalid:
      "Complete all fields with valid dates. Membership must end after the decision deadline.",
    retrySubmission: "Retry unchanged submission",
    retained:
      "An unconfirmed submission is retained in this page. Retry it before making another change.",
    newType: "Membership / position",
    result: "Recorded decision",
  },
  ka: {
    title: "მოთხოვნები და შეტყობინებები",
    intro:
      "განიხილეთ წევრობისა და პოზიციის მოთხოვნები თქვენი უფლებების ფარგლებში.",
    pending: "დასადასტურებელი",
    mine: "ჩემი მოთხოვნები",
    history: "ისტორია",
    notifications: "შეტყობინებები",
    loading: "იტვირთება…",
    empty: "ამ ხედში მოთხოვნები არ არის.",
    filtered: "ამ ფილტრებით მოთხოვნები ვერ მოიძებნა.",
    unavailable:
      "ამ ანგარიშს მოთხოვნების განხილვის უფლება ჯერ არ აქვს. მხოლოდ ადმინისტრატორის როლი წევრობის მართვის უფლებას არ იძლევა.",
    error: "მოთხოვნები ვერ ჩაიტვირთა. შეამოწმეთ კავშირი და სცადეთ ხელახლა.",
    denied: "წვდომა არ გაქვთ ან უფლება გაუქმებულია.",
    conflict:
      "მოთხოვნა შეიცვალა, ვადა ამოიწურა ან პირობებს აღარ აკმაყოფილებს. განაახლეთ დეტალები.",
    failed:
      "შედეგი ვერ დადასტურდა. იმავე მოთხოვნის ხელახლა გაგზავნით შედეგს უსაფრთხოდ გადაამოწმებთ.",
    retry: "ხელახლა ცდა",
    refresh: "განახლება",
    reset: "ფილტრების გასუფთავება",
    search: "ერთეულის ან პოზიციის ძებნა",
    status: "სტატუსი",
    all: "ყველა სტატუსი",
    approved: "დამტკიცებული",
    rejected: "უარყოფილი",
    expired: "ვადაგასული",
    requestPending: "მოლოდინში",
    unit: "ერთეული / პოზიცია",
    requester: "მომთხოვნის კოდი",
    created: "შექმნილია",
    deadline: "გადაწყვეტილების ვადა",
    details: "დეტალები",
    previous: "წინა",
    next: "შემდეგი",
    total: "მოთხოვნების რაოდენობა",
    page: "გვერდი",
    create: "პოზიციის შეთავაზება",
    target: "არსებული წევრის კოდი",
    position: "პოზიცია",
    reason: "სამუშაო მიზეზი (10–1000 სიმბოლო)",
    until: "წევრობის დასრულება",
    expires: "გადაწყვეტილების ვადა",
    password: "დაადასტურეთ თქვენი პაროლით",
    submit: "მოთხოვნის გაგზავნა",
    cancel: "გაუქმება",
    close: "დეტალების დახურვა",
    approve: "დამტკიცება",
    reject: "უარყოფა",
    decisionReason: "გადაწყვეტილების მიზეზი (10–1000 სიმბოლო)",
    decision: "გადაწყვეტილება",
    duration: "მოქმედების ბოლო ვადა",
    version: "უფლებების პაკეტის ვერსია",
    targetHint:
      "გამოიყენეთ ამ ორგანიზაციის არსებული წევრის კოდი, რომლის გამოყენების უფლებაც გაქვთ. აქ ადამიანების რეგისტრაცია ან ძებნა არ ხდება.",
    noIdentity:
      "კოდები ტექნიკური იდენტიფიკატორებია; პირადი საიდენტიფიკაციო მონაცემები არ ჩანს.",
    noDecision:
      "ამ ანგარიშს გადაწყვეტილების უფლება არ აქვს ან მოთხოვნა აღარ არის მოლოდინში.",
    confirm: "გავეცანი შემოთავაზებულ ცვლილებასა და მოქმედების ვადას.",
    saved: "მოთხოვნა გაიგზავნა.",
    decided: "გადაწყვეტილება შენახულია.",
    read: "წაკითხულად მონიშვნა",
    unread: "წაუკითხავი",
    readStatus: "წაკითხული",
    notificationEmpty: "ხელმისაწვდომი შეტყობინებები არ არის.",
    recent: "ბოლო 50 ხელმისაწვდომი შეტყობინება",
    busy: "ინახება…",
    invalid:
      "შეავსეთ ყველა ველი სწორი თარიღებით. წევრობის ვადა გადაწყვეტილების ვადაზე გვიან უნდა სრულდებოდეს.",
    retrySubmission: "იმავე მოთხოვნის ხელახლა გაგზავნა",
    retained:
      "დაუდასტურებელი მოთხოვნა ამ გვერდზე შენარჩუნებულია. სხვა ცვლილებამდე ხელახლა გაგზავნეთ.",
    newType: "წევრობა / პოზიცია",
    result: "მიღებული გადაწყვეტილება",
  },
};
type Tab = "pending" | "mine" | "history" | "notifications";
export default function Reviews() {
  const location = useLocation(),
    navigate = useNavigate(),
    [directoryTarget, setDirectoryTarget] = useState("");
  const { language } = useConsolePreferences();
  const t = copy[language];
  const [params, setParams] = useSearchParams();
  const tab: Tab = ["pending", "mine", "history", "notifications"].includes(
    params.get("view") ?? "",
  )
    ? (params.get("view") as Tab)
    : "pending";
  const [contexts, setContexts] = useState<ReviewContext[] | null>(null),
    [org, setOrg] = useState("");
  const [list, setList] = useState<ReviewList | null>(null),
    [notifications, setNotifications] = useState<ReviewNotification[]>([]);
  const [page, setPage] = useState(1),
    [search, setSearch] = useState(""),
    [debounced, setDebounced] = useState(""),
    [status, setStatus] = useState("");
  const [unitFilter, setUnitFilter] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [revision, setRevision] = useState(0);
  const [detail, setDetail] = useState<ReviewDetail | null>(null),
    [detailLoading, setDetailLoading] = useState(false);
  const [creating, setCreating] = useState(false),
    [busy, setBusy] = useState(false),
    [password, setPassword] = useState("");
  const [position, setPosition] = useState(""),
    [target, setTarget] = useState(""),
    [reason, setReason] = useState(""),
    [until, setUntil] = useState(""),
    [expires, setExpires] = useState("");
  const [decisionReason, setDecisionReason] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [decisionChoice, setDecisionChoice] = useState<"approved" | "rejected">(
      "approved",
    );
  const [retry, setRetry] = useState<
    | { kind: "propose"; data: Proposal }
    | { kind: "decide"; data: ReviewDecision }
    | null
  >(null);
  const detailGeneration = useRef(0);
  const detailTitle = useRef<HTMLHeadingElement>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const [demoPeople, setDemoPeople] = useState<DemoPerson[] | null>(null);
  useEffect(() => {
    let live = true;
    if (import.meta.env.DEV)
      void demoApi
        .scenario()
        .then((r) => {
          if (live) setDemoPeople(r.accounts);
        })
        .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const active = contexts?.find((c) => c.id === org);
  const directoryIntent = location.state?.memberDirectory;
  if (active && directoryIntent && directoryTarget !== location.key) {
    setDirectoryTarget(location.key);
    const choice = active.positions.find((p) => p.canPropose);
    if (
      directoryIntent.organizationId === org &&
      typeof directoryIntent.memberId === "string" &&
      /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(
        directoryIntent.memberId,
      ) &&
      choice
    ) {
      setTarget(directoryIntent.memberId);
      setPosition(choice.id);
      setCreating(true);
    }
  }
  useEffect(() => {
    if (directoryTarget === location.key && directoryIntent)
      navigate(location.pathname + location.search, {
        replace: true,
        state: null,
      });
  }, [directoryTarget, location, navigate, directoryIntent]);
  const message = (e: unknown) =>
    apiErrorStatus(e) === 403
      ? t.denied
      : apiErrorStatus(e) === 409
        ? t.conflict
        : t.failed;
  const refresh = () => {
    setError("");
    setRevision((v) => v + 1);
  };
  const closeDetail = () => {
    detailGeneration.current++;
    setDetail(null);
    setDetailLoading(false);
    setDecisionReason("");
    setPassword("");
    setConfirmed(false);
  };
  const [accessRevision, setAccessRevision] = useState(revision);
  if (accessRevision !== revision) {
    setAccessRevision(revision);
    setLoading(true);
    setError("");
  }
  useEffect(() => {
    let live = true;
    reviewApi
      .contexts()
      .then((rows) => {
        if (live) {
          setContexts(rows);
          setOrg((current) =>
            rows.some((c) => c.id === current) ? current : (rows[0]?.id ?? ""),
          );
          if (!rows.length) {
            setList(null);
            setNotifications([]);
            closeDetail();
          }
        }
      })
      .catch((e) => {
        if (live) {
          setContexts(null);
          setOrg("");
          setList(null);
          setNotifications([]);
          closeDetail();
          setError(message(e));
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [revision]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const listKey = JSON.stringify([
    org,
    tab,
    page,
    status,
    debounced,
    revision,
    unitFilter,
    from,
    to,
  ]);
  const [observedList, setObservedList] = useState(listKey);
  if (observedList !== listKey) {
    setObservedList(listKey);
    setLoading(true);
    setError("");
    setList(null);
    setNotifications([]);
  }
  useEffect(() => {
    if (!org) return;
    let live = true;
    const work =
      tab === "notifications"
        ? reviewApi.notifications(org).then((data) => {
            if (live) setNotifications(data.items);
          })
        : reviewApi
            .list({
              organizationId: org,
              view: tab,
              status,
              search: debounced,
              page,
              unitId: unitFilter || undefined,
              from: from || undefined,
              to: to || undefined,
            })
            .then((data) => {
              if (live) setList(data);
            });
    work
      .catch((e) => {
        if (live) {
          closeDetail();
          setError(message(e));
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [org, tab, page, status, debounced, revision, unitFilter, from, to]);
  useEffect(() => {
    if (detail) detailTitle.current?.focus();
  }, [detail?.id]);
  useEffect(() => {
    if (!retry && !creating && !decisionReason) return;
    const guard = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [retry, creating, decisionReason]);
  async function open(id: string) {
    const generation = ++detailGeneration.current;
    setDetail(null);
    setDetailLoading(true);
    setError("");
    setPassword("");
    setDecisionReason("");
    setConfirmed(false);
    try {
      const value = await reviewApi.detail(org, id);
      if (generation === detailGeneration.current) setDetail(value);
    } catch (e) {
      if (generation === detailGeneration.current) setError(message(e));
    } finally {
      if (generation === detailGeneration.current) setDetailLoading(false);
    }
  }
  useInboxTarget("membership", org, (id) => void open(id));
  async function send(submission: NonNullable<typeof retry>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    setRetry(submission);
    let submitted = false;
    try {
      if (demoPeople) await demoApi.stepUp();
      else await authApi.stepUp(password);
      setPassword("");
      submitted = true;
      if (submission.kind === "propose") {
        await reviewApi.propose(submission.data);
        setCreating(false);
        setReason("");
        setTarget("");
        setNotice(t.saved);
      } else {
        await reviewApi.decide(submission.data);
        closeDetail();
        setNotice(t.decided);
      }
      setRetry(null);
      refresh();
      window.dispatchEvent(new Event("ertad-reviews-changed"));
    } catch (e: unknown) {
      setError(message(e));
      if (submitted && apiErrorStatus(e) && (apiErrorStatus(e) ?? 500) < 500) {
        setRetry(null);
        if (apiErrorStatus(e) === 403) closeDetail();
      }
    } finally {
      setBusy(false);
    }
  }
  function propose(e: FormEvent) {
    e.preventDefault();
    if (retry) {
      void send(retry);
      return;
    }
    if (
      !position ||
      !target ||
      reason.trim().length < 10 ||
      !Number.isFinite(Date.parse(until)) ||
      !Number.isFinite(Date.parse(expires)) ||
      Date.parse(until) <= Date.parse(expires)
    ) {
      setError(t.invalid);
      return;
    }
    void send({
      kind: "propose",
      data: {
        organizationId: org,
        key: crypto.randomUUID(),
        positionId: position,
        targetId: target.trim(),
        reason: reason.trim(),
        validUntil: new Date(until).toISOString(),
        expiresAt: new Date(expires).toISOString(),
      },
    });
  }
  function decide(e: FormEvent) {
    e.preventDefault();
    if (!detail || !confirmed) return;
    void send(
      retry ?? {
        kind: "decide",
        data: {
          organizationId: org,
          id: detail.id,
          key: crypto.randomUUID(),
          decision: decisionChoice,
          reason: decisionReason.trim(),
        },
      },
    );
  }
  const date = (value: string) =>
    new Intl.DateTimeFormat(language === "ka" ? "ka-GE" : "en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      hour12: false,
    }).format(new Date(value));
  const statusLabel = (value: string) =>
    value === "pending"
      ? t.requestPending
      : value === "approved"
        ? t.approved
        : value === "rejected"
          ? t.rejected
          : t.expired;
  const locked = busy || !!retry;
  return (
    <section className="review-page" aria-labelledby="reviews-title">
      <header>
        <h1 id="reviews-title">{t.title}</h1>
        <p>{t.intro}</p>
      </header>
      <div className="review-toolbar">
        <Button
          variant="secondary"
          onClick={refresh}
          disabled={locked || creating || !!decisionReason}
        >
          {t.refresh}
        </Button>
        {active?.positions.some((p) => p.canPropose) && (
          <Button
            onClick={() => {
              closeDetail();
              setCreating(true);
              setPosition(active.positions.find((p) => p.canPropose)!.id);
              setNotice("");
            }}
            disabled={locked || creating}
          >
            {t.create}
          </Button>
        )}
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          {!retry && (
            <Button variant="secondary" onClick={refresh}>
              {t.retry}
            </Button>
          )}
        </div>
      )}
      {contexts?.length === 0 && (
        <Card>
          <p>{t.unavailable}</p>
        </Card>
      )}
      {!!contexts?.length && (
        <>
          <nav className="review-tabs" aria-label={t.title}>
            {(["pending", "mine", "history", "notifications"] as const).map(
              (view) => (
                <Button
                  key={view}
                  variant={tab === view ? "primary" : "secondary"}
                  aria-current={tab === view ? "page" : undefined}
                  disabled={locked || creating || !!decisionReason}
                  onClick={() => {
                    closeDetail();
                    setParams({ view }, { replace: true });
                    setPage(1);
                    setStatus("");
                  }}
                >
                  {t[view]}
                </Button>
              ),
            )}
          </nav>
          {tab !== "notifications" && (
            <div className="review-filters">
              <Input
                label={t.search}
                value={search}
                maxLength={80}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Select
                label={t.status}
                value={status}
                options={[
                  { value: "", label: t.all },
                  ...["pending", "approved", "rejected", "expired"].map(
                    (value) => ({ value, label: statusLabel(value) }),
                  ),
                ]}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
              />
              <Select
                label={language === "ka" ? "ერთეული" : "Unit"}
                value={unitFilter}
                options={[
                  {
                    value: "",
                    label:
                      language === "ka"
                        ? "ყველა ხელმისაწვდომი"
                        : "All permitted",
                  },
                  ...Array.from(
                    new Map(
                      (active?.positions ?? []).map((p) => [
                        p.unitId,
                        { value: p.unitId, label: p.unitName },
                      ]),
                    ).values(),
                  ),
                ]}
                onChange={(e) => {
                  setUnitFilter(e.target.value);
                  setPage(1);
                }}
              />
              <Input
                label={
                  language === "ka"
                    ? "შექმნილია თარიღიდან (UTC)"
                    : "Created from (UTC)"
                }
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPage(1);
                }}
              />
              <Input
                label={
                  language === "ka"
                    ? "შექმნილია თარიღამდე (UTC)"
                    : "Created through (UTC)"
                }
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setPage(1);
                }}
              />
              <Button
                variant="secondary"
                onClick={() => {
                  setSearch("");
                  setStatus("");
                  setUnitFilter("");
                  setFrom("");
                  setTo("");
                  setPage(1);
                }}
              >
                {t.reset}
              </Button>
            </div>
          )}
        </>
      )}
      {loading && <p role="status">{t.loading}</p>}
      {!loading && !error && list && (
        <Card>
          <p role="status">
            {t.total}: {list.total}
          </p>
          {list.items.length === 0 ? (
            <p>
              {search || status || unitFilter || from || to
                ? t.filtered
                : t.empty}
            </p>
          ) : (
            <div
              className="review-table-scroll"
              tabIndex={0}
              role="region"
              aria-label={t.title}
            >
              <table>
                <thead>
                  <tr>
                    {[
                      t.unit,
                      t.requester,
                      t.created,
                      t.deadline,
                      t.status,
                      t.details,
                    ].map((label) => (
                      <th key={label} scope="col">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <strong>{row.position_name}</strong>
                        <br />
                        {row.unit_name}
                        <br />
                        <small>
                          {membershipChangeLabel(row.kind, language, t.newType)}
                        </small>
                      </td>
                      <td>
                        <code>{row.requester_id}</code>
                      </td>
                      <td>{date(row.created_at)}</td>
                      <td>{date(row.expires_at)}</td>
                      <td>
                        <span className="status-badge" data-status={row.status}>
                          {statusLabel(row.status)}
                        </span>
                      </td>
                      <td>
                        <Button
                          variant="secondary"
                          disabled={locked || creating || !!decisionReason}
                          onClick={() => void open(row.id)}
                          aria-label={`${t.details}: ${row.position_name}`}
                        >
                          {t.details}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="review-toolbar">
            <Button
              variant="secondary"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => p - 1)}
            >
              {t.previous}
            </Button>
            <span>
              {t.page} {page}
            </span>
            <Button
              variant="secondary"
              disabled={page * 25 >= list.total || loading}
              onClick={() => setPage((p) => p + 1)}
            >
              {t.next}
            </Button>
          </div>
        </Card>
      )}
      {!loading && !error && org && tab === "notifications" && (
        <Card>
          <p>{t.recent}</p>
          {notifications.length === 0 ? (
            <p>{t.notificationEmpty}</p>
          ) : (
            <ul className="review-notifications">
              {notifications.map((n) => (
                <li key={n.id}>
                  <span>
                    {statusLabel(n.status)} · {date(n.created_at)} ·{" "}
                    {n.read_at ? t.readStatus : t.unread}
                  </span>
                  <Button
                    variant="secondary"
                    onClick={() => void open(n.id)}
                    disabled={locked}
                  >
                    {t.details}
                  </Button>
                  {!n.read_at && (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await reviewApi.read(org, n.id);
                          refresh();
                        } catch (e) {
                          setError(message(e));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      {t.read}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {detailLoading && <p role="status">{t.loading}</p>}
      {detail && (
        <Card>
          <h2 ref={detailTitle} tabIndex={-1}>
            {t.details}
          </h2>
          <p>{t.noIdentity}</p>
          <dl className="review-details">
            <dt>{t.status}</dt>
            <dd>
              {statusLabel(
                detail.status === "pending" &&
                  Date.parse(detail.expires_at) <= clockNow
                  ? "expired"
                  : detail.status,
              )}
            </dd>
            <dt>{t.requester}</dt>
            <dd>
              {demoPeople?.find((p) => p.memberId === detail.requester_id)
                ?.label ?? <code>{detail.requester_id}</code>}
            </dd>
            <dt>{t.target}</dt>
            <dd>
              {demoPeople?.find((p) => p.memberId === detail.target_id)
                ?.label ?? <code>{detail.target_id}</code>}
            </dd>
            <dt>{t.position}</dt>
            {detail.kind && detail.kind !== "grant" && (
              <dd>
                <strong>
                  {membershipChangeLabel(detail.kind, language, t.newType)}
                </strong>
                <p>
                  {detail.sourceUnitName} / {detail.sourcePositionName}
                </p>
                <p>
                  {detail.kind === "revision"
                    ? language === "ka"
                      ? "ძველი წევრობა დასრულდება და ახალი პოზიცია შეინარჩუნებს თავდაპირველ ვადასა და სტატუსს; ქულები და ისტორია უცვლელია."
                      : "The old membership ends and the new position preserves its original term and status; points and history remain unchanged."
                    : detail.kind === "suspend" || detail.kind === "resume"
                      ? language === "ka"
                        ? "იცვლება მხოლოდ ამ წევრობის წვდომა; პოზიცია, ვადა, დავალებები, ქულები და ისტორია შენარჩუნდება."
                        : "Only this membership's access changes; its position, expiry, assignments, points and history are preserved."
                      : language === "ka"
                        ? "ძველი წევრობა დასრულდება; ქულები და ისტორია შენარჩუნდება."
                        : "The source membership will end; points and history are preserved."}
                </p>
                {detail.comparison && (
                  <PositionComparison comparison={detail.comparison} />
                )}
              </dd>
            )}
            <dd>
              {active?.positions.find((p) => p.id === detail.position_id)
                ?.name ?? detail.position_id}
            </dd>
            <dt>{t.reason}</dt>
            <dd>{detail.reason}</dd>
            <dt>{t.duration}</dt>
            <dd>
              {detail.kind === "suspend" ||
              detail.kind === "resume" ||
              detail.kind === "revision"
                ? detail.sourceValidUntil
                  ? date(detail.sourceValidUntil)
                  : language === "ka"
                    ? "უვადო — უცვლელი"
                    : "No expiry — unchanged"
                : detail.valid_until
                  ? date(detail.valid_until)
                  : "—"}
            </dd>
            <dt>{t.deadline}</dt>
            <dd>{date(detail.expires_at)}</dd>
            <dt>{t.version}</dt>
            <dd>{detail.bundle_version}</dd>
            {detail.decision_reason && (
              <>
                <dt>{t.result}</dt>
                <dd>
                  {detail.decision_reason}
                  <br />
                  {detail.decision_at && date(detail.decision_at)}
                </dd>
              </>
            )}
          </dl>
          {detail.canDecide ? (
            <form onSubmit={decide} className="review-form">
              <fieldset disabled={locked}>
                <legend>{t.decision}</legend>
                <Select
                  label={t.decision}
                  value={decisionChoice}
                  onChange={(e) =>
                    setDecisionChoice(e.target.value as "approved" | "rejected")
                  }
                  options={[
                    { value: "approved", label: t.approve },
                    { value: "rejected", label: t.reject },
                  ]}
                />
                <Input
                  label={t.decisionReason}
                  required
                  minLength={10}
                  maxLength={1000}
                  value={decisionReason}
                  onChange={(e) => setDecisionReason(e.target.value)}
                />
                <label className="review-confirm">
                  <input
                    type="checkbox"
                    required
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  {t.confirm}
                </label>
              </fieldset>
              {!demoPeople && (
                <Input
                  label={t.password}
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  disabled={busy}
                  onChange={(e) => setPassword(e.target.value)}
                />
              )}
              {retry && <p>{t.retained}</p>}
              <Button type="submit" disabled={busy || !confirmed}>
                {busy
                  ? t.busy
                  : retry
                    ? t.retrySubmission
                    : decisionChoice === "approved"
                      ? t.approve
                      : t.reject}
              </Button>
            </form>
          ) : (
            <p>{t.noDecision}</p>
          )}
          <Button variant="secondary" disabled={locked} onClick={closeDetail}>
            {t.close}
          </Button>
        </Card>
      )}
      {creating && (
        <Card>
          <h2>{t.create}</h2>
          <p>{t.targetHint}</p>
          <form onSubmit={propose} className="review-form">
            <fieldset disabled={locked}>
              <Select
                label={t.position}
                value={position}
                required
                onChange={(e) => setPosition(e.target.value)}
                options={(active?.positions ?? [])
                  .filter((p) => p.canPropose)
                  .map((p) => ({
                    value: p.id,
                    label: `${p.unitName} / ${p.name}`,
                  }))}
              />
              {demoPeople ? (
                <Select
                  label={t.target}
                  required
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  options={[
                    {
                      value: "",
                      label:
                        language === "ka"
                          ? "აირჩიე სატესტო წევრი"
                          : "Choose a demo member",
                    },
                    ...(target && !demoPeople.some((p) => p.memberId === target)
                      ? [
                          {
                            value: target,
                            label:
                              (language === "ka" ? "წევრი" : "Member") +
                              " " +
                              target.slice(0, 8),
                          },
                        ]
                      : []),
                    ...demoPeople.map((p) => ({
                      value: p.memberId,
                      label: p.label,
                    })),
                  ]}
                />
              ) : (
                <Input
                  label={t.target}
                  required
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  pattern="[0-9a-fA-F-]{36}"
                />
              )}
              <Input
                label={t.reason}
                required
                minLength={10}
                maxLength={1000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <Input
                label={t.expires}
                type="datetime-local"
                required
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
              />
              <Input
                label={t.until}
                type="datetime-local"
                required
                value={until}
                onChange={(e) => setUntil(e.target.value)}
              />
            </fieldset>
            {!demoPeople && (
              <Input
                label={t.password}
                type="password"
                autoComplete="current-password"
                required
                value={password}
                disabled={busy}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
            {retry && <p>{t.retained}</p>}
            <div className="review-toolbar">
              <Button type="submit" disabled={busy}>
                {busy ? t.busy : retry ? t.retrySubmission : t.submit}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={locked}
                onClick={() => {
                  setCreating(false);
                  setPassword("");
                }}
              >
                {t.cancel}
              </Button>
            </div>
          </form>
        </Card>
      )}
    </section>
  );
}
