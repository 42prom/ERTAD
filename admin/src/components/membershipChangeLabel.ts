export function membershipChangeLabel(
  kind: string | undefined,
  language: string,
  fallback: string,
) {
  const labels: Record<string, [string, string]> = {
    transfer: ["წევრობის გადაყვანა", "Membership transfer"],
    revoke: ["წევრობის შეწყვეტა", "End membership"],
    suspend: ["წევრობის შეჩერება", "Suspend membership"],
    resume: ["წევრობის აღდგენა", "Resume membership"],
    revision: ["პოზიციის ახალ ვერსიაზე გადაყვანა", "Adopt position revision"],
    admission: ["ჯგუფში გაწევრიანების მოთხოვნა", "Group admission request"],
  };
  return kind && labels[kind]
    ? labels[kind][language === "ka" ? 0 : 1]
    : fallback;
}
