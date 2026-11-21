import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  platformApi,
  type ExternalIntegrationProposal,
  type ExternalIntegrationProvider,
  type ExternalIntegrationState,
} from "../api/platform";
import { useConsolePreferences } from "./useConsolePreferences";
import Card from "./ui/Card";
import Button from "./ui/Button";
import Input from "./ui/Input";

interface Props {
  canPropose: boolean;
  canApprove: boolean;
  refreshRevision?: number;
}

const PROVIDER_META: Record<
  ExternalIntegrationProvider,
  {
    ka: string;
    en: string;
    configKey: string;
    configLabelKa: string;
    configLabelEn: string;
    secondaryConfigKey?: string;
    secondaryLabelKa?: string;
    secondaryLabelEn?: string;
    secretLabelKa: string;
    secretLabelEn: string;
  }
> = {
  google_oidc: {
    ka: "Google OIDC (ავტორიზაცია)",
    en: "Google OIDC (Sign-In)",
    configKey: "androidClientId",
    configLabelKa: "Android OAuth Client ID",
    configLabelEn: "Android OAuth Client ID",
    secondaryConfigKey: "iosClientId",
    secondaryLabelKa: "iOS OAuth Client ID (არასავალდებულო)",
    secondaryLabelEn: "iOS OAuth Client ID (optional)",
    secretLabelKa: "OAuth Client Secret (არასავალდებულო)",
    secretLabelEn: "OAuth Client Secret (optional)",
  },
  fcm_push: {
    ka: "Firebase Push (FCM)",
    en: "Firebase Push (FCM)",
    configKey: "projectId",
    configLabelKa: "Firebase Project ID",
    configLabelEn: "Firebase Project ID",
    secretLabelKa: "Service Account Key JSON / Token",
    secretLabelEn: "Service Account Key JSON / Token",
  },
  telegram_bot: {
    ka: "Telegram Bot",
    en: "Telegram Bot",
    configKey: "botUsername",
    configLabelKa: "ბოტის სახელი (@ertad_bot)",
    configLabelEn: "Bot username (@ertad_bot)",
    secretLabelKa: "Telegram Bot Token",
    secretLabelEn: "Telegram Bot Token",
  },
  whatsapp_business: {
    ka: "WhatsApp Business API",
    en: "WhatsApp Business API",
    configKey: "phoneNumberId",
    configLabelKa: "Phone Number ID",
    configLabelEn: "Phone Number ID",
    secretLabelKa: "Meta Permanent Access Token",
    secretLabelEn: "Meta Permanent Access Token",
  },
  viber_bot: {
    ka: "Viber Bot",
    en: "Viber Bot",
    configKey: "senderName",
    configLabelKa: "გამგზავნის სახელი (ERTAD)",
    configLabelEn: "Sender name (ERTAD)",
    secretLabelKa: "Viber Auth Token",
    secretLabelEn: "Viber Auth Token",
  },
};

export default function PlatformExternalIntegrations({
  canPropose,
  canApprove,
  refreshRevision = 0,
}: Props) {
  const { language } = useConsolePreferences();
  const t = (ka: string, en: string) => (language === "ka" ? ka : en);

  const [providers, setProviders] = useState<ExternalIntegrationState[]>([]);
  const [proposals, setProposals] = useState<ExternalIntegrationProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<ExternalIntegrationProvider | null>(
    null,
  );
  const [enabled, setEnabled] = useState(false);
  const [configVal, setConfigVal] = useState("");
  const [secondaryConfigVal, setSecondaryConfigVal] = useState("");
  const [secret, setSecret] = useState("");
  const [clearSecret, setClearSecret] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await platformApi.externalIntegrations();
      setProviders(data.providers);
      setProposals(data.proposals);
      setError("");
    } catch {
      setError(
        language === "ka"
          ? "ინტეგრაციის კრედენშელების ჩატვირთვა ვერ მოხერხდა."
          : "Could not load external integration credentials.",
      );
    } finally {
      setLoading(false);
    }
  }, [language]);

  useEffect(() => {
    let live = true;
    platformApi
      .externalIntegrations()
      .then((data) => {
        if (!live) return;
        setProviders(data.providers);
        setProposals(data.proposals);
        setError("");
        setLoading(false);
      })
      .catch(() => {
        if (!live) return;
        setError(
          language === "ka"
            ? "ინტეგრაციის კრედენშელების ჩატვირთვა ვერ მოხერხდა."
            : "Could not load external integration credentials.",
        );
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [language, refreshRevision]);

  function startEdit(item: ExternalIntegrationState) {
    const meta = PROVIDER_META[item.provider];
    setEditing(item.provider);
    setEnabled(item.enabled);
    setConfigVal(item.publicConfig[meta.configKey] ?? "");
    setSecondaryConfigVal(
      meta.secondaryConfigKey
        ? (item.publicConfig[meta.secondaryConfigKey] ?? "")
        : "",
    );
    setSecret("");
    setClearSecret(false);
    setReason("");
    setNotice("");
    setError("");
  }

  async function submitProposal(e: FormEvent) {
    e.preventDefault();
    if (!editing || busy) return;
    const current = providers.find((p) => p.provider === editing);
    if (!current) return;
    const meta = PROVIDER_META[editing];
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await platformApi.proposeExternalIntegration({
        requestId: crypto.randomUUID(),
        provider: editing,
        expectedVersion: current.version,
        enabled,
        publicConfig: {
          ...current.publicConfig,
          [meta.configKey]: configVal.trim(),
          ...(meta.secondaryConfigKey
            ? { [meta.secondaryConfigKey]: secondaryConfigVal.trim() }
            : {}),
        },
        ...(secret.trim() ? { secret: secret.trim() } : {}),
        ...(clearSecret ? { clearSecret: true } : {}),
        reason: reason.trim(),
      });
      setSecret("");
      setEditing(null);
      setNotice(
        t(
          "ინტეგრაციის ცვლილება გაიგზავნა მეორე ტექნიკურ ოპერატორთან დასამტკიცებლად.",
          "Integration change proposed for independent technical approval.",
        ),
      );
      await load();
    } catch {
      setError(
        t(
          "ცვლილების შეთავაზება ვერ შესრულდა — შეამოწმეთ უფლება და მიმდინარე პაროლის დადასტურება.",
          "Could not submit integration proposal — verify permission and fresh step-up.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function reviewProposal(
    proposalId: string,
    action: "approve" | "reject",
  ) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await platformApi.reviewExternalIntegration({
        requestId: crypto.randomUUID(),
        proposalId,
        action,
      });
      setNotice(
        action === "approve"
          ? t("ინტეგრაცია დამტკიცდა და გააქტიურდა.", "Integration change approved.")
          : t("შეთავაზება უარყოფილია.", "Proposal rejected."),
      );
      await load();
    } catch {
      setError(
        t(
          "დამტკიცება ვერ შესრულდა (საკუთარი შეთავაზების დამტკიცება აკრძალულია).",
          "Review failed (independent second operator required).",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  const pendingProposals = proposals.filter((p) => p.status === "pending");

  return (
    <Card className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">
          {t(
            "მესენჯერების, Push და Google OIDC კრედენშელები",
            "Messenger, Push & Google OIDC Credentials",
          )}
        </h2>
        <p className="text-sm text-[var(--muted)] mt-1">
          {t(
            "ყველა გარე გასაღები ინახება AES-256-GCM დაშიფვრით და არასოდეს ბრუნდება ბრაუზერში. ცვლილება მოითხოვს მეორე ტექნიკური ადმინისტრატორის დადასტურებას.",
            "All external secrets are stored with AES-256-GCM encryption and never returned to the browser. Changes require independent two-person technical approval.",
          )}
        </p>
      </div>

      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">{t("იტვირთება…", "Loading…")}</p>}

      {!loading && (
        <div className="space-y-3">
          {providers.map((item) => {
            const meta = PROVIDER_META[item.provider];
            const cfgValue = item.publicConfig[meta.configKey] || "—";
            const secondaryValue = meta.secondaryConfigKey
              ? item.publicConfig[meta.secondaryConfigKey]
              : undefined;
            return (
              <div
                key={item.provider}
                className="border-t border-[var(--border)] pt-3 flex flex-wrap items-center justify-between gap-3"
              >
                <div>
                  <h3 className="font-semibold">
                    {t(meta.ka, meta.en)} · v{item.version}
                  </h3>
                  <p className="text-sm text-[var(--muted)]">
                    {item.enabled
                      ? t("ჩართულია", "Enabled")
                      : t("გამორთულია", "Disabled")}{" "}
                    · {t(meta.configLabelKa, meta.configLabelEn)}: {cfgValue}
                    {secondaryValue
                      ? ` · ${t(meta.secondaryLabelKa ?? "", meta.secondaryLabelEn ?? "")}: ${secondaryValue}`
                      : ""}{" "}
                    ·{" "}
                    {item.hasSecret
                      ? t("საიდუმლო გასაღები შენახულია", "Secret stored")
                      : t("საიდუმლო გასაღები არ არის", "No secret stored")}
                  </p>
                </div>
                {canPropose && (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => startEdit(item)}
                  >
                    {t("კონფიგურაცია", "Configure")}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <form onSubmit={submitProposal} className="border-t pt-4 space-y-3">
          <h3 className="font-semibold">
            {t("შეთავაზება:", "Propose:")}{" "}
            {t(PROVIDER_META[editing].ka, PROVIDER_META[editing].en)}
          </h3>
          <label className="flex items-center gap-2 min-h-11">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {t("ინტეგრაცია ჩართულია", "Enable integration")}
          </label>
          <Input
            label={t(
              PROVIDER_META[editing].configLabelKa,
              PROVIDER_META[editing].configLabelEn,
            )}
            value={configVal}
            onChange={(e) => setConfigVal(e.target.value)}
          />
          {PROVIDER_META[editing].secondaryConfigKey && (
            <Input
              label={t(
                PROVIDER_META[editing].secondaryLabelKa ?? "",
                PROVIDER_META[editing].secondaryLabelEn ?? "",
              )}
              value={secondaryConfigVal}
              onChange={(e) => setSecondaryConfigVal(e.target.value)}
            />
          )}
          <Input
            type="password"
            label={t(
              PROVIDER_META[editing].secretLabelKa,
              PROVIDER_META[editing].secretLabelEn,
            )}
            placeholder={t(
              "ცარიელი დატოვეთ არსებული გასაღების შესანარჩუნებლად",
              "Leave blank to keep existing encrypted secret",
            )}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          <label className="flex items-center gap-2 min-h-11">
            <input
              type="checkbox"
              checked={clearSecret}
              onChange={(e) => setClearSecret(e.target.checked)}
            />
            {t("არსებული საიდუმლო გასაღების წაშლა", "Clear stored secret")}
          </label>
          <Input
            label={t("ცვლილების მიზეზი", "Change reason")}
            required
            minLength={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {t("შეთავაზების გაგზავნა", "Submit proposal")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              {t("გაუქმება", "Cancel")}
            </Button>
          </div>
        </form>
      )}

      {pendingProposals.length > 0 && (
        <div className="border-t border-[var(--border)] pt-4 space-y-2">
          <h3 className="font-semibold">
            {t("დასადასტურებელი შეთავაზებები", "Pending integration proposals")}
          </h3>
          {pendingProposals.map((p) => (
            <div
              key={p.id}
              className="border border-[var(--border)] rounded p-3 flex flex-wrap items-center justify-between gap-2"
            >
              <div>
                <p className="font-medium">
                  {t(PROVIDER_META[p.provider].ka, PROVIDER_META[p.provider].en)}{" "}
                  · {p.enabled ? t("ჩართვა", "Enable") : t("გამორთვა", "Disable")}
                  {p.hasSecretUpdate
                    ? ` · ${t("ახალი გასაღები", "New secret")}`
                    : ""}
                </p>
                <p className="text-sm text-[var(--muted)]">{p.reason}</p>
              </div>
              {canApprove && (
                <div className="flex gap-2">
                  <Button
                    disabled={busy}
                    onClick={() => void reviewProposal(p.id, "approve")}
                  >
                    {t("დამტკიცება", "Approve")}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void reviewProposal(p.id, "reject")}
                  >
                    {t("უარყოფა", "Reject")}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
