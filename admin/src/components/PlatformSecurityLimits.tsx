import { useAsyncResource } from "./useAsyncResource";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  platformApi,
  type SecurityLimitsList,
  type SecurityLimitsProposal,
  type LimitsProposalInput,
  type PolicyReviewInput,
  type LimitsReason,
} from "../api/platform";
import { authApi } from "../api/client";
import { useConsolePreferences } from "./useConsolePreferences";
import Card from "./ui/Card";
import Button from "./ui/Button";
import Input from "./ui/Input";
import Select from "./ui/Select";

export default function PlatformSecurityLimits({
  canPropose,
  canApprove,
  refreshRevision = 0,
}: {
  canPropose: boolean;
  canApprove: boolean;
  refreshRevision?: number;
}) {
  const { language } = useConsolePreferences();
  const t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [cursors, setCursors] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState<
    "new" | SecurityLimitsProposal | null
  >(null);
  const [values, setValues] = useState({
    apiPerMinute: 120,
    loginFailures: 5,
    lockoutMinutes: 15,
    anonymousMinElectorate: 10,
  });
  const [reason, setReason] = useState<LimitsReason>("security_tightening"),
    [password, setPassword] = useState("");
  const [pending, setPending] = useState(false),
    [attempted, setAttempted] = useState(false),
    [writeError, setWriteError] = useState(""),
    [success, setSuccess] = useState("");
  const request = useRef<LimitsProposalInput | PolicyReviewInput | null>(null);
  const [baseline, setBaseline] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLElement | null>(null);
  const cursor = cursors[cursors.length - 1];
  const canAct =
    selection === "new" || selection?.mine ? canPropose : canApprove;
  const load = useCallback(() => platformApi.securityLimits(cursor), [cursor]);
  const { data, loading, failed } = useAsyncResource<SecurityLimitsList>(
    JSON.stringify([cursor, revision, refreshRevision, language]),
    load,
  );
  const error = failed
    ? t(
        "პოლიტიკა ვერ ჩაიტვირთა ან წვდომა აღარ გაქვთ.",
        "Policy could not be loaded or access is no longer available.",
      )
    : "";
  useEffect(() => {
    if (!selection) return;
    const element = dialog.current,
      overflow = document.body.style.overflow;
    element?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      element?.close();
      document.body.style.overflow = overflow;
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
  const open = (item: "new" | SecurityLimitsProposal, restore = false) => {
    if (!data) return;
    trigger.current = document.activeElement as HTMLElement;
    setBaseline(data.current.version);
    setValues(
      item === "new"
        ? {
            apiPerMinute: data.current.apiPerMinute,
            loginFailures: data.current.loginFailures,
            lockoutMinutes: data.current.lockoutMinutes,
            anonymousMinElectorate: data.current.anonymousMinElectorate ?? 10,
          }
        : {
            apiPerMinute: item.apiPerMinute,
            loginFailures: item.loginFailures,
            lockoutMinutes: item.lockoutMinutes,
            anonymousMinElectorate:
              item.anonymousMinElectorate ??
              data.current.anonymousMinElectorate ??
              10,
          },
    );
    setReason(restore ? "recovery" : "security_tightening");
    setSelection(restore ? "new" : item);
    setPassword("");
    setAttempted(false);
    setWriteError("");
    setSuccess("");
    request.current = null;
  };
  const mutate = async (action?: PolicyReviewInput["action"]) => {
    if (!selection || !password || pending || !canAct) return;
    setPending(true);
    setWriteError("");
    try {
      await authApi.stepUp(password);
      if (!request.current) {
        request.current =
          selection === "new"
            ? {
                requestId: crypto.randomUUID(),
                expectedVersion: baseline,
                apiPerMinute: values.apiPerMinute,
                loginFailures: values.loginFailures,
                lockoutMinutes: values.lockoutMinutes,
                anonymousMinElectorate: values.anonymousMinElectorate,
                reason,
              }
            : {
                requestId: crypto.randomUUID(),
                proposalId: selection.id,
                action: action!,
              };
      }
      setAttempted(true);
      if ("proposalId" in request.current)
        await platformApi.reviewSecurityLimits(request.current);
      else await platformApi.proposeSecurityLimits(request.current);
      setSelection(null);
      request.current = null;
      setCursors([]);
      setRevision((v) => v + 1);
      setSuccess(
        t(
          "ცვლილება შენახულია. სტატუსი განახლდა.",
          "Change saved. Status refreshed.",
        ),
      );
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      if ([400, 403, 404, 409].includes(status ?? 0)) {
        setSelection(null);
        request.current = null;
        setRevision((v) => v + 1);
        setSuccess(
          t(
            "მოთხოვნა უარყოფილია: შეამოწმეთ განახლებული ვერსია და უფლებები.",
            "Request rejected: check the refreshed version and permissions.",
          ),
        );
      } else
        setWriteError(
          t(
            "ქმედება ვერ დადასტურდა. გადაამოწმეთ პაროლი და გაიმეორეთ იგივე მოთხოვნა.",
            "Action could not be confirmed. Check your password and retry the same request.",
          ),
        );
    } finally {
      setPassword("");
      setPending(false);
    }
  };
  const reasons = {
    security_tightening: t("უსაფრთხოების გაძლიერება", "Tighten security"),
    traffic_adjustment: t("ტრაფიკის მორგება", "Adjust traffic limits"),
    recovery: t("წინა პარამეტრების აღდგენა", "Restore previous values"),
  };
  const statuses = {
    pending: t("დასადასტურებელია", "Pending review"),
    approved: t("დამტკიცებულია", "Approved"),
    rejected: t("უარყოფილია", "Rejected"),
    withdrawn: t("გამოთხოვილია", "Withdrawn"),
    expired: t("ვადაგასულია", "Expired"),
  };
  const date = (value: string) =>
    new Date(value).toLocaleString(language === "ka" ? "ka-GE" : "en-GB", {
      dateStyle: "short",
      timeStyle: "short",
      hour12: false,
    });
  const fields = [
    {
      key: "apiPerMinute" as const,
      min: 60,
      max: 600,
      label: t(
        "API-მოთხოვნები მისამართზე / წუთში",
        "API requests per address / minute",
      ),
    },
    {
      key: "loginFailures" as const,
      min: 3,
      max: 10,
      label: t("წარუმატებელი მცდელობების ზღვარი", "Failed attempt limit"),
    },
    {
      key: "lockoutMinutes" as const,
      min: 5,
      max: 60,
      label: t("ანგარიშის დაბლოკვა (წუთი)", "Account lockout (minutes)"),
    },
    {
      key: "anonymousMinElectorate" as const,
      min: 2,
      max: 1000,
      label: t(
        "ანონიმური პულის მინ. ამომრჩეველი (k)",
        "Anonymous poll minimum electorate (k)",
      ),
    },
  ];
  const valid = fields.every(
    (f) =>
      Number.isInteger(values[f.key]) &&
      values[f.key] >= f.min &&
      values[f.key] <= f.max,
  );
  return (
    <div className="space-y-4">
      <Card>
        <h2>{t("უსაფრთხოების ლიმიტები", "Security limits")}</h2>
        <p>
          {t(
            "ცვლილებას სხვა ტექნიკური ადმინისტრატორი ამტკიცებს. დამტკიცებული ლიმიტები შემდეგ მოთხოვნაზე მოქმედებს. მისამართზე წარუმატებელი შესვლები 15 წუთის განმავლობაში ითვლება; ანგარიშზე — ზედიზედ წარუმატებელი შესვლა და პაროლის დადასტურება. უკვე დაწესებული დაბლოკვა ძალაში რჩება. მისამართის მრიცხველები სერვერის გადატვირთვისას ნულდება; ანგარიშის დაბლოკვა ბაზაში ინახება.",
            "Another technical administrator must approve changes. Limits apply on the next request. Address failures use a 15-minute window; account failures count consecutive failed logins and password confirmations. Existing lockouts remain. Address counters reset on server restart; account lockouts persist in the database.",
          )}
        </p>
        {loading && <p role="status">{t("იტვირთება…", "Loading…")}</p>}
        {error && <p role="alert">{error}</p>}
        {success && <p role="status">{success}</p>}
        {data && (
          <>
            <p>
              {t("მოქმედი ვერსია:", "Current version:")} {data.current.version}{" "}
              {data.current.version === 0 &&
                t("(საწყისი ლიმიტები)", "(default limits)")}
            </p>
            <dl className="grid gap-3 my-4 md:grid-cols-2 lg:grid-cols-4">
              {fields.map((f) => (
                <div key={f.key}>
                  <dt>{f.label}</dt>
                  <dd>{data.current[f.key] ?? "—"}</dd>
                </div>
              ))}
            </dl>
            {canPropose && (
              <Button onClick={() => open("new")}>
                {t("ცვლილების შეთავაზება", "Propose change")}
              </Button>
            )}
          </>
        )}
      </Card>
      {data && (
        <Card>
          <h2>{t("მოთხოვნები და ვერსიები", "Requests and versions")}</h2>
          {!data.items.length && (
            <p>
              {t(
                "ცვლილების მოთხოვნები ჯერ არ არის.",
                "No change requests yet.",
              )}
            </p>
          )}
          <div className="space-y-4">
            {data.items.map((item) => (
              <article
                key={item.id}
                className="border border-[var(--border)] rounded-lg p-4 space-y-2"
              >
                <h3>
                  {statuses[item.status]} ·{" "}
                  {item.version === null
                    ? t("საწყისი ვერსია", "Base version")
                    : t("ვერსია", "Version")}{" "}
                  {item.version ?? item.expectedVersion}
                </h3>
                <p>
                  {reasons[item.reason]} · {date(item.createdAt)}
                  {item.mine ? t(" · ჩემი მოთხოვნა", " · My request") : ""}
                </p>
                <dl className="grid gap-2 md:grid-cols-3">
                  {fields.map((f) => (
                    <div key={f.key}>
                      <dt>{f.label}</dt>
                      <dd>{item[f.key]}</dd>
                    </div>
                  ))}
                </dl>
                {item.status === "pending" && (
                  <p>
                    {t("დადასტურების ვადა:", "Review deadline:")}{" "}
                    {date(item.expiresAt)}
                    {item.expectedVersion !== data.current.version &&
                      t(
                        " · ვერსია შეიცვალა — საჭიროა ახალი შეთავაზება.",
                        " · Version changed — submit a new proposal.",
                      )}
                  </p>
                )}
                {item.status === "pending" &&
                  (item.mine ? canPropose : canApprove) && (
                    <Button variant="secondary" onClick={() => open(item)}>
                      {item.mine
                        ? t("გამოთხოვა", "Withdraw request")
                        : t("განხილვა", "Review request")}
                    </Button>
                  )}
                {item.status === "approved" && canPropose && (
                  <Button variant="secondary" onClick={() => open(item, true)}>
                    {t("ამ პარამეტრებით შეთავაზება", "Propose these values")}
                  </Button>
                )}
              </article>
            ))}
          </div>
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
        </Card>
      )}
      {selection && (
        <dialog
          ref={dialog}
          aria-labelledby="limits-dialog-title"
          className="m-auto rounded-xl p-6 w-[calc(100%-2rem)] max-w-lg max-h-[85vh] overflow-y-auto bg-[var(--surface)] text-[var(--text)] border border-[var(--border)] backdrop:bg-black/50"
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(
                selection === "new"
                  ? undefined
                  : selection.mine
                    ? "withdraw"
                    : "approve",
              );
            }}
          >
            <h2 id="limits-dialog-title">
              {selection === "new"
                ? t("ლიმიტების ცვლილების შეთავაზება", "Propose security limits")
                : t("ლიმიტების ცვლილების განხილვა", "Review security limits")}
            </h2>
            <p>
              {t("საწყისი ვერსია:", "Base version:")}{" "}
              {selection === "new" ? baseline : selection.expectedVersion}
            </p>
            {fields.map((f) => (
              <Input
                key={f.key}
                label={f.label + " (" + f.min + "–" + f.max + ")"}
                type="number"
                min={f.min}
                max={f.max}
                step={1}
                required
                value={values[f.key]}
                disabled={selection !== "new" || attempted || pending}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [f.key]: Number(e.target.value) }))
                }
              />
            ))}
            {selection === "new" ? (
              <Select
                label={t("მიზეზი", "Reason")}
                value={reason}
                disabled={attempted || pending}
                options={Object.entries(reasons).map(([value, label]) => ({
                  value,
                  label,
                }))}
                onChange={(e) => setReason(e.target.value as LimitsReason)}
              />
            ) : (
              <p>{reasons[selection.reason]}</p>
            )}
            {!valid && (
              <p role="alert">
                {t(
                  "მიუთითეთ მთელი რიცხვები დასაშვებ საზღვრებში.",
                  "Use whole numbers within the stated bounds.",
                )}
              </p>
            )}
            <Input
              label={t("თქვენი პაროლი", "Your password")}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              disabled={pending}
              onChange={(e) => setPassword(e.target.value)}
            />
            {writeError && <p role="alert">{writeError}</p>}
            {!canAct && (
              <p role="alert">
                {t(
                  "ამ ქმედების უფლება აღარ გაქვთ.",
                  "You no longer have permission for this action.",
                )}
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              <Button
                type="submit"
                disabled={
                  !canAct ||
                  pending ||
                  !password ||
                  !valid ||
                  (!attempted &&
                    selection !== "new" &&
                    !selection.mine &&
                    data?.current.version !== selection.expectedVersion)
                }
              >
                {pending
                  ? t("ინახება…", "Saving…")
                  : attempted
                    ? t("იგივე მოთხოვნის გამეორება", "Retry same request")
                    : selection === "new"
                      ? t("გაგზავნა დასადასტურებლად", "Submit for approval")
                      : selection.mine
                        ? t("გამოთხოვის დადასტურება", "Confirm withdrawal")
                        : t("დამტკიცება", "Approve")}
              </Button>
              {selection !== "new" && !selection.mine && !attempted && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!canAct || pending || !password}
                  onClick={() => void mutate("reject")}
                >
                  {t("უარყოფა", "Reject")}
                </Button>
              )}
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={close}
              >
                {t("დახურვა", "Close")}
              </Button>
            </div>
          </form>
        </dialog>
      )}
    </div>
  );
}
