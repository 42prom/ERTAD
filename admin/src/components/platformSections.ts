export const platformSections = [
  {
    key: "overview",
    permission: "platform.read",
    ka: "სისტემის მდგომარეობა",
    en: "System overview",
  },
  {
    key: "network",
    permission: "platform.network.read",
    ka: "ქსელის დაცვა",
    en: "Network protection",
  },
  {
    key: "monitoring",
    permission: "platform.audit.read",
    ka: "უსაფრთხოების მონიტორინგი",
    en: "Security monitoring",
  },
  {
    key: "limits",
    permission: "platform.limits.read",
    ka: "უსაფრთხოების ლიმიტები",
    en: "Security limits",
  },
  {
    key: "sessions",
    permission: "platform.sessions.read",
    ka: "ვებ-სესიები",
    en: "Web sessions",
  },
  {key:'accounts',permission:'platform.accounts.read',ka:'ვებ-ანგარიშების დაცვა',en:'Web account protection'},
  {
    key: "policy",
    permission: "platform.policy.read",
    ka: "სესიების პოლიტიკა",
    en: "Session policy",
  },
  {
    key: "integrations",
    permission: "platform.integrations.read",
    ka: "ინტეგრაციები",
    en: "Integrations",
  },
  {
    key: "providers",
    permission: "platform.providers.read",
    ka: "პროვაიდერების მართვა",
    en: "Provider settings",
  },
  {
    key: "audit",
    permission: "platform.audit.read",
    ka: "ტექნიკური ჟურნალი",
    en: "Technical audit",
  },
  { key: "email", permission: "platform.providers.read", ka: "ელფოსტის სერვისი", en: "Email service" },
  {
    key: "verification",
    permission: "platform.verification.read",
    ka: "ბიომეტრია და მოწყობილობები",
    en: "Biometrics & devices",
  },
] as const;
export type PlatformSection = (typeof platformSections)[number]["key"];
export const platformPath = (key: PlatformSection) =>
  key === "overview" ? "/platform" : `/platform/${key}`;
