import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ShieldCheck, Smartphone, Trash2, Lock, CheckCircle2, XCircle } from "lucide-react";
import { authApi } from "../api/client";
import {
  platformApi,
  type MobileDevicesResponse,
  type VerificationPolicyResponse,
  type VerificationPolicyValues,
  type VerificationProposalItem,
} from "../api/platform";
import { useConsolePreferences } from "./useConsolePreferences";
import Card from "./ui/Card";
import Button from "./ui/Button";
import Input from "./ui/Input";
import Select from "./ui/Select";

interface PlatformVerificationProps {
  canPropose: boolean;
  canApprove: boolean;
  canControlDevices: boolean;
  refreshRevision: number;
}

export default function PlatformVerification({
  canPropose,
  canApprove,
  canControlDevices,
  refreshRevision,
}: PlatformVerificationProps) {
  const { language } = useConsolePreferences();
  const ka = language === "ka";
  const t = (ge: string, en: string) => (ka ? ge : en);

  const [policyData, setPolicyData] = useState<VerificationPolicyResponse | null>(null);
  const [devicesData, setDevicesData] = useState<MobileDevicesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingDeviceAction, setPendingDeviceAction] = useState<{
    op: "hold" | "revoke" | "purge_biometrics";
    bindingId?: string;
    label: string;
  } | null>(null);
  const [stepUpPassword, setStepUpPassword] = useState("");
  const [pendingStepUp, setPendingStepUp] = useState<
    | { kind: "propose" }
    | { kind: "review"; proposal: VerificationProposalItem; action: "approve" | "reject" | "withdraw" }
    | { kind: "device"; op: "hold" | "release" | "revoke" | "purge_biometrics"; bindingId?: string }
    | null
  >(null);

  const [draft, setDraft] = useState<VerificationPolicyValues>({
    authProfile: "google_hybrid",
    requireDeviceAttestation: true,
    requireNfc: true,
    requireGeorgianCitizen: true,
    livenessProvider: "3d_face_detector",
    faceMatchProvider: "custom_biometric_matcher",
    livenessMinScore: 0.7,
    faceMatchMinScore: 0.4,
    retryLimit: 3,
    biometricTtlSeconds: 900,
  });
  const [ttlInput, setTtlInput] = useState("900");
  const [livenessInput, setLivenessInput] = useState("0.7");
  const [faceMatchInput, setFaceMatchInput] = useState("0.4");
  const [retryInput, setRetryInput] = useState("3");
  const [reason, setReason] = useState<"security_tightening" | "provider_change" | "recovery">(
    "security_tightening",
  );

  const applyLoaded = useCallback(
    (pol: VerificationPolicyResponse, devs: MobileDevicesResponse) => {
      setPolicyData(pol);
      setDevicesData(devs);
      const livenessScore = Number(pol.policy.livenessMinScore);
      const faceScore = Number(pol.policy.faceMatchMinScore);
      setDraft({
        authProfile: pol.policy.authProfile,
        requireDeviceAttestation: pol.policy.requireDeviceAttestation,
        requireNfc: pol.policy.requireNfc,
        requireGeorgianCitizen: pol.policy.requireGeorgianCitizen,
        livenessProvider: "3d_face_detector",
        faceMatchProvider: "custom_biometric_matcher",
        livenessMinScore: livenessScore,
        faceMatchMinScore: faceScore,
        retryLimit: pol.policy.retryLimit,
        biometricTtlSeconds: pol.policy.biometricTtlSeconds,
      });
      setTtlInput(String(pol.policy.biometricTtlSeconds));
      setLivenessInput(String(livenessScore));
      setFaceMatchInput(String(faceScore));
      setRetryInput(String(pol.policy.retryLimit));
    },
    [],
  );

  const load = useCallback(async () => {
    setError("");
    try {
      const [pol, devs] = await Promise.all([
        platformApi.verificationPolicy(),
        platformApi.mobileDevices(),
      ]);
      applyLoaded(pol, devs);
    } catch {
      setError(
        ka
          ? "ბიომეტრიისა და მოწყობილობების პოლიტიკის ჩატვირთვა ვერ მოხერხდა."
          : "Failed to load verification policy and mobile devices.",
      );
    } finally {
      setLoading(false);
    }
  }, [applyLoaded, ka]);

  useEffect(() => {
    let active = true;
    Promise.all([
      platformApi.verificationPolicy(),
      platformApi.mobileDevices(),
    ])
      .then(([pol, devs]) => {
        if (!active) return;
        setError("");
        applyLoaded(pol, devs);
      })
      .catch(() => {
        if (!active) return;
        setError(
          ka
            ? "ბიომეტრიისა და მოწყობილობების პოლიტიკის ჩატვირთვა ვერ მოხერხდა."
            : "Failed to load verification policy and mobile devices.",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [applyLoaded, ka, refreshRevision]);

  const handlePropose = async () => {
    if (!policyData || !canPropose) return;
    const ttl = Number(ttlInput);
    const livenessScore = Number(livenessInput);
    const faceScore = Number(faceMatchInput);
    const retryLimit = Number(retryInput);
    if (
      !Number.isInteger(ttl) ||
      ttl < 60 ||
      ttl > 86400 ||
      Number.isNaN(livenessScore) ||
      livenessScore < 0.3 ||
      livenessScore > 0.99 ||
      Number.isNaN(faceScore) ||
      faceScore < 0.15 ||
      faceScore > 0.99 ||
      !Number.isInteger(retryLimit) ||
      retryLimit < 1 ||
      retryLimit > 10
    ) {
      setError(
        t(
          "შეამოწმეთ ზღვრები: TTL 60–86400, Liveness 0.30–0.99, სახის თანხვედრა 0.15–0.99, მცდელობა 1–10.",
          "Invalid bounds: TTL 60–86400, Liveness 0.30–0.99, Face-Match 0.15–0.99, Retries 1–10.",
        ),
      );
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await platformApi.proposeVerificationPolicy({
        requestId: crypto.randomUUID(),
        expectedVersion: policyData.policy.version,
        ...draft,
        livenessMinScore: livenessScore,
        faceMatchMinScore: faceScore,
        retryLimit,
        biometricTtlSeconds: ttl,
        livenessProvider: "3d_face_detector",
        faceMatchProvider: "custom_biometric_matcher",
        reason,
      });
      setPendingStepUp(null);
      setStepUpPassword("");
      setNotice(
        t(
          "ცვლილების შეთავაზება გაიგზავნა დამოუკიდებელ დამტკიცებაზე.",
          "Policy change proposal submitted for independent approval.",
        ),
      );
      await load();
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 428) {
        setPendingStepUp({ kind: "propose" });
        setError(
          t(
            "ამ ცვლილების შესანახად დაადასტურეთ თქვენი პაროლი ქვემოთ.",
            "Confirm your password below to submit this proposal.",
          ),
        );
      } else {
        setError(
          t(
            "შეთავაზების გაგზავნა ვერ მოხერხდა (საჭიროა ახალი step-up დადასტურება).",
            "Failed to submit proposal (fresh step-up authentication required).",
          ),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const handleReview = async (
    proposal: VerificationProposalItem,
    action: "approve" | "reject" | "withdraw",
  ) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await platformApi.reviewVerificationPolicy({
        requestId: crypto.randomUUID(),
        proposalId: proposal.id,
        action,
      });
      setPendingStepUp(null);
      setStepUpPassword("");
      setNotice(
        t(
          `შეთავაზებაზე ქმედება შესრულდა: ${action}.`,
          `Proposal action completed: ${action}.`,
        ),
      );
      await load();
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 428) {
        setPendingStepUp({ kind: "review", proposal, action });
        setError(
          t(
            "ამ მოქმედებისთვის დაადასტურეთ თქვენი პაროლი ქვემოთ.",
            "Confirm your password below to complete this review.",
          ),
        );
      } else {
        setError(
          t(
            "შეთავაზების განხილვა ვერ მოხერხდა (საჭიროა დამოუკიდებელი რევიუერი და step-up).",
            "Review failed (independent reviewer and step-up required).",
          ),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDeviceControl = async (
    op: "hold" | "release" | "revoke" | "purge_biometrics",
    bindingId?: string,
  ) => {
    if (!canControlDevices) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await platformApi.controlMobileDevice({
        op,
        ...(bindingId ? { bindingId } : {}),
        ...(op === "hold" || op === "revoke" ? { reason: "operator_request" } : {}),
      });
      setPendingStepUp(null);
      setStepUpPassword("");
      setNotice(
        op === "purge_biometrics"
          ? t(
              `ვადაგასული ბიომეტრიული სესიები გაიწმინდა: ${res.purgedCount ?? 0}.`,
              `Expired biometric sessions purged: ${res.purgedCount ?? 0}.`,
            )
          : t("მოწყობილობის სტატუსი განახლდა.", "Device binding status updated."),
      );
      await load();
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 428) {
        setPendingStepUp({ kind: "device", op, bindingId });
        setError(
          t(
            "მოწყობილობის მართვისთვის დაადასტურეთ თქვენი პაროლი ქვემოთ.",
            "Confirm your password below to run this device action.",
          ),
        );
      } else {
        setError(
          t(
            "მოწყობილობის მართვის ქმედება ვერ შესრულდა.",
            "Device control action failed.",
          ),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmStepUpAndRetry = async (e: FormEvent) => {
    e.preventDefault();
    if (!pendingStepUp || !stepUpPassword || busy) return;
    setBusy(true);
    setError("");
    try {
      await authApi.stepUp(stepUpPassword);
      setStepUpPassword("");
      const action = pendingStepUp;
      setPendingStepUp(null);
      setBusy(false);
      if (action.kind === "propose") {
        await handlePropose();
      } else if (action.kind === "review") {
        await handleReview(action.proposal, action.action);
      } else {
        await handleDeviceControl(action.op, action.bindingId);
      }
    } catch {
      setStepUpPassword("");
      setError(
        t(
          "პაროლის დადასტურება ვერ მოხერხდა. გადაამოწმეთ პაროლი და სცადეთ ხელახლა.",
          "Password confirmation failed. Check your password and try again.",
        ),
      );
      setBusy(false);
    }
  };

  if (loading && !policyData) {
    return (
      <Card>
        <p className="text-sm text-[var(--muted)]">
          {t("იტვირთება ბიომეტრიისა და მოწყობილობების პოლიტიკა...", "Loading verification policy...")}
        </p>
      </Card>
    );
  }

  const readOnly = !canPropose && !canApprove && !canControlDevices;

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-[var(--primary)]" />
            <h2 className="text-lg font-semibold">
              {t("eID ბიომეტრია და მობილური ვერიფიკაცია", "eID Biometrics & Mobile Verification")}
            </h2>
          </div>
          <span className="rounded-full bg-[var(--elevated)] px-3 py-1 text-xs font-medium">
            {readOnly
              ? t("მხოლოდ წაკითხვა (Read-only)", "Read-only access")
              : t("მართვადი კონტროლი (Two-Person)", "Governed control (Two-Person)")}
          </span>
        </div>

        {error && (
          <div
            role="alert"
            className="mt-3 rounded-lg border border-[var(--danger)] bg-[var(--elevated)] px-3 py-2 text-sm text-[var(--danger)]"
          >
            {error}
          </div>
        )}
        {notice && (
          <div
            role="status"
            className="mt-3 rounded-lg border border-[var(--success)] bg-[var(--elevated)] px-3 py-2 text-sm text-[var(--success)]"
          >
            {notice}
          </div>
        )}
        {pendingStepUp && (
          <form
            onSubmit={confirmStepUpAndRetry}
            className="mt-3 rounded-lg border border-[var(--primary)] bg-[var(--elevated)] p-3 space-y-3"
          >
            <p className="text-sm font-medium">
              {t(
                "უსაფრთხოების დადასტურება (Step-Up): შეიყვანეთ თქვენი ანგარიშის პაროლი ცვლილების გასაგრძელებლად.",
                "Security step-up required: enter your account password to continue.",
              )}
            </p>
            <Input
              type="password"
              autoComplete="current-password"
              label={t("თქვენი პაროლი", "Your password")}
              value={stepUpPassword}
              disabled={busy}
              onChange={(e) => setStepUpPassword(e.target.value)}
            />
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || !stepUpPassword}>
                {t("დადასტურება და გაგზავნა", "Confirm & submit")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setPendingStepUp(null);
                  setStepUpPassword("");
                }}
              >
                {t("გაუქმება", "Cancel")}
              </Button>
            </div>
          </form>
        )}

        {pendingDeviceAction && (
          <div
            role="alertdialog"
            aria-modal="false"
            className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--danger)] bg-[var(--elevated)] p-3 text-sm"
          >
            <span>
              {t("დაადასტურეთ მოქმედება:", "Confirm action:")}{" "}
              <strong>{pendingDeviceAction.label}</strong>
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() => {
                  const action = pendingDeviceAction;
                  setPendingDeviceAction(null);
                  void handleDeviceControl(action.op, action.bindingId);
                }}
              >
                {t("დადასტურება", "Confirm action")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => setPendingDeviceAction(null)}
              >
                {t("გაუქმება", "Cancel")}
              </Button>
            </div>
          </div>
        )}

        {policyData && (
          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="rounded-lg border border-[var(--border)] p-3">
              <div className="text-xs text-[var(--muted)]">
                {t("აქტიური ვერსია / პროფილი", "Active version / profile")}
              </div>
              <div className="mt-1 text-base font-semibold">
                v{policyData.policy.version} · {policyData.policy.authProfile}
              </div>
              <div className="mt-1 text-xs text-[var(--muted)]">
                {t(
                  "ERTAD-ის საკუთარი სუვერენული ბიომეტრიული ძრავა (გარე პროვაიდერების გარეშე)",
                  "ERTAD sovereign in-house biometric engine (no third-party providers)",
                )}
              </div>
            </div>
            <div className="rounded-lg border border-[var(--border)] p-3">
              <div className="text-xs text-[var(--muted)]">
                {t("ბიომეტრიული TTL ჯანმრთელობა", "Biometric TTL purge health")}
              </div>
              <div className="mt-1 text-base font-semibold">
                {policyData.policy.biometricTtlSeconds}s TTL
              </div>
              <div className="mt-1 text-xs text-[var(--muted)]">
                {t("აქტიური სესიები", "Active sessions")}: {policyData.ttlHealth.activeBiometricSessions} ·{" "}
                {t("გაწმენდილი", "Purged")}: {policyData.ttlHealth.purgedOnRead}
              </div>
            </div>
            <div className="rounded-lg border border-[var(--border)] p-3">
              <div className="text-xs text-[var(--muted)]">
                {t("მობილური მოწყობილობები (Zero-PII)", "Mobile device bindings (Zero-PII)")}
              </div>
              <div className="mt-1 text-base font-semibold">
                {t("აქტიური", "Active")}: {devicesData?.summary.activeDevices ?? 0} ·{" "}
                {t("შეჩერებული", "Held")}: {devicesData?.summary.heldDevices ?? 0}
              </div>
              {canControlDevices && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-2"
                  disabled={busy}
                  onClick={() =>
                    setPendingDeviceAction({
                      op: "purge_biometrics",
                      label: t(
                        "ვადაგასული ბიომეტრიული სესიების წაშლა",
                        "Purge expired biometric sessions",
                      ),
                    })
                  }
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  {t("ვადაგასული ბიომეტრიის წაშლა", "Purge expired biometrics")}
                </Button>
              )}
            </div>
          </div>
        )}

        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
          <Select
            label={t("ავტორიზაციის პროფილი", "Authentication profile")}
            value={draft.authProfile}
            disabled={!canPropose || busy}
            options={[
              { value: "google_hybrid", label: "google_hybrid (Google + eID)" },
              { value: "document_and_face", label: "document_and_face (eID only)" },
            ]}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                authProfile: e.target.value as VerificationPolicyValues["authProfile"],
              }))
            }
          />

          <Input
            label={t("ბიომეტრიული TTL (წამი, 60–86400)", "Biometric TTL (seconds, 60–86400)")}
            type="number"
            min={60}
            max={86400}
            value={ttlInput}
            disabled={!canPropose || busy}
            onChange={(e) => setTtlInput(e.target.value)}
          />

          <Input
            label={t("Liveness მინ. ზღვარი (0.30–0.99)", "Liveness min score (0.30–0.99)")}
            type="number"
            step="0.01"
            min={0.3}
            max={0.99}
            value={livenessInput}
            disabled={!canPropose || busy}
            onChange={(e) => setLivenessInput(e.target.value)}
          />

          <div>
            <Input
              label={t(
                "სახის მსგავსების მინ. ზღვარი (0.15–0.99 · რეკომენდებული: 0.40)",
                "Face-Match min score (0.15–0.99 · Recommended: 0.40)",
              )}
              type="number"
              step="0.01"
              min={0.15}
              max={0.99}
              value={faceMatchInput}
              disabled={!canPropose || busy}
              onChange={(e) => setFaceMatchInput(e.target.value)}
            />
            <p className="mt-1 text-xs text-[var(--muted)]">
              {t(
                "ArcFace 512-D კოსინუსური მსგავსება: პირადობის ჩიპის ფოტოსთან ერთი და იგივე ადამიანი იღებს ~0.38–0.65 (38%–65%). 0.40 (40%) უზრუნველყოფს 54%-იანი რეალური თანხვედრის უპრობლემო გატარებას.",
                "ArcFace 512-D cosine similarity: same person against an eID chip photo scores ~0.38–0.65 (38%–65%). 0.40 (40%) comfortably passes a 54% real match.",
              )}
            </p>
          </div>

          <Input
            label={t("მცდელობების ლიმიტი (1–10)", "Retry limit (1–10)")}
            type="number"
            min={1}
            max={10}
            value={retryInput}
            disabled={!canPropose || busy}
            onChange={(e) => setRetryInput(e.target.value)}
          />
        </div>

        <div className="mt-4 flex flex-wrap gap-6 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.requireDeviceAttestation}
              disabled={!canPropose || busy}
              onChange={(e) =>
                setDraft((d) => ({ ...d, requireDeviceAttestation: e.target.checked }))
              }
            />
            {t("Play Integrity / App Attest სავალდებულო", "Require Device Attestation")}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.requireNfc}
              disabled={!canPropose || busy}
              onChange={(e) => setDraft((d) => ({ ...d, requireNfc: e.target.checked }))}
            />
            {t("NFC SOD/CSCA სავალდებულო", "Require NFC SOD/CSCA")}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.requireGeorgianCitizen}
              disabled={!canPropose || busy}
              onChange={(e) =>
                setDraft((d) => ({ ...d, requireGeorgianCitizen: e.target.checked }))
              }
            />
            {t("საქართველოს მოქალაქეობა სავალდებულო", "Require Georgian citizenship")}
          </label>
        </div>

        {canPropose && (
          <div className="mt-5 grid grid-cols-1 gap-4 border-t border-[var(--border)] pt-4 md:grid-cols-2">
            <Select
              label={t("ცვლილების მიზეზი", "Change reason")}
              value={reason}
              disabled={busy}
              options={[
                {
                  value: "security_tightening",
                  label: t("ზღვრის / უსაფრთხოების კორექტირება", "Threshold / security adjustment"),
                },
                {
                  value: "recovery",
                  label: t("აღდგენა", "Recovery"),
                },
              ]}
              onChange={(e) =>
                setReason(e.target.value as "security_tightening" | "provider_change" | "recovery")
              }
            />
            <div className="flex items-end">
              <Button onClick={() => void handlePropose()} disabled={busy} className="w-full">
                <Lock className="mr-1.5 h-4 w-4" />
                {t("ცვლილების შეთავაზება (Propose)", "Propose policy change")}
              </Button>
            </div>
          </div>
        )}
      </Card>

      {policyData && policyData.pendingProposals.length > 0 && (
        <Card>
          <h3 className="text-base font-semibold">
            {t("დამტკიცების მოლოდინში მყოფი შეთავაზებები", "Pending policy proposals")}
          </h3>
          <div className="mt-3 space-y-3">
            {policyData.pendingProposals.map((prop) => (
              <div
                key={prop.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border)] p-3 text-sm"
              >
                <div>
                  <div className="font-medium">
                    {prop.authProfile} · Liveness {prop.livenessMinScore} ·{" "}
                    {t("სახე", "Face")} {prop.faceMatchMinScore} ·{" "}
                    {t("მცდელობა", "Retries")} {prop.retryLimit} · TTL{" "}
                    {prop.biometricTtlSeconds}s
                  </div>
                  <div className="text-xs text-[var(--muted)]">
                    v{prop.expectedVersion} → v{prop.expectedVersion + 1} · {prop.reason} ·{" "}
                    {[
                      prop.requireDeviceAttestation && t("Attestation", "Attestation"),
                      prop.requireNfc && "NFC",
                      prop.requireGeorgianCitizen && "GE",
                    ]
                      .filter(Boolean)
                      .join(" + ")}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {canApprove && (
                    <>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => void handleReview(prop, "approve")}
                      >
                        <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                        {t("დამტკიცება", "Approve")}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void handleReview(prop, "reject")}
                      >
                        <XCircle className="mr-1 h-3.5 w-3.5" />
                        {t("უარყოფა", "Reject")}
                      </Button>
                    </>
                  )}
                  {canPropose && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void handleReview(prop, "withdraw")}
                    >
                      {t("გაუქმება", "Withdraw")}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <div className="flex items-center gap-2">
          <Smartphone className="h-5 w-5 text-[var(--primary)]" />
          <h3 className="text-base font-semibold">
            {t("მობილური მოწყობილობების მიბმა (Zero-PII)", "Mobile device bindings (Zero-PII)")}
          </h3>
        </div>
        {!devicesData || devicesData.devices.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--muted)]">
            {t("დარეგისტრირებული მოწყობილობები ჯერ არ არის.", "No attested mobile devices yet.")}
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-xs text-[var(--muted)]">
                  <th className="py-2 pr-3">{t("პლატფორმა", "Platform")}</th>
                  <th className="py-2 pr-3">App ID</th>
                  <th className="py-2 pr-3">{t("ვერდიქტი", "Verdict")}</th>
                  <th className="py-2 pr-3">{t("სტატუსი", "Status")}</th>
                  {canControlDevices && <th className="py-2">{t("კონტროლი", "Control")}</th>}
                </tr>
              </thead>
              <tbody>
                {devicesData.devices.map((dev) => (
                  <tr key={dev.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="py-2 pr-3 font-medium uppercase">{dev.platform}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{dev.appId}</td>
                    <td className="py-2 pr-3">{dev.verdict}</td>
                    <td className="py-2 pr-3">{dev.status}</td>
                    {canControlDevices && (
                      <td className="py-2">
                        <div className="flex gap-2">
                          {dev.status === "active" && (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busy}
                              onClick={() =>
                                setPendingDeviceAction({
                                  op: "hold",
                                  bindingId: dev.id,
                                  label: `${t("მოწყობილობის შეჩერება", "Hold device")} (${dev.platform} · ${dev.appId})`,
                                })
                              }
                            >
                              {t("შეჩერება", "Hold")}
                            </Button>
                          )}
                          {dev.status === "held" && (
                            <Button
                              size="sm"
                              disabled={busy}
                              onClick={() => void handleDeviceControl("release", dev.id)}
                            >
                              {t("აღდგენა", "Release")}
                            </Button>
                          )}
                          {dev.status !== "revoked" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() =>
                                setPendingDeviceAction({
                                  op: "revoke",
                                  bindingId: dev.id,
                                  label: `${t("მოწყობილობის გაუქმება", "Revoke device")} (${dev.platform} · ${dev.appId})`,
                                })
                              }
                            >
                              {t("გაუქმება", "Revoke")}
                            </Button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
