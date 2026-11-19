import { useAsyncResource } from "./useAsyncResource";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  platformApi,
  type NetworkPolicyList,
  type NetworkProposal,
  type NetworkProposalInput,
  type PolicyReviewInput,
  type NetworkSettings,
} from "../api/platform";
import { authApi } from "../api/client";
import { useConsolePreferences } from "./useConsolePreferences";
import Card from "./ui/Card";
import Button from "./ui/Button";
import Input from "./ui/Input";
import Select from "./ui/Select";

import NetworkFields, { NetworkSummary } from "./NetworkFields";
type NetworkReason = NetworkProposalInput["reason"];

export default function PlatformNetworkPolicy({
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
  const [selection, setSelection] = useState<"new" | NetworkProposal | null>(
    null,
  );
  const [values, setValues] = useState<NetworkSettings>({
    mode: "off",
    countries: [],
    blocked: [],
    exceptions: [],
  });
  const [reason, setReason] = useState<NetworkReason>("security_tightening"),
    [password, setPassword] = useState("");
  const [pending, setPending] = useState(false),
    [attempted, setAttempted] = useState(false),
    [writeError, setWriteError] = useState(""),
    [success, setSuccess] = useState("");
  const request = useRef<NetworkProposalInput | PolicyReviewInput | null>(null);
  const [baseline, setBaseline] = useState(0);
  const [reviewAttempt, setReviewAttempt] = useState<
    PolicyReviewInput["action"] | null
  >(null);
  const dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLElement | null>(null);
  const cursor = cursors[cursors.length - 1];
  const canAct =
    selection === "new" || selection?.mine ? canPropose : canApprove;
  const load = useCallback(() => platformApi.networkPolicy(cursor), [cursor]);
  const { data, loading, failed } = useAsyncResource<NetworkPolicyList>(
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
  const open = (item: "new" | NetworkProposal, restore = false) => {
    if (!data) return;
    trigger.current = document.activeElement as HTMLElement;
    setBaseline(data.current.version);
    const settings = item === "new" ? data.current.settings : item.settings;
    setValues({
      ...settings,
      countries: [...settings.countries],
      blocked: settings.blocked.filter(
        (row) => Date.parse(row.until) > Date.now(),
      ),
      exceptions: settings.exceptions.filter(
        (row) => Date.parse(row.until) > Date.now(),
      ),
    });
    setReason(restore ? "recovery" : "security_tightening");
    setSelection(restore ? "new" : item);
    setPassword("");
    setAttempted(false);
    setReviewAttempt(null);
    setWriteError("");
    setSuccess("");
    request.current = null;
  };
  const mutate = async (action?: PolicyReviewInput["action"]) => {
    if (!selection || !password || pending || !canAct || !data?.configured)
      return;
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
                settings: values,
                reason,
              }
            : {
                requestId: crypto.randomUUID(),
                proposalId: selection.id,
                action: action!,
              };
      }
      setAttempted(true);
      setReviewAttempt(
        "action" in request.current ? request.current.action : null,
      );
      if ("proposalId" in request.current)
        await platformApi.reviewNetworkPolicy(request.current);
      else await platformApi.proposeNetworkPolicy(request.current);
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
    network_access: t("ქსელური წვდომა", "Network access"),
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
  const valid =
    values.countries.length <= 250 &&
    values.countries.every((code) => /^([A-Z]{2}|T1)$/.test(code)) &&
    (values.mode === "off" || values.countries.length > 0);
  return (
    <div className="space-y-4">
      <Card>
        <h2>{t("ქსელური დაცვა", "Network protection")}</h2>
        <p>
          {t(
            "ქვეყნის წესები და დროებითი IP-შეზღუდვები მოქმედებს გარე API-წვდომაზე. ცვლილებას სხვა ტექნიკური ადმინისტრატორი ამტკიცებს. ლოკალური აღდგენა კვლავ მოითხოვს ავტორიზაციას.",
            "Country rules and temporary IP restrictions govern external API access. Another technical administrator must approve changes. Local recovery still requires authentication.",
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
                t("(გარემოს საწყისი პარამეტრები)", "(environment defaults)")}
            </p>
            <NetworkSummary settings={data.current.settings} />
            <p>
              {data.configured
                ? t("ქსელური კონტროლი ჩართულია.", "Network control is enabled.")
                : t(
                    "ქსელური კონტროლი არ არის კონფიგურირებული.",
                    "Network control is not configured.",
                  )}
            </p>
            {!data.countryReady && (
              <p role="status">
                {t(
                  "ქვეყნის ჰედერები ჯერ არ არის დამოწმებული — ქვეყნის წესის დამტკიცება დაბლოკილია.",
                  "Country headers are not verified yet — country policy approval is blocked.",
                )}
              </p>
            )}
            <p>
              {data.source === "local"
                ? t("ლოკალური აღდგენის კავშირი", "Local recovery connection")
                : t("გარე კავშირი", "External connection")}
              {data.country ? " · " + data.country : ""}
            </p>
            {canPropose && (
              <Button disabled={!data.configured} onClick={() => open("new")}>
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
                <NetworkSummary settings={item.settings} />
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
          aria-labelledby="policy-dialog-title"
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
            <h2 id="policy-dialog-title">
              {selection === "new"
                ? t("პოლიტიკის შეთავაზება", "Propose network policy")
                : t("პოლიტიკის განხილვა", "Review network policy")}
            </h2>
            <p>
              {t("საწყისი ვერსია:", "Base version:")}{" "}
              {selection === "new" ? baseline : selection.expectedVersion}
            </p>
            <NetworkFields
              value={values}
              onChange={setValues}
              disabled={selection !== "new" || attempted || pending}
            />
            {selection === "new" ? (
              <Select
                label={t("მიზეზი", "Reason")}
                value={reason}
                disabled={attempted || pending}
                options={Object.entries(reasons).map(([value, label]) => ({
                  value,
                  label,
                }))}
                onChange={(e) => setReason(e.target.value as NetworkReason)}
              />
            ) : (
              <p>{reasons[selection.reason]}</p>
            )}
            {!valid && (
              <p role="alert">
                {t(
                  "გამოიყენეთ ქვეყნის ორსიმბოლოიანი კოდები, მაგალითად GE, DE. აქტიურ წესს სჭირდება მინიმუმ ერთი ქვეყანა.",
                  "Use two-letter country codes, for example GE, DE. An active country rule needs at least one country.",
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
                  !data?.configured ||
                  (selection !== "new" &&
                    !selection.mine &&
                    values.mode !== "off" &&
                    !data?.countryReady &&
                    reviewAttempt !== "reject") ||
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
