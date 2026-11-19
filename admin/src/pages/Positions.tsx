import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  positionsApi,
  type PositionDefinition,
  type PositionGrant,
  type PositionUnit,
} from "../api/positions";
import type { CollectiveWrite } from "../api/collective";
import { authApi } from "../api/client";
import { demoApi } from "../api/demo";
import { useAsyncResource } from "../components/useAsyncResource";
import { useCollectiveWrite } from "../components/CollectiveWrite";
import { useConsolePreferences } from "../components/useConsolePreferences";
import PositionComparison from "../components/PositionComparison";
import PositionPermissions from "../components/PositionPermissions";
import PositionRetirement from "../components/PositionRetirement";
import PositionRollout from "../components/PositionRollout";
import { positionPermissionLabel } from "../components/positionPermissionNames";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import Input from "../components/ui/Input";
import Select from "../components/ui/Select";
import Textarea from "../components/ui/Textarea";

export default function Positions() {
  const { language } = useConsolePreferences();
  const load = useCallback(() => positionsApi.contexts(), []);
  const contexts = useAsyncResource("positions", load);
  if (contexts.loading)
    return <p role="status">{language === "ka" ? "იტვირთება…" : "Loading…"}</p>;
  if (contexts.failed || !contexts.data?.length)
    return (
      <p role="alert">
        {language === "ka"
          ? "პოზიციებზე წვდომა მიუწვდომელია."
          : "Position access unavailable."}
      </p>
    );
  return (
    <Catalogue key={contexts.data[0].id} organizationId={contexts.data[0].id} />
  );
}
function Catalogue({ organizationId }: { organizationId: string }) {
  const { language } = useConsolePreferences(),
    t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(1),
    [revision, setRevision] = useState(0);
  const [form, setForm] = useState<PositionDefinition | "new" | null>(null),
    [demo, setDemo] = useState(false);
  const [retiring, setRetiring] = useState<PositionDefinition | null>(null);
  const [rollout, setRollout] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareA, setCompareA] = useState("");
  const [compareB, setCompareB] = useState("");
  const load = useCallback(
    () => positionsApi.list(organizationId, search, page),
    [organizationId, search, page],
  );
  const resource = useAsyncResource(
      JSON.stringify([organizationId, search, page, revision]),
      load,
    ),
    data = resource.data;
  const write = useCollectiveWrite(demo, () => {
    setForm(null);
    setRetiring(null);
    setRevision((v) => v + 1);
  });
  useEffect(() => {
    let live = true;
    if (import.meta.env.DEV)
      void demoApi
        .scenario()
        .then(() => {
          if (live) setDemo(true);
        })
        .catch(() => {});
    const refresh = () => setRevision((v) => v + 1);
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return (
    <div className="review-page">
      <header>
        <h1 className="text-2xl font-bold">
          {t("პოზიციები და უფლებები", "Positions and permissions")}
        </h1>
        <p className="mt-2">
          {t(
            "ცვლილება საჭიროებს დამოუკიდებელ დამტკიცებას. ახალი ვერსია წევრების უფლებებს ავტომატურად არ ცვლის.",
            "Changes require independent approval. A new version does not automatically change members’ permissions.",
          )}
        </p>
        <Link className="text-primary-600 underline" to="/approvals">
          {t("დამტკიცებები და ისტორია", "Approvals and history")}
        </Link>
      </header>
      {write.feedback}
      {resource.failed && (
        <p role="alert">
          {t(
            "წვდომა ან მონაცემები შეიცვალა. განაახლეთ გვერდი.",
            "Access or data changed. Reload the page.",
          )}
        </p>
      )}
      {resource.loading && <p role="status">{t("იტვირთება…", "Loading…")}</p>}
      {rollout && (
        <PositionRollout
          key={rollout}
          organizationId={organizationId}
          positionId={rollout}
          demo={demo}
          close={() => {
            setRollout(null);
            setRevision((v) => v + 1);
          }}
        />
      )}
      {retiring && (
        <PositionRetirement
          key={retiring.id}
          source={retiring}
          organizationId={organizationId}
          demo={demo}
          locked={write.locked}
          available={
            !!data?.items.some(
              (p) =>
                p.id === retiring.id &&
                p.version === retiring.version &&
                p.canRetire &&
                !p.retirementBlocked,
            )
          }
          send={write.send}
          close={() => setRetiring(null)}
        />
      )}
      {form && (
        <PositionForm
          key={typeof form === "string" ? form : form.id}
          organizationId={organizationId}
          source={form === "new" ? null : form}
          units={data?.units ?? []}
          demo={demo}
          locked={write.locked}
          send={write.send}
          close={() => setForm(null)}
        />
      )}
      {data && !resource.failed && (
        <>
          {!form &&
            !retiring &&
            !rollout &&
            data.units.some((u) => u.canPropose) && (
              <Button
                className="justify-self-start"
                onClick={() => setForm("new")}
              >
                {t("ახალი პოზიცია", "New position")}
              </Button>
            )}
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(query.trim());
              setPage(1);
            }}
          >
            <Input
              label={t("პოზიციის ძიება", "Search positions")}
              value={query}
              maxLength={120}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Button type="submit" variant="secondary">
              {t("ძებნა", "Search")}
            </Button>
            {data.items.length >= 2 && (
              <Button
                type="button"
                variant={compareOpen ? "primary" : "secondary"}
                onClick={() => {
                  setCompareOpen((v) => !v);
                  if (!compareA && data.items[0]) setCompareA(data.items[0].id);
                  if (!compareB && data.items[1]) setCompareB(data.items[1].id);
                }}
              >
                {t("უფლებების შედარების მატრიცა", "Permission comparison matrix")}
              </Button>
            )}
          </form>
          {compareOpen && data.items.length >= 2 && (
            <Card>
              <h2 className="text-lg font-semibold mb-3">
                {t("პოზიციების უფლებების შედარება", "Position permission diff matrix")}
              </h2>
              <div className="grid gap-4 md:grid-cols-2 mb-4">
                <Select
                  label={t("საწყისი პოზიცია (A)", "Baseline position (A)")}
                  value={compareA || data.items[0].id}
                  onChange={(e) => setCompareA(e.target.value)}
                  options={data.items.map((item) => ({
                    value: item.id,
                    label: `${item.name} (v${item.revision})`,
                  }))}
                />
                <Select
                  label={t("შესადარებელი პოზიცია (B)", "Target position (B)")}
                  value={compareB || data.items[1].id}
                  onChange={(e) => setCompareB(e.target.value)}
                  options={data.items.map((item) => ({
                    value: item.id,
                    label: `${item.name} (v${item.revision})`,
                  }))}
                />
              </div>
              {(() => {
                const posA =
                  data.items.find((x) => x.id === compareA) ?? data.items[0];
                const posB =
                  data.items.find((x) => x.id === compareB) ?? data.items[1];
                const keyOf = (g: PositionGrant) => `${g.permission}:${g.scope}`;
                const setA = new Set(posA.grants.map(keyOf));
                const setB = new Set(posB.grants.map(keyOf));
                return (
                  <PositionComparison
                    comparison={{
                      sourceName: `${posA.name} (v${posA.revision})`,
                      destinationName: `${posB.name} (v${posB.revision})`,
                      added: posB.grants.filter((g) => !setA.has(keyOf(g))),
                      removed: posA.grants.filter((g) => !setB.has(keyOf(g))),
                      unchanged: posA.grants.filter((g) => setB.has(keyOf(g))),
                    }}
                  />
                );
              })()}
            </Card>
          )}
          <p>
            {t("ჩანაწერები", "Records")}: {data.total}
          </p>
          {!data.items.length && (
            <p>{t("პოზიციები ვერ მოიძებნა.", "No positions found.")}</p>
          )}
          {data.items.map((p) => (
            <Card key={p.id}>
              <h2 className="text-lg font-semibold break-words">{p.name}</h2>
              <p className="mb-3">
                {p.unitName} · {t("ვერსია", "Version")} {p.revision} ·{" "}
                {p.status === "active"
                  ? t("მოქმედი", "Active")
                  : t("გაუქმებული", "Retired")}
              </p>
              <details>
                <summary className="cursor-pointer mb-3">
                  {t("უფლებების ნახვა", "View permissions")}
                </summary>
                <PositionPermissions grants={p.grants} />
              </details>
              {p.canRollout && !form && !retiring && !rollout && (
                <Button
                  className="mt-3"
                  variant="secondary"
                  onClick={() => setRollout(p.id)}
                >
                  {t(
                    "წევრების გადაყვანა / მიმდინარეობა",
                    "Adopt revision / progress",
                  )}
                </Button>
              )}
              {p.canRevise && !form && !retiring && !rollout && (
                <Button
                  className="mt-3"
                  variant="secondary"
                  onClick={() => setForm(p)}
                >
                  {t("ახალი ვერსიის მოთხოვნა", "Propose revision")}
                </Button>
              )}
              {p.canRetire && !form && !retiring && !rollout && (
                <div className="mt-3">
                  <Button
                    variant="secondary"
                    disabled={p.retirementBlocked || write.locked}
                    onClick={() => setRetiring(p)}
                  >
                    {t("გამოყენებიდან ამოღება", "Retire position")}
                  </Button>
                  {p.retirementBlocked && (
                    <p className="text-sm">
                      {t(
                        "ჯერ მოაგვარეთ ამ პოზიციასთან დაკავშირებული წევრობები ან მიმდინარე მოთხოვნები.",
                        "Resolve memberships or pending changes for this position first.",
                      )}
                    </p>
                  )}
                </div>
              )}
            </Card>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              disabled={page === 1}
              onClick={() => setPage((v) => v - 1)}
            >
              {t("წინა", "Previous")}
            </Button>
            <span>{page}</span>
            <Button
              variant="secondary"
              disabled={page * 25 >= data.total}
              onClick={() => setPage((v) => v + 1)}
            >
              {t("შემდეგი", "Next")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
function PositionForm({
  organizationId,
  source,
  units,
  demo,
  locked,
  send,
  close,
}: {
  organizationId: string;
  source: PositionDefinition | null;
  units: PositionUnit[];
  demo: boolean;
  locked: boolean;
  send: (input: CollectiveWrite) => Promise<boolean>;
  close: () => void;
}) {
  const { language } = useConsolePreferences(),
    t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [permissionRevision, setPermissionRevision] = useState(0);
  const loadPermissions = useCallback(
    () => positionsApi.list(organizationId, "", 1, true),
    [organizationId],
  );
  const permissionsResource = useAsyncResource(
    JSON.stringify([organizationId, permissionRevision]),
    loadPermissions,
  );
  useEffect(() => {
    const refresh = () => setPermissionRevision((v) => v + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  const [unitId, setUnitId] = useState(
      source?.unitId ?? units.find((u) => u.canPropose)?.id ?? "",
    ),
    [name, setName] = useState(
      source ? `${source.name} (v${source.revision + 1})` : "",
    ),
    [grants, setGrants] = useState<PositionGrant[]>(
      source?.grants ?? [{ permission: "unit.read", scope: "unit" }],
    ),
    [reason, setReason] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const unit = units.find((u) => u.id === unitId),
    permissionUnit = permissionsResource.data?.units.find(
      (u) => u.id === unitId,
    ),
    permissionsReady = !!unit?.canPropose && !!permissionUnit?.canPropose,
    available = unit ? (permissionUnit?.grants ?? []) : [];
  const invalid = grants.some(
    (g) =>
      !available.some(
        (a) => a.permission === g.permission && a.scope === g.scope,
      ),
  );
  const permissions = [
    ...new Set([
      ...available.map((g) => g.permission),
      ...grants.map((g) => g.permission),
    ]),
  ];
  const dirty = !!name || !!reason || locked;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || locked || invalid || !confirmed || !permissionsReady) return;
    setBusy(true);
    setError("");
    try {
      if (!demo) await authApi.stepUp(password);
      setPassword("");
      await send({
        operation: "propose",
        organizationId,
        unitId,
        key: crypto.randomUUID(),
        kind: source ? "position_revision" : "position_create",
        parameters: {
          name: name.trim(),
          grants,
          ...(source
            ? { sourceId: source.id, sourceVersion: source.version }
            : {}),
        },
        reason: reason.trim(),
        deadline: new Date(Date.now() + 86400000).toISOString(),
      });
    } catch {
      setError(
        t("პაროლის დადასტურება ვერ მოხერხდა.", "Password confirmation failed."),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <h2 className="text-lg font-semibold">
          {source
            ? t("პოზიციის ახალი ვერსია", "New position version")
            : t("ახალი პოზიცია", "New position")}
        </h2>
        <p>
          {t(
            "აირჩიეთ მხოლოდ საჭირო უფლებები და მათი მოქმედების არეალი. მოქმედი ვერსიები ხელმისაწვდომი რჩება; წევრის ახალზე გადაყვანა ცალკე მტკიცდება.",
            "Choose only the required permissions and scope. Existing approved versions remain available; moving a member to the new version needs separate approval.",
          )}
        </p>
        {error && <p role="alert">{error}</p>}
        {permissionsResource.loading && (
          <p role="status">
            {t("უფლებები იტვირთება…", "Loading permissions…")}
          </p>
        )}
        {permissionsResource.failed && (
          <div role="alert">
            <p>
              {t(
                "უფლებები ვერ ჩაიტვირთა. შევსებული ველები შენარჩუნებულია.",
                "Permissions could not load. Your entered fields are preserved.",
              )}
            </p>
            <Button
              variant="secondary"
              disabled={busy || locked}
              onClick={() => setPermissionRevision((v) => v + 1)}
            >
              {t("ხელახლა ცდა", "Retry permissions")}
            </Button>
          </div>
        )}
        <fieldset disabled={busy || locked} className="space-y-4 min-w-0">
          <Select
            label={t("ერთეული", "Unit")}
            value={unitId}
            disabled={!!source}
            options={units
              .filter((u) => u.canPropose)
              .map((u) => ({ value: u.id, label: u.name }))}
            onChange={(e) => {
              setUnitId(e.target.value);
              setGrants([{ permission: "unit.read", scope: "unit" }]);
              setConfirmed(false);
            }}
          />
          <Input
            label={t("პოზიციის სახელი", "Position name")}
            value={name}
            required
            maxLength={120}
            onChange={(e) => {
              setName(e.target.value);
              setConfirmed(false);
            }}
          />
          {permissions.map((permission) => (
            <Select
              key={permission}
              label={positionPermissionLabel(permission, language)}
              value={
                grants.find((g) => g.permission === permission)?.scope ?? ""
              }
              options={[
                ...(permission === "unit.read"
                  ? []
                  : [{ value: "", label: t("არ მიენიჭოს", "Not granted") }]),
                ...available
                  .filter((g) => g.permission === permission)
                  .map((g) => ({
                    value: g.scope,
                    label:
                      g.scope === "unit"
                        ? t("მხოლოდ ეს ერთეული", "This unit only")
                        : t("ერთეული და ქვემდგომები", "Unit and descendants"),
                  })),
              ]}
              onChange={(e) => {
                const scope = e.target.value as PositionGrant["scope"] | "";
                setGrants((prev) => [
                  ...prev.filter((g) => g.permission !== permission),
                  ...(scope ? [{ permission, scope }] : []),
                ]);
                setConfirmed(false);
              }}
            />
          ))}
          {invalid && permissionsResource.data && (
            <p role="alert">
              {t(
                "ზოგი უფლების მინიჭება აღარ შეგიძლიათ. გადაამოწმეთ არჩევანი.",
                "Some permissions exceed your current authority. Review the selection.",
              )}
            </p>
          )}
          <Textarea
            label={t("ცვლილების მიზეზი", "Reason for change")}
            value={reason}
            minLength={3}
            maxLength={1000}
            required
            onChange={(e) => {
              setReason(e.target.value);
              setConfirmed(false);
            }}
          />
          {!demo && (
            <Input
              type="password"
              autoComplete="current-password"
              label={t("მიმდინარე პაროლი", "Current password")}
              value={password}
              required
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
          <label className="flex gap-3 items-start">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>
              {t(
                "გადავამოწმე უფლებები და მოქმედების არეალი. მოთხოვნა დამოუკიდებელ დამტკიცებაზე გაიგზავნება.",
                "I reviewed the permissions and scope. Submit this request for independent approval.",
              )}
            </span>
          </label>
          <div className="flex flex-wrap gap-3">
            <Button
              type="submit"
              disabled={
                !confirmed ||
                invalid ||
                !name.trim() ||
                reason.trim().length < 3 ||
                !permissionsReady
              }
            >
              {t("დამტკიცებაზე გაგზავნა", "Submit for approval")}
            </Button>
            <Button type="button" variant="secondary" onClick={close}>
              {t("გაუქმება", "Cancel")}
            </Button>
          </div>
        </fieldset>
      </form>
    </Card>
  );
}
