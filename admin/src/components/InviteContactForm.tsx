import { useCallback, useRef, useState, type FormEvent } from "react";
import { invitationsApi } from "../api/invitations";
import { authApi } from "../api/client";
import { useAsyncResource } from "./useAsyncResource";
import { useConsolePreferences } from "./useConsolePreferences";
import Card from "./ui/Card";
import Button from "./ui/Button";
import Select from "./ui/Select";
import Input from "./ui/Input";
export default function InviteContactForm({
  organizationId,
  onCreated,
}: {
  organizationId: string;
  onCreated: () => void;
}) {
  const { language } = useConsolePreferences(),
    t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [open, setOpen] = useState(false),
    [page, setPage] = useState(1),
    [revision, setRevision] = useState(0);
  const load = useCallback(
    () =>
      open
        ? invitationsApi.candidates(organizationId, page)
        : Promise.resolve(null),
    [organizationId, page, open],
  );
  const resource = useAsyncResource(
    JSON.stringify([organizationId, page, open, revision]),
    load,
  );
  const [selected, setSelected] = useState(""),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const lock = useRef(false),
    candidate = resource.data?.items.find(
      (c) => c.unitId + ":" + c.memberId === selected,
    );
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !candidate || !confirmed || !password || !email) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      await authApi.stepUp(password);
      await invitationsApi.createContact({
        organizationId,
        unitId: candidate.unitId,
        memberId: candidate.memberId,
        email,
        requestId: crypto.randomUUID(),
      });
      setMessage(
        t(
          "კონტაქტი შენახულია. ახლა შექმენით მოწვევა და წარადგინეთ დამოუკიდებლად დასამტკიცებლად.",
          "Contact saved. Create an invitation and submit it for independent approval.",
        ),
      );
      setOpen(false);
      onCreated();
    } catch {
      setMessage(
        t(
          "შედეგი ვერ დადასტურდა. გადაამოწმეთ ადრესატების სია; მოთხოვნა ავტომატურად არ განმეორდება.",
          "The outcome is unconfirmed. Check the recipient list; this request will not retry automatically.",
        ),
      );
      setRevision((v) => v + 1);
    } finally {
      setPassword("");
      setEmail("");
      setConfirmed(false);
      setBusy(false);
      lock.current = false;
    }
  }
  return (
    <Card>
      <h2>{t("ახალი ადრესატი", "New recipient")}</h2>
      {message && <p role="status">{message}</p>}
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() => {
          setOpen((v) => !v);
          setPassword("");
          setEmail("");
          setSelected("");
          setConfirmed(false);
        }}
      >
        {open
          ? t("დახურვა", "Close")
          : t("წევრის ელფოსტის მითითება", "Add member email")}
      </Button>
      {open && (
        <form onSubmit={submit} className="space-y-4 mt-4">
          <p>
            {t(
              "მიუთითეთ ამ წევრის მიერ მოწოდებული მისამართი. მოწვევას სხვა უფლებამოსილი მენეჯერი ამტკიცებს, მისამართს კი თავად მიმღები დაადასტურებს. ეს არ არის იდენტობის ბიომეტრიული შემოწმება.",
              "Use the address supplied by this member. Another authorized manager reviews the invitation and the recipient proves email ownership. This is not biometric identity verification.",
            )}
          </p>
          {resource.loading && (
            <p role="status">{t("იტვირთება…", "Loading…")}</p>
          )}
          {resource.failed && (
            <p role="alert">
              {t("წევრები ვერ ჩაიტვირთა.", "Could not load members.")}
            </p>
          )}
          <Select
            label={t("წევრი და ერთეული", "Member and unit")}
            disabled={busy}
            value={selected}
            options={[
              { value: "", label: t("აირჩიეთ", "Select") },
              ...(resource.data?.items ?? []).map((c) => ({
                value: c.unitId + ":" + c.memberId,
                label: (c.displayName ?? c.memberId) + " · " + c.unitName,
              })),
            ]}
            onChange={(e) => {
              setSelected(e.target.value);
              setConfirmed(false);
            }}
          />
          <div className="flex gap-3">
            <Button
              variant="secondary"
              disabled={busy || page === 1}
              onClick={() => {
                setPage((p) => p - 1);
                setSelected("");
              }}
            >
              {t("წინა", "Previous members")}
            </Button>
            <Button
              variant="secondary"
              disabled={busy || resource.data?.items.length !== 25}
              onClick={() => {
                setPage((p) => p + 1);
                setSelected("");
              }}
            >
              {t("შემდეგი", "Next members")}
            </Button>
          </div>
          <Input
            label={t("წევრის ელფოსტა", "Member email")}
            type="email"
            required
            maxLength={254}
            value={email}
            disabled={busy}
            onChange={(e) => setEmail(e.target.value)}
          />
          <label className="flex gap-3">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {t(
              "მისამართი შერჩეულ წევრს ეკუთვნის და მას მოწვევაზე თანხმობა აქვს მოცემული.",
              "The selected member supplied this address and agreed to receive an invitation.",
            )}
          </label>
          <Input
            label={t("თქვენი პაროლი", "Your password")}
            type="password"
            autoComplete="current-password"
            value={password}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button
            type="submit"
            disabled={busy || !candidate || !email || !password || !confirmed}
          >
            {t("კონტაქტის შენახვა", "Save contact")}
          </Button>
        </form>
      )}
    </Card>
  );
}
