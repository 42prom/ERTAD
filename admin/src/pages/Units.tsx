import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronDown, ChevronRight, List, Network } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import Select from "../components/ui/Select";
import { useConsolePreferences } from "../components/useConsolePreferences";
import { useInboxTarget } from "../components/useInboxTarget";
import { authApi } from "../api/client";
import { demoApi } from "../api/demo";
import {
  unitApi,
  type UnitContext,
  type UnitRow,
  type UnitReview,
  type UnitDetail,
  type UnitPage,
  type UnitProposal,
  type UnitDecision,
  type UnitChange,
} from "../api/units";

type Submission =
  | { kind: "propose"; data: UnitProposal }
  | { kind: "change"; data: UnitChange }
  | { kind: "decide"; data: UnitDecision };
export default function Units() {
  const { language } = useConsolePreferences(),
    ka = language === "ka";
  const label = (en: string, ge: string) => (ka ? ge : en);
  const [contexts, setContexts] = useState<UnitContext[] | null>(null),
    [org, setOrg] = useState("");
  const [params, setParams] = useSearchParams();
  const tab = ["pending", "mine", "history"].includes(params.get("view") ?? "")
    ? params.get("view")!
    : "units";
  const setTab = (view: string) => setParams(view === "units" ? {} : { view });
  const choosingParent = params.get("create") === "group" && tab === "units";
  const [page, setPage] = useState(1),
    [revision, setRevision] = useState(0);
  const [data, setData] = useState<UnitPage<UnitRow | UnitReview> | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState("");
  const [parent, setParent] = useState<UnitRow | null>(null),
    [detail, setDetail] = useState<UnitDetail | null>(null);
  const [change, setChange] = useState<{
    row: UnitRow;
    kind: "rename" | "archive" | "restore";
  } | null>(null);
  const [unitStatus, setUnitStatus] = useState<"active" | "archived">("active");
  const [viewMode, setViewMode] = useState<"table" | "tree">("table");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [name, setName] = useState(""),
    [reason, setReason] = useState(""),
    [password, setPassword] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const [demo, setDemo] = useState(false),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState<Submission | null>(null);
  const generation = useRef(0),
    formTitle = useRef<HTMLHeadingElement>(null),
    busyRef = useRef(false);
  const fail = (e: unknown) => {
    const status = (e as { response?: { status?: number } })?.response?.status;
    return status === 403
      ? label("Access denied or revoked.", "წვდომა არ გაქვთ ან გაუქმებულია.")
      : status === 409
        ? label(
            "Request expired or conditions changed. Refresh and review again.",
            "მოთხოვნის ვადა ან პირობები შეიცვალა. განაახლეთ და გადაამოწმეთ.",
          )
        : label(
            "Could not confirm the result. Check your connection and retry.",
            "შედეგი ვერ დადასტურდა. შეამოწმეთ კავშირი და სცადეთ ხელახლა.",
          );
  };
  useEffect(() => {
    let live = true;
    unitApi
      .contexts()
      .then((rows) => {
        if (live) {
          setContexts(rows);
          setOrg((current) =>
            rows.some((r) => r.id === current) ? current : (rows[0]?.id ?? ""),
          );
        }
      })
      .catch((e) => {
        if (live) {
          setContexts(null);
          setOrg("");
          setData(null);
          setError(fail(e));
        }
      });
    return () => {
      live = false;
    };
  }, [revision]);
  useEffect(() => {
    let live = true;
    if (import.meta.env.DEV)
      void demoApi
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
    const timer = setTimeout(() => {
      setFilter(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const readScope1Key = JSON.stringify([
    org,
    page,
    tab,
    filter,
    revision,
    unitStatus,
  ]);
  const [readScope1, setReadScope1] = useState(readScope1Key);
  // Reconcile scope before committing children, so previous-scope records cannot flash.
  if (readScope1 !== readScope1Key) {
    setReadScope1(readScope1Key);
    setLoading(true);
    setData(null);
  }
  useEffect(() => {
    if (!org) return;
    let live = true;
    (tab === "units"
      ? unitApi.units(org, page, filter, unitStatus)
      : unitApi.reviews(org, page, tab)
    )
      .then((r) => {
        if (live) setData(r);
      })
      .catch((e) => {
        if (live) {
          setError(fail(e));
          setDetail(null);
          setParent(null);
          setChange(null);
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [org, page, tab, filter, revision, unitStatus]);
  useEffect(() => {
    if (parent || detail || change) formTitle.current?.focus();
  }, [parent, detail, change]);
  useEffect(() => {
    if (!parent && !detail && !change && !retry) return;
    const guard = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [parent, detail, change, retry]);
  function clear() {
    generation.current++;
    setParent(null);
    setDetail(null);
    setChange(null);
    setName("");
    setReason("");
    setPassword("");
    setConfirmed(false);
  }
  function refresh() {
    clear();
    setError("");
    setRevision((v) => v + 1);
  }
  useInboxTarget("unit", org, (id) => void open(id));
  async function open(id: string) {
    const version = ++generation.current;
    setError("");
    setLoading(true);
    try {
      const row = await unitApi.detail(org, id);
      if (version === generation.current) {
        setDetail(row);
        setParent(null);
        setChange(null);
        setReason("");
        setConfirmed(false);
      }
    } catch (e) {
      if (version === generation.current) setError(fail(e));
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }
  async function send(submission: Submission) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setRetry(submission);
    try {
      if (demo) await demoApi.stepUp();
      else await authApi.stepUp(password);
      setPassword("");
      if (submission.kind === "propose") await unitApi.propose(submission.data);
      else if (submission.kind === "change")
        await unitApi.change(submission.data);
      else await unitApi.decide(submission.data);
      setRetry(null);
      clear();
      setNotice(label("Saved.", "შენახულია."));
      setTab(submission.kind !== "decide" ? "mine" : "history");
      setPage(1);
      setRevision((v) => v + 1);
      window.dispatchEvent(new Event("ertad-reviews-changed"));
    } catch (e) {
      setError(fail(e));
      const status = (e as { response?: { status?: number } })?.response
        ?.status;
      if (status && status < 500) {
        setRetry(null);
        if (status === 403 || status === 409) {
          clear();
          setData(null);
        }
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  function propose(e: FormEvent) {
    e.preventDefault();
    if (retry) return;
    if (change) {
      if (change.kind !== "rename" && !confirmed) return;
      void send({
        kind: "change",
        data: {
          organizationId: org,
          unitId: change.row.id,
          version: change.row.version,
          kind: change.kind,
          ...(change.kind === "rename" ? { name: name.trim() } : {}),
          reason: reason.trim(),
          expiresAt: new Date(Date.now() + 6 * 86400_000).toISOString(),
          key: crypto.randomUUID(),
        },
      });
      return;
    }
    if (!parent) return;
    void send({
      kind: "propose",
      data: {
        organizationId: org,
        parentId: parent.id,
        name: name.trim(),
        reason: reason.trim(),
        expiresAt: new Date(Date.now() + 6 * 86400_000).toISOString(),
        key: crypto.randomUUID(),
      },
    });
  }
  function decide(decision: "approved" | "rejected") {
    if (!detail || !confirmed || reason.trim().length < 10 || retry) return;
    void send({
      kind: "decide",
      data: {
        organizationId: org,
        id: detail.id,
        decision,
        reason: reason.trim(),
        key: crypto.randomUUID(),
      },
    });
  }
  const editing = !!parent || !!detail || !!change || !!retry || busy;
  const kindLabel = (kind: string) =>
    ({
      create: label("Create", "შექმნა"),
      rename: label("Rename", "სახელის შეცვლა"),
      archive: label("Archive", "არქივირება"),
      restore: label("Restore", "აღდგენა"),
    })[kind] ?? kind;
  const blockerLabel = (code: string) =>
    ({
      children: label("Child units", "ქვედანაყოფები"),
      memberships: label("Membership records", "წევრობის ჩანაწერები"),
      positions: label("Positions", "თანამდებობები"),
      work: label("Task records", "დავალებების ჩანაწერები"),
      decisions: label("Poll records", "პოლების ჩანაწერები"),
      channels: label("Channels", "არხები"),
      events: label("Event records", "ღონისძიებები"),
      governance: label("Approval records", "დამტკიცების ჩანაწერები"),
      policies: label("Management policies", "მართვის წესები"),
      qualifications: label("Qualifications", "კვალიფიკაციები"),
      contribution: label("Points rules", "ქულების წესები"),
      activity: label("Activity history", "აქტივობის ისტორია"),
      work_reviews: label("Task reviews", "დავალებების განხილვები"),
      membership_requests: label("Pending memberships", "წევრობის მოთხოვნები"),
      unit_requests: label(
        "Pending unit changes",
        "ერთეულის მიმდინარე მოთხოვნები",
      ),
    })[code] ?? label("Linked records", "დაკავშირებული ჩანაწერები");
  const statusLabel = (s: string) =>
    ({
      pending: label("Pending", "მოლოდინში"),
      approved: label("Approved", "დამტკიცებული"),
      rejected: label("Rejected", "უარყოფილი"),
      expired: label("Expired", "ვადაგასული"),
    })[s] ?? s;
  return (
    <section className="review-page">
      <header>
        <h1>{label("Groups and regions", "ჯგუფები და რეგიონები")}</h1>
        <p>
          {label(
            "Create, rename or archive units within your scope through independent approval.",
            "ერთეულების შექმნა, სახელის შეცვლა და არქივირება თქვენს ფარგლებში დამოუკიდებელი დამტკიცებით.",
          )}
        </p>
        <Link className="subtle-link" to="/reviews">
          {label("Membership requests", "დანიშვნის მოთხოვნები")}
        </Link>
      </header>
      {error && (
        <div role="alert">
          {error}{" "}
          {!retry && (
            <Button disabled={busy} onClick={refresh}>
              {label("Retry", "ხელახლა ცდა")}
            </Button>
          )}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {!contexts && !error && (
        <p role="status">{label("Loading…", "იტვირთება…")}</p>
      )}
      {contexts?.length === 0 && (
        <p>
          {label(
            "No hierarchy access is assigned.",
            "სტრუქტურაზე წვდომა მინიჭებული არ არის.",
          )}
        </p>
      )}
      {contexts && contexts.length > 0 && (
        <>
          {choosingParent && !parent && (
            <Card>
              <h2>
                {label(
                  "Choose where to create the group",
                  "აირჩიე სად შეიქმნას ჯგუფი",
                )}
              </h2>
              <p>
                {!loading &&
                data &&
                !(data.items as UnitRow[]).some(
                  (u) => "canPropose" in u && u.canPropose,
                )
                  ? label(
                      "You do not have permission to propose a new group in this organization.",
                      "ამ ორგანიზაციაში ახალი ჯგუფის შეთავაზების უფლება არ გაქვთ.",
                    )
                  : label(
                      "Find the region or parent group below and select Create group here. Enter a name and reason; a different authorized administrator must approve the request.",
                      "ქვემოთ მოძებნე რეგიონი ან ზედა ჯგუფი და აირჩიე „აქ ჯგუფის შექმნა“. მიუთითე სახელი და მიზეზი; მოთხოვნა სხვა უფლებამოსილმა ადმინისტრატორმა უნდა დაამტკიცოს.",
                    )}
              </p>
            </Card>
          )}
          <nav
            className="review-tabs"
            aria-label={label("Hierarchy views", "სტრუქტურის ხედები")}
          >
            {[
              ["units", label("Units", "ერთეულები")],
              ["pending", label("Needs my decision", "დასადასტურებელი")],
              ["mine", label("My requests", "ჩემი მოთხოვნები")],
              ["history", label("History", "ისტორია")],
            ].map(([value, text]) => (
              <Button
                key={value}
                variant="secondary"
                aria-current={tab === value ? "page" : undefined}
                disabled={editing}
                onClick={() => {
                  setTab(value);
                  setPage(1);
                  setError("");
                }}
              >
                {text}
              </Button>
            ))}
          </nav>
          {tab === "units" && (
            <div className="review-toolbar">
              <Input
                label={label("Search units", "ერთეულების ძებნა")}
                maxLength={80}
                value={search}
                disabled={editing}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Select
                label={label("Unit status", "ერთეულის სტატუსი")}
                value={unitStatus}
                disabled={editing}
                onChange={(e) => {
                  setUnitStatus(e.target.value as "active" | "archived");
                  setPage(1);
                }}
                options={[
                  { value: "active", label: label("Active", "მოქმედი") },
                  { value: "archived", label: label("Archived", "არქივი") },
                ]}
              />
              <div className="task-display-toggle" role="group" aria-label={label("Display layout", "ჩვენების რეჟიმი")}>
                <Button
                  type="button"
                  size="sm"
                  variant={viewMode === "table" ? "primary" : "secondary"}
                  aria-pressed={viewMode === "table"}
                  onClick={() => setViewMode("table")}
                >
                  <List size={15} aria-hidden="true" />
                  {label("List", "ცხრილი")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={viewMode === "tree" ? "primary" : "secondary"}
                  aria-pressed={viewMode === "tree"}
                  onClick={() => setViewMode("tree")}
                >
                  <Network size={15} aria-hidden="true" />
                  {label("Visual Tree", "იერარქიული ხე")}
                </Button>
              </div>
            </div>
          )}
          {loading && <p role="status">{label("Loading…", "იტვირთება…")}</p>}
          {data && !loading && (
            <Card>
              <p>
                {label("Matching items", "ჩანაწერების რაოდენობა")}: {data.total}
              </p>
              {!data.items.length ? (
                <p>
                  {label(
                    "No items in this view.",
                    "ამ ხედში ჩანაწერები არ არის.",
                  )}
                </p>
              ) : tab === "units" && viewMode === "tree" ? (
                (() => {
                  const unitRows = data.items as UnitRow[];
                  const visibleIds = new Set(unitRows.map((u) => u.id));
                  const childrenMap = new Map<string | null, UnitRow[]>();
                  for (const u of unitRows) {
                    const parentKey =
                      u.parent_id && visibleIds.has(u.parent_id)
                        ? u.parent_id
                        : null;
                    const list = childrenMap.get(parentKey) ?? [];
                    list.push(u);
                    childrenMap.set(parentKey, list);
                  }
                  const renderBranch = (parentKey: string | null, depth: number) => {
                    const nodes = childrenMap.get(parentKey) ?? [];
                    if (!nodes.length) return null;
                    return (
                      <ul role={depth === 0 ? undefined : "group"} className="unit-tree-branch">
                        {nodes.map((node) => {
                          const kids = childrenMap.get(node.id) ?? [];
                          const isCollapsed = !!collapsed[node.id];
                          return (
                            <li
                              key={node.id}
                              role="treeitem"
                              aria-expanded={kids.length ? !isCollapsed : undefined}
                              className="unit-tree-item"
                            >
                              <div className="unit-tree-node">
                                <div className="flex items-center gap-2 min-w-0">
                                  {kids.length > 0 ? (
                                    <button
                                      type="button"
                                      className="unit-tree-toggle"
                                      aria-label={
                                        isCollapsed
                                          ? label("Expand group", "გაშლა")
                                          : label("Collapse group", "ჩაკეცვა")
                                      }
                                      onClick={() =>
                                        setCollapsed((prev) => ({
                                          ...prev,
                                          [node.id]: !prev[node.id],
                                        }))
                                      }
                                    >
                                      {isCollapsed ? (
                                        <ChevronRight size={16} aria-hidden="true" />
                                      ) : (
                                        <ChevronDown size={16} aria-hidden="true" />
                                      )}
                                    </button>
                                  ) : (
                                    <span className="unit-tree-leaf-dot" aria-hidden="true" />
                                  )}
                                  <strong className="break-words">{node.name}</strong>
                                  <span className="status-badge" data-status={node.status === "active" ? "approved" : undefined}>
                                    {statusLabel(node.status)}
                                  </span>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  {node.canPropose && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      disabled={editing}
                                      onClick={() => {
                                        clear();
                                        setParent(node);
                                        setNotice("");
                                      }}
                                    >
                                      {label("Create group here", "აქ ჯგუფის შექმნა")}
                                    </Button>
                                  )}
                                  {node.canChange && node.status === "active" && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      disabled={editing}
                                      onClick={() => {
                                        clear();
                                        setChange({ row: node, kind: "rename" });
                                        setName(node.name);
                                        setNotice("");
                                      }}
                                    >
                                      {kindLabel("rename")}
                                    </Button>
                                  )}
                                </div>
                              </div>
                              {!isCollapsed && renderBranch(node.id, depth + 1)}
                            </li>
                          );
                        })}
                      </ul>
                    );
                  };
                  return (
                    <div role="tree" aria-label={label("Unit hierarchy tree", "ორგანიზაციული იერარქიის ხე")} className="unit-tree-root">
                      {renderBranch(null, 0)}
                    </div>
                  );
                })()
              ) : (
                <div
                  className="review-table-scroll"
                  tabIndex={0}
                  role="region"
                  aria-label={label(
                    "Groups and requests",
                    "ჯგუფები და მოთხოვნები",
                  )}
                >
                  <table>
                    <thead>
                      <tr>
                        <th>{label("Name", "სახელი")}</th>
                        <th>
                          {tab === "units"
                            ? label("Parent", "ზედა ერთეული")
                            : label(
                                "Parent / status",
                                "ზედა ერთეული / სტატუსი",
                              )}
                        </th>
                        <th>{label("Action", "მოქმედება")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((row) => (
                        <tr key={row.id}>
                          <td>
                            {row.name}
                            {!("canPropose" in row) && (
                              <p className="text-sm">{kindLabel(row.kind)}</p>
                            )}
                          </td>
                          <td>
                            {"canPropose" in row ? (
                              <span>
                                {row.parent_name ??
                                  label(
                                    "Scope root",
                                    "წვდომის საწყისი ერთეული",
                                  )}
                              </span>
                            ) : (
                              <>
                                {row.parent_name} · {statusLabel(row.status)}
                              </>
                            )}
                          </td>
                          <td>
                            {"canPropose" in row ? (
                              <>
                                {row.canPropose && (
                                  <Button
                                    variant="ghost"
                                    disabled={editing}
                                    onClick={() => {
                                      clear();
                                      setParent(row);
                                      setNotice("");
                                    }}
                                  >
                                    {label(
                                      "Create group here",
                                      "აქ ჯგუფის შექმნა",
                                    )}
                                  </Button>
                                )}
                                {row.canChange && row.status === "archived" && (
                                  <Button
                                    variant="ghost"
                                    disabled={editing}
                                    onClick={() => {
                                      clear();
                                      setChange({ row, kind: "restore" });
                                      setNotice("");
                                    }}
                                  >
                                    {kindLabel("restore")}
                                  </Button>
                                )}
                                {row.canChange && row.status === "active" && (
                                  <>
                                    <Button
                                      variant="ghost"
                                      disabled={editing}
                                      onClick={() => {
                                        clear();
                                        setChange({ row, kind: "rename" });
                                        setName(row.name);
                                        setNotice("");
                                      }}
                                    >
                                      {kindLabel("rename")}
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      disabled={
                                        editing ||
                                        row.archiveBlockers.length > 0
                                      }
                                      onClick={() => {
                                        clear();
                                        setChange({ row, kind: "archive" });
                                        setNotice("");
                                      }}
                                    >
                                      {kindLabel("archive")}
                                    </Button>
                                    {row.archiveBlockers.length > 0 && (
                                      <p className="text-sm">
                                        {label(
                                          "Archive blocked: ",
                                          "არქივირებას აფერხებს: ",
                                        )}
                                        {row.archiveBlockers
                                          .map(blockerLabel)
                                          .join(", ")}
                                      </p>
                                    )}
                                  </>
                                )}
                              </>
                            ) : (
                              <Button
                                variant="ghost"
                                disabled={editing}
                                onClick={() => void open(row.id)}
                              >
                                {label("Details", "დეტალები")}
                              </Button>
                            )}
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
                  disabled={editing || page === 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  {label("Previous", "წინა")}
                </Button>
                <span>{page}</span>
                <Button
                  variant="secondary"
                  disabled={editing || page * 25 >= data.total}
                  onClick={() => setPage((p) => p + 1)}
                >
                  {label("Next", "შემდეგი")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={editing}
                  onClick={refresh}
                >
                  {label("Refresh", "განახლება")}
                </Button>
              </div>
            </Card>
          )}
          {(parent || detail || change) && (
            <Card>
              <h2 ref={formTitle} tabIndex={-1}>
                {change
                  ? kindLabel(change.kind) + ": " + change.row.name
                  : parent
                    ? label("New unit under: ", "ახალი ერთეული: ") + parent.name
                    : detail?.name}
              </h2>
              {detail && (
                <dl className="review-details">
                  <dt>{label("Change", "ცვლილება")}</dt>
                  <dd>{kindLabel(detail.kind)}</dd>
                  {detail.original_name && (
                    <>
                      <dt>{label("Original name", "საწყისი სახელი")}</dt>
                      <dd>{detail.original_name}</dd>
                    </>
                  )}
                  <dt>{label("Parent", "ზედა ერთეული")}</dt>
                  <dd>{detail.parent_name}</dd>
                  <dt>{label("Reason", "მიზეზი")}</dt>
                  <dd>{detail.reason}</dd>
                  <dt>{label("Status", "სტატუსი")}</dt>
                  <dd>{statusLabel(detail.status)}</dd>
                  <dt>{label("Deadline", "ბოლო ვადა")}</dt>
                  <dd>
                    {new Date(detail.expires_at).toLocaleString(
                      ka ? "ka-GE" : "en-GB",
                    )}
                  </dd>
                  {detail.decision_reason && (
                    <>
                      <dt>
                        {label("Decision reason", "გადაწყვეტილების მიზეზი")}
                      </dt>
                      <dd>{detail.decision_reason}</dd>
                    </>
                  )}
                </dl>
              )}
              {(parent || change || detail?.canDecide) && (
                <form
                  className="review-form"
                  onSubmit={
                    parent || change ? propose : (e) => e.preventDefault()
                  }
                >
                  <fieldset disabled={busy || !!retry}>
                    {(parent || change?.kind === "rename") && (
                      <Input
                        label={label("Unit name", "ერთეულის სახელი")}
                        required
                        maxLength={160}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                      />
                    )}
                    <Input
                      label={label(
                        "Reason (10–1000 characters)",
                        "მიზეზი (10–1000 სიმბოლო)",
                      )}
                      required
                      minLength={10}
                      maxLength={1000}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                    {!demo && (
                      <Input
                        label={label(
                          "Password confirmation",
                          "პაროლის დადასტურება",
                        )}
                        type="password"
                        autoComplete="current-password"
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                    )}
                    {parent || change ? (
                      <>
                        <p>
                          {label(
                            "The request expires in six days.",
                            "მოთხოვნის ვადა ექვს დღეში იწურება.",
                          )}
                        </p>
                        {change?.kind === "archive" && (
                          <>
                            <p>
                              {label(
                                "Only empty units without attached operational records can be archived. The unit and approval history are retained.",
                                "არქივდება მხოლოდ ცარიელი ერთეული დაკავშირებული სამუშაო ჩანაწერების გარეშე. ერთეული და დამტკიცების ისტორია შენარჩუნდება.",
                              )}
                            </p>
                            <label className="review-confirm">
                              <input
                                type="checkbox"
                                checked={confirmed}
                                onChange={(e) => setConfirmed(e.target.checked)}
                              />
                              {label(
                                "I understand this unit will be archived after approval.",
                                "ვადასტურებ, რომ დამტკიცების შემდეგ ერთეული დაარქივდება.",
                              )}
                            </label>
                          </>
                        )}
                        {change?.kind === "restore" && (
                          <label className="review-confirm">
                            <input
                              type="checkbox"
                              checked={confirmed}
                              onChange={(e) => setConfirmed(e.target.checked)}
                            />
                            {label(
                              "I understand this unit will become active after approval.",
                              "ვადასტურებ, რომ დამტკიცების შემდეგ ერთეული კვლავ გააქტიურდება.",
                            )}
                          </label>
                        )}
                        <Button
                          type="submit"
                          disabled={
                            ((!change || change.kind === "rename") &&
                              (!name.trim() ||
                                (change?.kind === "rename" &&
                                  name.trim() === change.row.name))) ||
                            reason.trim().length < 10 ||
                            (!!change && change.kind !== "rename" && !confirmed)
                          }
                        >
                          {label("Submit request", "მოთხოვნის გაგზავნა")}
                        </Button>
                      </>
                    ) : (
                      <>
                        <label className="review-confirm">
                          <input
                            type="checkbox"
                            checked={confirmed}
                            onChange={(e) => setConfirmed(e.target.checked)}
                          />
                          {label(
                            "I reviewed this change.",
                            "გავეცანი ცვლილებას.",
                          )}
                        </label>
                        <div className="review-toolbar">
                          <Button
                            type="button"
                            disabled={
                              !confirmed ||
                              reason.trim().length < 10 ||
                              (!demo && !password)
                            }
                            onClick={() => decide("approved")}
                          >
                            {label("Approve", "დამტკიცება")}
                          </Button>
                          <Button
                            type="button"
                            disabled={
                              !confirmed ||
                              reason.trim().length < 10 ||
                              (!demo && !password)
                            }
                            onClick={() => decide("rejected")}
                          >
                            {label("Reject", "უარყოფა")}
                          </Button>
                        </div>
                      </>
                    )}
                  </fieldset>
                </form>
              )}
              {detail && !detail.canDecide && (
                <p>
                  {label(
                    "You cannot decide this request, or it is already closed.",
                    "ამ მოთხოვნაზე გადაწყვეტილებას ვერ მიიღებთ ან ის უკვე დასრულებულია.",
                  )}
                </p>
              )}
              {!retry && (
                <Button variant="secondary" disabled={busy} onClick={clear}>
                  {label("Close", "დახურვა")}
                </Button>
              )}
            </Card>
          )}
          {retry && (
            <Card>
              <p>
                {label(
                  "The same submission is retained on this page until its outcome is confirmed.",
                  "შედეგის დადასტურებამდე იგივე მოთხოვნა ამ გვერდზე შენარჩუნებულია.",
                )}
              </p>
              {!demo && (
                <Input
                  type="password"
                  label={label("Password confirmation", "პაროლის დადასტურება")}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              )}
              <Button disabled={busy} onClick={() => void send(retry)}>
                {label(
                  "Retry same submission",
                  "იმავე მოთხოვნის ხელახლა გაგზავნა",
                )}
              </Button>
            </Card>
          )}
        </>
      )}
    </section>
  );
}
