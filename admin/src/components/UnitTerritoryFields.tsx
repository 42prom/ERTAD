import { useEffect, useState } from "react";
import { territoryTypeLabel, unitApi, type GeographicCatalogue, type OperationalType } from "../api/units";
import Button from "./ui/Button";
import Select from "./ui/Select";

export interface TerritoryChoice {
  type: OperationalType;
  area: string;
}

export default function UnitTerritoryFields({ organizationId, allowedTypes, parentArea, value, onChange, ka }: {
  organizationId: string;
  allowedTypes: OperationalType[];
  parentArea: string | null;
  value: TerritoryChoice;
  onChange: (value: TerritoryChoice) => void;
  ka: boolean;
}) {
  const [catalogue, setCatalogue] = useState<GeographicCatalogue | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const needsCatalogue = value.type !== "unclassified";
  useEffect(() => {
    if (!needsCatalogue) return;
    let live = true;
    void unitApi.geography(organizationId).then((data) => {
      if (live) { setCatalogue(data); setFailed(false); }
    }).catch(() => {
      if (live) { setCatalogue(null); setFailed(true); }
    });
    return () => { live = false; };
  }, [organizationId, needsCatalogue, revision]);
  const items = catalogue?.items.filter((area) => value.type === "region"
    ? area.kind === "region"
    : value.type === "locality"
      ? area.parentId === parentArea && area.kind !== "region"
      : area.id === parentArea) ?? [];
  const label = (en: string, ge: string) => ka ? ge : en;
  return <>
    <Select label={label("Unit type", "ერთეულის ტიპი")}
      value={value.type}
      options={allowedTypes.map((type) => ({ value: type, label: territoryTypeLabel(type, ka) }))}
      onChange={(event) => {
        const type = event.target.value as OperationalType;
        onChange({ type, area: type === "group" || type === "team" ? parentArea ?? "" : "" });
      }} />
    {needsCatalogue && (failed ? <div role="alert">
      <p>{label("Could not load territories. Check your access and retry.", "ტერიტორიები ვერ ჩაიტვირთა. შეამოწმეთ წვდომა და სცადეთ ხელახლა.")}</p>
      <Button type="button" variant="ghost" onClick={() => { setFailed(false); setRevision((v) => v + 1); }}>
        {label("Retry territories", "ტერიტორიების ხელახლა ჩატვირთვა")}
      </Button>
    </div> : !catalogue ? <p role="status">{label("Loading territories…", "ტერიტორიები იტვირთება…")}</p> : <>
      <Select label={label("Territory", "ტერიტორია")} required
        value={value.area}
        options={[{ value: "", label: label("Choose territory", "აირჩიეთ ტერიტორია") },
          ...items.map((area) => ({ value: area.id, label: ka ? area.nameKa : area.nameEn }))]}
        onChange={(event) => onChange({ ...value, area: event.target.value })} />
      {items.length === 0 && <p role="status">{label(
        "No verified subdivisions are available for this parent yet.",
        "ამ ზედა ერთეულისთვის გადამოწმებული ქვედანაყოფები ჯერ ხელმისაწვდომი არ არის.")}</p>}
      {catalogue.additionalReferencesPending && <p className="text-xs text-[var(--muted)]">{label(
        "Initial territorial coverage; additional de jure territorial references are under review.",
        "საწყისი ტერიტორიული დაფარვა; დამატებითი დე იურე ტერიტორიული ერთეულები მოწმდება.")}</p>}
    </>)}
  </>;
}
