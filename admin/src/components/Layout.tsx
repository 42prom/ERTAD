import { isAxiosError } from "axios";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  Outlet,
  Link,
  Navigate,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  ListTodo,
  BadgeCheck,
  Award,
  UserCheck,
  ChevronRight,
  LogOut,
  Menu,
  X,
  Bell,
  Vote,
  CalendarDays,
  MessageSquare,
  Shield,
  Search,
} from "lucide-react";
import { clsx } from "clsx";
import {
  ADMIN_STEP_UP_EVENT,
  authApi,
  type AdminStepUpEventDetail,
} from "../api/client";
import type { AdminUser } from "../types";
import { useConsolePreferences } from "./useConsolePreferences";
import ConsolePreferences from "./ConsolePreferences";
import CommandPalette, { type CommandPaletteNavItem } from "./CommandPalette";
import { type ReviewContext } from "../api/reviews";
import { type UnitContext } from "../api/units";
import { type DecisionContext } from "../api/decisions";
import { type WorkContext } from "../api/work";
import { inboxApi, type InboxSummary } from "../api/inbox";
import { platformSections, platformPath } from "./platformSections";
import { type PlatformAccess } from "../api/platform";
import { workspaceApi, type WorkspaceSummary } from "../api/workspace";
import { useRealtimeStream, type RealtimeSignal } from "../api/realtime";

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { language, theme, setLanguage, setTheme } = useConsolePreferences();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navigation, setNavigation] = useState({
    pathname: location.pathname,
    open: false,
  });
  if (navigation.pathname !== location.pathname)
    setNavigation({ pathname: location.pathname, open: false });
  const navOpen = navigation.pathname === location.pathname && navigation.open;
  const setNavOpen = (open: boolean) =>
    setNavigation({ pathname: location.pathname, open });
  const [platformAccess, setPlatformAccess] = useState<PlatformAccess | null>(
    null,
  );
  const [reviewCount, setReviewCount] = useState<number | null>(null);
  const [inboxState, setInboxState] = useState<{
    access: PlatformAccess;
    summary: InboxSummary | null;
    error: boolean;
  } | null>(null);
  const inboxSummary =
    inboxState?.access === platformAccess ? inboxState?.summary : null;
  const inboxError =
    inboxState?.access === platformAccess && !!inboxState?.error;

  const [reviewContexts, setReviewContexts] = useState<ReviewContext[] | null>(
    null,
  );
  const [reviewError, setReviewError] = useState(false);
  const [unitContexts, setUnitContexts] = useState<UnitContext[]>([]);
  const [invitationContexts, setInvitationContexts] = useState<
    { id: string; name: string }[]
  >([]);
  const [positionContexts, setPositionContexts] = useState<
    { id: string; name: string }[]
  >([]);
  const [workContexts, setWorkContexts] = useState<WorkContext[]>([]);
  const [collectiveContexts, setCollectiveContexts] = useState<WorkContext[]>(
    [],
  );
  const [channelContexts, setChannelContexts] = useState<
    { id: string; name: string }[]
  >([]);
  const [pointContexts, setPointContexts] = useState<WorkContext[]>([]);
  const [decisionContexts, setDecisionContexts] = useState<DecisionContext[]>(
    [],
  );
  const [memberContexts, setMemberContexts] = useState<
    { id: string; name: string }[]
  >([]);
  const [workspaceSummary, setWorkspaceSummary] =
    useState<WorkspaceSummary | null>(null);

  const bootstrapSequence = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshBootstrap = useCallback(async () => {
    const current = ++bootstrapSequence.current;
    try {
      const data = await workspaceApi.bootstrap();
      if (!mountedRef.current || current !== bootstrapSequence.current) return;
      const technical = data.platformAccess;
      setPlatformAccess((prev) =>
        prev &&
        prev.technicalAccount === technical.technicalAccount &&
        prev.validUntil === technical.validUntil &&
        prev.permissions.join("\0") === technical.permissions.join("\0")
          ? prev
          : technical,
      );
      setUnitContexts(data.units);
      setMemberContexts(data.members);
      setPositionContexts(data.positions);
      setInvitationContexts(data.invitations);
      setDecisionContexts(data.decisions);
      setWorkContexts(data.work);
      setCollectiveContexts(data.collective);
      setPointContexts(data.points);
      setChannelContexts(data.channels);
      setReviewContexts(data.reviews);
      setReviewCount(data.reviewCount);
      setReviewError(false);
      setWorkspaceSummary(data.summary);
      if (!technical.technicalAccount) {
        setInboxState({ access: technical, summary: data.inbox, error: false });
      }
    } catch {
      if (!mountedRef.current || current !== bootstrapSequence.current) return;
      setPlatformAccess(null);
      setInvitationContexts([]);
      setUnitContexts([]);
      setMemberContexts([]);
      setPositionContexts([]);
      setDecisionContexts([]);
      setWorkContexts([]);
      setCollectiveContexts([]);
      setPointContexts([]);
      setChannelContexts([]);
      setReviewCount(null);
      setReviewContexts([]);
      setReviewError(true);
      setWorkspaceSummary(null);
    }
  }, []);

  useEffect(() => {
    let live = true;
    const initialTimer = window.setTimeout(() => {
      if (live) void refreshBootstrap();
    }, 0);
    const timer = window.setInterval(() => {
      void refreshBootstrap();
    }, 60_000);
    const onRefresh = () => void refreshBootstrap();
    window.addEventListener("focus", onRefresh);
    window.addEventListener("ertad-reviews-changed", onRefresh);
    return () => {
      live = false;
      window.clearTimeout(initialTimer);
      clearInterval(timer);
      window.removeEventListener("focus", onRefresh);
      window.removeEventListener("ertad-reviews-changed", onRefresh);
    };
  }, [refreshBootstrap]);

  useEffect(() => {
    if (!platformAccess || platformAccess.technicalAccount) return;
    let live = true;
    let sequence = 0;
    const updateInbox = async () => {
      const current = ++sequence;
      try {
        const summary = await inboxApi.summary();
        if (live && current === sequence) {
          setInboxState({ access: platformAccess, summary, error: false });
        }
      } catch {
        if (live && current === sequence) {
          setInboxState({ access: platformAccess, summary: null, error: true });
        }
      }
    };
    const events = ["ertad-work-changed", "ertad-inbox-changed"];
    for (const event of events) window.addEventListener(event, updateInbox);
    return () => {
      live = false;
      for (const event of events) window.removeEventListener(event, updateInbox);
    };
  }, [platformAccess]);

  const onRealtimeSignal = useCallback(
    (signal: RealtimeSignal) => {
      if (
        signal.topic === "workspace" ||
        signal.topic === "inbox" ||
        signal.topic === "review" ||
        signal.topic === "work" ||
        signal.topic === "event" ||
        signal.topic === "decision" ||
        signal.topic === "unit" ||
        signal.topic === "collective"
      ) {
        void refreshBootstrap();
      }
    },
    [refreshBootstrap],
  );
  useRealtimeStream(Boolean(platformAccess), onRealtimeSignal);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const [stepUpRequest, setStepUpRequest] =
    useState<AdminStepUpEventDetail | null>(null);
  const [stepUpPassword, setStepUpPassword] = useState("");
  const [stepUpError, setStepUpError] = useState("");
  const [stepUpLoading, setStepUpLoading] = useState(false);

  useEffect(() => {
    const handleStepUpRequired = (event: Event) => {
      const detail = (event as CustomEvent<AdminStepUpEventDetail>).detail;
      setStepUpError("");
      setStepUpPassword("");
      setStepUpRequest(detail);
    };
    window.addEventListener(ADMIN_STEP_UP_EVENT, handleStepUpRequired);
    return () =>
      window.removeEventListener(ADMIN_STEP_UP_EVENT, handleStepUpRequired);
  }, []);

  const storedUser = sessionStorage.getItem("admin_user");
  let adminUser: AdminUser | null;
  try {
    adminUser = storedUser ? JSON.parse(storedUser) : null;
  } catch {
    adminUser = null;
  }

  const handleLogout = async () => {
    try {
      await authApi.logout();
    } finally {
      sessionStorage.removeItem("admin_csrf");
      sessionStorage.removeItem("admin_user");
      navigate("/login");
      window.location.reload();
    }
  };

  const submitStepUp = async (event: FormEvent) => {
    event.preventDefault();
    if (!stepUpRequest || !stepUpPassword) return;
    setStepUpLoading(true);
    setStepUpError("");
    try {
      await authApi.stepUp(stepUpPassword);
      const request = stepUpRequest;
      setStepUpRequest(null);
      setStepUpPassword("");
      request.resolve();
    } catch (error: unknown) {
      setStepUpError(
        (isAxiosError<{ error?: { message?: string } }>(error) &&
          error.response?.data?.error?.message) ||
          "Re-authentication failed",
      );
    } finally {
      setStepUpLoading(false);
    }
  };

  const cancelStepUp = () => {
    stepUpRequest?.reject(
      new Error("Administrator cancelled re-authentication"),
    );
    setStepUpRequest(null);
    setStepUpPassword("");
    setStepUpError("");
  };

  const getBreadcrumbs = () => {
    const paths = location.pathname.split("/").filter(Boolean);
    return paths.map((path, index) => ({
      label:
        (paths[0] === "platform" && index === 1
          ? platformSections.find((section) => section.key === path)?.[
              language === "ka" ? "ka" : "en"
            ]
          : undefined) ??
        (
          {
            dashboard: language === "ka" ? "სამუშაო სივრცე" : "Workspace",
            tasks: language === "ka" ? "დავალებები" : "Tasks",
            members: language === "ka" ? "წევრები" : "Members",
            invitations: language === "ka" ? "ვებმოწვევები" : "Web invitations",
            positions:
              language === "ka"
                ? "პოზიციები და უფლებები"
                : "Positions and permissions",
            account:
              language === "ka" ? "ანგარიშის უსაფრთხოება" : "Account security",
            platform:
              language === "ka" ? "სისტემის მართვა" : "System administration",
            events: language === "ka" ? "ღონისძიებები" : "Events",
            approvals: language === "ka" ? "დამტკიცებები" : "Approvals",
            contribution: language === "ka" ? "კონტრიბუცია" : "Contribution",
            reviews: language === "ka" ? "მოთხოვნები" : "Requests",
            inbox: language === "ka" ? "შემოსული მოთხოვნები" : "Inbox",
            channels: language === "ka" ? "ჯგუფის არხები" : "Group channels",
            decisions: language === "ka" ? "პულები" : "Polls",
            units:
              language === "ka" ? "ჯგუფები და რეგიონები" : "Groups and regions",
          } as Record<string, string>
        )[path] ??
        path.charAt(0).toUpperCase() + path.slice(1).replace("-", " "),
      path: `/${paths.slice(0, index + 1).join("/")}`,
    }));
  };

  const breadcrumbs = getBreadcrumbs();

  const navItems = [
    {
      path: "/dashboard",
      label: language === "ka" ? "სამუშაო სივრცე" : "Workspace",
      icon: LayoutDashboard,
      visible: !platformAccess?.technicalAccount,
    },
    {
      path: "/units",
      label: language === "ka" ? "ჯგუფები და რეგიონები" : "Groups and regions",
      icon: Users,
      visible: !!unitContexts.length,
    },
    ...platformSections.map((section) => ({
      path: platformPath(section.key),
      label: language === "ka" ? section.ka : section.en,
      icon: Shield,
      visible:
        !!platformAccess?.technicalAccount &&
        platformAccess.permissions.includes(section.permission),
    })),
    {
      path: "/inbox",
      label: language === "ka" ? "შემოსული მოთხოვნები" : "Inbox",
      icon: Bell,
      visible:
        !platformAccess?.technicalAccount &&
        (!!inboxSummary?.contexts.length || inboxError),
    },
    {
      path: "/channels",
      label: language === "ka" ? "ჯგუფის არხები" : "Group channels",
      icon: MessageSquare,
      visible: !!channelContexts.length,
    },
    {
      path: "/tasks",
      label: language === "ka" ? "დავალებები" : "Tasks",
      icon: ListTodo,
      visible: !!workContexts.length,
    },
    {
      path: "/invitations",
      label: language === "ka" ? "ვებმოწვევები" : "Web invitations",
      icon: Users,
      visible: invitationContexts.length > 0,
    },
    {
      path: "/members",
      label: language === "ka" ? "წევრები" : "Members",
      icon: Users,
      visible: !!memberContexts.length,
    },
    {
      path: "/events",
      label: language === "ka" ? "ღონისძიებები" : "Events",
      icon: CalendarDays,
      visible: !!workContexts.length,
    },
    {
      path: "/positions",
      label:
        language === "ka" ? "პოზიციები და უფლებები" : "Positions and permissions",
      icon: BadgeCheck,
      visible: !!positionContexts.length,
    },
    {
      path: "/approvals",
      label: language === "ka" ? "დამტკიცებები" : "Approvals",
      icon: BadgeCheck,
      visible: !!collectiveContexts.length,
    },
    {
      path: "/contribution",
      label: language === "ka" ? "კონტრიბუცია" : "Contribution",
      icon: Award,
      visible: !!pointContexts.length,
    },
    {
      path: "/decisions",
      label: language === "ka" ? "პულები" : "Polls",
      icon: Vote,
      visible: !!decisionContexts.length,
    },
    {
      path: "/reviews",
      label: language === "ka" ? "მოთხოვნები" : "Requests",
      icon: UserCheck,
      visible: reviewCount !== null,
    },
  ].filter((item) => item.visible);

  const paletteItems: CommandPaletteNavItem[] = navItems.map((item) => ({
    path: item.path,
    label: item.label,
    group: platformAccess?.technicalAccount
      ? language === "ka"
        ? "პლატფორმა"
        : "Platform"
      : language === "ka"
        ? "მოდული"
        : "Module",
  }));

  const resolvedTheme: "light" | "dark" =
    theme === "dark"
      ? "dark"
      : theme === "light"
        ? "light"
        : typeof window !== "undefined" &&
            window.matchMedia?.("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";

  return (
    <div
      className="ertad-console flex h-screen bg-gray-50"
      data-nav-open={navOpen}
    >
      {/* Sidebar */}
      <aside
        id="console-navigation"
        className="w-64 bg-white border-r border-gray-200 flex flex-col"
      >
        <Link to="/dashboard" className="console-brand" aria-label="ERTAD">
          <span className="console-brand-mark" aria-hidden="true">
            E
          </span>
          <span>
            <strong>ERTAD</strong>
            <small>
              {language === "ka" ? "მართვის პლატფორმა" : "Management console"}
            </small>
          </span>
        </Link>
        <nav
          className="console-nav"
          aria-label={language === "ka" ? "მთავარი მენიუ" : "Main navigation"}
        >
          <p className="console-nav-caption">
            {platformAccess?.technicalAccount
              ? language === "ka"
                ? "ტექნიკური მართვა"
                : "Technical administration"
              : language === "ka"
                ? "მართვა"
                : "Management"}
          </p>
          {navItems.map(({ path, label, icon: Icon }) => (
            <Link
              key={path}
              to={path}
              className="console-nav-item"
              aria-current={location.pathname === path ? "page" : undefined}
            >
              <Icon size={19} aria-hidden="true" />
              <span>{label}</span>
              {path === "/inbox" && !!inboxSummary?.unread && (
                <span className="console-count" aria-hidden="true">
                  {inboxSummary.unread}
                </span>
              )}
              {path === "/reviews" && !!reviewCount && (
                <span
                  className="console-count"
                  aria-label={
                    language === "ka"
                      ? "დასადასტურებელი დანიშვნები"
                      : "Pending appointments"
                  }
                >
                  {reviewCount}
                </span>
              )}
            </Link>
          ))}
        </nav>
        <div className="console-sidebar-tools">
          <ConsolePreferences />
          <span className="console-environment">
            {language === "ka" ? "სატესტო გარემო" : "Demo environment"}
          </span>
        </div>

        <div className="p-4 border-t border-gray-200">
          <Link
            to="/account"
            className="inline-flex items-center min-h-11 text-sm text-primary-600 underline"
          >
            {language === "ka" ? "ანგარიშის უსაფრთხოება" : "Account security"}
          </Link>
          <div className="console-account">
            <div className="flex items-center">
              <div className="w-8 h-8 bg-primary-100 rounded-full flex items-center justify-center">
                <span className="text-sm font-semibold text-primary-700">
                  {adminUser?.email?.[0]?.toUpperCase() || "A"}
                </span>
              </div>
              <div className="console-account-text">
                <p className="text-sm font-medium text-gray-700">
                  {adminUser?.fullName ||
                    (language === "ka" ? "ადმინისტრატორი" : "Administrator")}
                </p>
                <p className="text-xs text-gray-500">
                  {adminUser?.email || ""}
                </p>
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="p-2 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
              title={language === "ka" ? "გასვლა" : "Logout"}
              aria-label={language === "ka" ? "გასვლა" : "Logout"}
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top Bar */}
        <header className="console-topbar bg-white border-b border-gray-200">
          <button
            type="button"
            className="console-menu"
            aria-controls="console-navigation"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(!navOpen)}
          >
            {navOpen ? (
              <X size={20} aria-hidden="true" />
            ) : (
              <Menu size={20} aria-hidden="true" />
            )}
            <span className="sr-only">
              {language === "ka" ? "მენიუ" : "Menu"}
            </span>
          </button>
          <div className="console-breadcrumbs flex items-center text-sm text-gray-600">
            {breadcrumbs.map((crumb, index) => (
              <div key={crumb.path} className="flex items-center">
                {index > 0 && <ChevronRight className="w-4 h-4 mx-2" />}
                <Link
                  to={crumb.path}
                  className={clsx(
                    "hover:text-primary-600",
                    index === breadcrumbs.length - 1
                      ? "text-gray-900 font-medium"
                      : "text-gray-600",
                  )}
                >
                  {crumb.label}
                </Link>
              </div>
            ))}
          </div>
          {platformAccess && (
            <button
              type="button"
              className="console-command-trigger"
              onClick={() => setPaletteOpen(true)}
              aria-label={
                language === "ka"
                  ? "სწრაფი ნავიგაცია (Ctrl+K)"
                  : "Quick command palette (Ctrl+K)"
              }
            >
              <Search size={16} aria-hidden="true" />
              <span>{language === "ka" ? "ძიება" : "Search"}</span>
              <kbd aria-hidden="true">⌘K</kbd>
            </button>
          )}
          {!platformAccess?.technicalAccount &&
            (!!inboxSummary?.contexts.length || inboxError) && (
              <Link
                to="/inbox"
                className="console-inbox"
                aria-label={
                  language === "ka"
                    ? `შემოსული მოთხოვნები${inboxError ? " — განახლება საჭიროა" : ` — წაუკითხავი: ${inboxSummary?.unread ?? 0}`}`
                    : `Inbox${inboxError ? " — refresh required" : ` — unread: ${inboxSummary?.unread ?? 0}`}`
                }
              >
                <Bell size={19} aria-hidden="true" />
                {!!inboxSummary?.unread && (
                  <span aria-hidden="true">{inboxSummary.unread}</span>
                )}
              </Link>
            )}
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-auto">
          {location.pathname === "/account" ? (
            <Outlet />
          ) : !platformAccess ? (
            <div
              className="review-page"
              role={reviewError ? "alert" : "status"}
            >
              {reviewError
                ? language === "ka"
                  ? "წვდომა ვერ შემოწმდა. განაახლეთ გვერდი."
                  : "Could not check access. Refresh the page."
                : language === "ka"
                  ? "წვდომა მოწმდება…"
                  : "Checking access…"}
            </div>
          ) : platformAccess.technicalAccount &&
            location.pathname !== "/platform" &&
            !location.pathname.startsWith("/platform/") ? (
            <Navigate to="/platform" replace />
          ) : (
            <Outlet
              context={{
                workContexts,
                reviewContexts,
                reviewCount,
                reviewError,
                unitContexts,
                decisionContexts,
                workspaceSummary,
                inboxSummary,
              }}
            />
          )}
        </main>
      </div>

      {paletteOpen && (
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          language={language}
          items={paletteItems}
          urgent={workspaceSummary?.urgent ?? []}
          theme={resolvedTheme}
          onToggleTheme={() =>
            setTheme(resolvedTheme === "dark" ? "light" : "dark")
          }
          onToggleLanguage={() => setLanguage(language === "ka" ? "en" : "ka")}
        />
      )}

      {stepUpRequest && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="step-up-title"
        >
          <form
            onSubmit={submitStepUp}
            className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl"
          >
            <h2
              id="step-up-title"
              className="text-lg font-semibold text-gray-900"
            >
              {language === "ka"
                ? "მოქმედების დადასტურება"
                : "Confirm sensitive operation"}
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              {language === "ka"
                ? "ხელახლა შეიყვანე პაროლი. დადასტურება მოქმედებს ხუთი წუთით."
                : "Re-enter your password. Approval remains valid for five minutes."}
            </p>
            {stepUpError && (
              <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
                {stepUpError}
              </div>
            )}
            <label
              className="mt-5 block text-sm font-medium text-gray-700"
              htmlFor="step-up-password"
            >
              {language === "ka" ? "პაროლი" : "Password"}
            </label>
            <input
              id="step-up-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={stepUpPassword}
              onChange={(event) => setStepUpPassword(event.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm"
            />
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={cancelStepUp}
                disabled={stepUpLoading}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
              >
                {language === "ka" ? "გაუქმება" : "Cancel"}
              </button>
              <button
                type="submit"
                disabled={stepUpLoading || !stepUpPassword}
                className="rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {stepUpLoading ? "Verifying…" : "Confirm and continue"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
