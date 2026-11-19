import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { collectiveApi, type RecognitionContext } from "../api/collective";
import { useConsolePreferences } from "./useConsolePreferences";
import { useCollectiveWrite } from "./CollectiveWrite";
import Card from "./ui/Card";
import Button from "./ui/Button";
import Input from "./ui/Input";
import Select from "./ui/Select";

// Construct the bounded review window only when submitting a new proposal.
function reviewDeadline() {
  return new Date(Date.now() + 7 * 86400000).toISOString();
}

export default function TaskRecognition({
  organizationId,
  workId,
  version,
  demo,
  people,
}: {
  organizationId: string;
  workId: string;
  version: number;
  demo: boolean;
  people: Record<string, string>;
}) {
  const { language } = useConsolePreferences();
  const t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [result, setResult] = useState<{
    revision: string;
    data?: RecognitionContext;
    error?: boolean;
  } | null>(null);
  const [reload, setReload] = useState(0);
  const [activity, setActivity] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const revision = `${organizationId}:${workId}:${version}:${reload}`;
  const { send, locked, feedback } = useCollectiveWrite(demo, () =>
    setReload((n) => n + 1),
  );
  useEffect(() => {
    let current = true;
    collectiveApi
      .recognition(organizationId, workId)
      .then((data) => {
        if (current) setResult({ revision, data });
      })
      .catch(() => {
        if (current) setResult({ revision, error: true });
      });
    return () => {
      current = false;
    };
  }, [organizationId, workId, revision]);
  const data = result?.revision === revision ? result.data : undefined;
  const eligible =
    data?.participants.filter((p) => p.state === "available") ?? [];
  const selected = eligible.find((p) => p.activityId === activity);
  const person = (id: string) =>
    people[id] || `${t("წევრი", "Member")} ${id.slice(0, 8)}`;
  async function submitBonus(event: FormEvent) {
    event.preventDefault();
    if (!selected || !data?.rule || !data.unitId || locked) return;
    const saved = await send({
      operation: "propose",
      organizationId,
      key: crypto.randomUUID(),
      unitId: data.unitId,
      kind: "points_award",
      parameters: {
        memberId: selected.memberId,
        activityId: selected.activityId,
        ruleId: data.rule.id,
        amount: Number(amount),
      },
      reason: reason.trim(),
      deadline: reviewDeadline(),
    });
    if (saved) {
      setActivity("");
      setAmount("");
      setReason("");
    }
  }
  if (result?.revision === revision && result.error)
    return (
      <Card>
        {feedback}
        <p role="alert">
          {t(
            "პირადი ბონუსის მონაცემები ვერ ჩაიტვირთა.",
            "Could not load additional recognition.",
          )}
        </p>
        <Button variant="secondary" onClick={() => setReload((n) => n + 1)}>
          {t("ხელახლა ცდა", "Retry")}
        </Button>
      </Card>
    );
  if (data && !data.canAward && !data.unitId) return null;
  return (
    <Card>
      <section
        aria-label={t("პირადი ბონუსი", "Additional recognition")}
        className="space-y-4"
      >
        <h3 className="text-lg font-semibold">
          {t("პირადი ბონუსი", "Additional recognition")}
        </h3>
        <p className="text-sm text-gray-600">
          {t(
            "დადასტურებული შესრულებისთვის შესაძლებელია დამატებითი ქულის შეთავაზება. საჭიროა დამოუკიდებელი დამტკიცება; მოქმედებს საერთო ყოველთვიური ლიმიტები.",
            "Propose extra points for verified work. Independent approval and shared monthly limits apply.",
          )}
        </p>
        {feedback}
        {!data ? (
          <p role="status">{t("იტვირთება…", "Loading…")}</p>
        ) : (
          <>
            {!data.rule ? (
              <p>
                {t(
                  "პირადი ჯილდოების წესი ჯერ არ არის ჩართული.",
                  "Individual recognition has not been enabled yet.",
                )}{" "}
                <Link to="/contribution">
                  {t("ჯილდოების წესები", "Recognition rules")}
                </Link>
              </p>
            ) : (
              <p className="text-sm text-gray-600">
                {t("ერთჯერადი მაქსიმუმი", "Maximum per award")}:{" "}
                {data.rule.amount} ·{" "}
                {t("წევრის თვიური ზღვარი", "Member monthly cap")}:{" "}
                {data.rule.memberMonthCap} ·{" "}
                {t("გამცემის თვიური ლიმიტი", "Issuer monthly allowance")}:{" "}
                {data.rule.issuerMonthCap}
              </p>
            )}
            {data.participants
              .filter((p) => p.state !== "available")
              .map((p) => (
                <p key={p.activityId}>
                  {person(p.memberId)} ·{" "}
                  {p.state === "pending"
                    ? t("ბონუსი ელოდება დამტკიცებას", "Bonus awaiting approval")
                    : t("ბონუსი უკვე მინიჭებულია", "Bonus already awarded")}
                </p>
              ))}
            {!eligible.length && (
              <p>
                {t(
                  "დამატებითი ბონუსისთვის ხელმისაწვდომი დადასტურებული მონაწილე ჯერ არ არის. საკუთარ თავს ჯილდოს ვერ მიანიჭებ.",
                  "No verified participant is currently available for an additional bonus. You cannot award yourself.",
                )}
              </p>
            )}
            {data.canAward && data.rule && eligible.length > 0 && (
              <form onSubmit={submitBonus}>
                <fieldset disabled={locked} className="space-y-4">
                  <Select
                    label={t("დადასტურებული მონაწილე", "Verified participant")}
                    required
                    value={activity}
                    onChange={(e) => setActivity(e.target.value)}
                    options={[
                      {
                        value: "",
                        label: t("აირჩიე მონაწილე", "Select participant"),
                      },
                      ...eligible.map((p) => ({
                        value: p.activityId,
                        label: person(p.memberId),
                      })),
                    ]}
                  />
                  <Input
                    label={t("ბონუსის ქულა", "Bonus points")}
                    type="number"
                    min={1}
                    max={data.rule.amount}
                    step={1}
                    required
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                  <Input
                    label={t("ბონუსის დასაბუთება", "Reason for bonus")}
                    required
                    minLength={3}
                    maxLength={1000}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <Button type="submit" disabled={!selected}>
                    {t("ბონუსის შეთავაზება", "Propose bonus")}
                  </Button>
                </fieldset>
              </form>
            )}
          </>
        )}
      </section>
    </Card>
  );
}
