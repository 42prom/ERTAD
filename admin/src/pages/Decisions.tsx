import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus, ArrowLeft, Clock, Users, CheckCircle, Download } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { downloadSafeCsv } from "../utils/safeCsv";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import DecisionComposer from "../components/DecisionComposer";
import { newComposerDraft } from "../components/decisionDraft";
import { SurveyResponse, SurveyResults } from "../components/SurveyFields";
import { validSurveyAnswers } from "../components/surveyModel";
import { useConsolePreferences } from "../components/useConsolePreferences";
import { useInboxTarget } from "../components/useInboxTarget";
import { authApi } from "../api/client";
import { demoApi } from "../api/demo";
import {
  decisionApi,
  type Decision,
  type DecisionKind,
  type DecisionContext,
  type DecisionPage,
  type DecisionWrite,
  type SurveyAnswers,
} from "../api/decisions";

export default function Decisions() {
  const { language } = useConsolePreferences();
  const ka = language === "ka";
  const t = (ge: string, en: string) => (ka ? ge : en);
  const [params, setParams] = useSearchParams();
  const view = ["draft", "scheduled", "closed", "cancelled"].includes(
    params.get("view") ?? "",
  )
    ? params.get("view")!
    : "open";
  const [contexts, setContexts] = useState<DecisionContext[] | null>(null);
  const [audiences, setAudiences] = useState<DecisionContext[]>([]);
  const [org, setOrg] = useState("");
  const [data, setData] = useState<DecisionPage | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [detail, setDetail] = useState<Decision | null>(null);
  const [editing, setEditing] = useState(false);
  const [editId, setEditId] = useState("");
  const [version, setVersion] = useState(1);
  const [draft, setDraft] = useState(() => newComposerDraft());
  const [estimateState, setEstimateState] = useState<{
    key: string;
    data: {
      electorateCount: number;
      meetsAnonymousFloor: boolean;
      anonymousMinElectorate?: number;
      policyMinElectorate?: number;
    } | null;
  }>({ key: "", data: null });
  const estimateKey =
    editing && org && draft.includedUnitIds.length
      ? JSON.stringify([
          org,
          draft.includedUnitIds,
          draft.excludedUnitIds,
          draft.privacy === "anonymous" ? draft.anonymousMinElectorate ?? null : null,
        ])
      : "";
  const estimate =
    estimateKey && estimateState.key === estimateKey
      ? estimateState.data
      : null;
  const policyFloor =
    contexts?.find((c) => c.id === org)?.anonymousMinElectorate ??
    estimate?.policyMinElectorate;
  const [nomineeLabel, setNomineeLabel] = useState("");
  const [withdrawReason, setWithdrawReason] = useState("");
  const [answers, setAnswers] = useState<SurveyAnswers>({});
  const [demo, setDemo] = useState(false);
  const [password, setPassword] = useState("");
  const [choice, setChoice] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState<DecisionWrite | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<{
    title: string;
    digest: string;
  } | null>(null);
  const [verifyDigest, setVerifyDigest] = useState("");
  const lock = useRef(false);
  const generation = useRef(0);
  const formTitle = useRef<HTMLHeadingElement>(null);
  const locked = busy || !!pending;

  const failure = (e: unknown) => {
    const status = (e as { response?: { status?: number } })?.response?.status;
    return status === 403
      ? t("წვდომა არ გაქვს ან უფლება გაუქმდა.", "Access denied or revoked.")
      : status === 409
        ? t(
            "პული შეიცვალა, ვადა ამოიწურა ან მოქმედება უკვე შესრულდა. განაახლე დეტალები.",
            "The poll changed, expired or the action was already completed. Refresh its details.",
          )
        : status === 400
          ? t(
              "შეამოწმე ველები, პასუხები და დასრულების დრო.",
              "Check the fields, options and closing time.",
            )
          : t(
              "შედეგი ვერ დადასტურდა. შეამოწმე კავშირი და სცადე ხელახლა.",
              "Could not confirm the result. Check your connection and retry.",
            );
  };

  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      decisionApi
        .contexts()
        .then((rows) => {
          if (live) {
            setContexts(rows);
            setOrg((old) =>
              rows.some((r) => r.id === old) ? old : (rows[0]?.id ?? ""),
            );
          }
        })
        .catch((e) => {
          if (live) {
            setError(failure(e));
            setContexts(null);
            setData(null);
          }
        });
    }, 0);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, []);

  useEffect(() => {
    let live = true;
    if (import.meta.env.DEV) {
      const t = window.setTimeout(() => {
        void demoApi
          .scenario()
          .then(() => {
            if (live) setDemo(true);
          })
          .catch(() => {});
      }, 0);
      return () => {
        live = false;
        window.clearTimeout(t);
      };
    }
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

  const readScope1Key = JSON.stringify([org, view, page, filter, revision]);
  const [readScope1, setReadScope1] = useState(readScope1Key);
  if (readScope1 !== readScope1Key) {
    setReadScope1(readScope1Key);
    setLoading(true);
    setData(null);
  }

  useEffect(() => {
    if (!org) return;
    let live = true;
    const t = window.setTimeout(() => {
      decisionApi
        .audiences(org)
        .then((rows) => {
          if (live) setAudiences(rows);
        })
        .catch(() => {
          if (live) setAudiences([]);
        });
    }, 0);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [org]);

  useEffect(() => {
    if (!org) return;
    let live = true;
    const t = window.setTimeout(() => {
      decisionApi
        .list(org, view, page, filter)
        .then((list) => {
          if (live) setData(list);
        })
        .catch((e) => {
          if (live) {
            setError(failure(e));
            setDetail(null);
          }
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    }, 0);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [org, view, page, filter, revision]);

  useEffect(() => {
    if (!estimateKey || !decisionApi.estimate) return;
    let live = true;
    void decisionApi
      .estimate(
        org,
        draft.includedUnitIds,
        draft.excludedUnitIds,
        draft.privacy === "anonymous" ? draft.anonymousMinElectorate : undefined,
      )
      .then((res) => {
        if (live) setEstimateState({ key: estimateKey, data: res });
      })
      .catch(() => {
        if (live) setEstimateState({ key: estimateKey, data: null });
      });
    return () => {
      live = false;
    };
  }, [
    estimateKey,
    org,
    draft.includedUnitIds,
    draft.excludedUnitIds,
    draft.privacy,
    draft.anonymousMinElectorate,
  ]);

  useEffect(() => {
    if (editing || detail) formTitle.current?.focus();
  }, [editing, detail]);

  useEffect(() => {
    if (!editing && !pending) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editing, pending]);

  const status = (value: string) =>
    ({
      draft: t("დრაფტი", "Draft"),
      scheduled: t("დაგეგმილი", "Scheduled"),
      open: t("მიმდინარე", "Open"),
      closed: t("დასრულებული", "Closed"),
      cancelled: t("გაუქმებული", "Cancelled"),
    })[value] ?? value;

  function reset() {
    generation.current++;
    setEditing(false);
    setDetail(null);
    setChoice("");
    setAnswers({});
    setConfirmed(false);
    setPassword("");
    setNomineeLabel("");
    setWithdrawReason("");
  }

  function create(row?: Decision, kind: DecisionKind = "poll") {
    setEditId(row?.id ?? "");
    setVersion(row?.version ?? 1);
    const next = newComposerDraft(row, audiences[0]?.id ?? "");
    if (!row) {
      next.kind = kind;
      next.options =
        kind === "survey"
          ? []
          : kind === "referendum"
            ? ["Yes", "No", "Abstain"]
            : ["", ""];
    }
    setDraft(next);
    setDetail(null);
    setEditing(true);
    setError("");
    setNotice("");
  }

  async function open(id: string) {
    const request = ++generation.current;
    setDetail(null);
    setEditing(false);
    setLoading(true);
    setError("");
    try {
      const row = await decisionApi.detail(org, id);
      if (request === generation.current) {
        setDetail(row);
        setEditing(false);
        setChoice("");
        setAnswers({});
        setConfirmed(false);
        setNomineeLabel("");
        setWithdrawReason("");
        setVerifyDigest("");
      }
    } catch (e) {
      if (request === generation.current) setError(failure(e));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }

  useInboxTarget("decision", org, open);

  async function send(input: DecisionWrite) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setPending(input);
    setError("");
    setNotice("");
    try {
      if (demo) await demoApi.stepUp();
      else await authApi.stepUp(password);
      setPassword("");
      const votedTitle = detail?.title ?? "";
      const result = await decisionApi.write(input);
      setPending(null);
      reset();
      if (input.operation === "vote" && result.receiptDigest) {
        setLastReceipt({ title: votedTitle, digest: result.receiptDigest });
      }
      setNotice(t("მოქმედება შენახულია.", "Action saved."));
      const nextView = input.operation === "vote" ? "open" : result.status;
      setParams({ view: nextView });
      setSearch("");
      setFilter("");
      setPage(1);
      setRevision((v) => v + 1);
      window.dispatchEvent(new Event("ertad-inbox-changed"));
    } catch (e) {
      setError(failure(e));
      const code = (e as { response?: { status?: number } })?.response?.status;
      if (code && code < 500 && code !== 429) {
        setPending(null);
        if (code === 403 || code === 409) {
          reset();
          setData(null);
          setRevision((v) => v + 1);
        }
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    const refLabels =
      draft.kind === "referendum" &&
      (draft.yesLabel.trim() ||
        draft.noLabel.trim() ||
        draft.abstainLabel.trim())
        ? {
            ...(draft.yesLabel.trim() ? { yes: draft.yesLabel.trim() } : {}),
            ...(draft.noLabel.trim() ? { no: draft.noLabel.trim() } : {}),
            ...(draft.abstainLabel.trim()
              ? { abstain: draft.abstainLabel.trim() }
              : {}),
          }
        : undefined;
    const fields = {
      organizationId: org,
      key: crypto.randomUUID(),
      unitId: draft.unitId,
      title: draft.title.trim(),
      description: draft.description.trim(),
      options: draft.options.map((option) => option.trim()),
      kind: draft.kind,
      ...(draft.privacy === "anonymous"
        ? {
            privacy: "anonymous" as const,
            ...(draft.anonymousMinElectorate !== undefined
              ? { anonymousMinElectorate: draft.anonymousMinElectorate }
              : {}),
          }
        : {}),
      ...(draft.governanceMode === "binding_review"
        ? { governanceMode: "binding_review" as const }
        : {}),
      ...(draft.includedUnitIds.length > 1 || draft.excludedUnitIds.length > 0
        ? {
            includedUnitIds: draft.includedUnitIds,
            excludedUnitIds: draft.excludedUnitIds,
          }
        : {}),
      ...(draft.opensAt
        ? { opensAt: new Date(draft.opensAt).toISOString() }
        : {}),
      ...(refLabels ? { referendumLabels: refLabels } : {}),
      ...(draft.kind === "referendum" ? { threshold: draft.threshold } : {}),
      ...(draft.kind === "survey" ? { questions: draft.questions } : {}),
      quorum: draft.quorum,
      closesAt: new Date(draft.deadline).toISOString(),
    };
    void send(
      editId
        ? { ...fields, operation: "update", id: editId, version }
        : { ...fields, operation: "create" },
    );
  }

  const transition = (operation: "publish" | "close" | "cancel") => {
    if (detail && confirmed)
      void send({
        operation,
        organizationId: org,
        id: detail.id,
        version: detail.version,
        key: crypto.randomUUID(),
      });
  };

  const nominate = () => {
    if (detail && nomineeLabel.trim()) {
      void send({
        operation: "nominate",
        organizationId: org,
        id: detail.id,
        version: detail.version,
        key: crypto.randomUUID(),
        candidateLabel: nomineeLabel.trim(),
      });
    }
  };

  const withdrawCandidate = (candidateLabel: string) => {
    if (detail && withdrawReason.trim().length >= 3) {
      void send({
        operation: "withdraw_nomination",
        organizationId: org,
        id: detail.id,
        version: detail.version,
        key: crypto.randomUUID(),
        candidateLabel,
        reason: withdrawReason.trim(),
      });
    }
  };

  const vote = () => {
    if (!detail || !confirmed) return;
    if (detail.kind === "survey") {
      if (validSurveyAnswers(detail.questions ?? [], answers))
        void send({
          operation: "vote",
          organizationId: org,
          id: detail.id,
          key: crypto.randomUUID(),
          answers,
        });
    } else if (choice !== "")
      void send({
        operation: "vote",
        organizationId: org,
        id: detail.id,
        key: crypto.randomUUID(),
        choice: Number(choice),
      });
  };

  const [handledCreate, setHandledCreate] = useState(false);
  const wantsCreate = params.get("create") === "1";
  if (wantsCreate && audiences.length && !editing && !handledCreate) {
    setHandledCreate(true);
    create();
  }
  if (!wantsCreate && handledCreate) setHandledCreate(false);
  useEffect(() => {
    if (wantsCreate && handledCreate)
      setParams({ view: "draft" }, { replace: true });
  }, [wantsCreate, handledCreate, setParams]);

  const kindLabel = (kind: string | undefined) =>
    kind === "survey"
      ? t("გამოკითხვა", "Survey")
      : kind === "referendum"
        ? t("რეფერენდუმი", "Referendum")
        : kind === "election"
          ? t("არჩევნები", "Election")
          : t("პული", "Poll");

  const optionLabel = (label: string) => {
    if (detail?.kind !== "referendum") return label;
    if (label === "Yes") {
      return detail.referendumLabels?.yes || t("ვეთანხმები", "Yes");
    }
    if (label === "No") {
      return detail.referendumLabels?.no || t("არ ვეთანხმები", "No");
    }
    if (label === "Abstain") {
      return detail.referendumLabels?.abstain || t("თავს ვიკავებ", "Abstain");
    }
    return label;
  };

  const quorumReached =
    detail?.quorumMet ??
    (detail ? (detail.participation ?? 0) * 100 >= detail.electorate * detail.quorum : false);

  return (
    <section className="review-page decisions-page">
      <header className="decision-page-header">
        <div>
          <h1>{t("პულები", "Polls")}</h1>
          <p>
            {t(
              "შექმენი გამოკითხვა, შეარჩიე აუდიტორია და მიიღე გადაწყვეტილების საფუძველი.",
              "Create a poll, select an audience and collect responses.",
            )}
          </p>
        </div>
        {!editing && !detail && audiences.length > 0 && (
          <div className="review-toolbar">
            {decisionApi.report && (
              <Button
                variant="secondary"
                disabled={locked}
                onClick={async () => {
                  try {
                    const report = await decisionApi.report(org, view, filter);
                    downloadSafeCsv(
                      `ertad-decisions-${view}.csv`,
                      [
                        "Title",
                        "Unit",
                        "Kind",
                        "Status",
                        "Privacy",
                        "Governance",
                        "Electorate",
                        "Quorum%",
                        "Participation",
                        "ClosesAt",
                      ],
                      report.items.map((item) => [
                        item.title,
                        item.unitName,
                        item.kind,
                        item.status,
                        item.privacy,
                        item.governanceMode,
                        item.electorate,
                        item.quorum,
                        item.participation ?? "",
                        item.closesAt,
                      ]),
                    );
                    setNotice(
                      report.truncated
                        ? t(
                            "ექსპორტირებულია პირველი 250 ჩანაწერი (პირადი მონაცემების გარეშე).",
                            "Exported the first 250 aggregate records without personal data.",
                          )
                        : t(
                            "ანგარიში ჩამოიტვირთა პირადი მონაცემების გარეშე.",
                            "Privacy-safe aggregate report downloaded.",
                          ),
                    );
                  } catch (e) {
                    setError(failure(e));
                  }
                }}
              >
                <Download size={16} aria-hidden="true" />
                {t("ანგარიშის ექსპორტი (CSV)", "Export report")}
              </Button>
            )}
            <Button disabled={locked} onClick={() => create()}>
              <Plus size={17} aria-hidden="true" />
              {t("შექმნა", "Create")}
            </Button>
          </div>
        )}
      </header>
      {error && (
        <div role="alert">
          {error}{" "}
          {!pending && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setError("");
                setRevision((v) => v + 1);
              }}
            >
              {t("განახლება", "Refresh")}
            </Button>
          )}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {lastReceipt && (
        <Card className="decision-receipt-card">
          <div className="review-toolbar">
            <div>
              <strong>
                {t("ანონიმური ბიულეტენის ქვითარი", "Anonymous ballot receipt")}
              </strong>
              {lastReceipt.title ? ` · ${lastReceipt.title}` : ""}
              <p>
                {t(
                  "შეინახე ეს 16-ნიშნა კოდი ერთჯერადად: სისტემა არ ინახავს კავშირს შენს ანგარიშსა და ქვითარს შორის. დახურვის შემდეგ შეგიძლია შეამოწმო დათვლილ შედეგებში.",
                  "Save this 16-character digest once: the server does not link your account to this receipt. After closing, you can verify inclusion in the tallied receipts.",
                )}
              </p>
              <code className="decision-receipt-code">{lastReceipt.digest}</code>
            </div>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setLastReceipt(null)}
            >
              {t("დახურვა", "Dismiss")}
            </Button>
          </div>
        </Card>
      )}
      {contexts?.length === 0 && (
        <Card>
          <p>
            {t(
              "ამ ანგარიშს პულებზე წვდომა არ აქვს.",
              "This account has no poll access.",
            )}
          </p>
        </Card>
      )}
      {(loading || (!contexts && !error)) && (
        <p role="status">{t("იტვირთება…", "Loading…")}</p>
      )}
      {!!contexts?.length && !editing && !detail && (
        <>
          <nav
            className="review-tabs"
            aria-label={t("პულების ხედები", "Poll views")}
          >
            {["open", "scheduled", "draft", "closed", "cancelled"].map((v) => (
              <Button
                key={v}
                variant="secondary"
                aria-current={view === v ? "page" : undefined}
                disabled={locked}
                onClick={() => {
                  setParams({ view: v });
                  setPage(1);
                  setError("");
                }}
              >
                {status(v)}
              </Button>
            ))}
          </nav>
          <Input
            label={t("პულის ძებნა", "Search polls")}
            value={search}
            maxLength={80}
            disabled={locked}
            onChange={(e) => setSearch(e.target.value)}
          />
          {data && !loading && (
            <>
              <p className="decision-count">
                {t("პულების რაოდენობა", "Matching polls")}: {data.total}
              </p>
              <div className="decision-grid">
                {data.items.map((row) => (
                  <Card key={row.id} className="decision-card">
                    <span className="status-badge" data-status={row.status}>
                      {status(row.status)}
                    </span>
                    <p className="decision-kind">
                      {kindLabel(row.kind)}
                      {row.privacy === "anonymous"
                        ? ` · ${t("ანონიმური", "Anonymous")}`
                        : ""}
                    </p>
                    <h2>{row.title}</h2>
                    <p className="decision-description">{row.description}</p>
                    <p>
                      <Users size={15} aria-hidden="true" />
                      {row.unitName}
                    </p>
                    <p>
                      <Clock size={15} aria-hidden="true" />
                      {new Date(row.closesAt).toLocaleString(
                        ka ? "ka-GE" : "en-GB",
                        { hour12: false },
                      )}
                    </p>
                    {row.voted && (
                      <p>
                        <CheckCircle size={15} aria-hidden="true" />
                        {t("ხმა დაფიქსირებულია", "Participation recorded")}
                      </p>
                    )}
                    <Button
                      variant="secondary"
                      disabled={locked}
                      onClick={() => void open(row.id)}
                      aria-label={`${t("გახსნა", "Open")}: ${row.title}`}
                    >
                      {t("პულის გახსნა", "Open poll")}
                    </Button>
                  </Card>
                ))}
              </div>
              {!data.items.length && (
                <Card>
                  <h2>{t("პულები ჯერ არ არის", "No polls in this view")}</h2>
                  <p>
                    {t(
                      "შეცვალე ძებნა ან შექმენი ახალი პული.",
                      "Change your search or create a poll.",
                    )}
                  </p>
                </Card>
              )}
              <div className="review-toolbar">
                <Button
                  variant="secondary"
                  disabled={locked || page === 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  {t("წინა", "Previous")}
                </Button>
                <span>{page}</span>
                <Button
                  variant="secondary"
                  disabled={locked || page * 25 >= data.total}
                  onClick={() => setPage((p) => p + 1)}
                >
                  {t("შემდეგი", "Next")}
                </Button>
              </div>
            </>
          )}
        </>
      )}
      {editing && (
        <>
          <h2 ref={formTitle} tabIndex={-1}>
            {editId
              ? t("დრაფტის რედაქტირება", "Edit draft")
              : t("ახალი პული", "New poll")}
          </h2>
          <DecisionComposer
            draft={draft}
            onChange={setDraft}
            audiences={audiences}
            estimate={estimate}
            policyFloor={policyFloor}
            editing={!!editId}
            locked={locked}
            demo={demo}
            password={password}
            onPassword={setPassword}
            onSubmit={save}
            onCancel={() => {
              if (
                window.confirm(
                  t("დახურო შეუნახავი ცვლილებები?", "Discard unsaved changes?"),
                )
              )
                reset();
            }}
          />
        </>
      )}
      {detail && (
        <Card>
          <div className="review-toolbar">
            <Button variant="ghost" disabled={locked} onClick={reset}>
              <ArrowLeft size={16} aria-hidden="true" />
              {t("უკან", "Back")}
            </Button>
            <span className="status-badge" data-status={detail.status}>
              {status(detail.status)}
            </span>
          </div>
          <h2 ref={formTitle} tabIndex={-1}>
            {detail.title}
          </h2>
          <p className="decision-kind">
            {kindLabel(detail.kind)}
            {detail.governanceMode === "binding_review"
              ? ` · ${t("სავალდებულო (საჭიროებს დამოუკიდებელ განხილვას)", "Binding (requires independent review execution)")}`
              : ` · ${t("საკონსულტაციო", "Advisory")}`}
          </p>
          <p className="decision-description">{detail.description}</p>
          {detail.contributionOffer && (
            <p>
              {t("მონაწილეობისთვის ქულები", "Points for participation")}:{" "}
              {detail.contributionOffer.amount} ·{" "}
              {t("თვიური ზღვარი", "Monthly cap")}:{" "}
              {detail.contributionOffer.memberMonthCap}
            </p>
          )}
          {detail.kind === "survey" &&
            !detail.canVote &&
            !detail.surveyResults && (
              <div className="survey-preview">
                {(detail.questions ?? []).map((question, index) => (
                  <div key={question.id}>
                    <h4>
                      {index + 1}. {question.title}
                      {question.required ? " *" : ""}
                    </h4>
                    {"options" in question && (
                      <ol>
                        {question.options.map((option, i) => (
                          <li key={i}>{option}</li>
                        ))}
                      </ol>
                    )}
                  </div>
                ))}
              </div>
            )}
          <p>
            {detail.unitName} ·{" "}
            {detail.opensAt && (
              <>
                {t("იხსნება:", "Opens:")}{" "}
                {new Date(detail.opensAt).toLocaleString(
                  ka ? "ka-GE" : "en-GB",
                  { hour12: false },
                )}{" "}
                ·{" "}
              </>
            )}
            {t("სრულდება:", "Closes:")}{" "}
            {new Date(detail.closesAt).toLocaleString(ka ? "ka-GE" : "en-GB", {
              hour12: false,
            })}
          </p>
          <p className="decision-privacy">
            {detail.privacy === "anonymous"
              ? t(
                  "ანონიმური პული — ბიულეტენი განცალკევებულია ანგარიშისგან და არ იბმება მომხმარებელზე.",
                  "Anonymous poll — ballot choices are unlinkable and stored separately from member receipts.",
                )
              : t(
                  "არანონიმური პული — პასუხი ანგარიშთან დაკავშირებულად ინახება.",
                  "Named poll — responses are stored with the account.",
                )}
          </p>
          <p>
            {t("დაფიქსირებული აუდიტორია", "Frozen electorate")}:{" "}
            {detail.electorate} · {t("კვორუმი", "Quorum")}: {detail.quorum}%
            {detail.quorumRequired !== undefined
              ? ` (${t("საჭიროა", "required")}: ${detail.quorumRequired})`
              : ""}
            {detail.privacy === "anonymous" && detail.anonymousMinElectorate !== undefined
              ? ` · ${t("ანონიმურობის ზღვარი", "Anonymity floor")}: k ≥ ${detail.anonymousMinElectorate}`
              : ""}
          </p>
          {detail.voted && (
            <p role="status">
              {t("შენი ხმა დაფიქსირებულია.", "Your participation is recorded.")}
            </p>
          )}
          {detail.kind === "referendum" && (
            <p>
              {t("მხარდაჭერის ზღვარი", "Approval threshold")}:{" "}
              {detail.threshold}%.{" "}
              {t(
                "ზღვარში ითვლება თანხმობა და უარი; თავის შეკავება ითვლება კვორუმში. ფრე არ ნიშნავს მიღებას. შედეგი არ ანიჭებს უფლებამოსილებას.",
                "The threshold uses Yes and No; abstentions count toward quorum. Ties do not pass. The result grants no authority.",
              )}
            </p>
          )}
          {detail.kind === "election" && detail.status === "draft" && detail.canManage && (
            <Card className="my-3">
              <h3>{t("კანდიდატების წარდგენა და გაწვევა", "Candidate nominations & withdrawals")}</h3>
              <div className="review-toolbar my-2">
                <Input
                  label={t("ახალი კანდიდატი", "Candidate label")}
                  value={nomineeLabel}
                  disabled={locked}
                  maxLength={160}
                  onChange={(e) => setNomineeLabel(e.target.value)}
                />
                <Button
                  variant="secondary"
                  disabled={
                    locked ||
                    !nomineeLabel.trim() ||
                    detail.options.length >= 8
                  }
                  onClick={nominate}
                >
                  {t("კანდიდატის დამატება", "Nominate candidate")}
                </Button>
              </div>
              {detail.options.length > 2 && (
                <div className="space-y-2 mt-2">
                  <Input
                    label={t("გაწვევის მიზეზი", "Withdrawal reason")}
                    value={withdrawReason}
                    disabled={locked}
                    maxLength={1000}
                    onChange={(e) => setWithdrawReason(e.target.value)}
                  />
                  <div className="flex flex-wrap gap-2">
                    {detail.options.map((cand) => (
                      <Button
                        key={cand}
                        variant="ghost"
                        disabled={locked || withdrawReason.trim().length < 3}
                        onClick={() => withdrawCandidate(cand)}
                      >
                        {t("გაწვევა:", "Withdraw:")} {cand}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              {!!detail.nominations?.length && (
                <ul className="text-xs opacity-80 mt-2 space-y-1">
                  {detail.nominations.map((n) => (
                    <li key={n.id}>
                      {n.label} ·{" "}
                      {n.status === "nominated"
                        ? t("წარდგენილია", "Nominated")
                        : `${t("გაწვეულია", "Withdrawn")} (${n.reason})`}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
          {detail.outcome && (
            <p className="decision-outcome" role="status">
              {t("რეფერენდუმის შედეგი", "Referendum outcome")}:{" "}
              {
                {
                  accepted: t("მიღებულია", "Accepted"),
                  rejected: t("უარყოფილია", "Rejected"),
                  tie: t("ფრე", "Tie"),
                  inquorate: t("კვორუმი ვერ შედგა", "Quorum not reached"),
                  no_decision: t("გადაწყვეტილება არ მიღებულა", "No decision"),
                }[detail.outcome]
              }
            </p>
          )}
          {detail.resultsSuppressed ? (
            <p role="status">
              {t(
                "შედეგები დაფარულია ანონიმურობის მინიმალური ზღვრის გამო.",
                "Results are suppressed to protect participant anonymity.",
              )}
            </p>
          ) : detail.surveyResults ? (
            <>
              <h3>{t("შედეგები", "Results")}</h3>
              <p>
                {t("მონაწილეობა", "Participation")}: {detail.participation}/
                {detail.electorate} ·{" "}
                {quorumReached
                  ? t("კვორუმი შედგა", "Quorum reached")
                  : t("კვორუმი ვერ შედგა", "Quorum not reached")}
              </p>
              <SurveyResults results={detail.surveyResults} />
            </>
          ) : detail.results ? (
            <>
              <h3>{t("შედეგები", "Results")}</h3>
              <p>
                {t("მონაწილეობა", "Participation")}: {detail.participation}/
                {detail.electorate} (
                {detail.electorate > 0
                  ? Math.round(
                      ((detail.participation ?? 0) / detail.electorate) * 100,
                    )
                  : 0}
                %) ·{" "}
                {quorumReached
                  ? t("კვორუმი შედგა", "Quorum reached")
                  : t("კვორუმი ვერ შედგა", "Quorum not reached")}
              </p>
              <div
                className="decision-chart-wrap"
                aria-label={t("შედეგების გრაფიკი", "Results chart")}
              >
                <ResponsiveContainer
                  width="100%"
                  height={220}
                  initialDimension={{ width: 480, height: 220 }}
                >
                  <BarChart
                    data={detail.results.map((r) => ({
                      name: optionLabel(r.label),
                      votes: r.votes,
                    }))}
                    layout="vertical"
                    margin={{ top: 8, right: 20, bottom: 8, left: 8 }}
                  >
                    <XAxis type="number" allowDecimals={false} />
                    <YAxis type="category" dataKey="name" width={140} />
                    <Tooltip />
                    <Bar
                      dataKey="votes"
                      fill="var(--primary)"
                      radius={[0, 4, 4, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="decision-results">
                {detail.results.map((r) => {
                  const pct = detail.participation
                    ? Math.round((r.votes / detail.participation) * 100)
                    : 0;
                  return (
                    <div key={r.label}>
                      <span>{optionLabel(r.label)}</span>
                      <strong>
                        {r.votes} ({pct}%)
                      </strong>
                      <progress
                        aria-label={optionLabel(r.label)}
                        value={r.votes}
                        max={Math.max(detail.participation ?? 0, 1)}
                      />
                    </div>
                  );
                })}
              </div>
              {detail.kind !== "referendum" &&
                !!detail.participation &&
                detail.results.filter(
                  (r) =>
                    r.votes ===
                    Math.max(...detail.results!.map((v) => v.votes)),
                ).length > 1 && <p>{t("შედეგი: ფრე", "Result: tie")}</p>}
            </>
          ) : (
            <p>
              {detail.status === "cancelled"
                ? t(
                    "გაუქმებულ პულზე შედეგები არ ქვეყნდება.",
                    "Cancelled polls do not publish results.",
                  )
                : detail.status === "scheduled"
                  ? t(
                      "პული გამოქვეყნებულია და გაიხსნება დაგეგმილ დროს.",
                      "This poll is scheduled and will open for participation at the scheduled start time.",
                    )
                  : t(
                      "შედეგები გამოჩნდება დასრულების შემდეგ.",
                      "Results are hidden until closing.",
                    )}
            </p>
          )}
          {!detail.resultsSuppressed &&
            (detail.surveyResults || detail.results) &&
            detail.privacy === "anonymous" &&
            detail.receiptDigests &&
            detail.receiptDigests.length > 0 && (
              <Card className="decision-receipt-verify">
                <h4>
                  {t(
                    "ანონიმური ბიულეტენის გადამოწმება",
                    "Verify ballot receipt",
                  )}{" "}
                  ({detail.receiptDigests.length})
                </h4>
                <Input
                  label={t("ქვითრის 16-ნიშნა კოდი", "16-char receipt digest")}
                  placeholder="e.g. a1b2-c3d4-e5f6-0718"
                  value={verifyDigest}
                  onChange={(e) => setVerifyDigest(e.target.value)}
                />
                {verifyDigest.replace(/[-\s]/g, "").length > 0 && (
                  <p role="status">
                    {detail.receiptDigests.some(
                      (digest) =>
                        digest.replace(/[-\s]/g, "").toLowerCase() ===
                        verifyDigest.replace(/[-\s]/g, "").toLowerCase(),
                    )
                      ? t(
                          "დადასტურებულია: ქვითარი ჩართულია დათვლილ ანონიმურ ბიულეტენებში.",
                          "Verified: receipt included in final tallied ballots.",
                        )
                      : t(
                          "ქვითარი ვერ მოიძებნა დათვლილ ბიულეტენებში.",
                          "Receipt digest not found in tallied ballots.",
                        )}
                  </p>
                )}
                <details>
                  <summary>
                    {t("დათვლილი ქვითრების სია", "Tallied receipt digests")}
                  </summary>
                  <div className="decision-receipt-list">
                    {detail.receiptDigests.map((digest) => (
                      <code key={digest}>{digest}</code>
                    ))}
                  </div>
                </details>
              </Card>
            )}
          {detail.canVote && detail.kind === "survey" && (
            <SurveyResponse
              questions={detail.questions ?? []}
              answers={answers}
              onChange={(value) => {
                setAnswers(value);
                setConfirmed(false);
              }}
              disabled={locked}
            />
          )}
          {detail.canVote && detail.kind !== "survey" && (
            <fieldset disabled={locked} className="review-form">
              <legend>
                {detail.kind === "election"
                  ? t("აირჩიე ერთი კანდიდატი", "Choose one candidate")
                  : t("აირჩიე ერთი პასუხი", "Choose one option")}
              </legend>
              {detail.options.map((o, i) => (
                <label key={i} className="decision-choice">
                  <input
                    type="radio"
                    name="choice"
                    value={i}
                    checked={choice === String(i)}
                    onChange={(e) => {
                      setChoice(e.target.value);
                      setConfirmed(false);
                    }}
                  />
                  {optionLabel(o)}
                </label>
              ))}
            </fieldset>
          )}
          {(((detail.canManage || detail.canPublish) &&
            ["draft", "scheduled", "open"].includes(detail.status)) ||
            detail.canVote) && (
            <div className="review-form">
              <label className="review-confirm">
                <input
                  type="checkbox"
                  disabled={locked}
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                {t(
                  "გავეცანი პულის პირობებს და ვადას; ვადასტურებ არჩეულ მოქმედებას.",
                  "I reviewed the poll rules and deadline and confirm the selected action.",
                )}
              </label>
              {!demo && (
                <Input
                  label={t("პაროლი", "Password")}
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  disabled={busy}
                  onChange={(e) => setPassword(e.target.value)}
                />
              )}
              <div className="review-toolbar">
                {detail.status === "draft" && detail.canManage && (
                  <Button
                    variant="secondary"
                    disabled={locked}
                    onClick={() => create(detail)}
                  >
                    {t("რედაქტირება", "Edit")}
                  </Button>
                )}
                {detail.status === "draft" && detail.canPublish && (
                  <Button
                    disabled={locked || !confirmed}
                    onClick={() => transition("publish")}
                  >
                    {t("გამოქვეყნება", "Publish")}
                  </Button>
                )}
                {["scheduled", "open"].includes(detail.status) &&
                  detail.canPublish && (
                    <Button
                      variant="secondary"
                      disabled={locked || !confirmed}
                      onClick={() => transition("close")}
                    >
                      {t("დახურვა", "Close poll")}
                    </Button>
                  )}
                {["draft", "scheduled", "open"].includes(detail.status) &&
                  detail.canManage && (
                    <Button
                      variant="danger"
                      disabled={locked || !confirmed}
                      onClick={() => {
                        if (
                          window.confirm(
                            t(
                              "გააუქმო პული? ხმის მიცემა შეწყდება და შედეგები არ გამოქვეყნდება.",
                              "Cancel this poll? Voting will stop and results will not be published.",
                            ),
                          )
                        )
                          transition("cancel");
                      }}
                    >
                      {t("პულის გაუქმება", "Cancel poll")}
                    </Button>
                  )}
                {detail.canVote && (
                  <Button
                    disabled={
                      locked ||
                      !confirmed ||
                      (detail.kind === "survey"
                        ? !validSurveyAnswers(detail.questions ?? [], answers)
                        : choice === "")
                    }
                    onClick={vote}
                  >
                    {detail.kind === "survey"
                      ? t("პასუხების გაგზავნა", "Submit responses")
                      : t("ხმის მიცემა", "Submit vote")}
                  </Button>
                )}
              </div>
            </div>
          )}
        </Card>
      )}
      {pending && !busy && (
        <Card>
          <p>
            {t(
              "გაურკვეველი შედეგი — ხელახლა გაიგზავნება ზუსტად იგივე მოქმედება.",
              "Unconfirmed result — retry sends exactly the same action.",
            )}
          </p>
          {!demo && (
            <Input
              label={t("პაროლი ხელახალი ცდისთვის", "Password for retry")}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
          <Button onClick={() => void send(pending)}>
            {t("იმავე მოქმედების ხელახალი ცდა", "Retry same action")}
          </Button>
        </Card>
      )}
    </section>
  );
}
