import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  collectiveApi,
  displayMoney,
  type CollectiveUnit,
  type Proposal,
} from "../api/collective";
import { demoApi } from "../api/demo";
import { downloadSafeCsv } from "../utils/safeCsv";
import { useConsolePreferences } from "../components/useConsolePreferences";
import { useCollectiveWrite } from "../components/CollectiveWrite";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import Select from "../components/ui/Select";
import Textarea from "../components/ui/Textarea";
import { useInboxTarget } from "../components/useInboxTarget";
import PositionPermissions from "../components/PositionPermissions";

export default function Collective() {
  const { language } = useConsolePreferences(),
    t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [org, setOrg] = useState(""),
    [units, setUnits] = useState<CollectiveUnit[]>([]),
    [rows, setRows] = useState<Proposal[]>([]),
    [total, setTotal] = useState(0),
    [selected, setSelected] = useState(""),
    [detail, setDetail] = useState<Proposal | null>(null);
  useInboxTarget("collective", org, setSelected);
  const [view, setView] = useState("pending"),
    [fundingCurrency, setFundingCurrency] = useState(""),
    [page, setPage] = useState(1),
    [revision, setRevision] = useState(0),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [demo, setDemo] = useState(false),
    [people, setPeople] = useState<Record<string, string>>({});
  const [form, setForm] = useState(""),
    [unitId, setUnitId] = useState(""),
    [title, setTitle] = useState(""),
    [body, setBody] = useState(""),
    [reason, setReason] = useState(""),
    [method, setMethod] = useState("fixed"),
    [minimum, setMinimum] = useState(1),
    [choice, setChoice] = useState("approve");
  const previewDialog = useRef<HTMLDialogElement>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewMediaType, setPreviewMediaType] = useState("");
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );
  function closePreview() {
    previewDialog.current?.close();
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl("");
    }
    setPreviewMediaType("");
  }
  async function openAttachment(attachment: NonNullable<Proposal["attachment"]>) {
    setError("");
    try {
      const blob = await collectiveApi.downloadAttachment(org, attachment.id);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const url = URL.createObjectURL(blob);
      setPreviewUrl(url);
      setPreviewMediaType(attachment.mediaType);
      previewDialog.current?.showModal();
    } catch {
      setError(
        t(
          "დამადასტურებელი დოკუმენტი ვერ ჩაიტვირთა.",
          "Could not load supporting receipt.",
        ),
      );
    }
  }
  const refresh = () => {
    setDetail(null);
    setRows([]);
    setRevision((v) => v + 1);
  };
  const { send, locked, feedback } = useCollectiveWrite(demo, refresh);
  const person = (id: string) =>
    people[id] ?? t("წევრი ", "Member ") + id.slice(0, 8);
  const label = (key: string) =>
    (
      ({
        position_create: t("ახალი პოზიცია", "New position"),
        account_invite: t("ვებანგარიშის მოწვევა", "Web account invitation"),
        position_revision: t("პოზიციის ახალი ვერსია", "New position version"),
        position_retire: t("პოზიციის გამოყენებიდან ამოღება", "Retire position"),
        points_rule: t("ქულების წესი", "Points rule"),
        points_award: t("პირადი ჯილდო", "Individual recognition"),
        points_reverse: t("ქულების შესწორება", "Points correction"),
        task: t("დავალებაში მონაწილეობა", "Task participation"),
        vote: t("ხმის მიცემა", "Voting participation"),
        survey: t("გამოკითხვა", "Survey participation"),
        manual: t("პირადი ჯილდო", "Individual recognition"),
        referral_join: t("რეფერალით შემოსვლა", "Referral signup"),
        referral_verified: t(
          "რეფერალის ვერიფიკაცია",
          "Referral biometric verification",
        ),
        referral_l2_verified: t(
          "მე-2 დონის რეფერალის ვერიფიკაცია",
          "Level-2 referral verification",
        ),
        pending: t("დასადასტურებელი", "Pending"),
        mine: t("ჩემი მოთხოვნები", "My requests"),
        inbox: t("შეტყობინებები", "Inbox"),
        history: t("ისტორია", "History"),
        approved: t("დამტკიცებული", "Approved"),
        rejected: t("უარყოფილი", "Rejected"),
        withdrawn: t("გამოთხოვილი", "Withdrawn"),
        expired: t("ვადაგასული", "Expired"),
        directive: t("დირექტივა", "Directive"),
        policy: t("თანხმობის წესი", "Approval policy"),
        funding_target: t("ბიუჯეტი", "Funding target"),
        funding_receipt: t("თანხის მიღება", "Funding receipt"),
        funding_expense: t("ხარჯი", "Expense"),
        funding_reserve: t("თანხის დაჯავშნა", "Reservation"),
        funding_release: t("ჯავშნის გაუქმება", "Reservation release"),
        funding_refund: t("თანხის დაბრუნება", "Refund"),
        funding_reverse: t("ხარჯის შესწორება", "Expense reversal"),
        funding_envelope: t("ჯგუფის ბიუჯეტი", "Child budget"),
        funding_publish: t(
          "წევრებისთვის შეჯამების გამოქვეყნება",
          "Publish member summary",
        ),
        fixed: t("ფიქსირებული რაოდენობა", "Fixed count"),
        majority: t("უმრავლესობა", "Majority"),
        supermajority: t("ორი მესამედი", "Two thirds"),
        unanimous: t("ერთსულოვნება", "Unanimity"),
      }) as Record<string, string>
    )[key] ?? key;
  useEffect(() => {
    let live = true;
    collectiveApi
      .contexts()
      .then((c) => {
        if (live) {
          setOrg(c[0]?.id ?? "");
          if (!c.length) setLoading(false);
        }
      })
      .catch(() => {
        if (live) {
          setError(t("წვდომა ვერ ჩაიტვირთა.", "Could not load access."));
          setLoading(false);
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
  const readScope1Key = JSON.stringify([org, page, view, selected]);
  const [readScope1, setReadScope1] = useState(readScope1Key);
  // Reconcile scope before committing children, so previous-scope records cannot flash.
  if (readScope1 !== readScope1Key) {
    setReadScope1(readScope1Key);
    setLoading(true);
    setError("");
    setRows([]);
    setDetail(null);
  }
  useEffect(() => {
    if (!org) return;
    let live = true;
    Promise.all([
      collectiveApi.units(org),
      collectiveApi.list({ organizationId: org, page, view }),
      selected ? collectiveApi.detail(org, selected) : Promise.resolve(null),
    ])
      .then(async ([u, r, d]) => {
        let currency = "";
        if (d?.kind.startsWith("funding_") && d.workId) {
          const funding = await collectiveApi.funding(org, d.workId);
          currency =
            funding.target?.currency ?? String(d.parameters.currency ?? "");
          if (!currency) throw new Error("Funding currency unavailable");
        }
        if (live) {
          setFundingCurrency(currency);
          setUnits(u);
          setRows(r.items);
          setTotal(r.total);
          setDetail(d);
        }
      })
      .catch((e) => {
        if (live) {
          if (
            (e as { response?: { status?: number } })?.response?.status ===
              403 &&
            selected
          ) {
            setDetail(null);
          }
          setError(
            t(
              "მონაცემები ვერ ჩაიტვირთა. გადაამოწმეთ წვდომა.",
              "Could not load records. Check your access.",
            ),
          );
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [org, page, view, selected, revision]);
  useEffect(() => {
    const update = () => setRevision((v) => v + 1);
    window.addEventListener("focus", update);
    return () => window.removeEventListener("focus", update);
  }, []);
  async function save(e: FormEvent) {
    e.preventDefault();
    const current = units.find((u) => u.id === unitId);
    if (!current) return;
    const parameters: Record<string, string | number> =
      form === "directive"
        ? { title, body }
        : { policyVersion: current.policy.version, method, minimum };
    if (
      await send({
        operation: "propose",
        organizationId: org,
        key: crypto.randomUUID(),
        unitId,
        kind: form,
        parameters,
        reason,
        deadline: new Date(Date.now() + 7 * 86400000).toISOString(),
      })
    ) {
      setForm("");
      setReason("");
    }
  }
  return (
    <section className="review-page space-y-6">
      <header className="page-header">
        <h1>{t("ადმინისტრაციული დამტკიცებები", "Administrative approvals")}</h1>
        <p>
          {t(
            "განიხილეთ მოთხოვნები, ნახეთ კოლეგების გადაწყვეტილებები და დაადასტურეთ თქვენი იერარქიის ფარგლებში.",
            "Review proposals, inspect colleague decisions and approve within your scope.",
          )}
        </p>
      </header>
      <div className="flex flex-wrap gap-2">
        {units.some((u) => u.canPropose) && (
          <Button
            disabled={locked}
            onClick={() => {
              setForm("directive");
              setUnitId(units.find((u) => u.canPropose)!.id);
            }}
          >
            {t("დირექტივის შეთავაზება", "Propose directive")}
          </Button>
        )}
        {units.some((u) => u.canManage) && (
          <Button
            variant="secondary"
            disabled={locked}
            onClick={() => {
              setForm("policy");
              setUnitId(units.find((u) => u.canManage)!.id);
            }}
          >
            {t("თანხმობის წესის შეცვლა", "Change approval policy")}
          </Button>
        )}
        <Button variant="secondary" disabled={locked} onClick={refresh}>
          {t("განახლება", "Refresh")}
        </Button>
      </div>
      {feedback}
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">{t("იტვირთება…", "Loading…")}</p>}
      {!org && !loading && !error && (
        <Card>
          {t(
            "ამ განყოფილებაზე წვდომა არ გაქვთ.",
            "You do not have access to this area.",
          )}
        </Card>
      )}
      {form && (
        <Card>
          <h2 className="text-xl font-semibold mb-3">{label(form)}</h2>
          <form onSubmit={save}>
            <fieldset disabled={locked} className="space-y-4">
              <Select
                label={t("ერთეული", "Unit")}
                required
                value={unitId}
                onChange={(e) => setUnitId(e.target.value)}
                options={units
                  .filter((u) =>
                    form === "policy" ? u.canManage : u.canPropose,
                  )
                  .map((u) => ({ value: u.id, label: u.name }))}
              />
              {form === "directive" ? (
                <>
                  <Input
                    label={t("სათაური", "Directive title")}
                    required
                    minLength={3}
                    maxLength={160}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                  <Textarea
                    label={t("დირექტივის ტექსტი", "Directive text")}
                    required
                    minLength={3}
                    maxLength={3000}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                  />
                </>
              ) : (
                <>
                  <p>
                    {t(
                      "ავტორი და ბენეფიციარი არ მონაწილეობენ საკუთარი მოთხოვნის დამტკიცებაში. წესი ითვლის დამოუკიდებელ უფლებამოსილ შემფასებლებს; შემადგენლობა მოთხოვნის შექმნისას ფიქსირდება.",
                      "The author and beneficiary cannot approve their own proposal. Rules count independent eligible reviewers, with the cohort fixed at proposal creation.",
                    )}
                  </p>
                  <Select
                    label={t("თანხმობის მეთოდი", "Approval method")}
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                    options={[
                      "fixed",
                      "majority",
                      "supermajority",
                      "unanimous",
                    ].map((value) => ({ value, label: label(value) }))}
                  />
                  {method === "fixed" && (
                    <Input
                      label={t(
                        "საჭირო თანხმობების რაოდენობა",
                        "Required approvals",
                      )}
                      type="number"
                      min={1}
                      max={20}
                      required
                      value={minimum}
                      onChange={(e) => setMinimum(Number(e.target.value))}
                    />
                  )}
                </>
              )}
              <Textarea
                label={t("მიზეზი", "Proposal reason")}
                required
                minLength={3}
                maxLength={1000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <div className="flex gap-2">
                <Button type="submit">
                  {t("დასამტკიცებლად გაგზავნა", "Submit for approval")}
                </Button>
                <Button variant="secondary" onClick={() => setForm("")}>
                  {t("დახურვა", "Close")}
                </Button>
              </div>
            </fieldset>
          </form>
        </Card>
      )}
      {detail ? (
        <Card>
          <Button
            variant="secondary"
            onClick={() => {
              setSelected("");
              setReason("");
            }}
          >
            {t("სიაში დაბრუნება", "Back to proposals")}
          </Button>
          <Button
            variant="secondary"
            disabled={locked}
            onClick={async () => {
              try {
                await collectiveApi.ack(org, detail.id, detail.version);
                window.dispatchEvent(new Event("ertad-inbox-changed"));
                setSelected("");
                refresh();
              } catch {
                setError(
                  t(
                    "წაკითხულად მონიშვნა ვერ მოხერხდა.",
                    "Could not mark the notification as read.",
                  ),
                );
              }
            }}
          >
            {t("წაკითხულად მონიშვნა", "Mark as read")}
          </Button>
          <h2 className="text-xl font-semibold mt-4">
            {label(detail.kind)} · {label(detail.status)}
          </h2>
          <p>
            {person(detail.proposerId)} · {detail.reason}
          </p>
          <p>
            {t("თანხმობები", "Approvals")}: {detail.approvedCount}/
            {detail.threshold} ·{" "}
            {t("უფლებამოსილი შემფასებლები", "Eligible reviewers")}:{" "}
            {detail.eligibleCount}
          </p>
          <p>
            {t("ვადა", "Deadline")}:{" "}
            {new Date(detail.deadline).toLocaleString(
              language === "ka" ? "ka-GE" : "en-GB",
              { hour12: false },
            )}
          </p>
          <dl className="mt-4 space-y-2">
            {Object.entries(detail.parameters)
              .filter(([key]) => key !== "activityId" && !(key === "contactId" && detail.invitationRecipient))
              .map(([key, value]) => (
                <div key={key}>
                  <dt className="font-semibold">
                    {(
                      {
                        name: t("პოზიციის სახელი", "Position name"),
                        contactId: t("დადასტურებული კონტაქტის ცნობარი", "Bound contact reference"),
                        grants: t("უფლებები და არეალი", "Permissions and scope"),
                        sourceId: t("წინა პოზიციის ცნობარი", "Previous position reference"),
                        sourceVersion: t("წინა ჩანაწერის ვერსია", "Previous record version"),
                        sourceName: t("პოზიცია", "Position"),
                        title: t("სათაური", "Title"),
                        body: t("ტექსტი", "Text"),
                        amount: detail.kind.startsWith("points_")
                          ? t("ქულების რაოდენობა", "Points amount")
                          : t("თანხა", "Amount"),
                        currency: t("ვალუტა", "Currency"),
                        purpose: t("მიზანი", "Purpose"),
                        externalRef: t(
                          "აღრიცხვის ცნობარი",
                          "Accounting reference",
                        ),
                        memberId: t("კონტრიბუტორი", "Contributor"),
                        referenceId: t(
                          "დაკავშირებული ჩანაწერი",
                          "Linked record",
                        ),
                        childId: t("ქვედა დავალება", "Child task"),
                        method: t("მეთოდი", "Method"),
                        minimum: t("მინიმუმი", "Minimum"),
                        policyVersion: t("წესის ვერსია", "Policy version"),
                        targetVersion: t("ბიუჯეტის ვერსია", "Budget version"),
                        category: t(
                          "მონაწილეობის ტიპი",
                          "Participation category",
                        ),
                        ruleVersion: t("წესის ვერსია", "Rule version"),
                        ruleId: t("წესის ცნობარი", "Rule reference"),
                        templateId: t("შაბლონის ცნობარი", "Template reference"),
                        allowedUnitId: t("გამოყენების ერთეული", "Allowed unit"),
                        enabled: t("ჩართულია", "Enabled"),
                        memberMonthCap: t(
                          "წევრის თვიური ზღვარი",
                          "Member monthly cap",
                        ),
                        issuerMonthCap: t(
                          "გამცემის თვიური ლიმიტი",
                          "Issuer monthly allowance",
                        ),
                        entryId: t("ჩანაწერის ცნობარი", "Entry reference"),
                        pledgeId: t("დაპირების ცნობარი", "Pledge reference"),
                      } as Record<string, string>
                    )[key] ?? key}
                  </dt>
                  <dd className="break-words">
                    {Array.isArray(value) ? <PositionPermissions grants={value} /> : key === "amount" && fundingCurrency
                      ? displayMoney(String(value), fundingCurrency)
                      : key === "memberId"
                        ? person(String(value))
                        : key === "allowedUnitId"
                          ? (units.find((u) => u.id === String(value))?.name ??
                            t("განსაზღვრული იერარქია", "Assigned hierarchy"))
                          : typeof value === "boolean"
                            ? value
                              ? t("დიახ", "Yes")
                              : t("არა", "No")
                            : ["category", "method"].includes(key)
                              ? label(String(value))
                              : String(value)}
                  </dd>
                </div>
              ))}
          </dl>
          {detail.invitationRecipient && <p>{detail.invitationRecipient.displayName} · {detail.invitationRecipient.unitName} · {detail.invitationRecipient.contactHint}</p>}
          {detail.recognitionSource && (
            <p>
              {t("დადასტურებული დავალება", "Verified task")}:{" "}
              {detail.recognitionSource.workTitle ||
                t("დაცული ჩანაწერი", "Restricted record")}
            </p>
          )}
          {detail.attachment && (
            <div className="my-3">
              <Button
                type="button"
                variant="secondary"
                onClick={() => void openAttachment(detail.attachment!)}
              >
                {t("დამადასტურებელი დოკუმენტის ნახვა", "View supporting receipt")} (
                {Math.max(1, Math.round(detail.attachment.bytes / 1024))} KB)
              </Button>
            </div>
          )}
          {detail.workId && (
            <Link to="/tasks">{t("დავალებების ნახვა", "View tasks")}</Link>
          )}
          <h3 className="font-semibold mt-4">
            {t("შემფასებლების გადაწყვეტილებები", "Reviewer decisions")}
          </h3>
          {detail.votes.map((v) => (
            <div key={v.actorId} className="border-t py-3">
              <p>
                {person(v.actorId)} ·{" "}
                {v.choice === "approve"
                  ? t("თანახმაა", "Approved")
                  : t("უარყოფილია", "Rejected")}
                {!v.currentlyEligible &&
                  ` · ${t("უფლება აღარ მოქმედებს", "Authority no longer active")}`}
              </p>
              <p>{v.reason}</p>
              <p>
                {new Date(v.at).toLocaleString(
                  language === "ka" ? "ka-GE" : "en-GB",
                  { hour12: false },
                )}
              </p>
            </div>
          ))}
          {detail.canVote && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                await send({
                  operation: "vote",
                  organizationId: org,
                  key: crypto.randomUUID(),
                  id: detail.id,
                  version: detail.version,
                  choice,
                  reason,
                });
                setReason("");
              }}
            >
              <fieldset disabled={locked} className="space-y-3 mt-4">
                <Select
                  label={t("გადაწყვეტილება", "Review decision")}
                  value={choice}
                  onChange={(e) => setChoice(e.target.value)}
                  options={[
                    { value: "approve", label: t("დამტკიცება", "Approve") },
                    { value: "reject", label: t("უარყოფა", "Reject") },
                  ]}
                />
                <Textarea
                  label={t("დასაბუთება", "Review reason")}
                  required
                  minLength={3}
                  maxLength={1000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <Button type="submit">
                  {t("გადაწყვეტილების დაფიქსირება", "Record decision")}
                </Button>
              </fieldset>
            </form>
          )}
          {detail.canWithdraw && (
            <Button
              variant="secondary"
              disabled={locked}
              onClick={() =>
                void send({
                  operation: "withdraw",
                  organizationId: org,
                  key: crypto.randomUUID(),
                  id: detail.id,
                  version: detail.version,
                })
              }
            >
              {t("მოთხოვნის გამოთხოვა", "Withdraw proposal")}
            </Button>
          )}
        </Card>
      ) : (
        <>
          <nav
            className="review-tabs"
            aria-label={t("მოთხოვნების ხედები", "Proposal views")}
          >
            {["pending", "mine", "inbox", "history"].map((v) => (
              <button
                key={v}
                type="button"
                aria-current={view === v ? "page" : undefined}
                onClick={() => {
                  setView(v);
                  setPage(1);
                }}
              >
                {label(v)}
              </button>
            ))}
          </nav>
          {!loading && org && (
            <Card>
              <div className="review-toolbar">
                <p>
                  {t("რაოდენობა", "Total")}: {total}
                </p>
                {rows.length > 0 && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      downloadSafeCsv(
                        `approvals-${view}-p${page}.csv`,
                        [
                          "id",
                          "kind",
                          "status",
                          "unit",
                          "approvedCount",
                          "threshold",
                          "deadline",
                        ],
                        rows.map((p) => [
                          p.id,
                          p.kind,
                          p.status,
                          units.find((u) => u.id === p.unitId)?.name ?? p.unitId,
                          String(p.approvedCount),
                          String(p.threshold),
                          p.deadline,
                        ]),
                      )
                    }
                  >
                    {t("უწყისის ექსპორტი (CSV)", "Export CSV")}
                  </Button>
                )}
              </div>
              {rows.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr>
                        <th>{t("მოთხოვნა", "Proposal")}</th>
                        <th>{t("სტატუსი", "Status")}</th>
                        <th>{t("თანხმობა", "Approval")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((p) => (
                        <tr key={p.id} data-proposal-id={p.id}>
                          <td>
                            <button
                              className="min-h-11 text-left"
                              onClick={() => {
                                setSelected(p.id);
                                setReason("");
                              }}
                            >
                              {label(p.kind)} ·{" "}
                              {units.find((u) => u.id === p.unitId)?.name}
                            </button>
                          </td>
                          <td>{label(p.status)}</td>
                          <td>
                            {p.approvedCount}/{p.threshold}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p>{t("მოთხოვნები არ არის.", "No proposals.")}</p>
              )}
              <div className="flex gap-3 mt-3">
                <Button
                  variant="secondary"
                  disabled={page === 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  {t("წინა", "Previous")}
                </Button>
                <span>{page}</span>
                <Button
                  variant="secondary"
                  disabled={page * 25 >= total}
                  onClick={() => setPage((p) => p + 1)}
                >
                  {t("შემდეგი", "Next")}
                </Button>
              </div>
            </Card>
          )}
        </>
      )}
      <dialog
        ref={previewDialog}
        className="attachment-preview-dialog"
        aria-label={t("დოკუმენტის წინასწარი ნახვა", "Supporting receipt preview")}
        onCancel={(e) => {
          e.preventDefault();
          closePreview();
        }}
      >
        <div className="review-toolbar mb-3">
          <strong>
            {t("დამადასტურებელი დოკუმენტი", "Supporting receipt")}
          </strong>
          <div className="flex gap-2">
            {previewUrl && (
              <a
                href={previewUrl}
                download={`funding-evidence.${previewMediaType === "application/pdf" ? "pdf" : "png"}`}
                className="underline self-center"
              >
                {t("ჩამოტვირთვა", "Download")}
              </a>
            )}
            <Button type="button" variant="secondary" onClick={closePreview}>
              {t("დახურვა", "Close")}
            </Button>
          </div>
        </div>
        {previewUrl &&
          (previewMediaType === "application/pdf" ? (
            <iframe
              src={previewUrl}
              title={t("PDF დოკუმენტი", "PDF document")}
              className="w-full h-[70vh] border rounded"
            />
          ) : (
            <img
              src={previewUrl}
              alt={t("ქვითრის სურათი", "Receipt preview")}
              className="max-w-full max-h-[70vh] mx-auto rounded"
            />
          ))}
      </dialog>
    </section>
  );
}
