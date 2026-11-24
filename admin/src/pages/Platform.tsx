import { useNavigate, useParams } from "react-router-dom";
import { platformSections, platformPath, type PlatformSection } from "../components/platformSections";
import PlatformProviders from "../components/PlatformProviders";
import PlatformMail from "../components/PlatformMail";
import PlatformSecurityLimits from "../components/PlatformSecurityLimits";
import { useEffect, useState } from "react";
import { Shield, RefreshCw } from "lucide-react";
import {
  platformApi,
  type AuditChainVerification,
  type PlatformAccess,
  type PlatformOverview,
  type PlatformAudit,
} from "../api/platform";
import { useConsolePreferences } from "../components/useConsolePreferences";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Select from "../components/ui/Select";
import PlatformSessions from "../components/PlatformSessions";
import PlatformAccounts from '../components/PlatformAccounts';
import PlatformIntegrations from "../components/PlatformIntegrations";
import PlatformNetworkPolicy from "../components/PlatformNetworkPolicy";
import PlatformSessionPolicy from "../components/PlatformSessionPolicy";
import PlatformVerification from "../components/PlatformVerification";
import PlatformExternalIntegrations from "../components/PlatformExternalIntegrations";
import ShieldDashboard from "./ShieldDashboard";

export default function Platform() {
  const { language } = useConsolePreferences(),
    ka = language === "ka";
  const t = (ge: string, en: string) => (ka ? ge : en);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    access: PlatformAccess | null;
    overview: PlatformOverview | null;
    audit: PlatformAudit | null;
    failed: boolean;
    pending: boolean;
    cause?: unknown;
  } | null>(null);
  const { section } = useParams(), navigate = useNavigate();
  const activeSection = platformSections.find(s => s.key === (section ?? "overview"));
  const tab = activeSection?.key ?? "overview";
  const setTab = (next: PlatformSection) => navigate(platformPath(next));
  const [category, setCategory] = useState("all"),
    [cursors, setCursors] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [chainVerification, setChainVerification] =
    useState<AuditChainVerification | null>(null);
  const [verifyingChain, setVerifyingChain] = useState(false);
  const [verifyError, setVerifyError] = useState("");
  const cursor = cursors[cursors.length - 1];
  const scopeKey = JSON.stringify([tab, category, cursor]);
  const resourceKey = JSON.stringify([tab, category, cursor, revision]);
  const sameScope = snapshot?.key.startsWith(scopeKey.slice(0, -1)) ?? false;
  const loading = !sameScope && (snapshot?.key !== resourceKey || snapshot.pending);
  // Confirmation dialogs retain their existing grant while a refresh is pending;
  // a denied response clears it. Every action rechecks current server authority.
  const access =
    sameScope || snapshot?.key === resourceKey || !["overview", "audit"].includes(tab)
      ? (snapshot?.access ?? null)
      : null;
  const overview = loading ? null : snapshot?.overview;
  const audit = loading ? null : snapshot?.audit;
  const error =
    !loading && snapshot?.failed
      ? (snapshot.cause as { response?: { status?: number } })?.response
          ?.status === 403
        ? t("წვდომა აღარ გაქვთ.", "Access is no longer available.")
        : t(
            "მონაცემები ვერ ჩაიტვირთა. სცადეთ განახლება.",
            "Could not load data. Please refresh.",
          )
      : "";
  useEffect(() => {
    if (!activeSection) return;
    let live = true;
    void (async () => {
      try {
        const current = await platformApi.access();
        if (!live) return;
        setSnapshot((prev) => ({
          key: resourceKey,
          access: current,
          overview: prev && prev.key.startsWith(scopeKey.slice(0, -1)) ? prev.overview : null,
          audit: prev && prev.key.startsWith(scopeKey.slice(0, -1)) ? prev.audit : null,
          failed: false,
          pending: true,
        }));
        let overview: PlatformOverview | null = null,
          audit: PlatformAudit | null = null;
        if (current.permissions.includes("platform.read")) {
          if (tab === "overview") overview = await platformApi.overview();
          else if (
            tab === "audit" &&
            current.permissions.includes("platform.audit.read")
          )
            audit = await platformApi.audit(category, cursor);
        }
        if (live)
          setSnapshot({
            key: resourceKey,
            access: current,
            overview,
            audit,
            failed: false,
            pending: false,
          });
      } catch (cause) {
        if (live)
          setSnapshot({
            key: resourceKey,
            access: null,
            overview: null,
            audit: null,
            failed: true,
            pending: false,
            cause,
          });
      }
    })();
    return () => {
      live = false;
    };
  }, [tab, category, cursor, resourceKey, scopeKey, activeSection]);
  useEffect(() => {
    let lastRefresh = Date.now();
    const refresh = () => {
      const now = Date.now();
      if (now - lastRefresh < 30_000) return;
      lastRefresh = now;
      setRevision((v) => v + 1);
    };
    const timer = window.setInterval(() => {
      lastRefresh = Date.now();
      setRevision((v) => v + 1);
    }, 120_000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  const date = (v: string) =>
    new Date(v).toLocaleString(ka ? "ka-GE" : "en-GB", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  const names: Record<string, string> = {
    PLATFORM_PROVIDER_POLICY_READ: t(
      "პროვაიდერის პარამეტრების ნახვა",
      "Provider configuration read",
    ),
    PLATFORM_PROVIDER_POLICY_PROPOSED: t(
      "პროვაიდერის ცვლილების შეთავაზება",
      "Provider change proposed",
    ),
    PLATFORM_PROVIDER_POLICY_REVIEWED: t(
      "პროვაიდერის ცვლილების განხილვა",
      "Provider change reviewed",
    ),
    PLATFORM_PROVIDER_ACCESS_ENABLED: t(
      "პროვაიდერის მართვის წვდომა",
      "Provider management access",
    ),
    PLATFORM_SECURITY_LIMITS_READ: t("ლიმიტების ნახვა", "Security limits read"),
    PLATFORM_SECURITY_LIMITS_PROPOSED: t(
      "ლიმიტების ცვლილების შეთავაზება",
      "Security limits proposed",
    ),
    PLATFORM_SECURITY_LIMITS_REVIEWED: t(
      "ლიმიტების ცვლილების განხილვა",
      "Security limits reviewed",
    ),
    PLATFORM_LIMITS_ACCESS_ENABLED: t(
      "ლიმიტების მართვის წვდომა",
      "Security limits access enabled",
    ),
    PLATFORM_NETWORK_POLICY_READ: t(
      "ქსელის პოლიტიკის ნახვა",
      "Network policy read",
    ),
    PLATFORM_NETWORK_POLICY_PROPOSED: t(
      "ქსელის პოლიტიკის შეთავაზება",
      "Network policy proposed",
    ),
    PLATFORM_NETWORK_POLICY_REVIEWED: t(
      "ქსელის პოლიტიკის განხილვა",
      "Network policy reviewed",
    ),
    PLATFORM_NETWORK_ACCESS_ENABLED: t(
      "ქსელის მართვის უფლების გააქტიურება",
      "Network access enabled",
    ),
    PLATFORM_SESSION_POLICY_READ: t(
      "სესიების პოლიტიკის ნახვა",
      "Session policy read",
    ),
    PLATFORM_SESSION_POLICY_PROPOSED: t(
      "სესიების პოლიტიკის შეთავაზება",
      "Session policy proposed",
    ),
    PLATFORM_SESSION_POLICY_REVIEWED: t(
      "სესიების პოლიტიკის განხილვა",
      "Session policy reviewed",
    ),
    PLATFORM_POLICY_ACCESS_ENABLED: t(
      "პოლიტიკის შეთავაზების უფლების გააქტიურება",
      "Policy proposal access enabled",
    ),
    PLATFORM_INTEGRATIONS_READ: t(
      "ინტეგრაციების სიის ნახვა",
      "Integration inventory read",
    ),
    PLATFORM_INTEGRATION_CHECK: t(
      "ინტეგრაციის კავშირის შემოწმება",
      "Integration connection check",
    ),
    PLATFORM_MAIL_POLICY_READ: t("ელფოსტის პარამეტრების ნახვა", "Email configuration read"),
    PLATFORM_MAIL_POLICY_PROPOSED: t("ელფოსტის ცვლილების წარდგენა", "Email configuration proposed"),
    PLATFORM_MAIL_POLICY_REVIEWED: t("ელფოსტის ცვლილების განხილვა", "Email configuration reviewed"),
    PLATFORM_MAIL_CHECK: t("ელფოსტის სატესტო შემოწმება", "Email sandbox validation"),
    PLATFORM_INTEGRATION_ACCESS_ENABLED: t(
      "ინტეგრაციების დიაგნოსტიკის გააქტიურება",
      "Integration diagnostic access enabled",
    ),
    PLATFORM_BOOTSTRAPPED: t(
      "ტექნიკური ანგარიშის შექმნა",
      "Technical account created",
    ),
    PLATFORM_ACCESS_READ: t(
      "ტექნიკური წვდომის შემოწმება",
      "Technical access checked",
    ),
    PLATFORM_OVERVIEW_READ: t(
      "სისტემის მდგომარეობის ნახვა",
      "System overview read",
    ),
    PLATFORM_AUDIT_READ: t("ტექნიკური ჟურნალის ნახვა", "Technical audit read"),
    PLATFORM_SESSIONS_READ: t("ვებ-სესიების ნახვა", "Web sessions read"),
    PLATFORM_SESSION_REVOKED: t("ვებ-სესიის შეწყვეტა", "Web session revoked"),
    PLATFORM_ACCOUNT_SECURITY_READ: t(
      "ვებ-ანგარიშების დაცვის სიის ნახვა",
      "Web account protection read",
    ),
    PLATFORM_ACCOUNT_HELD: t(
      "ვებ-ანგარიშის წვდომის შეჩერება",
      "Web account access paused",
    ),
    PLATFORM_ACCOUNT_RELEASED: t(
      "ვებ-ანგარიშის შეზღუდვის მოხსნა",
      "Web account hold released",
    ),
    PLATFORM_ACCOUNT_LIFECYCLE_PROPOSED: t(
      "ვებ-ანგარიშის სასიცოცხლო ცვლილების შეთავაზება",
      "Web account lifecycle change proposed",
    ),
    PLATFORM_ACCOUNT_LIFECYCLE_REVIEWED: t(
      "ვებ-ანგარიშის სასიცოცხლო ცვლილების განხილვა",
      "Web account lifecycle change reviewed",
    ),
    PLATFORM_ACCOUNT_SECURITY_ENABLED: t(
      "ვებ-ანგარიშების დაცვის უფლების გააქტიურება",
      "Web account protection access enabled",
    ),
    PLATFORM_SESSION_ACCESS_ENABLED: t(
      "სესიების მართვის უფლების გააქტიურება",
      "Session response access enabled",
    ),
    ADMIN_LOGIN_SUCCEEDED: t(
      "ტექნიკური ანგარიშის შესვლა",
      "Technical account login",
    ),
    ADMIN_LOGOUT: t("ტექნიკური ანგარიშის გამოსვლა", "Technical account logout"),
    ADMIN_STEP_UP_GRANTED: t("ხელახალი ავტორიზაცია", "Reauthentication"),
    ADMIN_STEP_UP_FAILED: t(
      "ხელახალი ავტორიზაცია ვერ შესრულდა",
      "Reauthentication failed",
    ),
  };
  if (!activeSection) return <p role="alert">{t("გვერდი ვერ მოიძებნა.", "Page not found.")}</p>;
  return (
    <section
      className="review-page platform-page"
      aria-labelledby="platform-title"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 id="platform-title" className="flex items-center gap-2">
            <Shield aria-hidden="true" />
            {t("სისტემის მართვა", "System administration")}
          </h1>
          <p>
            {t(
              "ტექნიკური მდგომარეობა, ინტეგრაციები და უსაფრთხოების პოლიტიკა.",
              "Technical status, integrations, and security policies.",
            )}
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={loading}
          onClick={() => setRevision((v) => v + 1)}
        >
          <RefreshCw size={18} aria-hidden="true" />
          {t("განახლება", "Refresh")}
        </Button>
      </header>

      {access && (
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="status-badge" data-status="approved">
                {access.permissions.some((p) => p.endsWith(".propose"))
                  ? t(
                      "ტექნიკური ოპერატორი · ცვლილების შეთავაზება",
                      "Technical operator · Propose changes",
                    )
                  : access.permissions.some((p) => p.endsWith(".approve"))
                    ? t(
                        "ტექნიკური მიმომხილველი · დამტკიცება / უარყოფა",
                        "Technical reviewer · Approve / Reject",
                      )
                    : t("მხოლოდ წაკითხვა", "Read-only access")}
              </span>
              <span className="text-xs text-[var(--muted)]">
                {access.permissions.some((p) => p.endsWith(".propose"))
                  ? t(
                      "ცვლილების შესანახად დაადასტურეთ პაროლი; საბოლოო გააქტიურებას ამტკიცებს მეორე ტექნიკური მიმომხილველი.",
                      "Confirm your password to submit a change; a second independent reviewer approves activation.",
                    )
                  : t(
                      "ამ ანგარიშით ამტკიცებთ ოპერატორის მიერ შეთავაზებულ ცვლილებებს. პარამეტრების რედაქტირებისთვის შედით როგორც ტექნიკური ადმინისტრატორი.",
                      "Use this account to approve or reject operator proposals. Sign in as Technical Administrator to edit settings.",
                    )}
              </span>
            </div>
            {import.meta.env.DEV && (
              <span className="text-xs font-mono text-[var(--muted)]">
                {t(
                  "ლოკალური პაროლი: .local/PLATFORM_ACCESS.md / PLATFORM_REVIEWER_ACCESS.md",
                  "Local password: .local/PLATFORM_ACCESS.md / PLATFORM_REVIEWER_ACCESS.md",
                )}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {(access.permissions.includes("platform.integrations.read") ||
              access.permissions.includes("platform.verification.read")) && (
              <Button
                size="sm"
                variant={tab === "integrations" ? "primary" : "secondary"}
                onClick={() => setTab("integrations")}
              >
                {t(
                  "Google / Push / Telegram / WhatsApp / Viber",
                  "Google / Push / Telegram / WhatsApp / Viber",
                )}
              </Button>
            )}
            {access.permissions.includes("platform.providers.read") && (
              <Button
                size="sm"
                variant={tab === "email" ? "primary" : "secondary"}
                onClick={() => setTab("email")}
              >
                {t("ელფოსტა (SMTP / SendGrid)", "Email (SMTP / SendGrid)")}
              </Button>
            )}
            {access.permissions.includes("platform.verification.read") && (
              <Button
                size="sm"
                variant={tab === "verification" ? "primary" : "secondary"}
                onClick={() => setTab("verification")}
              >
                {t("ბიომეტრია და მოწყობილობები", "Biometrics & devices")}
              </Button>
            )}
            {access.permissions.includes("platform.network.read") && (
              <Button
                size="sm"
                variant={tab === "network" ? "primary" : "secondary"}
                onClick={() => setTab("network")}
              >
                {t("ქსელის დაცვა", "Network protection")}
              </Button>
            )}
          </div>
        </Card>
      )}

      {tab === "email" && access?.permissions.includes("platform.providers.read") && <PlatformMail canPropose={access.permissions.includes("platform.providers.propose")} canApprove={access.permissions.includes("platform.providers.approve")} canTest={access.permissions.includes("platform.integrations.test")} refreshRevision={revision} />}
      {tab === "verification" &&
        access?.permissions.includes("platform.verification.read") && (
          <PlatformVerification
            canPropose={access.permissions.includes(
              "platform.verification.propose",
            )}
            canApprove={access.permissions.includes(
              "platform.verification.approve",
            )}
            canControlDevices={access.permissions.includes(
              "platform.mobile_devices.control",
            )}
            refreshRevision={revision}
          />
        )}
      {tab === "providers" &&
        access?.permissions.includes("platform.providers.read") && (
          <PlatformProviders
            canPropose={access.permissions.includes(
              "platform.providers.propose",
            )}
            canApprove={access.permissions.includes(
              "platform.providers.approve",
            )}
            refreshRevision={revision}
          />
        )}

      {tab === "limits" &&
        access?.permissions.includes("platform.limits.read") && (
          <PlatformSecurityLimits
            canPropose={access.permissions.includes("platform.limits.propose")}
            canApprove={access.permissions.includes("platform.limits.approve")}
            refreshRevision={revision}
          />
        )}

      {tab === "network" &&
        access?.permissions.includes("platform.network.read") && (
          <PlatformNetworkPolicy
            canPropose={access.permissions.includes("platform.network.propose")}
            canApprove={access.permissions.includes("platform.network.approve")}
            refreshRevision={revision}
          />
        )}
      {tab === "monitoring" &&
        access?.permissions.includes("platform.audit.read") && (
          <ShieldDashboard
            refreshRevision={revision}
            onAudit={() => setTab("audit")}
            onSessions={
              access.permissions.includes("platform.sessions.read")
                ? () => setTab("sessions")
                : undefined
            }
          />
        )}
      {tab === "policy" &&
        access?.permissions.includes("platform.policy.read") && (
          <PlatformSessionPolicy
            canPropose={access.permissions.includes("platform.policy.propose")}
            canApprove={access.permissions.includes("platform.policy.approve")}
            refreshRevision={revision}
          />
        )}
      {tab === "integrations" &&
        (access?.permissions.includes("platform.integrations.read") ||
          access?.permissions.includes("platform.verification.read")) && (
          <div className="space-y-6">
            {access.permissions.includes("platform.verification.read") && (
              <PlatformExternalIntegrations
                canPropose={access.permissions.includes(
                  "platform.verification.propose",
                )}
                canApprove={access.permissions.includes(
                  "platform.verification.approve",
                )}
                refreshRevision={revision}
              />
            )}
            {access.permissions.includes("platform.integrations.read") && (
              <PlatformIntegrations
                onConfigure={access.permissions.includes("platform.providers.read") ? () => setTab("providers") : undefined}
                canTest={access.permissions.includes("platform.integrations.test")}
                refreshRevision={revision}
              />
            )}
          </div>
        )}
      {tab === "sessions" &&
        access?.permissions.includes("platform.sessions.read") && (
          <PlatformSessions
            canRevoke={access.permissions.includes("platform.sessions.revoke")}
            refreshRevision={revision}
          />
        )}
      {tab==='accounts'&&access?.permissions.includes('platform.accounts.read')&&<PlatformAccounts canHold={access.permissions.includes('platform.accounts.hold')} canRelease={access.permissions.includes('platform.accounts.release')} canPropose={access.permissions.includes('platform.accounts.propose')} canApprove={access.permissions.includes('platform.accounts.approve')} refreshRevision={revision}/>}
      {loading && <p role="status">{t("იტვირთება…", "Loading…")}</p>}
      {error && <p role="alert">{error}</p>}
      {!loading &&
        access &&
        !(tab === "integrations"
          ? access.permissions.includes("platform.integrations.read") ||
            access.permissions.includes("platform.verification.read")
          : access.permissions.includes(
              tab === "accounts"
                ? "platform.accounts.read"
                : tab === "verification"
                  ? "platform.verification.read"
                  : tab === "providers" || tab === "email"
                    ? "platform.providers.read"
                    : tab === "limits"
                      ? "platform.limits.read"
                      : tab === "network"
                        ? "platform.network.read"
                        : tab === "audit" || tab === "monitoring"
                          ? "platform.audit.read"
                          : tab === "policy"
                            ? "platform.policy.read"
                            : tab === "sessions"
                              ? "platform.sessions.read"
                              : "platform.read",
            )) && (
          <Card>
            {t(
              "ამ პანელის ნახვის უფლება არ გაქვთ ან წვდომას ვადა გაუვიდა.",
              "You do not have access to this panel, or the grant has expired.",
            )}
          </Card>
        )}
      {overview && (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            {(["postgres", "redis", "storage"] as const).map((name) => (
              <Card key={name}>
                <h2>
                  {
                    {
                      postgres: t("მონაცემთა ბაზა", "Database"),
                      redis: t("ქეში", "Cache"),
                      storage: t("ფაილების საცავი", "File storage"),
                    }[name]
                  }
                </h2>
                <p
                  className={
                    overview.dependencies[name] === "ready"
                      ? "text-[var(--success)]"
                      : "text-[var(--danger)]"
                  }
                >
                  {overview.dependencies[name] === "ready"
                    ? t("ხელმისაწვდომია", "Available")
                    : t("მიუწვდომელია", "Unavailable")}
                </p>
              </Card>
            ))}
          </div>
          <Card>
            <h2>{t("გაშვებული გარემო", "Running environment")}</h2>
            <dl className="grid gap-3 md:grid-cols-2">
              <div>
                <dt>{t("გარემო", "Environment")}</dt>
                <dd>
                  {overview.mode === "test"
                    ? t("ტესტირება", "Test")
                    : t("დეველოპმენტი", "Development")}
                </dd>
              </div>
              <div>
                <dt>{t("ბაზის მიგრაციები", "Database migrations")}</dt>
                <dd>{overview.migrations}</dd>
              </div>
              <div>
                <dt>{t("ჩემი აქტიური სესიები", "My active sessions")}</dt>
                <dd>{overview.ownActiveSessions}</dd>
              </div>
              <div>
                <dt>{t("წვდომის ვადა", "Access expires")}</dt>
                <dd>{date(overview.validUntil)}</dd>
              </div>
            </dl>
            <p>
              {t("შემოწმებულია: ", "Checked: ")}
              {date(overview.checkedAt)}
            </p>
          </Card>
          <Card>
            <h2>{t("უსაფრთხოების მდგომარეობა", "Security controls")}</h2>
            <ul className="list-disc pl-5 space-y-2">
              <li>
                {t(
                  "ორგანიზაციული და ტექნიკური უფლებები გამიჯნულია.",
                  "Technical and organizational permissions are separated.",
                )}
              </li>
              <li>
                {t(
                  "პროდაქშენის გაშვება დაბლოკილია.",
                  "Production startup is blocked.",
                )}
              </li>
              <li>
                {t(
                  "ვებ MFA: სავალდებულოა პროდაქშენამდე; დეველოპმენტში გამორთულია.",
                  "Web MFA: required before production; disabled in development.",
                )}
              </li>
              <li>
                {t(
                  "გარე ხელმოწერილი აუდიტის დამოწმება ჯერ არ არის გააქტიურებული.",
                  "External signed audit checkpoints are not activated.",
                )}
              </li>
            </ul>
          </Card>
          <Card>
            <h2>
              {t(
                "ინტეგრაციები და შემდეგი ნაბიჯები",
                "Integrations and next steps",
              )}
            </h2>
            <p>
              {t(
                "ბაზის, ქეშისა და საცავის კავშირები ზემოთ მოწმდება. ვებ-სესიები ცალკე უფლებებით იმართება. ქსელის წესები, ლიმიტები და VPN/proxy პროვაიდერი შესაბამის ჩანართებში იმართება. იდენტობისა და მობილური მოწყობილობების ინტეგრაცია შემდეგი ეტაპია.",
                "Database, cache and storage connections are monitored above. Session, network, security-limit and provider policies have separate permissions and independent review. Mobile identity and device acceptance remain incomplete.",
              )}
            </p>
            <p>
              {t(
                "ეს პანელი აჩვენებს მიმდინარე მდგომარეობას; იგი უსაფრთხოების აუდიტს არ ცვლის.",
                "This panel reports current status; it does not replace a security audit.",
              )}
            </p>
          </Card>
        </>
      )}
      {tab === "audit" &&
        access?.permissions.includes("platform.audit.read") && (
          <>
            <Select
              label={t("მოვლენის კატეგორია", "Event category")}
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                setCursors([]);
              }}
              options={[
                {
                  value: "all",
                  label: t("ყველა ტექნიკური მოვლენა", "All technical events"),
                },
                {
                  value: "access",
                  label: t("ტექნიკური წვდომა", "Technical access"),
                },
                {
                  value: "authentication",
                  label: t("ტექნიკური ავტორიზაცია", "Technical authentication"),
                },
              ]}
            />
            {audit && (
              <Card>
                <p>
                  {t(
                    "ჟურნალი არ შეიცავს ორგანიზაციულ ქმედებებს, პირად მონაცემებს ან სესიის საიდუმლოებებს.",
                    "The log excludes organizational activity, personal data and session secrets.",
                  )}
                </p>
                <div className="review-toolbar my-3">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={verifyingChain}
                    onClick={async () => {
                      setVerifyingChain(true);
                      setVerifyError("");
                      try {
                        setChainVerification(
                          await platformApi.verifyAuditChain(),
                        );
                      } catch {
                        setVerifyError(
                          t(
                            "აუდიტის ჯაჭვის შემოწმება ვერ შესრულდა.",
                            "Audit hash-chain verification failed.",
                          ),
                        );
                      } finally {
                        setVerifyingChain(false);
                      }
                    }}
                  >
                    {verifyingChain
                      ? t("მიმდინარეობს შემოწმება…", "Verifying chain…")
                      : t(
                          "ჰეშ-ჯაჭვის კრიპტოგრაფიული შემოწმება",
                          "Verify audit hash chain",
                        )}
                  </Button>
                </div>
                {verifyError && <p role="alert">{verifyError}</p>}
                {chainVerification && (
                  <Card className="decision-receipt-card mb-4">
                    <div className="review-toolbar">
                      <div>
                        <strong>
                          {chainVerification.unbroken
                            ? t(
                                `უწყვეტი SHA-256 ჯაჭვი დადასტურებულია (${chainVerification.verifiedCount} ჩანაწერი)`,
                                `Unbroken SHA-256 hash chain verified (${chainVerification.verifiedCount} entries)`,
                              )
                            : t(
                                `ჯაჭვის დარღვევა დაფიქსირდა ჩანაწერზე #${chainVerification.brokenId}`,
                                `Hash-chain break detected at entry #${chainVerification.brokenId}`,
                              )}
                        </strong>
                        <p className="text-xs mt-1 break-all">
                          Head #{chainVerification.headId ?? "—"} · SHA-256:{" "}
                          <code>{chainVerification.headHash}</code>
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => {
                          const blob = new Blob(
                            [JSON.stringify(chainVerification, null, 2)],
                            { type: "application/json;charset=utf-8" },
                          );
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `ertad-audit-checkpoint-${chainVerification.headId ?? "genesis"}.json`;
                          a.click();
                          URL.revokeObjectURL(url);
                        }}
                      >
                        {t("საკონტროლო JSON ექსპორტი", "Export checkpoint JSON")}
                      </Button>
                    </div>
                  </Card>
                )}
                {!audit.items.length ? (
                  <p>{t("მოვლენები არ მოიძებნა.", "No events found.")}</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left">
                      <thead>
                        <tr>
                          <th>{t("დრო", "Time")}</th>
                          <th>{t("მოვლენა", "Event")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {audit.items.map((item) => (
                          <tr key={item.id}>
                            <td className="p-3 align-top">{date(item.at)}</td>
                            <td className="p-3">
                              {names[item.event] ??
                                t("ტექნიკური მოვლენა", "Technical event")}
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
                    disabled={loading || !audit.nextBefore}
                    onClick={() => setCursors((v) => [...v, audit.nextBefore!])}
                  >
                    {t("შემდეგი", "Next")}
                  </Button>
                </div>
              </Card>
            )}
          </>
        )}
    </section>
  );
}
