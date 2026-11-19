import { useAsyncResource } from "./useAsyncResource";
import {Link} from 'react-router-dom';
import { useCallback, useEffect, useRef, useState } from "react";
import {
  platformApi,
  type PlatformSession,
  type PlatformSessions as SessionList,
  type SessionReason,
} from "../api/platform";
import { authApi } from "../api/client";
import { useConsolePreferences } from "./useConsolePreferences";
import Card from "./ui/Card";
import Button from "./ui/Button";
import Input from "./ui/Input";
import Select from "./ui/Select";

export default function PlatformSessions({
  canRevoke,
  refreshRevision = 0,
}: {
  canRevoke: boolean;
  refreshRevision?: number;
}) {
  const { language } = useConsolePreferences();
  const t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [kind, setKind] = useState("all"),
    [cursors, setCursors] = useState<string[]>([]);
  const [revision, setRevision] = useState(0),
    [success, setSuccess] = useState(false);
  const [selection, setSelection] = useState<PlatformSession | null>(null);
  const [reason, setReason] = useState<SessionReason>("suspected_compromise"),
    [password, setPassword] = useState("");
  const [pending, setPending] = useState(false),
    [writeError, setWriteError] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const request = useRef<{
    sessionId: string;
    requestId: string;
    reason: SessionReason;
  } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLElement | null>(null);
  const cursor = cursors[cursors.length - 1];
  const load = useCallback(
    () => platformApi.sessions(kind, cursor),
    [kind, cursor],
  );
  const { data, loading, failed, clear } = useAsyncResource<SessionList>(
    JSON.stringify([kind, cursor, revision, refreshRevision, language]),
    load,
  );
  const error = failed
    ? t(
        "სესიები ვერ ჩაიტვირთა ან წვდომა აღარ გაქვთ.",
        "Sessions could not be loaded or access is no longer available.",
      )
    : "";
  useEffect(() => {
    if (!selection) return;
    const element = dialog.current;
    element?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      element?.close();
      document.body.style.overflow = previous;
      trigger.current?.focus();
    };
  }, [selection]);
  const close = () => {
    if (!pending) {
      setSelection(null);
      setPassword("");
      request.current = null;
    }
  };
  const date = (v: string) =>
    new Date(v).toLocaleString(language === "ka" ? "ka-GE" : "en-GB", {
      dateStyle: "short",
      timeStyle: "short",
      hour12: false,
    });
  const labels = {
    technical: t("ტექნიკური", "Technical"),
    organization: t("ორგანიზაციული", "Organizational"),
    unclassified: t("სხვა ვებ-ანგარიში", "Other web account"),
  };
  return (
    <Card>
      <h2>{t("აქტიური ვებ-სესიები", "Active web sessions")}</h2>
      <p>
        {t(
          "შეწყვეტა ამ მოწყობილობის სესიას გააუქმებს. ანგარიშის უფლებები უცვლელი დარჩება; ხელახალი შესვლა შესაძლებელია.",
          "Revocation ends this browser session. Account permissions remain unchanged; signing in again is possible.",
        )}
      </p>
      <div className="flex flex-wrap items-end gap-3 my-4">
        <Select
          label={t("ანგარიშის ტიპი", "Account type")}
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setCursors([]);
          }}
          options={[
            { value: "all", label: t("ყველა", "All") },
            ...Object.entries(labels).map(([value, label]) => ({
              value,
              label,
            })),
          ]}
        />
        <Button
          variant="secondary"
          disabled={loading}
          onClick={() => setRevision((v) => v + 1)}
        >
          {t("სესიების განახლება", "Refresh sessions")}
        </Button>
      </div>
      {loading && <p role="status">{t("იტვირთება…", "Loading…")}</p>}
      {error && <p role="alert">{error}</p>}
      {success && <p role="status">{t("სესია შეწყდა.", "Session revoked.")}</p>}
      {data && (
        <>
          {!data.items.length ? (
            <p>
              {t("აქტიური სესიები არ მოიძებნა.", "No active sessions found.")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="review-table">
                <thead>
                  <tr>
                    <th>{t("სესიის კოდი", "Session reference")}</th>
                    <th>{t("ტიპი", "Type")}</th>
                    <th>{t("ბოლო მოთხოვნა", "Last request")}</th>
                    <th>{t("ვადა", "Expires")}</th>
                    <th>{t("მოქმედება", "Action")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <span className="break-all">{s.id}</span>
                        {s.current && (
                          <p>{t("მიმდინარე სესია", "Current session")}</p>
                        )}
                      </td>
                      <td>{labels[s.kind]}</td>
                      <td>{date(s.lastSeenAt)}</td>
                      <td>{date(s.expiresAt)}</td>
                      <td>
                        {canRevoke && !s.current && (
                          <Button
                            variant="danger"
                            onClick={(e) => {
                              trigger.current = e.currentTarget;
                              setSelection(s);
                              setReason("suspected_compromise");
                              setWriteError(false);
                              setAttempted(false);
                              setSuccess(false);
                            }}
                          >
                            {t("შეწყვეტა", "Revoke")}
                          </Button>
                        )}
                        {s.accountId&&<Link className="underline inline-flex min-h-11 items-center" to={'/platform/accounts?account='+s.accountId}>{t('ანგარიშის დაცვა','Protect account')}</Link>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3 mt-4">
            <Button
              variant="secondary"
              disabled={loading || !cursors.length}
              onClick={() => setCursors((v) => v.slice(0, -1))}
            >
              {t("წინა", "Previous")}
            </Button>
            <span>
              {t("გვერდი", "Page")} {cursors.length + 1}
            </span>
            <Button
              variant="secondary"
              disabled={loading || !data.nextBefore}
              onClick={() => setCursors((v) => [...v, data.nextBefore!])}
            >
              {t("შემდეგი", "Next")}
            </Button>
          </div>
        </>
      )}
      {selection && (
        <dialog
          ref={dialog}
          aria-labelledby="session-confirm-title"
          className="rounded-xl p-6 w-[calc(100%-2rem)] max-w-lg max-h-[85vh] overflow-y-auto bg-[var(--surface)] text-[var(--text)] border border-[var(--border)] backdrop:bg-black/50"
          onCancel={(e) => {
            e.preventDefault();
            close();
          }}
        >
          <h2 id="session-confirm-title">
            {t("სესიის შეწყვეტის დადასტურება", "Confirm session revocation")}
          </h2>
          <p className="break-all">{selection.id}</p>
          <form
            className="space-y-4 mt-4"
            onSubmit={async (e) => {
              e.preventDefault();
              if (pending || !password || !canRevoke) return;
              setPending(true);
              setAttempted(true);
              setWriteError(false);
              request.current ??= {
                sessionId: selection.id,
                reason,
                requestId: crypto.randomUUID(),
              };
              try {
                await authApi.stepUp(password);
                setPassword("");
                await platformApi.revokeSession(request.current);
                setSelection(null);
                request.current = null;
                setSuccess(true);
                clear();
                setRevision((v) => v + 1);
              } catch {
                setWriteError(true);
                setPassword("");
                clear();
              } finally {
                setPending(false);
              }
            }}
          >
            <Select
              label={t("მიზეზი", "Reason")}
              value={reason}
              disabled={pending || attempted}
              onChange={(e) => setReason(e.target.value as SessionReason)}
              options={[
                {
                  value: "suspected_compromise",
                  label: t("შესაძლო კომპრომეტაცია", "Suspected compromise"),
                },
                {
                  value: "operator_request",
                  label: t(
                    "წვდომის მფლობელის მოთხოვნა",
                    "Account holder request",
                  ),
                },
                {
                  value: "session_hygiene",
                  label: t(
                    "გამოუყენებელი სესიის დახურვა",
                    "Unused session cleanup",
                  ),
                },
              ]}
            />
            <Input
              label={t("თქვენი პაროლი", "Your password")}
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={pending}
              required
              onChange={(e) => setPassword(e.target.value)}
            />
            {writeError && (
              <p role="alert">
                {t(
                  "შედეგი ვერ დადასტურდა. გადაამოწმეთ პაროლი და წვდომა; გამეორება იმავე მოთხოვნას გამოიყენებს.",
                  "The result could not be confirmed. Check password and access; retry uses the same request.",
                )}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-3">
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={close}
              >
                {t("გაუქმება", "Cancel")}
              </Button>
              <Button
                type="submit"
                variant="danger"
                disabled={pending || !password}
              >
                {pending
                  ? t("მუშავდება…", "Processing…")
                  : t("დადასტურება და შეწყვეტა", "Confirm and revoke")}
              </Button>
            </div>
          </form>
        </dialog>
      )}
    </Card>
  );
}
