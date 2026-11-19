import { useAsyncResource } from "./useAsyncResource";
import { useEffect, useRef, useState } from "react";
import {
  platformApi,
  type PlatformIntegrations as Inventory,
  type IntegrationCheck,
} from "../api/platform";
import { useConsolePreferences } from "./useConsolePreferences";
import Card from "./ui/Card";
import Button from "./ui/Button";
import Select from "./ui/Select";

export default function PlatformIntegrations({
  canTest,
  onConfigure,
  refreshRevision = 0,
}: {
  canTest: boolean;
  onConfigure?: () => void;
  refreshRevision?: number;
}) {
  const { language } = useConsolePreferences(),
    ka = language === "ka";
  const t = (ge: string, en: string) => (ka ? ge : en);
  const [category, setCategory] = useState("all"),
    [revision, setRevision] = useState(0);
  const resourceKey = JSON.stringify([revision, refreshRevision]);
  const resource = useAsyncResource<Inventory>(
    resourceKey,
    platformApi.integrations,
  );
  const [probe, setProbe] = useState<{
    key: string;
    results: Record<string, IntegrationCheck>;
    pending: string | null;
    failed: boolean;
  } | null>(null);
  const activeProbe = probe?.key === resourceKey ? probe : null;
  const results = activeProbe?.results ?? {};
  const pending = activeProbe?.pending ?? null;
  const error = resource.failed || !!activeProbe?.failed;
  const loading = resource.loading;
  const inventory = error ? null : resource.data;
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    return () => {
      generation.current++;
    };
  }, [resourceKey]);
  const names: Record<string, string> = {
    postgres: t("მონაცემთა ბაზა", "Database"),
    redis: t("ქეში", "Cache"),
    storage: t("ფაილების საცავი", "File storage"),
    document: t("დოკუმენტის შემოწმება / NFC", "Document verification / NFC"),
    liveness: t("ცოცხალი ადამიანის შემოწმება", "Liveness / PAD"),
    face_match: t("სახის შედარება", "Face match"),
    android_integrity: "Android integrity",
    apple_attest: "Apple App Attest",
    push: t("მობილური შეტყობინებები", "Mobile notifications"),
    shield: t(
      "გარე Shield / ქსელური რეაგირება",
      "External Shield / network response",
    ),
    audit_checkpoint: t("აუდიტის გარე დამოწმება", "External audit checkpoint"),
  };
  const categories = [
    ["all", t("ყველა", "All")],
    ["infrastructure", t("ინფრასტრუქტურა", "Infrastructure")],
    ["identity", t("იდენტიფიკაცია", "Identity")],
    ["device", t("მოწყობილობები", "Devices")],
    ["delivery", t("შეტყობინებები", "Delivery")],
    ["security", t("უსაფრთხოება", "Security")],
  ];
  const blockers: Record<string, string> = {
    runtime_binding_missing: t(
      "გაშვებულ სერვერში კავშირი არ არის განსაზღვრული.",
      "No connection is defined in the running server.",
    ),
    mobile_contract_pending: t(
      "მობილურის რეგისტრაციასა და წვდომასთან დაკავშირება დასასრულებელია.",
      "Enrollment and mobile access integration remains incomplete.",
    ),
    pad_not_implemented: t(
      "სახის არსებობა ცოცხალი ადამიანის სანდო შემოწმებას არ უდრის; PAD დასასრულებელია.",
      "Face presence is not reliable liveness evidence; PAD remains incomplete.",
    ),
    provider_acceptance_pending: t(
      "პროვაიდერის ადაპტაცია და სრული შემოწმება დასასრულებელია.",
      "Provider adaptation and acceptance remain incomplete.",
    ),
    member_delivery_pending: t(
      "წევრების შეტყობინებების მიწოდება ჯერ არ არის გააქტიურებული.",
      "Member notification delivery is not activated.",
    ),
    response_policy_pending: t(
      "უსაფრთხო რეაგირების უფლებები და პოლიტიკა დასამატებელია.",
      "Response permissions and policy remain to be implemented.",
    ),
    external_checkpoint_pending: t(
      "გარე ხელმოწერილი აუდიტის დამოწმება ჯერ არ არის გააქტიურებული.",
      "External signed checkpoints are not activated.",
    ),
  };
  const items =
    inventory?.items.filter(
      (i) => category === "all" || i.category === category,
    ) ?? [];
  const date = (value: string) =>
    new Date(value).toLocaleString(ka ? "ka-GE" : "en-GB", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  return (
    <div className="space-y-4">
      {onConfigure && <Button variant="secondary" onClick={onConfigure}>{t("პროვაიდერის პარამეტრების შეცვლა","Configure provider")}</Button>}
      <Card>
        <h2>
          {t("ინტეგრაციები და პროვაიდერები", "Integrations and providers")}
        </h2>
        <p>
          {t(
            "კავშირის შემოწმება აჩვენებს სერვისის ხელმისაწვდომობას. იგი პიროვნების, დოკუმენტის ან მოწყობილობის უსაფრთხოებას არ ადასტურებს.",
            "A connection check shows service availability. It does not verify a person's identity, document or device security.",
          )}
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label={t("კატეგორია", "Category")}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            options={categories.map(([value, label]) => ({ value, label }))}
          />
          <Button
            variant="secondary"
            disabled={loading || !!pending}
            onClick={() => setRevision((v) => v + 1)}
          >
            {t("სიის განახლება", "Refresh inventory")}
          </Button>
        </div>
        {loading && <p role="status">{t("იტვირთება…", "Loading…")}</p>}
        {error && (
          <p role="alert">
            {t(
              "მონაცემები ვერ ჩაიტვირთა ან წვდომა აღარ გაქვთ. სცადეთ განახლება.",
              "Data could not be loaded or access is no longer available. Refresh to retry.",
            )}
          </p>
        )}
        {inventory && (
          <p>
            {t("ჩანაწერები: ", "Entries: ")}
            {items.length}
          </p>
        )}
      </Card>
      {!loading && !error && inventory && items.length === 0 && (
        <Card>
          {t(
            "ამ კატეგორიაში ინტეგრაცია არ მოიძებნა.",
            "No integrations in this category.",
          )}
        </Card>
      )}
      {!error &&
        items.map((item) => (
          <Card key={item.id}>
            <h3 className="font-semibold">{names[item.id] ?? item.id}</h3>
            <dl className="grid gap-3 my-3 sm:grid-cols-2">
              <div>
                <dt>{t("ჩართულობა", "Activation")}</dt>
                <dd>
                  {item.active
                    ? t("ჩართულია", "Active")
                    : t("არ არის ჩართული", "Not activated")}
                </dd>
              </div>
              <div>
                <dt>{t("კონფიგურაცია", "Configuration")}</dt>
                <dd>
                  {item.configuration === "loaded"
                    ? t(
                        "გაშვებული სერვერიდან ჩატვირთულია",
                        "Loaded by running server",
                      )
                    : item.configuration === "missing"
                      ? t("არ არის განსაზღვრული", "Missing")
                      : t(
                          "მოქმედ API-ში არ იტვირთება",
                          "Not loaded by active API",
                        )}
                </dd>
              </div>
            </dl>
            {item.blocker && (
              <p>
                {blockers[item.blocker] ??
                  t(
                    "ადაპტაცია დასასრულებელია.",
                    "Adaptation remains incomplete.",
                  )}
              </p>
            )}
            {item.assurance === "not_verified" && (
              <p>
                {t(
                  "ERTAD-ში სრული შემოწმება გავლილი არ აქვს.",
                  "Not accepted through an ERTAD end-to-end verification.",
                )}
              </p>
            )}
            {item.diagnostic === "available" && (
              <>
                <p role="status">
                  {results[item.id] ? (
                    <>
                      {results[item.id].status === "ready"
                        ? t("ხელმისაწვდომია", "Available")
                        : t("მიუწვდომელია", "Unavailable")}{" "}
                      · {date(results[item.id].checkedAt)}
                    </>
                  ) : (
                    t(
                      "ამ ხედში კავშირი ჯერ არ შემოწმებულა.",
                      "Connection has not been checked in this view.",
                    )
                  )}
                </p>
                {canTest && (
                  <Button
                    variant="secondary"
                    disabled={!!pending}
                    onClick={async () => {
                      const current = generation.current;
                      setProbe({
                        key: resourceKey,
                        results,
                        pending: item.id,
                        failed: false,
                      });
                      try {
                        const result = await platformApi.checkIntegration(
                          item.id,
                        );
                        if (current === generation.current)
                          setProbe({
                            key: resourceKey,
                            results: { ...results, [item.id]: result },
                            pending: null,
                            failed: false,
                          });
                      } catch {
                        if (current === generation.current) {
                          resource.clear();
                          setProbe({
                            key: resourceKey,
                            results: {},
                            pending: null,
                            failed: true,
                          });
                        }
                      }
                    }}
                  >
                    {pending === item.id
                      ? t("მოწმდება…", "Checking…")
                      : t("კავშირის შემოწმება", "Check connection")}
                  </Button>
                )}
              </>
            )}
          </Card>
        ))}
    </div>
  );
}
