import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import { useConsolePreferences } from "../components/useConsolePreferences";
import type { ReviewContext } from "../api/reviews";
import type { UnitContext } from "../api/units";
import type { WorkspaceSummary } from "../api/workspace";
import type { InboxSummary } from "../api/inbox";
import { demoApi, type DemoPerson } from "../api/demo";

export default function Workspace() {
  const { language } = useConsolePreferences(),
    ka = language === "ka";
  const {
    reviewContexts,
    reviewCount,
    reviewError: error,
    unitContexts = [],
    decisionContexts = [],
    workContexts = [],
    workspaceSummary = null,
    inboxSummary = null,
  } = useOutletContext<{
    reviewContexts: ReviewContext[] | null;
    reviewCount: number | null;
    reviewError: boolean;
    unitContexts: UnitContext[];
    decisionContexts: UnitContext[];
    workContexts: { id: string; name: string }[];
    workspaceSummary?: WorkspaceSummary | null;
    inboxSummary?: InboxSummary | null;
  }>();
  const contexts = reviewContexts ?? [],
    count = reviewCount ?? 0,
    loading = reviewContexts === null;
  const [people, setPeople] = useState<DemoPerson[]>([]);
  useEffect(() => {
    let live = true;
    if (import.meta.env.DEV)
      void demoApi
        .scenario()
        .then((r) => {
          if (live) setPeople(r.accounts);
        })
        .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const scheduleRows = (workspaceSummary?.schedule ?? []).map((bucket) => ({
    ...bucket,
    day: bucket.date.slice(5),
  }));

  const formatDue = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(ka ? "ka-GE" : "en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(iso));
    } catch {
      return iso.slice(0, 16);
    }
  };

  return (
    <section
      className="review-page workspace-page"
      aria-labelledby="workspace-title"
    >
      <header>
        <h1 id="workspace-title">{ka ? "სამუშაო სივრცე" : "Workspace"}</h1>
        <p>
          {ka
            ? "შენი უფლებებით ხელმისაწვდომი ერთეულები, ოპერაციები და მოთხოვნები."
            : "Units, active operations, and requests available under your current permissions."}
        </p>
      </header>
      {!loading && !error && (
        <div
          className="review-toolbar"
          style={{ gridColumn: "1 / -1" }}
          aria-label={ka ? "აქტიური წვდომის ფარგლები" : "Active access scope"}
        >
          {(unitContexts[0]?.name || workContexts[0]?.name || decisionContexts[0]?.name || contexts[0]?.name) && (
            <span className="status-badge" data-status="approved">
              {unitContexts[0]?.name || workContexts[0]?.name || decisionContexts[0]?.name || contexts[0]?.name}
            </span>
          )}
          {contexts.length > 0 && (
            <span className="status-badge" data-status="pending">
              {ka ? "წევრობის დადასტურება" : "Review authority"}
            </span>
          )}
          {unitContexts.length > 0 && (
            <span className="status-badge">
              {ka ? "ჯგუფები" : "Units"}
            </span>
          )}
          {workContexts.length > 0 && (
            <span className="status-badge">
              {ka ? "დავალებები და ღონისძიებები" : "Tasks & Events"}
            </span>
          )}
          {decisionContexts.length > 0 && (
            <span className="status-badge">
              {ka ? "პულები" : "Polls"}
            </span>
          )}
        </div>
      )}
      {loading ? (
        <div className="workspace-skeleton" role="status">
          <p>{ka ? "იტვირთება…" : "Loading…"}</p>
          <div className="workspace-kpi-grid" aria-hidden="true">
            <div className="workspace-skeleton-card" />
            <div className="workspace-skeleton-card" />
            <div className="workspace-skeleton-card" />
            <div className="workspace-skeleton-card" />
          </div>
        </div>
      ) : error ? (
        <Card>
          <p role="alert">
            {ka
              ? "მონაცემები ვერ ჩაიტვირთა."
              : "Unable to load your workspace."}
          </p>
          <Button
            onClick={() =>
              window.dispatchEvent(new Event("ertad-reviews-changed"))
            }
          >
            {ka ? "ხელახლა ცდა" : "Retry"}
          </Button>
        </Card>
      ) : (
        <>
          {workspaceSummary && (
            <div
              className="workspace-kpi-grid"
              aria-label={ka ? "ოპერაციული მაჩვენებლები" : "Operational KPIs"}
            >
              {workContexts.length > 0 && (
                <Link to="/tasks" className="workspace-kpi-card">
                  <span>{ka ? "აქტიური დავალებები" : "Open tasks"}</span>
                  <strong>{workspaceSummary.openWork}</strong>
                  {workspaceSummary.overdueWork > 0 && (
                    <small data-status="danger">
                      {ka
                        ? `${workspaceSummary.overdueWork} ვადაგადაცილებული`
                        : `${workspaceSummary.overdueWork} overdue`}
                    </small>
                  )}
                </Link>
              )}
              {workContexts.length > 0 && (
                <Link to="/events" className="workspace-kpi-card">
                  <span>{ka ? "ღონისძიებები (48სთ)" : "Events (48h)"}</span>
                  <strong>{workspaceSummary.upcomingEvents48h}</strong>
                </Link>
              )}
              {decisionContexts.length > 0 && (
                <Link to="/decisions" className="workspace-kpi-card">
                  <span>{ka ? "მიმდინარე პულები" : "Open polls"}</span>
                  <strong>{workspaceSummary.openDecisions}</strong>
                </Link>
              )}
              {contexts.length > 0 && (
                <Link to="/reviews" className="workspace-kpi-card">
                  <span>
                    {ka ? "დასადასტურებელი" : "Pending approvals"}
                  </span>
                  <strong>{count}</strong>
                </Link>
              )}
              <Link to="/inbox" className="workspace-kpi-card">
                <span>{ka ? "შემოსული წაუკითხავი" : "Unread inbox"}</span>
                <strong>{inboxSummary?.unread ?? 0}</strong>
                {(inboxSummary?.actionRequired ?? 0) > 0 && (
                  <small>
                    {ka
                      ? `${inboxSummary?.actionRequired} მოითხოვს ქმედებას`
                      : `${inboxSummary?.actionRequired} need action`}
                  </small>
                )}
              </Link>
            </div>
          )}

          {scheduleRows.length > 0 && (
            <Card className="workspace-chart-card">
              <h2>
                {ka
                  ? "7-დღიანი ოპერაციული დატვირთვა"
                  : "7-day operational schedule"}
              </h2>
              <div className="workspace-chart-wrap">
                <ResponsiveContainer width="100%" height={220} minWidth={240}>
                  <BarChart
                    data={scheduleRows}
                    margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="var(--border)"
                      opacity={0.4}
                    />
                    <XAxis
                      dataKey="day"
                      tick={{ fill: "var(--muted)", fontSize: 12 }}
                      stroke="var(--border)"
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fill: "var(--muted)", fontSize: 12 }}
                      stroke="var(--border)"
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "var(--surface)",
                        borderColor: "var(--border)",
                        color: "var(--text)",
                        borderRadius: "8px",
                      }}
                    />
                    <Bar
                      dataKey="tasks"
                      name={ka ? "დავალებები" : "Tasks"}
                      fill="var(--primary)"
                      radius={[4, 4, 0, 0]}
                    />
                    <Bar
                      dataKey="events"
                      name={ka ? "ღონისძიებები" : "Events"}
                      fill="var(--success)"
                      radius={[4, 4, 0, 0]}
                    />
                    <Bar
                      dataKey="decisions"
                      name={ka ? "პულები" : "Polls"}
                      fill="var(--warning)"
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          )}

          {workspaceSummary && workspaceSummary.urgent.length > 0 && (
            <Card>
              <h2>{ka ? "ყურადღებას საჭიროებს" : "Needs attention"}</h2>
              <ul className="workspace-urgent-list">
                {workspaceSummary.urgent.map((item) => (
                  <li key={`${item.kind}:${item.id}`}>
                    <Link
                      to={item.route}
                      state={{
                        inbox: {
                          source: item.kind === "task" ? "work" : item.kind,
                          organizationId: item.organizationId,
                          id: item.id,
                        },
                      }}
                      className="workspace-urgent-link"
                    >
                      <div>
                        <span
                          className="status-badge"
                          data-status={item.overdue ? "rejected" : "pending"}
                        >
                          {ka
                            ? item.kind === "task"
                              ? "დავალება"
                              : item.kind === "event"
                                ? "ღონისძიება"
                                : "პული"
                            : item.kind}
                        </span>
                        <strong>{item.title}</strong>
                      </div>
                      <small>
                        {item.overdue
                          ? ka
                            ? `ვადაგადაცილებული · ${formatDue(item.dueAt)}`
                            : `Overdue · ${formatDue(item.dueAt)}`
                          : formatDue(item.dueAt)}
                      </small>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {workContexts.length > 0 && (
            <Card>
              <h2>
                {ka ? "დავალებები და შესრულება" : "Tasks and completion"}
              </h2>
              <p>
                {ka
                  ? "გადაანაწილე სამუშაო, ნახე მონაწილეები და დაადასტურე შესრულება."
                  : "Delegate work, track volunteers and verify completion."}
              </p>
              <div className="workspace-actions">
                <Link className="workspace-primary-action" to="/tasks">
                  {ka ? "დავალებების მართვა" : "Manage tasks"}
                </Link>
              </div>
            </Card>
          )}
          {decisionContexts.length > 0 && (
            <Card>
              <h2>{ka ? "პულები და გამოკითხვები" : "Polls and surveys"}</h2>
              <p>
                {ka
                  ? "შექმენი დრაფტი, გამოაქვეყნე არჩეულ რეგიონში ან ჯგუფში და ნახე შედეგები დასრულების შემდეგ."
                  : "Create a draft, publish to a region or group, and view results after closing."}
              </p>
              <div className="workspace-actions">
                <Link className="workspace-primary-action" to="/decisions">
                  {ka ? "პულების მართვა" : "Manage polls"}
                </Link>
              </div>
            </Card>
          )}
          {unitContexts.length > 0 && (
            <Card>
              <h2>{ka ? "ჯგუფების მართვა" : "Manage groups"}</h2>
              <p>
                {ka
                  ? "შექმენი ჯგუფის მოთხოვნა, აირჩიე რეგიონი ან ზედა ჯგუფი და გაუგზავნე სხვა უფლებამოსილ ადმინისტრატორს დასამტკიცებად."
                  : "Request a new group, choose its region or parent group, and have another authorized administrator approve it."}
              </p>
              <div className="review-toolbar workspace-actions">
                <Link
                  className="workspace-primary-action"
                  to="/units?create=group"
                >
                  {ka ? "ჯგუფის შექმნა" : "Create group"}
                </Link>
                <Link to="/units">{ka ? "ჯგუფების ნახვა" : "View groups"}</Link>
                <Link to="/units?view=pending">
                  {ka
                    ? "ჯგუფების დასადასტურებელი მოთხოვნები"
                    : "Group requests awaiting approval"}
                </Link>
              </div>
            </Card>
          )}
          <Card>
            <h2>
              {ka
                ? "დასადასტურებელი დანიშვნები"
                : "Appointments awaiting your decision"}
            </h2>
            <p className="workspace-count">{count}</p>
            {contexts.length > 0 ? (
              <div className="review-toolbar">
                <Link to="/reviews">
                  {ka ? "მოთხოვნების გახსნა" : "Open requests"}
                </Link>
                <Link to="/reviews?view=mine">
                  {ka ? "ჩემი მოთხოვნები" : "My requests"}
                </Link>
              </div>
            ) : (
              <p>
                {import.meta.env.DEV
                  ? ka
                    ? "ამ ანგარიშს დანიშვნის მოთხოვნებზე წვდომა ჯერ არ აქვს. ლოკალური დემოს სანახავად გამოდი და აირჩიე საბჭოს ან რეგიონის ერთ-ერთი სატესტო ანგარიში."
                    : "This account has no appointment-review access. To explore the local demo, sign out and choose a council or regional demo account."
                  : ka
                    ? "ამ ანგარიშს დანიშვნის მოთხოვნების განხილვის უფლება მინიჭებული არ აქვს."
                    : "This account has no appointment-review access assigned."}
              </p>
            )}
          </Card>
          {contexts.map((c) => (
            <Card key={c.id}>
              <h2>{c.name}</h2>
              <p>
                {ka
                  ? "ხელმისაწვდომი ერთეულები და პოზიციები"
                  : "Permitted units and positions"}
              </p>
              <ul className="workspace-units">
                {Array.from(
                  new Map(c.positions.map((p) => [p.unitId, p.unitName])),
                ).map(([id, name]) => (
                  <li key={id}>
                    <strong>{name}</strong>
                    <ul>
                      {c.positions
                        .filter((p) => p.unitId === id)
                        .map((p) => (
                          <li key={p.id}>
                            {p.name} ·{" "}
                            {p.canPropose
                              ? ka
                                ? "დანიშვნის მოთხოვნა"
                                : "Can propose appointment"
                              : ka
                                ? "მიმოხილვა"
                                : "Review"}
                          </li>
                        ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
          {people.length > 0 && (
            <details>
              <summary>
                {ka
                  ? "სატესტო ანგარიშები და მუშაობის ინსტრუქცია"
                  : "Demo accounts and instructions"}
              </summary>
              <p>
                {ka
                  ? "საბჭოს პირველმა ანგარიშმა თითო რეგიონში მოთხოვნა შექმნა. შესაბამისი რეგიონის მეორე ადმინისტრატორი ან საბჭოს მეორე ანგარიში ადასტურებს; მოთხოვნის ავტორი და ბენეფიციარი საკუთარ მოთხოვნას ვერ ადასტურებენ."
                  : "Council account 1 created a request in each region. Regional administrator 2 or council account 2 can decide. The requester and beneficiary cannot approve their own request."}
              </p>
              <p>
                {ka
                  ? "ანგარიშის შესაცვლელად გამოდი და შესვლის გვერდზე სხვა ანგარიში აირჩიე. სხვადასხვა ანგარიშით ერთდროულად მუშაობისთვის გამოიყენე ბრაუზერის ცალკე პროფილები."
                  : "Sign out to switch accounts. Use separate browser profiles for simultaneous sessions."}
              </p>
              <ul className="workspace-units">
                {people.map((p) => (
                  <li key={p.id}>
                    {p.label}
                    <small>
                      {ka ? "სატესტო წევრის ID" : "Demo member ID"}:{" "}
                      <code>{p.memberId}</code>
                    </small>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
