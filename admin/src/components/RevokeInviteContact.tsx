import { useEffect, useRef, useState, type FormEvent } from "react";
import { authApi } from "../api/client";
import { invitationsApi, type InviteContact } from "../api/invitations";
import { useConsolePreferences } from "./useConsolePreferences";
import Card from "./ui/Card";
import Button from "./ui/Button";
import Input from "./ui/Input";
export default function RevokeInviteContact({
  organizationId,
  contact,
  disabled = false,
  onSettled,
}: {
  organizationId: string;
  contact: InviteContact;
  disabled?: boolean;
  onSettled: (success: boolean) => void;
}) {
  const { language } = useConsolePreferences(),
    t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [open, setOpen] = useState(false),
    [password, setPassword] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    lock = useRef(false);
  useEffect(() => {
    if (!open) return;
    const node = dialog.current,
      overflow = document.body.style.overflow;
    node?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      node?.close();
      document.body.style.overflow = overflow;
      trigger.current?.focus();
    };
  }, [open]);
  function close() {
    if (lock.current) return;
    setOpen(false);
    setPassword("");
    setConfirmed(false);
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (lock.current || !confirmed || !password || disabled) return;
    lock.current = true;
    setBusy(true);
    let success = false;
    try {
      await authApi.stepUp(password);
      setPassword("");
      await invitationsApi.revokeContact(organizationId, contact.id);
      success = true;
    } catch {
      /* The parent refreshes current state without an automatic mutation retry. */
    } finally {
      setPassword("");
      setConfirmed(false);
      setOpen(false);
      setBusy(false);
      lock.current = false;
      onSettled(success);
    }
  }
  return (
    <Card>
      <h2>{t("შერჩეული ადრესატის კონტაქტი", "Selected recipient contact")}</h2>
      <p>
        {contact.displayName ?? t("წევრი", "Member")} · {contact.unitName} ·{" "}
        {contact.contactHint}
      </p>
      <p>
        {t(
          "არასწორი მისამართის გასასწორებლად გააუქმეთ ეს კონტაქტი და შექმენით ახალი. ძველი მოწვევები და ბმულები გაუქმდება. უკვე გააქტიურებული ანგარიშის კონტაქტს ეს მოქმედება არ ცვლის.",
          "To correct an address, revoke this contact and create a new one. Old invitations and links become unavailable. This action cannot change an activated account contact.",
        )}
      </p>
      <Button
        ref={trigger}
        variant="secondary"
        disabled={disabled || busy}
        onClick={() => {
          setPassword("");
          setConfirmed(false);
          setOpen(true);
        }}
      >
        {t("კონტაქტის გაუქმება", "Revoke recipient contact")}
      </Button>
      {open && (
        <dialog
          ref={dialog}
          aria-labelledby="revoke-contact-title"
          className="m-auto rounded-xl p-6 w-[calc(100%-2rem)] max-w-lg max-h-[85vh] overflow-y-auto bg-[var(--surface)] text-[var(--text)] border border-[var(--border)] backdrop:bg-black/50"
          onCancel={(e) => {
            e.preventDefault();
            close();
          }}
        >
          <form onSubmit={submit} className="space-y-4">
            <h2 id="revoke-contact-title">
              {t("ადრესატის კონტაქტის გაუქმება", "Revoke pending contact")}
            </h2>
            <p>
              {contact.displayName ?? t("წევრი", "Member")} · {contact.unitName}{" "}
              · {contact.contactHint}
            </p>
            <p>
              {t(
                "უკვე გაგზავნილი წერილის დაბრუნება შეუძლებელია; ძველი ბმულები მოქმედებას ვეღარ შეასრულებს. სწორი მისამართისთვის ახალი მოწვევა და დამოუკიდებელი დამტკიცება დაგჭირდებათ.",
                "An email already sent cannot be recalled; its old links will no longer perform the action. A corrected address needs a new invitation and independent approval.",
              )}
            </p>
            <label className="flex gap-3 items-center min-h-11">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              {t(
                "ვადასტურებ ამ კონტაქტისა და ძველი მოწვევების გაუქმებას.",
                "I confirm revoking this contact and its old invitations.",
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
            <div className="flex flex-wrap gap-3">
              <Button
                type="submit"
                disabled={busy || disabled || !password || !confirmed}
              >
                {t("გაუქმების დადასტურება", "Confirm revocation")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={close}
              >
                {t("დახურვა", "Close")}
              </Button>
            </div>
          </form>
        </dialog>
      )}
    </Card>
  );
}
