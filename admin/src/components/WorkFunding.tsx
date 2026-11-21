import { useAsyncResource } from "./useAsyncResource";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  collectiveApi,
  displayMoney,
  minorUnits,
  type FundingView,
} from "../api/collective";
import type { WorkDetail } from "../api/work";
import { useCollectiveWrite } from "./CollectiveWrite";
import { useConsolePreferences } from "./useConsolePreferences";
import { downloadSafeCsv } from "../utils/safeCsv";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import Card from "./ui/Card";
import Button from "./ui/Button";
import Input from "./ui/Input";
import Select from "./ui/Select";
import Textarea from "./ui/Textarea";

export default function WorkFunding({
  detail: d,
  organizationId,
  demo,
  people,
}: {
  detail: WorkDetail;
  organizationId: string;
  demo: boolean;
  people: Record<string, string>;
}) {
  const { language } = useConsolePreferences(),
    t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [revision, setRevision] = useState(0);
  const resourceKey = JSON.stringify([
    organizationId,
    d.id,
    d.version,
    revision,
  ]);
  const [actionError, setActionError] = useState({ key: "", message: "" });
  const setError = (message: string) =>
    setActionError({ key: resourceKey, message });
  const [mode, setMode] = useState(""),
    [amount, setAmount] = useState(""),
    [currency, setCurrency] = useState("GEL"),
    [purpose, setPurpose] = useState(""),
    [reason, setReason] = useState(""),
    [externalRef, setExternalRef] = useState(""),
    [memberId, setMemberId] = useState(d.actorId),
    [referenceId, setReferenceId] = useState(""),
    [childId, setChildId] = useState("");
  const [pledgeId, setPledgeId] = useState("");
  const [attachment, setAttachment] = useState<{
    id: string;
    name: string;
    bytes: number;
  } | null>(null);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const refresh = () => {
    setRevision((v) => v + 1);
  };
  const { send, locked, feedback } = useCollectiveWrite(demo, refresh);
  const load = useCallback(
    () => collectiveApi.funding(organizationId, d.id),
    [organizationId, d.id],
  );
  const { data, loading, failed } = useAsyncResource<FundingView>(
    resourceKey,
    load,
  );
  const error =
    (actionError.key === resourceKey ? actionError.message : "") ||
    (failed
      ? t("ფინანსური მონაცემები ვერ ჩაიტვირთა.", "Could not load funding.")
      : "");
  useEffect(() => {
    const update = () => {
      setRevision((v) => v + 1);
    };
    window.addEventListener("focus", update);
    return () => window.removeEventListener("focus", update);
  }, []);
  const label = (v: string) =>
    (
      ({
        funding_target: t("ბიუჯეტის შეთავაზება", "Propose budget"),
        funding_receipt: t(
          "მიღებული თანხის აღრიცხვა",
          "Record external receipt",
        ),
        funding_expense: t("ხარჯის შეთავაზება", "Propose expense"),
        funding_reserve: t("თანხის დაჯავშნა", "Reserve funds"),
        funding_release: t("ჯავშნის გამოთავისუფლება", "Release reservation"),
        funding_refund: t("თანხის დაბრუნება", "Record refund"),
        funding_reverse: t("ხარჯის შესწორება", "Reverse expense"),
        funding_envelope: t("ქვედა დავალების ბიუჯეტი", "Allocate child budget"),
        funding_publish: t("შეჯამების გამოქვეყნება", "Publish member summary"),
        pledge: t("დაფინანსების დაპირება", "Pledge funding"),
        receipt: t("მიღებული", "Receipt"),
        expense: t("ხარჯი", "Expense"),
        reserve: t("ჯავშანი", "Reservation"),
        release: t("გამოთავისუფლება", "Release"),
        refund: t("დაბრუნება", "Refund"),
        reverse: t("შესწორება", "Reversal"),
      }) as Record<string, string>
    )[v] ?? v;
  function choose(v: string) {
    setMode(v);
    setAmount("");
    setReason("");
    setExternalRef("");
    setReferenceId("");
    setAttachment(null);
    if (v === "funding_target") {
      setCurrency(data?.target?.currency ?? "GEL");
      setPurpose(data?.target?.purpose ?? d.title);
      setAmount(data?.target ? displayMoney(data.target.goal, "").trim() : "");
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!data) return;
    setError("");
    let minor: string | undefined;
    try {
      if (mode !== "funding_publish") minor = minorUnits(amount);
    } catch {
      setError(
        t(
          "თანხა მიუთითეთ დადებითი რიცხვით, მაქსიმუმ ორი ათწილადი ნიშნით.",
          "Enter a positive amount with at most two decimal places.",
        ),
      );
      return;
    }
    if (mode === "pledge") {
      if (
        await send({
          operation: "pledge",
          organizationId,
          key: crypto.randomUUID(),
          workId: d.id,
          amount: minor,
        })
      )
        setMode("");
      return;
    }
    const parameters: Record<string, string | number> = {
      ...(minor ? { amount: minor } : {}),
    };
    if (mode === "funding_target")
      Object.assign(parameters, {
        currency,
        purpose,
        targetVersion: data.target?.version ?? 0,
      });
    if (["funding_receipt", "funding_expense", "funding_refund"].includes(mode))
      parameters.externalRef = externalRef;
    if (mode === "funding_receipt") {
      parameters.memberId = memberId;
      if (pledgeId.trim()) parameters.pledgeId = pledgeId.trim();
    }
    if (referenceId) parameters.referenceId = referenceId;
    if (mode === "funding_envelope") parameters.childId = childId;
    if (
      await send({
        operation: "propose",
        organizationId,
        key: crypto.randomUUID(),
        unitId: d.unitId,
        workId: d.id,
        kind: mode,
        parameters,
        reason,
        deadline: new Date(Date.now() + 7 * 86400000).toISOString(),
        ...(attachment ? { attachmentId: attachment.id } : {}),
      })
    ) {
      setMode("");
      setAttachment(null);
    }
  }
  const target = data?.target,
    money = (v: string | null | undefined) =>
      displayMoney(v, target?.currency ?? currency);
  const options = (
    !target
      ? ["funding_target"]
      : target.isEnvelope
        ? [
            "funding_expense",
            "funding_reserve",
            "funding_release",
            "funding_reverse",
          ]
        : [
            "funding_target",
            "funding_receipt",
            "funding_expense",
            "funding_reserve",
            "funding_release",
            "funding_refund",
            "funding_reverse",
            "funding_envelope",
            "funding_publish",
          ]
  ).filter(
    (v) =>
      d.status === "open" ||
      [
        "funding_release",
        "funding_refund",
        "funding_reverse",
        "funding_publish",
      ].includes(v),
  );
  const linkedKind =
    mode === "funding_refund"
      ? "receipt"
      : mode === "funding_reverse"
        ? "expense"
        : "reserve";
  return (
    <Card>
      <h2 className="text-xl font-semibold mb-3">
        {t("დაფინანსება და ხარჯები", "Funding and expenses")}
      </h2>
      <p className="mb-4">
        {t(
          "აღირიცხება აპლიკაციის გარეთ მიღებული თანხები. ჩანაწერი ძალაში შედის დამოუკიდებელი დამტკიცების შემდეგ; დაპირება მიღებულ თანხას არ ზრდის.",
          "Records money received outside the application. Changes take effect after independent approval; pledges never increase collected funds.",
        )}
      </p>
      {feedback}
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">{t("იტვირთება…", "Loading…")}</p>}
      {!loading && !error && !target && (
        <p>
          {t(
            "დამტკიცებული ბიუჯეტი ჯერ არ არის.",
            "No approved funding target yet.",
          )}
        </p>
      )}
      {target && (
        <>
          <h3 className="font-semibold">{target.purpose}</h3>
          <p>
            {target.isEnvelope
              ? t("გამოყოფილი ბიუჯეტი", "Allocated budget")
              : t("საჭირო თანხა", "Funding goal")}
            : {money(target.goal)}
          </p>
          {target.suppressed ? (
            <p className="mt-3">
              {t(
                "თანხების შეჯამება ჯერ არ გამოქვეყნებულა ან კონფიდენციალურობის პირობები არ სრულდება.",
                "Totals are not published yet or the privacy conditions are not met.",
              )}
            </p>
          ) : (
            target.totals && (
              <>
              <div className="task-overview mt-4">
                {[
                  ...(!target.isEnvelope
                    ? [
                        [
                          t("დადასტურებულად მიღებული", "Confirmed collected"),
                          target.totals.collected,
                        ],
                        [
                          t("დარჩენილი საჭიროება", "Still needed"),
                          target.totals.stillNeeded,
                        ],
                      ]
                    : []),
                  [t("დახარჯული", "Spent"), target.totals.spent],
                  [t("დაჯავშნილი", "Committed"), target.totals.committed],
                  [t("ხელმისაწვდომი", "Available"), target.totals.available],
                ].map(([name, value]) => (
                  <div key={name}>
                    <span>{name}</span>
                    <strong>{money(value)}</strong>
                  </div>
                ))}
              </div>
              <div
                className="decision-chart-wrap mt-4"
                aria-label={t("ფინანსური სტატუსის გრაფიკი", "Funding overview chart")}
              >
                <ResponsiveContainer
                  width="100%"
                  height={180}
                  initialDimension={{ width: 420, height: 180 }}
                >
                  <BarChart
                    data={[
                      ...(!target.isEnvelope && target.totals.collected
                        ? [
                            {
                              name: t("მიღებული", "Collected"),
                              amount: Number(BigInt(target.totals.collected)) / 100,
                            },
                          ]
                        : []),
                      {
                        name: t("დახარჯული", "Spent"),
                        amount: Number(BigInt(target.totals.spent || "0")) / 100,
                      },
                      {
                        name: t("დაჯავშნილი", "Committed"),
                        amount: Number(BigInt(target.totals.committed || "0")) / 100,
                      },
                      {
                        name: t("ხელმისაწვდომი", "Available"),
                        amount: Number(BigInt(target.totals.available || "0")) / 100,
                      },
                    ]}
                    margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
                  >
                    <XAxis dataKey="name" />
                    <YAxis />
                    <Tooltip />
                    <Bar
                      dataKey="amount"
                      fill="var(--primary)"
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>
            )
          )}
          {target.totals?.publishedDate && (
            <p>
              {t("გამოქვეყნების თარიღი", "Published on")}:{" "}
              {target.totals.publishedDate}
            </p>
          )}
        </>
      )}
      {data?.canRecord && (
        <div className="flex flex-wrap gap-2 my-4">
          {options.map((op) => (
            <Button
              key={op}
              variant="secondary"
              disabled={locked}
              onClick={() => choose(op)}
            >
              {label(op)}
            </Button>
          ))}
          <Link to="/approvals">
            {t("მოთხოვნები და თანხმობები", "Proposals and approvals")}
          </Link>
        </div>
      )}
      {target &&
        !target.isEnvelope &&
        data?.canParticipate &&
        d.status === "open" && (
          <Button
            variant="secondary"
            disabled={locked}
            onClick={() => choose("pledge")}
          >
            {label("pledge")}
          </Button>
        )}
      {!!data?.pledges?.length && (
        <section className="my-4">
          <h3 className="font-semibold">
            {t("ჩემი დაპირებები", "My pledges")}
          </h3>
          {data.pledges.map((p) => (
            <div key={p.id} className="flex flex-wrap gap-3 items-center py-2">
              <span>
                {money(p.amount)} ·{" "}
                {p.withdrawn
                  ? t("გამოთხოვილია", "Withdrawn")
                  : t("დაპირებულია", "Pledged")}{" "}
                · {t("შესრულებულია", "Fulfilled")}: {money(p.fulfilled)} ·{" "}
                {t("დარჩენილია", "Remaining")}: {money(p.remaining)}
              </span>
              <code className="break-all">{p.id}</code>
              {!p.withdrawn && p.remaining !== "0" && (
                <Button
                  variant="secondary"
                  disabled={locked}
                  onClick={() =>
                    void send({
                      operation: "withdraw_pledge",
                      organizationId,
                      key: crypto.randomUUID(),
                      workId: d.id,
                      pledgeId: p.id,
                    })
                  }
                >
                  {t("გამოთხოვა", "Withdraw pledge")}
                </Button>
              )}
            </div>
          ))}
        </section>
      )}
      {mode && data && (
        <form onSubmit={save} className="mt-5">
          <fieldset disabled={locked} className="space-y-4">
            <h3 className="font-semibold">{label(mode)}</h3>
            {mode === "funding_target" && (
              <>
                <Select
                  label={t("ვალუტა", "Currency")}
                  disabled={!!target}
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  options={["GEL", "USD", "EUR"].map((value) => ({
                    value,
                    label: value,
                  }))}
                />
                <Input
                  label={t("დაფინანსების მიზანი", "Funding purpose")}
                  required
                  minLength={3}
                  maxLength={500}
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                />
              </>
            )}
            {mode !== "funding_publish" && (
              <Input
                label={
                  t("თანხა", "Amount") + ` (${target?.currency ?? currency})`
                }
                inputMode="decimal"
                required
                pattern="(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            )}
            {mode === "funding_receipt" && (
              <>
                {demo ? (
                  <Select
                    label={t("კონტრიბუტორი", "Contributor")}
                    required
                    value={memberId}
                    onChange={(e) => setMemberId(e.target.value)}
                    options={Object.entries(people).map(([value, label]) => ({
                      value,
                      label,
                    }))}
                  />
                ) : (
                  <Input
                    label={t(
                      "კონტრიბუტორის წევრობის ID",
                      "Contributor member ID",
                    )}
                    required
                    value={memberId}
                    onChange={(e) => setMemberId(e.target.value)}
                  />
                )}
                <Input
                  label={t(
                    "დაპირების ცნობარი — არასავალდებულო",
                    "Pledge reference — optional",
                  )}
                  value={pledgeId}
                  onChange={(e) => setPledgeId(e.target.value)}
                />
                <p>
                  {t(
                    "პირადი და საბანკო მონაცემების ნაცვლად გამოიყენეთ არასენსიტიური ცნობარი.",
                    "Use a non-sensitive reference, without personal or bank data.",
                  )}
                </p>
              </>
            )}
            {["funding_receipt", "funding_expense", "funding_refund"].includes(
              mode,
            ) && (
              <Input
                label={t("აღრიცხვის ცნობარი", "Accounting reference")}
                required
                minLength={3}
                maxLength={120}
                value={externalRef}
                onChange={(e) => setExternalRef(e.target.value)}
              />
            )}
            {[
              "funding_expense",
              "funding_release",
              "funding_refund",
              "funding_reverse",
            ].includes(mode) && (
              <Select
                label={t("დაკავშირებული ჩანაწერი", "Linked financial record")}
                value={referenceId}
                onChange={(e) => setReferenceId(e.target.value)}
                required={mode !== "funding_expense"}
                options={[
                  {
                    value: "",
                    label:
                      mode === "funding_expense"
                        ? t("ჯავშნის გარეშე", "Without reservation")
                        : t("აირჩიეთ ჩანაწერი", "Choose a record"),
                  },
                  ...(data.entries ?? [])
                    .filter((e) => e.kind === linkedKind && e.workId === d.id)
                    .map((e) => ({
                      value: e.id,
                      label: `${label(e.kind)} · ${money(e.amount)} · ${e.externalRef ?? e.id.slice(0, 8)}`,
                    })),
                ]}
              />
            )}
            {mode === "funding_envelope" && (
              <Select
                label={t("ქვედა დავალება", "Child task")}
                value={childId}
                onChange={(e) => setChildId(e.target.value)}
                required
                options={[
                  { value: "", label: t("აირჩიეთ დავალება", "Choose a task") },
                  ...d.children
                    .filter((c) => c.status === "open")
                    .map((c) => ({ value: c.id, label: c.title })),
                ]}
              />
            )}
            {mode === "funding_publish" && (
              <p>
                {t(
                  "გამოქვეყნდება ჯამები პირადი ცნობარების გარეშე. საჭიროა მინიმუმ 10 ახალი კონტრიბუტორის მიღებული თანხა; განახლებებს შორის — 24 საათი.",
                  "Publishes totals without personal references. Requires net receipts from ten new contributors and 24 hours between updates.",
                )}
              </p>
            )}
            {["funding_receipt", "funding_expense"].includes(mode) && (
              <div className="space-y-2">
                <label className="channel-file-picker">
                  <span>
                    {uploadingAttachment
                      ? t("დოკუმენტი იტვირთება…", "Uploading document…")
                      : t(
                          "დამადასტურებელი ქვითარი (PNG/JPEG/PDF, ≤5 MB — არასავალდებულო)",
                          "Supporting receipt/invoice (PNG/JPEG/PDF, ≤5 MB — optional)",
                        )}
                  </span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,application/pdf"
                    disabled={uploadingAttachment || locked}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (!file) return;
                      if (file.size > 5 * 1024 * 1024) {
                        setError(
                          t(
                            "ფაილი აღემატება 5 MB ლიმიტს.",
                            "File exceeds 5 MB limit.",
                          ),
                        );
                        return;
                      }
                      setError("");
                      setUploadingAttachment(true);
                      try {
                        const uploaded = await collectiveApi.uploadAttachment(
                          organizationId,
                          d.unitId,
                          file,
                        );
                        setAttachment({
                          id: uploaded.id,
                          name: file.name,
                          bytes: uploaded.bytes,
                        });
                      } catch {
                        setError(
                          t(
                            "დოკუმენტის ატვირთვა ვერ შესრულდა.",
                            "Could not upload document.",
                          ),
                        );
                      } finally {
                        setUploadingAttachment(false);
                      }
                    }}
                  />
                </label>
                {attachment && (
                  <p role="status">
                    {t("მიმაგრებული ფაილი", "Attached")}: {attachment.name} (
                    {Math.max(1, Math.round(attachment.bytes / 1024))} KB){" "}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => setAttachment(null)}
                    >
                      {t("წაშლა", "Remove")}
                    </button>
                  </p>
                )}
              </div>
            )}
            {mode !== "pledge" && (
              <Textarea
                label={t("დასაბუთება", "Funding reason")}
                required
                minLength={3}
                maxLength={1000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
            <div className="flex gap-2">
              <Button type="submit">
                {mode === "pledge"
                  ? t("დაპირების შენახვა", "Save pledge")
                  : t("დასამტკიცებლად გაგზავნა", "Submit funding proposal")}
              </Button>
              <Button variant="secondary" onClick={() => setMode("")}>
                {t("დახურვა", "Close")}
              </Button>
            </div>
          </fieldset>
        </form>
      )}
      {data?.canReadRecords && !!data.entries?.length && (
        <details className="mt-5">
          <summary className="min-h-11 cursor-pointer">
            {t(
              "დამტკიცებული ფინანსური ჩანაწერები",
              "Approved financial records",
            )}
          </summary>
          <div className="my-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                downloadSafeCsv(
                  `funding-ledger-${d.id.slice(0, 8)}.csv`,
                  ["id", "kind", "amount", "currency", "externalRef"],
                  (data.entries ?? []).map((e) => [
                    e.id,
                    e.kind,
                    displayMoney(e.amount, target?.currency ?? currency),
                    target?.currency ?? currency,
                    e.externalRef ?? "",
                  ]),
                )
              }
            >
              {t("ფინანსური უწყისის ექსპორტი (CSV)", "Export ledger CSV")}
            </Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th>{t("ტიპი", "Type")}</th>
                  <th>{t("თანხა", "Amount")}</th>
                  <th>{t("ცნობარი", "Reference")}</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr key={e.id}>
                    <td>{label(e.kind)}</td>
                    <td>{money(e.amount)}</td>
                    <td>{e.externalRef ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </Card>
  );
}
