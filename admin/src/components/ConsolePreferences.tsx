import {
  ConsolePreferencesContext,
  useConsolePreferences,
} from "./useConsolePreferences";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { Sun, Moon, Monitor } from "lucide-react";
type Language = "ka" | "en";
type Theme = "system" | "light" | "dark";
function saved(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function ConsolePreferencesProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [language, setLanguage] = useState<Language>(() =>
    saved("ertad.console.language") === "en" ? "en" : "ka",
  );
  const [theme, setTheme] = useState<Theme>(() => {
    const value = saved("ertad.console.theme");
    return value === "light" || value === "dark" ? value : "system";
  });
  useLayoutEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.family = "web";
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.lang = language;
    };
    apply();
    media.addEventListener("change", apply);
    try {
      localStorage.setItem("ertad.console.language", language);
      localStorage.setItem("ertad.console.theme", theme);
    } catch {
      /* Preferences remain usable in memory. */
    }
    return () => media.removeEventListener("change", apply);
  }, [language, theme]);
  return (
    <ConsolePreferencesContext.Provider
      value={{ language, theme, setLanguage, setTheme }}
    >
      {children}
    </ConsolePreferencesContext.Provider>
  );
}
export default function ConsolePreferences() {
  const { language, theme, setTheme } = useConsolePreferences();
  return (
    <div
      className="console-preferences"
      role="group"
      aria-label={language === "ka" ? "გარეგნობა" : "Appearance"}
    >
      {(
        [
          {
            value: "light",
            label: language === "ka" ? "დღე" : "Light",
            icon: Sun,
          },
          {
            value: "dark",
            label: language === "ka" ? "ღამე" : "Dark",
            icon: Moon,
          },
          {
            value: "system",
            label: language === "ka" ? "სისტემური" : "System",
            icon: Monitor,
          },
        ] as const
      ).map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          aria-label={label}
          title={label}
          aria-pressed={theme === value}
          onClick={() => setTheme(value)}
        >
          <Icon size={17} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
