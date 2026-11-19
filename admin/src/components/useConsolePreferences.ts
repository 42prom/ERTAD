import { createContext, useContext } from "react";
export type Language = "ka" | "en";
export type Theme = "system" | "light" | "dark";
export const ConsolePreferencesContext = createContext({
  language: "ka" as Language,
  theme: "system" as Theme,
  setLanguage: (_value: Language) => {},
  setTheme: (_value: Theme) => {},
});
export const useConsolePreferences = () =>
  useContext(ConsolePreferencesContext);
