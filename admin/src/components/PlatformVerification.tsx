import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, Smartphone, Trash2, Lock, CheckCircle2, XCircle } from "lucide-react";
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
  const [reason, setReason] = useState<"security_tightening" | "provider_change" | "recovery">(
    "security_tightening",
  );

  const applyLoaded = useCallback(
    (pol: VerificationPolicyResponse, devs: MobileDevicesResponse) => {
      setPolicyData(pol);
      setDevicesData(devs);
      setDraft({
        authProfile: pol.policy.authProfile,
        requireDeviceAttestation: pol.policy.requireDeviceAttestation,
        requireNfc: pol.policy.requireNfc,
        requireGeorgianCitizen: pol.policy.requireGeorgianCitizen,
        livenessProvider: "3d_face_detector",
        faceMatchProvider: "custom_biometric_matcher",
        livenessMinScore: Number(pol.policy.livenessMinScore),
        faceMatchMinScore: Number(pol.policy.faceMatchMinScore),
        retryLimit: pol.policy.retryLimit,
        biometricTtlSeconds: pol.policy.biometricTtlSeconds,
      });
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
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await platformApi.proposeVerificationPolicy({
        requestId: crypto.randomUUID(),
        expectedVersion: policyData.policy.version,
        ...draft,
        livenessProvider: "3d_face_detector",
        faceMatchProvider: "custom_biometric_matcher",
        reason,
      });
      setNotice(
        t(
          "ცვლილების შეთავაზება გაიგზავნა დამოუკიდებელ დამტკიცებაზე.",
          "Policy change proposal submitted for independent approval.",
        ),
      );
      await load();
    } catch {
      setError(
        t(
          "შეთავაზების გაგზავნა ვერ მოხერხდა (საჭიროა ახალი step-up დადასტურება).",
          "Failed to submit proposal (fresh step-up authentication required).",
        ),
      );
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
      setNotice(
        t(
          `შეთავაზებაზე ქმედება შესრულდა: ${action}.`,
          `Proposal action completed: ${action}.`,
        ),
      );
      await load();
    } catch {
      setError(
        t(
          "შეთავაზების განხილვა ვერ მოხერხდა (საჭიროა დამოუკიდებელი რევიუერი და step-up).",
          "Review failed (independent reviewer and step-up required).",
        ),
      );
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
      setNotice(
        op === "purge_biometrics"
          ? t(
              `ვადაგასული ბიომეტრიული სესიები გაიწმინდა: ${res.purgedCount ?? 0}.`,
              `Expired biometric sessions purged: ${res.purgedCount ?? 0}.`,
            )
          : t("მოწყობილობის სტატუსი განახლდა.", "Device binding status updated."),
      );
      await load();
    } catch {
      setError(
        t(
          "მოწყობილობის მართვის ქმედება ვერ შესრულდა.",
          "Device control action failed.",
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  if (loading && !policyData) {
    return (
      <Card>
        <p className="text-sm text-[var(--color-text-muted)]">
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
            <ShieldCheck className="h-5 w-5 text-[var(--color-primary)]" />
            <h2 className="text-lg font-semibold">
              {t("eID ბიომეტრია და მობილური ვერიფიკაცია", "eID Biometrics & Mobile Verification")}
            </h2>
          </div>
          <span className="rounded-full bg-[var(--color-surface-muted)] px-3 py-1 text-xs font-medium">
            {readOnly
              ? t("მხოლოდ წაკითხვა (Read-only)", "Read-only access")
              : t("მართვადი კონტროლი (Two-Person)", "Governed control (Two-Person)")}
          </span>
        </div>

        {error && (
          <div className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
        {notice && (
          <div className="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {notice}
          </div>
        )}

        {policyData && (
          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="text-xs text-[var(--color-text-muted)]">
                {t("აქტიური ვერსია / პროფილი", "Active version / profile")}
              </div>
              <div className="mt-1 text-base font-semibold">
                v{policyData.policy.version} · {policyData.policy.authProfile}
              </div>
              <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                {t(
                  "ERTAD-ის საკუთარი სუვერენული ბიომეტრიული ძრავა (გარე პროვაიდერების გარეშე)",
                  "ERTAD sovereign in-house biometric engine (no third-party providers)",
                )}
              </div>
            </div>
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="text-xs text-[var(--color-text-muted)]">
                {t("ბიომეტრიული TTL ჯანმრთელობა", "Biometric TTL purge health")}
              </div>
              <div className="mt-1 text-base font-semibold">
                {policyData.policy.biometricTtlSeconds}s TTL
              </div>
              <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                {t("აქტიური სესიები", "Active sessions")}: {policyData.ttlHealth.activeBiometricSessions} ·{" "}
                {t("გაწმენდილი", "Purged")}: {policyData.ttlHealth.purgedOnRead}
              </div>
            </div>
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="text-xs text-[var(--color-text-muted)]">
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
                  onClick={() => void handleDeviceControl("purge_biometrics")}
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
            value={String(draft.biometricTtlSeconds)}
            disabled={!canPropose || busy}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                biometricTtlSeconds: Number(e.target.value) || 900,
              }))
            }
          />

          <Input
            label={t("Liveness მინ. ზღვარი (0.30–0.99)", "Liveness min score (0.30–0.99)")}
            type="number"
            step="0.01"
            min={0.3}
            max={0.99}
            value={String(draft.livenessMinScore)}
            disabled={!canPropose || busy}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                livenessMinScore: Number(e.target.value) || 0.7,
              }))
            }
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
              value={String(draft.faceMatchMinScore)}
              disabled={!canPropose || busy}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  faceMatchMinScore: Number(e.target.value) || 0.4,
                }))
              }
            />
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              {t(
                "ArcFace 512-D კოსინუსური მსგავსება: პირადობის ჩიპის ფოტოსთან ერთი და იგივე ადამიანი იღებს ~0.38–0.65 (38%–65%). 0.40 (40%) უზრუნველყოფს 54%-იანი რეალური თანხვედრის უპრობლემო გატარებას.",
                "ArcFace 512-D cosine similarity: same person against an eID chip photo scores ~0.38–0.65 (38%–65%). 0.40 (40%) comfortably passes a 54% real match.",
              )}
            </p>
          </div>
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
          <div className="mt-5 grid grid-cols-1 gap-4 border-t border-[var(--color-border)] pt-4 md:grid-cols-2">
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
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] p-3 text-sm"
              >
                <div>
                  <div className="font-medium">
                    {prop.authProfile} · {prop.livenessProvider} / {prop.faceMatchProvider} · TTL{" "}
                    {prop.biometricTtlSeconds}s
                  </div>
                  <div className="text-xs text-[var(--color-text-muted)]">
                    v{prop.expectedVersion} → v{prop.expectedVersion + 1} · {prop.reason}
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
          <Smartphone className="h-5 w-5 text-[var(--color-primary)]" />
          <h3 className="text-base font-semibold">
            {t("მობილური მოწყობილობების მიბმა (Zero-PII)", "Mobile device bindings (Zero-PII)")}
          </h3>
        </div>
        {!devicesData || devicesData.devices.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--color-text-muted)]">
            {t("დარეგისტრირებული მოწყობილობები ჯერ არ არის.", "No attested mobile devices yet.")}
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs text-[var(--color-text-muted)]">
                  <th className="py-2 pr-3">{t("პლატფორმა", "Platform")}</th>
                  <th className="py-2 pr-3">App ID</th>
                  <th className="py-2 pr-3">{t("ვერდიქტი", "Verdict")}</th>
                  <th className="py-2 pr-3">{t("სტატუსი", "Status")}</th>
                  {canControlDevices && <th className="py-2">{t("კონტროლი", "Control")}</th>}
                </tr>
              </thead>
              <tbody>
                {devicesData.devices.map((dev) => (
                  <tr key={dev.id} className="border-b border-[var(--color-border)] last:border-0">
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
                              onClick={() => void handleDeviceControl("hold", dev.id)}
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
                              onClick={() => void handleDeviceControl("revoke", dev.id)}
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
