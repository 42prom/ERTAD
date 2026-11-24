import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  mailPolicyApi,
  type MailValues,
  type MailProposal,
} from "../api/mailPolicy";
import { authApi } from "../api/client";
import type { PolicyReviewInput, ProviderReason } from "../api/platform";
import { useAsyncResource } from "./useAsyncResource";
import { useConsolePreferences } from "./useConsolePreferences";
import Card from "./ui/Card";
import Button from "./ui/Button";
import Input from "./ui/Input";
import Select from "./ui/Select";

type Selection =
  | { kind: "new" }
  | { kind: "check" }
  | { kind: "review"; item: MailProposal; action: PolicyReviewInput["action"] };
export default function PlatformMail({
  canPropose,
  canApprove,
  canTest,
  refreshRevision = 0,
}: {
  canPropose: boolean;
  canApprove: boolean;
  canTest: boolean;
  refreshRevision?: number;
}) {
  const { language } = useConsolePreferences();
  const t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [revision, setRevision] = useState(0),
    [cursors, setCursors] = useState<string[]>([]);
  const before = cursors[cursors.length - 1];
  const key = JSON.stringify([before, revision, refreshRevision, language]);
  const load = useCallback(() => mailPolicyApi.list(before), [before]);
  const resource = useAsyncResource(key, load);
  const [selection, setSelection] = useState<Selection | null>(null),
    [baseline, setBaseline] = useState(0);
  const [values, setValues] = useState<MailValues>({
    provider: "none",
    mode: "off",
    senderName: "",
    senderEmail: "",
  });
  const [secret, setSecret] = useState(""),
    [password, setPassword] = useState("");
  const [reason, setReason] = useState<ProviderReason>("provider_change");
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const [diagnosticContext, setDiagnosticContext] = useState<string | null>(
    null,
  );
  const currentDiagnosticContext = JSON.stringify([
    refreshRevision,
    language,
    canTest,
    resource.data?.current.version,
  ]);
  const lock = useRef(false),
    dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!selection) return;
    const node = dialog.current,
      overflow = document.body.style.overflow;
    node?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      node?.close();
      document.body.style.overflow = overflow;
      trigger.current?.focus();
    };
  }, [selection]);
  function close() {
    if (!lock.current) {
      setSelection(null);
      setSecret("");
      setPassword("");
    }
  }
  function open(next: Selection) {
    if (!resource.data) return;
    trigger.current = document.activeElement as HTMLElement;
    setBaseline(resource.data.current.version);
    setValues(next.kind === "review" ? next.item : resource.data.current);
    setSecret("");
    setPassword("");
    setNotice("");
    setDiagnosticContext(null);
    setError("");
    setSelection(next);
  }
  const retainsCredential =
    !!resource.data?.current.hasCredential &&
    values.provider === resource.data.current.provider &&
    (values.provider !== "smtp" ||
      ((values.smtpService ?? "sendgrid") ===
        (resource.data.current.smtpService ?? "sendgrid") &&
        (values.smtpUser ?? "") === (resource.data.current.smtpUser ?? "")));
  const valid =
    values.provider === "none"
      ? values.mode === "off"
      : (values.mode === "off" ||
          /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(
            values.senderEmail,
          )) &&
        (!secret ||
          (values.provider === "smtp"
            ? secret.length >= 10 &&
              secret.length <= 256 &&
              [...secret].every(
                (char) =>
                  char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
              )
            : /^[A-Za-z0-9._-]{10,256}$/.test(secret))) &&
        (!values.deliveryEnabled ||
          (values.mode === "enabled" &&
            /^https:\/\/[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(
              values.publicOrigin ?? "",
            ))) &&
        (values.provider !== "smtp" ||
          values.mode === "off" ||
          !!values.smtpUser) &&
        (values.mode === "off" || !!secret || retainsCredential);
  const validationHint =
    selection?.kind !== "new" || valid
      ? ""
      : values.provider === "none" && values.mode !== "off"
        ? t(
            "გამორთულ პროვაიდერზე რეჟიმი უნდა იყოს გამორთული.",
            "Mode must be off when provider is disabled.",
          )
        : values.mode !== "off" &&
            !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(
              values.senderEmail,
            )
          ? t(
              "შეიყვანეთ გამგზავნის სწორი ელფოსტის მისამართი (მაგ. noreply@domain.ge).",
              "Enter a valid sender email address (e.g. noreply@domain.ge).",
            )
          : values.provider === "smtp" &&
              values.mode !== "off" &&
              !values.smtpUser
            ? t(
                "SMTP რეჟიმისთვის მიუთითეთ SMTP მომხმარებელი.",
                "Enter an SMTP username when SMTP mode is enabled.",
              )
            : values.mode !== "off" && !secret && !retainsCredential
              ? t(
                  values.provider === "smtp"
                    ? "პირველი ჩართვისთვის შეიყვანეთ SMTP პაროლი (მინ. 10 სიმბოლო)."
                    : "პირველი ჩართვისთვის შეიყვანეთ API გასაღები (მინ. 10 სიმბოლო).",
                  values.provider === "smtp"
                    ? "Enter an SMTP password (at least 10 characters)."
                    : "Enter an API key (at least 10 characters).",
                )
              : secret &&
                  !(values.provider === "smtp"
                    ? secret.length >= 10 &&
                      secret.length <= 256 &&
                      [...secret].every(
                        (char) =>
                          char.charCodeAt(0) >= 32 &&
                          char.charCodeAt(0) !== 127,
                      )
                    : /^[A-Za-z0-9._-]{10,256}$/.test(secret))
                ? t(
                    "გასაღები/პაროლი უნდა შეიცავდეს 10–256 დასაშვებ სიმბოლოს.",
                    "Credential must be 10–256 valid characters.",
                  )
                : values.deliveryEnabled &&
                    !(
                      values.mode === "enabled" &&
                      /^https:\/\/[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(
                        values.publicOrigin ?? "",
                      )
                    )
                  ? t(
                      "რეალური მიწოდებისთვის რეჟიმი უნდა იყოს ჩართული და საჯარო მისამართი იწყებოდეს https://-ით.",
                      "Real delivery requires enabled mode and a valid https:// public origin.",
                    )
                  : "";
  const allowed =
    !!resource.data &&
    (selection?.kind === "new"
      ? canPropose && valid
      : selection?.kind === "check"
        ? canTest
        : selection?.kind === "review"
          ? selection.action === "withdraw"
            ? canPropose
            : canApprove
          : false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !selection || !password || !allowed) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    let started = false;
    try {
      await authApi.stepUp(password);
      setPassword("");
      started = true;
      if (selection.kind === "new") {
        const { provider, mode, senderName, senderEmail } = values;
        await mailPolicyApi.propose({
          requestId: crypto.randomUUID(),
          expectedVersion: baseline,
          provider,
          mode,
          senderName,
          senderEmail,
          reason,
          deliveryEnabled: values.deliveryEnabled ?? false,
          publicOrigin: values.publicOrigin ?? "",
          smtpService: values.smtpService ?? "sendgrid",
          smtpUser: values.smtpUser ?? "",
          ...(secret && provider !== "none" ? { apiKey: secret } : {}),
        });
        setNotice(
          t(
            "ცვლილება წარდგენილია დამოუკიდებელი დადასტურებისთვის.",
            "Change submitted for independent approval.",
          ),
        );
      } else if (selection.kind === "review") {
        await mailPolicyApi.review({
          requestId: crypto.randomUUID(),
          proposalId: selection.item.id,
          action: selection.action,
        });
        setNotice(t("განხილვა დასრულდა.", "Review completed."));
      } else {
        const result = await mailPolicyApi.check(baseline);
        setDiagnosticContext(
          JSON.stringify([refreshRevision, language, canTest, result.version]),
        );
        setNotice(
          result.status === "valid"
            ? t(
                "პროვაიდერის შემოწმება წარმატებულია. წერილი არ გაგზავნილა; მიღებასა და მისამართის მფლობელობას ეს არ ადასტურებს.",
                "Provider validation passed. No email was sent; this does not prove delivery or address ownership.",
              )
            : result.status === "off"
              ? t(
                  "ელფოსტის ინტეგრაცია გამორთულია.",
                  "Email integration is off.",
                )
              : t(
                  "სატესტო შემოწმება ვერ დადასტურდა.",
                  "Sandbox validation could not be confirmed.",
                ),
        );
      }
    } catch {
      setError(
        started
          ? t(
              "შედეგი ვერ დადასტურდა. გადაამოწმეთ განახლებული სია; მოქმედება ავტომატურად არ განმეორდება.",
              "The outcome could not be confirmed. Check the refreshed list; this action will not be retried automatically.",
            )
          : t(
              "პაროლის დადასტურება ვერ მოხერხდა.",
              "Password confirmation failed.",
            ),
      );
    } finally {
      setSelection(null);
      setPassword("");
      setSecret("");
      resource.clear();
      setRevision((v) => v + 1);
      lock.current = false;
      setBusy(false);
    }
  }
  const statuses = {
    pending: t("მოლოდინში", "Pending"),
    approved: t("დადასტურებული", "Approved"),
    rejected: t("უარყოფილი", "Rejected"),
    withdrawn: t("გამოთხოვილი", "Withdrawn"),
    expired: t("ვადაგასული", "Expired"),
  };
  return (
    <div className="space-y-6">
      <Card>
        <h2>{t("ელფოსტის სერვისი", "Email service")}</h2>
        <p className="my-3">
          {t(
            "გამგზავნი და დაშიფრული გასაღები აქ იმართება. ცვლილებას მეორე ტექნიკური მენეჯერი ამტკიცებს. რეალური წერილების მიწოდება ცალკე უნდა ჩართოთ. შემოწმება არ ადასტურებს წერილის მიღებას ან დომენის მფლობელობას.",
            "Manage the sender and encrypted credential here. A second technical manager approves changes. Real delivery requires a separate opt-in. Validation does not prove delivery or domain ownership.",
          )}
        </p>
        {resource.loading && <p role="status">{t("იტვირთება…", "Loading…")}</p>}
        {resource.failed && (
          <p role="alert">
            {t(
              "პარამეტრები ვერ ჩაიტვირთა ან წვდომა აღარ გაქვთ.",
              "Settings could not load or access is no longer available.",
            )}
          </p>
        )}
        {notice &&
          (diagnosticContext === null ||
            diagnosticContext === currentDiagnosticContext) && (
            <p role="status">{notice}</p>
          )}
        {error && <p role="alert">{error}</p>}
        {resource.data && (
          <>
            <dl className="grid gap-3 my-4 md:grid-cols-2">
              <div>
                <dt>{t("მოქმედი ვერსია", "Current version")}</dt>
                <dd>{resource.data.current.version}</dd>
              </div>
              <div>
                <dt>{t("პროვაიდერი", "Provider")}</dt>
                <dd>
                  {resource.data.current.provider !== "none"
                    ? resource.data.current.provider === "smtp"
                      ? "SMTP"
                      : "SendGrid"
                    : t("არ არის არჩეული", "Not selected")}
                </dd>
              </div>
              <div>
                <dt>{t("გამგზავნი", "Sender")}</dt>
                <dd>
                  {resource.data.current.senderName}{" "}
                  {resource.data.current.senderEmail}
                </dd>
              </div>
              <div>
                <dt>{t("რეჟიმი", "Mode")}</dt>
                <dd>
                  {resource.data.current.mode === "off"
                    ? t("გამორთული", "Off")
                    : t("ჩართული", "Enabled")}
                </dd>
              </div>
              <div>
                <dt>{t("გასაღები", "Credential")}</dt>
                <dd>
                  {resource.data.current.hasCredential
                    ? t(
                        "შენახულია — მნიშვნელობა დამალულია",
                        "Stored — value hidden",
                      )
                    : t("არ არის შენახული", "Not stored")}
                </dd>
              </div>
            </dl>
            <p>
              {t("რეალური მიწოდება", "Real delivery")}:{" "}
              {resource.data.current.deliveryEnabled
                ? t("ჩართული", "Enabled")
                : t("გამორთული", "Off")}
            </p>
            {resource.data.delivery && (
              <div className="mt-4">
                <h3>{t("წერილების რიგი", "Email queue")}</h3>
                <dl className="grid gap-3 sm:grid-cols-2">
                  {Object.entries(resource.data.delivery).map(
                    ([state, count]) => (
                      <div key={state}>
                        <dt>
                          {(
                            {
                              queued: t("რიგშია", "Queued"),
                              sending: t("იგზავნება", "Sending"),
                              retry: t(
                                "განმეორებითი მცდელობა",
                                "Retry scheduled",
                              ),
                              accepted: t(
                                "პროვაიდერმა მიიღო",
                                "Provider accepted",
                              ),
                              failed: t("უარყოფილია", "Rejected"),
                              uncertain: t(
                                "შედეგი გაურკვეველია",
                                "Outcome uncertain",
                              ),
                              cancelled: t("გაუქმებულია", "Cancelled"),
                            } as Record<string, string>
                          )[state] ?? state}
                        </dt>
                        <dd>{count}</dd>
                      </div>
                    ),
                  )}
                </dl>
                <p>
                  {t(
                    "პროვაიდერის მიერ მიღება არ ნიშნავს, რომ წერილი მიმღების საფოსტო ყუთში მოხვდა.",
                    "Provider acceptance does not confirm inbox delivery.",
                  )}
                </p>
              </div>
            )}
            {resource.data.current.publicOrigin && (
              <p className="break-all">{resource.data.current.publicOrigin}</p>
            )}
            <div className="flex flex-wrap gap-3">
              {canPropose && (
                <Button disabled={busy} onClick={() => open({ kind: "new" })}>
                  {t("პარამეტრების შეცვლა", "Change email settings")}
                </Button>
              )}
              {canTest && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => open({ kind: "check" })}
                >
                  {t("შემოწმება გაგზავნის გარეშე", "Validate without sending")}
                </Button>
              )}
            </div>
          </>
        )}
        <Button
          variant="secondary"
          className="mt-3"
          disabled={busy}
          onClick={() => {
            setNotice("");
            setRevision((v) => v + 1);
          }}
        >
          {t("განახლება", "Refresh email settings")}
        </Button>
      </Card>
      {resource.data && (
        <Card>
          <h2>{t("მოთხოვნები და ვერსიები", "Requests and versions")}</h2>
          {!resource.data.items.length && (
            <p>{t("მოთხოვნები ჯერ არ არის.", "No requests yet.")}</p>
          )}
          <div className="space-y-3">
            {resource.data.items.map((item) => (
              <article
                key={item.id}
                className="border border-[var(--border)] rounded-lg p-4 space-y-2"
              >
                <h3>
                  {statuses[item.status]} · {t("ვერსია", "Version")}{" "}
                  {item.version ?? item.expectedVersion}
                </h3>
                <p>
                  {item.provider} ·{" "}
                  {item.mode === "off"
                    ? t("გამორთული", "Off")
                    : t("ჩართული", "Enabled")}{" "}
                  · {item.senderName} {item.senderEmail}
                </p>
                <p>
                  {item.hasCredential
                    ? t("გასაღები დაშიფრულია", "Credential encrypted")
                    : t("გასაღები არ არის", "No credential")}
                  {item.mine ? t(" · ჩემი მოთხოვნა", " · My request") : ""}
                </p>
                {item.status === "pending" && (
                  <div className="flex gap-3">
                    {item.mine && canPropose && (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          open({ kind: "review", item, action: "withdraw" })
                        }
                      >
                        {t("გამოთხოვა", "Withdraw")}
                      </Button>
                    )}
                    {!item.mine && canApprove && (
                      <>
                        <Button
                          disabled={busy}
                          onClick={() =>
                            open({ kind: "review", item, action: "approve" })
                          }
                        >
                          {t("დადასტურება", "Approve")}
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() =>
                            open({ kind: "review", item, action: "reject" })
                          }
                        >
                          {t("უარყოფა", "Reject")}
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </article>
            ))}
          </div>
          <div className="flex gap-3 mt-3">
            <Button
              variant="secondary"
              disabled={!cursors.length || busy}
              onClick={() => setCursors((v) => v.slice(0, -1))}
            >
              {t("წინა", "Previous")}
            </Button>
            <Button
              variant="secondary"
              disabled={!resource.data.nextBefore || busy}
              onClick={() =>
                setCursors((v) => [...v, resource.data!.nextBefore!])
              }
            >
              {t("შემდეგი", "Next")}
            </Button>
          </div>
        </Card>
      )}
      {selection && (
        <dialog
          ref={dialog}
          className="m-auto rounded-xl p-6 w-[calc(100%-2rem)] max-w-lg max-h-[85vh] overflow-y-auto bg-[var(--surface)] text-[var(--text)] border border-[var(--border)] backdrop:bg-black/50"
          aria-labelledby="mail-dialog-title"
          onCancel={(e) => {
            e.preventDefault();
            close();
          }}
        >
          <form onSubmit={submit} className="space-y-4">
            <h2 id="mail-dialog-title">
              {selection.kind === "new"
                ? t("ელფოსტის კონფიგურაცია", "Email configuration")
                : selection.kind === "check"
                  ? t("კონფიგურაციის შემოწმება", "Validate configuration")
                  : t("ცვლილების განხილვა", "Review change")}
            </h2>
            {selection.kind === "new" ? (
              <>
                <Select
                  label={t("პროვაიდერი", "Provider")}
                  value={values.provider}
                  disabled={busy}
                  options={[
                    {
                      value: "none",
                      label: t(
                        "გამორთვა და მოქმედი გასაღების გაუქმება",
                        "Disable and clear active credential",
                      ),
                    },
                    { value: "sendgrid", label: "SendGrid" },
                    { value: "smtp", label: "SMTP" },
                  ]}
                  onChange={(e) => {
                    const provider = e.target.value as MailValues["provider"];
                    setValues((v) => ({
                      ...v,
                      provider,
                      mode: provider === "none" ? "off" : v.mode,
                      deliveryEnabled: false,
                    }));
                    setSecret("");
                  }}
                />
                <Select
                  label={t("რეჟიმი", "Mode")}
                  value={values.mode}
                  disabled={busy || values.provider === "none"}
                  options={[
                    { value: "off", label: t("გამორთული", "Off") },
                    { value: "enabled", label: t("ჩართული", "Enabled") },
                  ]}
                  onChange={(e) =>
                    setValues((v) => ({
                      ...v,
                      mode: e.target.value as MailValues["mode"],
                      deliveryEnabled: false,
                    }))
                  }
                />
                <Input
                  label={t("გამგზავნის სახელი", "Sender name")}
                  value={values.senderName}
                  maxLength={80}
                  disabled={busy}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, senderName: e.target.value }))
                  }
                />
                <Input
                  label={t("გამგზავნის ელფოსტა", "Sender email")}
                  type="email"
                  value={values.senderEmail}
                  maxLength={254}
                  disabled={busy}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, senderEmail: e.target.value }))
                  }
                />
                {values.provider === "smtp" && (
                  <>
                    <Select
                      label={t("SMTP სერვისი", "SMTP service")}
                      value={values.smtpService ?? "sendgrid"}
                      disabled={busy}
                      options={[
                        { value: "sendgrid", label: "SendGrid" },
                        { value: "gmail", label: "Google / Gmail" },
                        { value: "office365", label: "Microsoft 365" },
                      ]}
                      onChange={(e) => {
                        setValues((v) => ({
                          ...v,
                          smtpService: e.target
                            .value as MailValues["smtpService"],
                        }));
                        setSecret("");
                      }}
                    />
                    <Input
                      label={t("SMTP მომხმარებელი", "SMTP username")}
                      value={values.smtpUser ?? ""}
                      maxLength={254}
                      disabled={busy}
                      autoComplete="off"
                      onChange={(e) =>
                        setValues((v) => ({ ...v, smtpUser: e.target.value }))
                      }
                    />
                    <p>
                      {t(
                        "STARTTLS სავალდებულოა. გამოიყენეთ სერვისის მიერ დაშვებული SMTP ავტორიზაცია.",
                        "STARTTLS is required. Use the SMTP authentication permitted by your provider.",
                      )}
                    </p>
                  </>
                )}
                {values.provider !== "none" && (
                  <Input
                    label={t(
                      values.provider === "smtp"
                        ? "ახალი SMTP პაროლი — ცარიელი ინარჩუნებს მოქმედს"
                        : "ახალი API გასაღები — ცარიელი ინარჩუნებს მოქმედს",
                      values.provider === "smtp"
                        ? "New SMTP password — empty keeps current"
                        : "New API key — empty keeps current",
                    )}
                    type="password"
                    autoComplete="off"
                    value={secret}
                    maxLength={256}
                    disabled={busy}
                    onChange={(e) => setSecret(e.target.value)}
                  />
                )}
                <Input
                  label={t(
                    "აპლიკაციის საჯარო HTTPS მისამართი",
                    "Public application HTTPS origin",
                  )}
                  value={values.publicOrigin ?? ""}
                  maxLength={260}
                  placeholder="https://app.example.org"
                  disabled={busy}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, publicOrigin: e.target.value }))
                  }
                />
                <label className="flex gap-3 items-center">
                  <input
                    type="checkbox"
                    checked={values.deliveryEnabled ?? false}
                    disabled={busy || values.mode !== "enabled"}
                    onChange={(e) =>
                      setValues((v) => ({
                        ...v,
                        deliveryEnabled: e.target.checked,
                      }))
                    }
                  />
                  {t(
                    "რეალური წერილების მიწოდების ჩართვა",
                    "Enable real email delivery",
                  )}
                </label>
                <Select
                  label={t("მიზეზი", "Reason")}
                  value={reason}
                  disabled={busy}
                  options={[
                    {
                      value: "provider_change",
                      label: t("პროვაიდერის ცვლილება", "Provider change"),
                    },
                    {
                      value: "security_tightening",
                      label: t(
                        "უსაფრთხოების გაძლიერება",
                        "Security tightening",
                      ),
                    },
                    { value: "recovery", label: t("აღდგენა", "Recovery") },
                  ]}
                  onChange={(e) => setReason(e.target.value as ProviderReason)}
                />
              </>
            ) : selection.kind === "check" ? (
              <p>
                {t(
                  "შემოწმდება სერვისთან ავტორიზაცია (SMTP) ან სატესტო მოთხოვნა (SendGrid). რეალური წერილი არ გაიგზავნება.",
                  "Checks SMTP authentication or SendGrid sandbox validation. No real email will be sent.",
                )}
              </p>
            ) : (
              <div className="space-y-3 break-words">
                <dl className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <dt>{t("პროვაიდერი", "Provider")}</dt>
                    <dd>
                      {selection.item.provider !== "none"
                        ? selection.item.provider === "smtp"
                          ? "SMTP"
                          : "SendGrid"
                        : t("არ არის არჩეული", "Not selected")}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("რეჟიმი", "Mode")}</dt>
                    <dd>
                      {selection.item.mode === "enabled"
                        ? t("ჩართული", "Enabled")
                        : t("გამორთული", "Off")}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("გამგზავნის სახელი", "Sender name")}</dt>
                    <dd>{selection.item.senderName || "—"}</dd>
                  </div>
                  <div>
                    <dt>{t("გასაღები", "Credential")}</dt>
                    <dd>
                      {selection.item.hasCredential
                        ? t(
                            "შენახულია — მნიშვნელობა დამალულია",
                            "Stored — value hidden",
                          )
                        : t("არ არის შენახული", "Not stored")}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("საწყისი ვერსია", "Base version")}</dt>
                    <dd>{selection.item.expectedVersion}</dd>
                  </div>
                </dl>
                <p>
                  {t("რეალური მიწოდება", "Real delivery")}:{" "}
                  {selection.item.deliveryEnabled
                    ? t("ჩართული", "Enabled")
                    : t("გამორთული", "Off")}{" "}
                  · {selection.item.publicOrigin}
                </p>
                {selection.item.provider === "smtp" && (
                  <p>
                    {selection.item.smtpService} · {selection.item.smtpUser}
                  </p>
                )}
                <p>
                  {selection.item.senderEmail} ·{" "}
                  {statuses[selection.item.status]} ·{" "}
                  {selection.action === "approve"
                    ? t("დადასტურება", "Approve")
                    : selection.action === "reject"
                      ? t("უარყოფა", "Reject")
                      : t("გამოთხოვა", "Withdraw")}
                </p>
              </div>
            )}
            <Input
              label={t("თქვენი პაროლი", "Your password")}
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
            />
            {validationHint && (
              <p role="alert" className="text-sm text-[var(--danger)]">
                {validationHint}
              </p>
            )}
            {error && selection && (
              <p role="alert" className="text-sm text-[var(--danger)]">
                {error}
              </p>
            )}
            <div className="flex gap-3">
              <Button type="submit" disabled={busy || !password || !allowed}>
                {t("დადასტურება", "Confirm")}
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
    </div>
  );
}
