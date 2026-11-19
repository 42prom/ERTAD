import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { downloadSafeCsv } from "../utils/safeCsv";
import {
  collectiveApi,
  type CollectiveUnit,
  type PointsView,
  type PointsRule,
} from "../api/collective";
import { demoApi } from "../api/demo";
import { useCollectiveWrite } from "../components/CollectiveWrite";
import { useInboxTarget } from "../components/useInboxTarget";
import { useConsolePreferences } from "../components/useConsolePreferences";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import Select from "../components/ui/Select";
import Textarea from "../components/ui/Textarea";

export default function Contribution() {
  const location = useLocation(),
    navigate = useNavigate(),
    [directoryTarget, setDirectoryTarget] = useState("");
  const { language } = useConsolePreferences(),
    t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [org, setOrg] = useState(""),
    [units, setUnits] = useState<CollectiveUnit[]>([]),
    [unitId, setUnitId] = useState(""),
    [memberId, setMemberId] = useState(""),
    [entryId, setEntryId] = useState(""),
    [people, setPeople] = useState<Record<string, string>>({}),
    [demo, setDemo] = useState(false);
  const [data, setData] = useState<PointsView | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0),
    [page, setPage] = useState(1);
  const [mode, setMode] = useState(""),
    [category, setCategory] = useState("task"),
    [amount, setAmount] = useState(10),
    [enabled, setEnabled] = useState(true),
    [memberCap, setMemberCap] = useState(100),
    [issuerCap, setIssuerCap] = useState(100),
    [reason, setReason] = useState(""),
    [recipient, setRecipient] = useState(""),
    [entry, setEntry] = useState("");
  const [templateId, setTemplateId] = useState(""),
    [templateTitle, setTemplateTitle] = useState(""),
    [allowedUnitId, setAllowedUnitId] = useState("");
  const refresh = () => {
    setData(null);
    setRevision((v) => v + 1);
  };
  const { send, locked, feedback } = useCollectiveWrite(demo, () => {
    setMode("");
    refresh();
  });
  const dirty = locked || !!mode;
  const directoryIntent = location.state?.memberDirectory;
  if (
    !dirty &&
    org &&
    units.length &&
    directoryIntent &&
    directoryTarget !== location.key
  ) {
    setDirectoryTarget(location.key);
    if (
      directoryIntent.organizationId === org &&
      typeof directoryIntent.memberId === "string" &&
      /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(
        directoryIntent.memberId,
      ) &&
      units.some((u) => u.id === directoryIntent.unitId)
    ) {
      setData(null);
      setEntryId("");
      setMemberId(directoryIntent.memberId);
      setRecipient(directoryIntent.memberId);
      setUnitId(directoryIntent.unitId);
      setPage(1);
    }
  }
  useEffect(() => {
    if (directoryTarget === location.key && directoryIntent)
      navigate(location.pathname, { replace: true, state: null });
  }, [directoryTarget, location, navigate, directoryIntent]);
  useInboxTarget("contribution", dirty ? "" : org, (id) => {
    setData(null);
    setEntryId(id);
    setMemberId("");
    setPage(1);
  });
  const label = (v: string) =>
    (
      ({
        task: t(
          "დავალების დადასტურებული შესრულება",
          "Verified task participation",
        ),
        vote: t("ხმის მიცემა", "Voting participation"),
        survey: t("გამოკითხვის დასრულება", "Survey completion"),
        manual: t("ინდივიდუალური აღიარება", "Individual recognition"),
        referral_join: t("რეფერალით შემოსვლა", "Referral signup"),
        referral_verified: t(
          "რეფერალის ბიომეტრიული ვერიფიკაცია",
          "Referral biometric verification",
        ),
        referral_l2_verified: t(
          "მე-2 დონის რეფერალის ვერიფიკაცია",
          "Level-2 referral verification",
        ),
        award: t("მინიჭება", "Award"),
        reversal: t("შესწორება", "Reversal"),
        cap_reached: t("პერიოდის ზღვარი მიღწეულია", "Period cap reached"),
      }) as Record<string, string>
    )[v] ?? v;
  useEffect(() => {
    let live = true;
    collectiveApi
      .pointContexts()
      .then(async (c) => {
        if (!live) return;
        setOrg(c[0]?.id ?? "");
        if (!c.length) {
          setLoading(false);
          return;
        }
        const u = await collectiveApi.units(c[0].id);
        if (live) {
          setUnits(u);
          setUnitId(u[0]?.id ?? "");
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
  const readScope1Key = JSON.stringify([
    org,
    unitId,
    memberId,
    page,
    revision,
    entryId,
  ]);
  const [readScope1, setReadScope1] = useState(readScope1Key);
  // Reconcile scope before committing children, so previous-scope records cannot flash.
  if (readScope1 !== readScope1Key) {
    setReadScope1(readScope1Key);
    setLoading(true);
    setError("");
    setData(null);
  }
  useEffect(() => {
    if (!org) return;
    let live = true;
    collectiveApi
      .points({
        organizationId: org,
        ...(entryId
          ? { entryId }
          : {
              ...(unitId ? { unitId } : {}),
              ...(memberId ? { memberId } : {}),
            }),
        page,
      })
      .then((value) => {
        if (live) setData(value);
      })
      .catch(() => {
        if (live) {
          setMode("");
          setError(
            t(
              "ქულების ნახვის უფლება არ გაქვთ ან მონაცემები ვერ ჩაიტვირთა.",
              "Points are unavailable or you do not have permission to view them.",
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
  }, [org, unitId, memberId, page, revision, entryId]);
  useEffect(() => {
    const update = () => {
      if (dirty) return;
      setData(null);
      setRevision((v) => v + 1);
    };
    window.addEventListener("focus", update);
    return () => window.removeEventListener("focus", update);
  }, [dirty]);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  function ruleForm(value: string, template?: PointsRule | "new") {
    setCategory(value);
    const r =
      template === "new"
        ? undefined
        : (template ??
          data?.rules.find((r) => r.category === value && !r.templateId));
    setTemplateId(
      template === "new" ? crypto.randomUUID() : (r?.templateId ?? ""),
    );
    setTemplateTitle(r?.title ?? "");
    setAllowedUnitId(r?.allowedUnitId ?? data?.rootUnitId ?? "");
    setAmount(r?.amount ?? 10);
    setMemberCap(r?.memberMonthCap ?? 100);
    setIssuerCap(r?.issuerMonthCap ?? 100);
    setEnabled(r?.enabled ?? true);
    setMode("points_rule");
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!data) return;
    const rule = data.rules.find((r) => r.category === "manual" && r.enabled);
    const parameters: Record<string, string | number | boolean> =
      mode === "points_rule"
        ? {
            category,
            ruleVersion:
              data.rules.find(
                (r) =>
                  r.category === category &&
                  (r.templateId ?? "") === templateId,
              )?.version ?? 0,
            ...(templateId
              ? { templateId, title: templateTitle, allowedUnitId }
              : {}),
            enabled,
            amount,
            memberMonthCap: memberCap,
            issuerMonthCap: issuerCap,
          }
        : mode === "points_award"
          ? { memberId: recipient, ruleId: rule?.id ?? "", amount }
          : { entryId: entry };
    if (
      await send({
        operation: "propose",
        organizationId: org,
        key: crypto.randomUUID(),
        unitId: mode === "points_rule" ? data.rootUnitId : unitId,
        kind: mode,
        parameters,
        reason,
        deadline: new Date(Date.now() + 7 * 86400000).toISOString(),
      })
    ) {
      setMode("");
      setReason("");
    }
  }
  return (
    <section className="review-page space-y-6">
      <header className="page-header">
        <h1>{t("კონტრიბუცია", "Contribution")}</h1>
        <p>
          {t(
            "ქულები ასახავს დადასტურებულ მონაწილეობასა და აღიარებას. ისინი არ არის ფული და არ ანიჭებს უფლებამოსილებას.",
            "Points recognize verified participation and contribution. They are not money and confer no authority.",
          )}
        </p>
      </header>
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
      {!!units.length && (
        <div className="grid gap-4 md:grid-cols-2">
          <Select
            label={t("მართვის ფარგლები", "Management scope")}
            disabled={dirty || !!entryId}
            value={unitId}
            onChange={(e) => {
              setUnitId(e.target.value);
              setMemberId("");
              setPage(1);
            }}
            options={units.map((u) => ({ value: u.id, label: u.name }))}
          />
          <Select
            label={t("ქულების ისტორია", "Points history")}
            disabled={dirty || !!entryId}
            value={memberId}
            onChange={(e) => {
              setMemberId(e.target.value);
              setPage(1);
            }}
            options={[
              { value: "", label: t("ჩემი ისტორია", "My history") },
              ...(memberId && !people[memberId]
                ? [
                    {
                      value: memberId,
                      label: t("წევრი", "Member") + " " + memberId.slice(0, 8),
                    },
                  ]
                : []),
              ...Object.entries(people).map(([value, label]) => ({
                value,
                label,
              })),
            ]}
          />
        </div>
      )}
      {!demo && !!units.length && !entryId && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const value = String(
              new FormData(e.currentTarget).get("memberLookup") ?? "",
            ).trim();
            setMemberId(value);
            setPage(1);
          }}
        >
          <Input
            disabled={dirty}
            name="memberLookup"
            label={t(
              "წევრის ID — ცარიელი ველი აჩვენებს ჩემს ისტორიას",
              "Member ID — leave blank for my history",
            )}
            pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
          />
          <Button type="submit" variant="secondary" disabled={dirty}>
            {t("ისტორიის ნახვა", "Look up history")}
          </Button>
        </form>
      )}
      <div className="flex gap-3 flex-wrap">
        <Button variant="secondary" disabled={dirty} onClick={refresh}>
          {t("განახლება", "Refresh")}
        </Button>
        <Link to="/approvals">
          {t("დამტკიცებების ნახვა", "View approvals")}
        </Link>
        {data?.canManageRules && !entryId && (
          <>
            <Button disabled={dirty} onClick={() => ruleForm("task")}>
              {t("ქულების წესის შეცვლა", "Configure points rule")}
            </Button>
            <Button disabled={dirty} onClick={() => ruleForm("task", "new")}>
              {t("ჯილდოს შაბლონის დამატება", "Add reward template")}
            </Button>
          </>
        )}
        {data?.canAward &&
          !entryId &&
          data.rules.some((r) => r.category === "manual" && r.enabled) && (
            <Button
              disabled={dirty}
              onClick={() => {
                setMode("points_award");
                setAmount(1);
                setReason("");
                setRecipient(
                  memberId && memberId !== data.actorId ? memberId : "",
                );
              }}
            >
              {t("პირადი ჯილდოს შეთავაზება", "Propose recognition")}
            </Button>
          )}
      </div>
      {entryId && (
        <Card>
          <p>
            {t(
              "შეტყობინებიდან გახსნილი ჩანაწერი",
              "Record opened from notification",
            )}
          </p>
          <Button
            variant="secondary"
            disabled={dirty}
            onClick={() => {
              setData(null);
              setEntryId("");
              setPage(1);
            }}
          >
            {t("ჩემი სრული ისტორია", "My full history")}
          </Button>
        </Card>
      )}
      {data && (
        <>
          <Card>
            <h2 className="text-xl font-semibold">
              {memberId
                ? (people[memberId] ?? t("წევრი", "Member"))
                : t("ჩემი კონტრიბუცია", "My contribution")}
            </h2>
            <p className="text-3xl font-semibold my-3">
              {data.balance} {t("ქულა", "points")}
            </p>
            <p>
              {t(
                "არ არსებობს ქულებით უფლებების მიღება, გადარიცხვა ან ფულად გადაქცევა.",
                "Points cannot be exchanged, transferred or used to acquire permissions.",
              )}
            </p>
          </Card>
          <Card>
            <h2 className="text-xl font-semibold mb-3">
              {t("მოქმედი წესები", "Current rules")}
            </h2>
            {!data.rules.length && (
              <p>
                {t(
                  "წესები ჯერ არ დამტკიცებულა.",
                  "No rules have been approved yet.",
                )}
              </p>
            )}
            {data.rules.map((r) => (
              <div key={r.id} className="border-t py-3">
                <h3 className="font-semibold">
                  {r.title || label(r.category)} ·{" "}
                  {r.enabled
                    ? t("ჩართულია", "Enabled")
                    : t("გამორთულია", "Disabled")}
                </h3>
                <p>
                  {r.category === "manual"
                    ? t("ერთი ჯილდოს მაქსიმუმი", "Maximum single award")
                    : t("დადასტურებული მონაწილეობა", "Confirmed participation")}
                  : {r.amount} ·{" "}
                  {t("წევრის თვიური ზღვარი", "Member monthly cap")}:{" "}
                  {r.memberMonthCap}
                </p>
                {r.templateId && (
                  <p>
                    {t("გამოყენების იერარქია", "Available hierarchy")}:{" "}
                    {units.find((u) => u.id === r.allowedUnitId)?.name ??
                      t("განსაზღვრული იერარქია", "Assigned hierarchy")}
                  </p>
                )}
                {r.category === "manual" && (
                  <p>
                    {t("გამცემის თვიური ლიმიტი", "Issuer monthly allowance")}:{" "}
                    {r.issuerMonthCap}
                  </p>
                )}
                {data.canManageRules && !entryId && (
                  <Button
                    variant="secondary"
                    disabled={dirty}
                    onClick={() => ruleForm(r.category, r)}
                  >
                    {t("ცვლილების შეთავაზება", "Propose rule change")}
                  </Button>
                )}
              </div>
            ))}
            <p className="mt-3">
              {t(
                "დავალებაზე წესი შექმნისას ფიქსირდება, კენჭისყრაზე — გამოქვეყნებისას. თვიური ზღვრის მიღწევა მონაწილეობას არ ბლოკავს. გაუქმებული კენჭისყრის ქულები შესწორების ჩანაწერით უქმდება.",
                "A task pins its rule at creation; a decision pins it at publication. Reaching the monthly cap does not block participation. Cancelling a decision reverses its participation awards through recorded corrections.",
              )}
            </p>
          </Card>
          <Card>
            <div className="review-toolbar mb-3">
              <h2 className="text-xl font-semibold">
                {t("ქულების ისტორია", "Recognition history")}
              </h2>
              {data.entries.length > 0 && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    downloadSafeCsv(
                      `contribution-ledger-p${page}.csv`,
                      ["id", "date", "category", "kind", "points", "reason"],
                      data.entries.map((e) => [
                        e.id,
                        e.date,
                        e.rewardTitle || e.category,
                        e.kind,
                        String(e.points),
                        e.reason,
                      ]),
                    )
                  }
                >
                  {t("უწყისის ექსპორტი (CSV)", "Export statement CSV")}
                </Button>
              )}
            </div>
            {data.entries.length > 0 && (
              <div
                className="decision-chart-wrap mb-4"
                aria-label={t("ქულების განაწილება", "Points breakdown chart")}
              >
                <ResponsiveContainer
                  width="100%"
                  height={180}
                  initialDimension={{ width: 420, height: 180 }}
                >
                  <BarChart
                    data={Object.values(
                      data.entries.reduce<
                        Record<string, { name: string; points: number }>
                      >((acc, item) => {
                        const key = item.rewardTitle || label(item.category);
                        const curr = acc[key] ?? { name: key, points: 0 };
                        curr.points += item.points;
                        acc[key] = curr;
                        return acc;
                      }, {}),
                    )}
                    margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
                  >
                    <XAxis dataKey="name" />
                    <YAxis allowDecimals={false} />
                    <Tooltip />
                    <Bar
                      dataKey="points"
                      fill="var(--accent, #2563eb)"
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            {!data.entries.length && (
              <p>{t("ჩანაწერები ჯერ არ არის.", "No entries yet.")}</p>
            )}
            {data.entries.map((e) => (
              <div
                key={e.id}
                data-contribution-id={e.id}
                className="border-t py-3 space-y-2"
              >
                <p>
                  {e.rewardTitle || label(e.category)} · {label(e.kind)} ·{" "}
                  {e.points > 0 ? "+" : ""}
                  {e.points} · {e.date}
                </p>
                {e.reason && <p>{e.reason}</p>}
                {e.recognitionSource && (
                  <p className="text-sm text-gray-600">
                    {t("დადასტურებული დავალება", "Verified task")}:{" "}
                    {e.recognitionSource.workTitle ||
                      t("დაცული ჩანაწერი", "Restricted record")}
                  </p>
                )}
                {data.canAward &&
                  data.memberId !== data.actorId &&
                  e.kind === "award" && (
                    <Button
                      variant="secondary"
                      disabled={dirty}
                      onClick={() => {
                        setMode("points_reverse");
                        setEntry(e.id);
                        setReason("");
                      }}
                    >
                      {t("შესწორების მოთხოვნა", "Request correction")}
                    </Button>
                  )}
              </div>
            ))}
            <div className="flex items-center gap-3 mt-4">
              <Button
                variant="secondary"
                disabled={dirty || !!entryId || page === 1}
                onClick={() => setPage((p) => p - 1)}
              >
                {t("წინა", "Previous")}
              </Button>
              <span>{page}</span>
              <Button
                variant="secondary"
                disabled={dirty || !!entryId || page * 25 >= data.total}
                onClick={() => setPage((p) => p + 1)}
              >
                {t("შემდეგი", "Next")}
              </Button>
            </div>
          </Card>
        </>
      )}
      {mode && data && (
        <Card>
          <form onSubmit={save}>
            <fieldset disabled={locked} className="space-y-4">
              <h2 className="text-xl font-semibold">
                {mode === "points_rule"
                  ? t("წესის ცვლილება", "Rule change")
                  : mode === "points_award"
                    ? t("პირადი ჯილდო", "Individual recognition")
                    : t("ქულების შესწორება", "Points correction")}
              </h2>
              {mode === "points_rule" && (
                <>
                  {templateId ? (
                    <>
                      <Input
                        label={t("შაბლონის სახელი", "Template name")}
                        required
                        minLength={3}
                        maxLength={100}
                        value={templateTitle}
                        onChange={(e) => setTemplateTitle(e.target.value)}
                      />
                      <Select
                        label={t("გამოყენების იერარქია", "Available hierarchy")}
                        required
                        value={allowedUnitId}
                        onChange={(e) => setAllowedUnitId(e.target.value)}
                        options={units.map((u) => ({
                          value: u.id,
                          label: u.name,
                        }))}
                      />
                      <p>
                        {t(
                          "შაბლონი გამოიყენება არჩეულ ერთეულსა და მის ქვედა იერარქიაში. ცვლილებები არსებულ დავალებებს არ ეხება.",
                          "This template applies within the selected unit and its descendants. Changes do not affect existing tasks.",
                        )}
                      </p>
                    </>
                  ) : (
                    <Select
                      label={t("მონაწილეობის ტიპი", "Participation category")}
                      value={category}
                      onChange={(e) => ruleForm(e.target.value)}
                      options={[
                        "task",
                        "vote",
                        "survey",
                        "manual",
                        "referral_join",
                        "referral_verified",
                        "referral_l2_verified",
                      ].map((value) => ({ value, label: label(value) }))}
                    />
                  )}
                  <label className="flex items-center gap-2 min-h-11">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => setEnabled(e.target.checked)}
                    />
                    {t("წესი ჩართულია", "Enable rule")}
                  </label>
                  <Input
                    type="number"
                    label={t("წევრის თვიური ზღვარი", "Member monthly cap")}
                    required
                    min={1}
                    max={1000000}
                    value={memberCap}
                    onChange={(e) => setMemberCap(Number(e.target.value))}
                  />
                  <Input
                    type="number"
                    label={t(
                      "გამცემის თვიური ლიმიტი",
                      "Issuer monthly allowance",
                    )}
                    required
                    min={1}
                    max={1000000}
                    value={issuerCap}
                    onChange={(e) => setIssuerCap(Number(e.target.value))}
                  />
                </>
              )}
              {mode === "points_award" &&
                (demo ? (
                  <Select
                    label={t("ჯილდოს მიმღები", "Recognition recipient")}
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                    required
                    options={[
                      {
                        value: "",
                        label: t("აირჩიეთ წევრი", "Choose a member"),
                      },
                      ...(recipient &&
                      recipient !== data.actorId &&
                      !people[recipient]
                        ? [
                            {
                              value: recipient,
                              label:
                                t("წევრი", "Member") +
                                " " +
                                recipient.slice(0, 8),
                            },
                          ]
                        : []),
                      ...Object.entries(people)
                        .filter(([id]) => id !== data.actorId)
                        .map(([value, label]) => ({ value, label })),
                    ]}
                  />
                ) : (
                  <Input
                    label={t("მიმღების წევრობის ID", "Recipient member ID")}
                    required
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                  />
                ))}
              {mode !== "points_reverse" && (
                <Input
                  label={t("ქულების რაოდენობა", "Points amount")}
                  type="number"
                  min={1}
                  max={100000}
                  required
                  value={amount}
                  onChange={(e) => setAmount(Number(e.target.value))}
                />
              )}
              <Textarea
                label={t("დასაბუთება", "Recognition reason")}
                required
                minLength={3}
                maxLength={1000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <p>
                {t(
                  "მოთხოვნას დამოუკიდებელი უფლებამოსილი პირი ამტკიცებს. საკუთარი ჯილდოს დამტკიცება აკრძალულია.",
                  "An independent authorized reviewer must approve this request. A beneficiary cannot approve their own award.",
                )}
              </p>
              <div className="flex gap-2">
                <Button type="submit">
                  {t("დასამტკიცებლად გაგზავნა", "Submit recognition proposal")}
                </Button>
                <Button variant="secondary" onClick={() => setMode("")}>
                  {t("დახურვა", "Close")}
                </Button>
              </div>
            </fieldset>
          </form>
        </Card>
      )}
    </section>
  );
}
