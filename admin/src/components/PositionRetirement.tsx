import { useEffect, useState, type FormEvent } from "react";
import { authApi } from "../api/client";
import type { CollectiveWrite } from "../api/collective";
import type { PositionDefinition } from "../api/positions";
import { useConsolePreferences } from "./useConsolePreferences";
import Card from "./ui/Card";
import Input from "./ui/Input";
import Textarea from "./ui/Textarea";
import Button from "./ui/Button";

export default function PositionRetirement({
  source,
  organizationId,
  demo,
  locked,
  available,
  send,
  close,
}: {
  source: PositionDefinition;
  organizationId: string;
  demo: boolean;
  locked: boolean;
  available: boolean;
  send: (input: CollectiveWrite) => Promise<boolean>;
  close: () => void;
}) {
  const { language } = useConsolePreferences(),
    t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [reason, setReason] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const dirty = !!reason || locked;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (locked || busy || !available || !confirmed || reason.trim().length < 3)
      return;
    setBusy(true);
    setError("");
    try {
      if (!demo) await authApi.stepUp(password);
      setPassword("");
      await send({
        operation: "propose",
        organizationId,
        unitId: source.unitId,
        key: crypto.randomUUID(),
        kind: "position_retire",
        parameters: {
          sourceId: source.id,
          sourceVersion: source.version,
          sourceName: source.name,
        },
        reason: reason.trim(),
        deadline: new Date(Date.now() + 86400000).toISOString(),
      });
    } catch {
      setError(
        t("პაროლის დადასტურება ვერ მოხერხდა.", "Password confirmation failed."),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <form
        className="space-y-4"
        onSubmit={(e) => void submit(e)}
        aria-label={t("პოზიციის გამოყენებიდან ამოღება", "Retire position")}
      >
        <h2>{t("პოზიციის გამოყენებიდან ამოღება", "Retire position")}</h2>
        <p>
          <strong>{source.name}</strong> · {source.unitName}
        </p>
        <p>
          {t(
            "დამტკიცების შემდეგ ამ პოზიციაზე ახალი დანიშვნა ვეღარ მოხდება. ისტორია და უფლებების აღწერა შენარჩუნდება. მოქმედი, დაგეგმილი ან შეჩერებული წევრობები და მიმდინარე დანიშვნის/რედაქტირების მოთხოვნები ჯერ უნდა გადაწყდეს.",
            "After approval, this position will no longer accept appointments. History and permission definitions are preserved. Active, scheduled or suspended memberships and pending appointment/revision requests must be resolved first.",
          )}
        </p>
        {!available && (
          <p role="alert">
            {t(
              "პოზიციის მდგომარეობა ან წვდომა შეიცვალა. გადაამოწმეთ მონაცემები.",
              "Position state or access changed. Review the current records.",
            )}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <Textarea
          label={t("ამოღების მიზეზი", "Reason for retirement")}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setConfirmed(false);
          }}
          required
          minLength={3}
          maxLength={1000}
          disabled={locked || busy}
        />
        {!demo && (
          <Input
            type="password"
            autoComplete="current-password"
            label={t("პაროლის დადასტურება", "Confirm password")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={locked || busy}
          />
        )}
        <label className="flex gap-2 items-start">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            disabled={locked || busy || !available}
          />
          {t(
            "ვადასტურებ ამ პოზიციის გამოყენებიდან ამოღების მოთხოვნას. საჭიროა სხვა უფლებამოსილი პირის დამტკიცება.",
            "I confirm this retirement request. Another authorized person must approve it.",
          )}
        </label>
        <div className="flex flex-wrap gap-3">
          <Button
            type="submit"
            disabled={
              locked ||
              busy ||
              !available ||
              !confirmed ||
              reason.trim().length < 3
            }
          >
            {t("ამოღების მოთხოვნის გაგზავნა", "Submit retirement request")}
          </Button>
          <Button
            variant="secondary"
            type="button"
            disabled={locked || busy}
            onClick={close}
          >
            {t("გაუქმება", "Cancel")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
