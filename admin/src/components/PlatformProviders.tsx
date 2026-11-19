import { useAsyncResource } from "./useAsyncResource";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  platformApi,
  type ProviderPolicyList,
  type ProviderProposal,
  type ProviderProposalInput,
  type PolicyReviewInput,
  type ProviderReason,
  type ProviderValues,
} from "../api/platform";
import { authApi } from "../api/client";
import { useConsolePreferences } from "./useConsolePreferences";
import Card from "./ui/Card";
import Button from "./ui/Button";
import Input from "./ui/Input";
import Select from "./ui/Select";

export default function PlatformProviders({
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
  const [selection, setSelection] = useState<"new" | ProviderProposal | null>(
    null,
  );
  const [values, setValues] = useState<ProviderValues>({
    provider: "none",
    mode: "off",
    blockSuspicious: false,
  });
  const [apiKey, setApiKey] = useState("");
  const [reason, setReason] = useState<ProviderReason>("security_tightening"),
    [password, setPassword] = useState("");
  const [pending, setPending] = useState(false),
    [attempted, setAttempted] = useState(false),
    [writeError, setWriteError] = useState(""),
    [success, setSuccess] = useState("");
  const request = useRef<ProviderProposalInput | PolicyReviewInput | null>(
    null,
  );
  const [baseline, setBaseline] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLElement | null>(null);
  const cursor = cursors[cursors.length - 1];
  const canAct =
    selection === "new" || selection?.mine ? canPropose : canApprove;
  const load = useCallback(() => platformApi.providerPolicy(cursor), [cursor]);
  const { data, loading, failed } = useAsyncResource<ProviderPolicyList>(
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
      setApiKey("");
      setPassword("");
      request.current = null;
    }
  };
  const open = (item: "new" | ProviderProposal, restore = false) => {
    if (!data) return;
    trigger.current = document.activeElement as HTMLElement;
    setBaseline(data.current.version);
    setValues(
      item === "new"
        ? data.current
        : {
            provider: item.provider,
            mode: item.mode,
            blockSuspicious: item.blockSuspicious,
          },
    );
    setApiKey("");
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
                provider: values.provider,
                mode: values.mode,
                blockSuspicious: values.blockSuspicious,
                ...(apiKey ? { apiKey } : {}),
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
        await platformApi.reviewProviderPolicy(request.current);
      else await platformApi.proposeProviderPolicy(request.current);
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
      setApiKey("");
      setPassword("");
      setPending(false);
    }
  };
  const reasons = {
    security_tightening: t("უსაფრთხოების გაძლიერება", "Tighten security"),
    provider_change: t("პროვაიდერის შეცვლა", "Change provider"),
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
    { key: "provider" as const, label: t("პროვაიდერი", "Provider") },
    { key: "mode" as const, label: t("მოქმედება", "Mode") },
    {
      key: "blockSuspicious" as const,
      label: t(
        "საეჭვო მისამართების შეზღუდვაც",
        "Also restrict suspicious addresses",
      ),
    },
  ];
  const display = (value: string | boolean) =>
    typeof value === "boolean"
      ? value
        ? t("კი", "Yes")
        : t("არა", "No")
      : value === "none"
        ? t("არ არის არჩეული", "Not selected")
        : value === "off"
          ? t("გამორთული", "Off")
          : value === "enforce"
            ? t("ჩართული", "Enforced")
            : "IPHub";
  const valid =
    values.provider === "none"
      ? values.mode === "off" && !apiKey
      : (!apiKey || /^[A-Za-z0-9+/=_-]{1,512}$/.test(apiKey)) &&
        (values.mode === "off" ||
          ((!!apiKey ||
            !!data?.current.hasCredential ||
            (selection !== "new" && !!selection?.hasCredential)) &&
            !!data?.runtimeReady));
  return (
    <div className="space-y-4">
      <Card>
        <h2>{t("VPN / პროქსი — პროვაიდერი", "VPN / proxy provider")}</h2>
        <p>
          {t(
            "IPHub ამოწმებს სანდო გარე მისამართს შესვლისა და პაროლის ხელახლა დადასტურებისას. ჩართვის შემდეგ ეს მისამართი IPHub-ს გადაეცემა. მიუწვდომლობისას გარე ავტორიზაცია შეჩერდება; ლოკალური აღდგენის გზა რჩება. ცვლილებას მეორე ტექნიკური ადმინისტრატორი ამტკიცებს.",
            "IPHub checks the trusted external address at login and password confirmation. Enabling sends that address to IPHub. Provider failure blocks external authentication; local recovery remains available. Another technical administrator must approve changes.",
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
                t("(საწყისი პარამეტრები)", "(default settings)")}
            </p>
            <dl className="grid gap-3 my-4 md:grid-cols-3">
              {fields.map((f) => (
                <div key={f.key}>
                  <dt>{f.label}</dt>
                  <dd>{display(data.current[f.key])}</dd>
                </div>
              ))}
            </dl>
            <p>
              {t("გასაღები: ", "Credential: ")}
              {data.current.hasCredential
                ? t("შენახულია (დაშიფრული)", "Stored (encrypted)")
                : t("არ არის შენახული", "Not stored")}
            </p>
            {!data.runtimeReady && (
              <p role="status">
                {t(
                  "სანდო შესასვლელი ჯერ არ არის დაკავშირებული; ჩართვა მიუწვდომელია.",
                  "Trusted ingress is not connected; enforcement is unavailable.",
                )}
              </p>
            )}
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
                      <dd>{display(item[f.key])}</dd>
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
          aria-labelledby="provider-dialog-title"
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
            <h2 id="provider-dialog-title">
              {selection === "new"
                ? t("პროვაიდერის პარამეტრების შეცვლა", "Configure provider")
                : t("პროვაიდერის ცვლილების განხილვა", "Review provider change")}
            </h2>
            <p>
              {t("საწყისი ვერსია:", "Base version:")}{" "}
              {selection === "new" ? baseline : selection.expectedVersion}
            </p>
            <Select
              label={t("პროვაიდერი", "Provider")}
              value={values.provider}
              disabled={selection !== "new" || attempted || pending}
              options={[
                { value: "none", label: t("არ არის არჩეული", "Not selected") },
                { value: "iphub", label: "IPHub" },
              ]}
              onChange={(e) => {
                const provider = e.target.value as ProviderValues["provider"];
                setValues((v) => ({
                  ...v,
                  provider,
                  mode: provider === "none" ? "off" : v.mode,
                }));
                setApiKey("");
              }}
            />
            <Select
              label={t("მოქმედება", "Mode")}
              value={values.mode}
              disabled={
                selection !== "new" ||
                attempted ||
                pending ||
                values.provider === "none"
              }
              options={[
                { value: "off", label: t("გამორთული", "Off") },
                { value: "enforce", label: t("ჩართული", "Enforced") },
              ]}
              onChange={(e) =>
                setValues((v) => ({
                  ...v,
                  mode: e.target.value as ProviderValues["mode"],
                }))
              }
            />
            <Select
              label={t(
                "საეჭვო მისამართების შეზღუდვაც",
                "Also restrict suspicious addresses",
              )}
              value={String(values.blockSuspicious)}
              disabled={selection !== "new" || attempted || pending}
              options={[
                {
                  value: "false",
                  label: t(
                    "არა — მხოლოდ დადასტურებული პროქსი",
                    "No — only identified proxy",
                  ),
                },
                {
                  value: "true",
                  label: t(
                    "კი — შესაძლებელია მცდარი შეზღუდვებიც",
                    "Yes — false positives are possible",
                  ),
                },
              ]}
              onChange={(e) =>
                setValues((v) => ({
                  ...v,
                  blockSuspicious: e.target.value === "true",
                }))
              }
            />
            {selection === "new" && values.provider === "iphub" && (
              <Input
                label={t(
                  "ახალი API-გასაღები (ცარიელი ინარჩუნებს მოქმედს)",
                  "New API key (empty keeps current)",
                )}
                type="password"
                autoComplete="off"
                maxLength={512}
                value={apiKey}
                disabled={attempted || pending}
                onChange={(e) => setApiKey(e.target.value)}
              />
            )}
            {selection === "new" ? (
              <Select
                label={t("მიზეზი", "Reason")}
                value={reason}
                disabled={attempted || pending}
                options={Object.entries(reasons).map(([value, label]) => ({
                  value,
                  label,
                }))}
                onChange={(e) => setReason(e.target.value as ProviderReason)}
              />
            ) : (
              <p>{reasons[selection.reason]}</p>
            )}
            {!valid && (
              <p role="alert">
                {t(
                  "ჩართვისთვის საჭიროა გასაღები და სანდო შესასვლელი. გასაღები უნდა იყოს დასაშვებ ფორმატში.",
                  "Enforcement requires a credential and trusted ingress. Use a valid credential format.",
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
                  (!attempted && !valid) ||
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
