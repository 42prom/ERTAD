import { useAsyncResource } from "../components/useAsyncResource";
import { useCallback, useState } from "react";
import { Shield, Download } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Select from "../components/ui/Select";
import { useConsolePreferences } from "../components/useConsolePreferences";
import {
  platformApi,
  type PlatformMonitoring,
  type SecuritySignal,
} from "../api/platform";

/** Adapted Shield dashboard: bounded observations, no inferred person/IP risk scores. */
export default function ShieldDashboard({
  refreshRevision = 0,
  onSessions,
  onAudit,
}: {
  refreshRevision?: number;
  onSessions?: () => void;
  onAudit?: () => void;
}) {
  const { language } = useConsolePreferences(),
    ka = language === "ka";
  const [minutes, setMinutes] = useState<"15" | "60" | "1440">("15");
  const [category, setCategory] = useState<SecuritySignal | "all">("all");
  const [metricsError, setMetricsError] = useState("");
  const load = useCallback(
    () => platformApi.monitoring(minutes, category),
    [minutes, category],
  );
  async function downloadMetrics() {
    setMetricsError("");
    try {
      const text = await platformApi.metricsPrometheus();
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ertad-security-metrics.prom.txt";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setMetricsError(
        ka
          ? "Prometheus მეტრიკების ჩამოტვირთვა ვერ შესრულდა."
          : "Could not download Prometheus metrics.",
      );
    }
  }
  const {
    data,
    loading,
    failed: error,
  } = useAsyncResource<PlatformMonitoring>(
    JSON.stringify([minutes, category, refreshRevision]),
    load,
  );
  const names: Record<SecuritySignal, string> = {
    login_failed: ka ? "წარუმატებელი შესვლა" : "Failed login",
    step_up_failed: ka
      ? "პაროლის ხელახლა დადასტურება უარყოფილია"
      : "Failed password confirmation",
    authentication_required: ka
      ? "აუთენტიფიკაცია საჭიროა"
      : "Authentication required",
    access_denied: ka ? "წვდომა უარყოფილია" : "Access denied",
    rate_limited: ka ? "მოთხოვნების ლიმიტი" : "Rate limited",
    server_error: ka ? "სერვერული შეცდომა" : "Server error",
  };
  const technicalNames: Record<string, string> = {
    ADMIN_LOGIN_SUCCEEDED: ka ? "ტექნიკური შესვლა" : "Technical login",
    ADMIN_STEP_UP_GRANTED: ka ? "პაროლი დადასტურებულია" : "Password confirmed",
    ADMIN_STEP_UP_FAILED: ka
      ? "პაროლის დადასტურება უარყოფილია"
      : "Password confirmation denied",
    ADMIN_LOGOUT: ka ? "სისტემიდან გასვლა" : "Logout",
  };
  const date = (value: string) =>
    new Date(value).toLocaleString(ka ? "ka-GE" : "en-GB", {
      dateStyle: "short",
      timeStyle: "short",
      hour12: false,
    });
  return (
    <div className="space-y-4">
      <Card>
        <h2 className="flex items-center gap-2">
          <Shield size={20} aria-hidden="true" />
          {ka ? "უსაფრთხოების მონიტორინგი" : "Security monitoring"}
        </h2>
        <p className="mt-2">
          {ka
            ? "API-ის პასუხების შეჯამება. უარყოფილი მოთხოვნა თავისთავად თავდასხმას არ ნიშნავს; სესიებს ავტომატურად არ ვუკავშირებთ ამ მაჩვენებლებს."
            : "API response observations. A rejected request is not necessarily an attack; these counts are not automatically attributed to sessions."}
        </p>
        <p className="mt-2 text-sm">
          {ka
            ? "დაფარვა: მიმდინარე API პროცესი, მაქსიმუმ 60 წუთი. გადატვირთვისას ეს დროებითი მრიცხველები ნულდება. გარე WAF, ქსელური ბლოკირება და მობილური დაცვა აქ არ იზომება."
            : "Coverage: this API process, up to 60 minutes. These temporary counters reset on restart. External WAF, network blocking and mobile protection are not measured here."}
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Select
            label={ka ? "პერიოდი" : "Period"}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value as "15" | "60" | "1440")}
            options={[
              { value: "15", label: ka ? "ბოლო 15 წუთი" : "Last 15 minutes" },
              { value: "60", label: ka ? "ბოლო 60 წუთი" : "Last 60 minutes" },
              { value: "1440", label: ka ? "ბოლო 24 საათი (შენახული)" : "Last 24 hours (persisted)" },
            ]}
          />
          <Select
            label={ka ? "მოვლენის ტიპი" : "Event type"}
            value={category}
            onChange={(e) =>
              setCategory(e.target.value as SecuritySignal | "all")
            }
            options={[
              { value: "all", label: ka ? "ყველა" : "All" },
              ...Object.entries(names).map(([value, label]) => ({
                value,
                label,
              })),
            ]}
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-2 items-center">
          <Button
            type="button"
            variant="secondary"
            onClick={() => void downloadMetrics()}
          >
            <Download size={16} aria-hidden="true" />
            {ka ? "Prometheus მეტრიკების ექსპორტი" : "Export Prometheus metrics"}
          </Button>
          {metricsError && <span role="alert">{metricsError}</span>}
        </div>
      </Card>
      {loading && <p role="status">{ka ? "იტვირთება…" : "Loading…"}</p>}
      {error && (
        <p role="alert">
          {ka
            ? "მონიტორინგი მიუწვდომელია ან წვდომა აღარ გაქვთ. სცადეთ განახლება."
            : "Monitoring is unavailable or access has expired. Please refresh."}
        </p>
      )}
      {data && (
        <>
          <p className="text-sm">
            {ka ? "დაკვირვება დაიწყო" : "Observed since"}:{" "}
            {date(data.observedSince)} · {ka ? "განახლდა" : "Updated"}:{" "}
            {date(data.checkedAt)}
          </p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {(Object.keys(names) as SecuritySignal[])
              .filter((key) => category === "all" || key === category)
              .map((key) => (
                <Card key={key}>
                  <h3>{names[key]}</h3>
                  <p className="mt-2 text-2xl font-semibold">
                    {data.totals[key]}
                  </p>
                </Card>
              ))}
          </div>
          <Card>
            <h3>
              {ka ? "მოვლენები წუთების მიხედვით" : "Observations by minute"}
            </h3>
            {data.items.length > 0 && (
              <div
                className="decision-chart-wrap my-3"
                aria-label={ka ? "ტელემეტრიის დროითი გრაფიკი" : "Telemetry timeline chart"}
              >
                <ResponsiveContainer
                  width="100%"
                  height={200}
                  initialDimension={{ width: 460, height: 200 }}
                >
                  <BarChart
                    data={[...data.items]
                      .reverse()
                      .map((item) => ({
                        time: new Date(item.at).toLocaleTimeString(
                          ka ? "ka-GE" : "en-GB",
                          { hour: "2-digit", minute: "2-digit", hour12: false },
                        ),
                        total: Object.values(item.counts).reduce(
                          (acc, n) => acc + n,
                          0,
                        ),
                      }))}
                    margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
                  >
                    <XAxis dataKey="time" />
                    <YAxis allowDecimals={false} />
                    <Tooltip />
                    <Bar
                      dataKey="total"
                      fill="var(--accent, #2563eb)"
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            {!data.items.length ? (
              <p className="mt-3">
                {ka
                  ? "არჩეულ პერიოდში შესაბამისი მოვლენები არ დაფიქსირებულა."
                  : "No matching observations in this period."}
              </p>
            ) : (
              <ul className="mt-3 space-y-3">
                {data.items.map((item) => (
                  <li
                    key={item.at}
                    className="border-b border-[var(--border)] pb-3"
                  >
                    <time dateTime={item.at} className="font-medium">
                      {date(item.at)}
                    </time>
                    <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                      {(Object.keys(names) as SecuritySignal[])
                        .filter((key) => item.counts[key] > 0)
                        .map((key) => (
                          <div key={key} className="flex justify-between gap-3">
                            <dt>{names[key]}</dt>
                            <dd>{item.counts[key]}</dd>
                          </div>
                        ))}
                    </dl>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <h3>
              {ka
                ? "ბოლო ტექნიკური ავთენტიფიკაციები"
                : "Latest technical authentication events"}
            </h3>
            <p className="mt-2 text-sm">
              {ka
                ? "აუდიტის ბოლო 5 ჩანაწერი; პერიოდის ფილტრი ამ ისტორიას არ ეხება. მომხმარებლის ვინაობა არ ჩანს."
                : "Latest 5 audit entries, independent of the period filter. Account identities are not displayed."}
            </p>
            {!data.recentTechnicalEvents.length && (
              <p className="mt-2">
                {ka ? "ჩანაწერები არ არის." : "No entries."}
              </p>
            )}
            <ul className="mt-3 space-y-2">
              {data.recentTechnicalEvents.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap justify-between gap-2"
                >
                  <span>
                    {technicalNames[item.event] ??
                      (ka ? "ავთენტიფიკაციის მოვლენა" : "Authentication event")}
                  </span>
                  <time dateTime={item.at}>{date(item.at)}</time>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap gap-3">
              {onAudit && (
                <Button variant="secondary" onClick={onAudit}>
                  {ka ? "აუდიტის ნახვა" : "Open audit"}
                </Button>
              )}
              {onSessions && (
                <Button variant="secondary" onClick={onSessions}>
                  {ka ? "სესიების შემოწმება" : "Review sessions"}
                </Button>
              )}
            </div>
            {onSessions && (
              <p className="mt-3 text-sm">
                {ka
                  ? "სესიის შეწყვეტა საჭიროებს ცალკე უფლებას, მიზეზსა და პაროლის დადასტურებას."
                  : "Revocation requires separate permission, a reason and password confirmation."}
              </p>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
