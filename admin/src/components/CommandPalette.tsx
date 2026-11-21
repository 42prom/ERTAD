import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Search, X } from "lucide-react";
import type { WorkspaceUrgentItem } from "../api/workspace";

export interface CommandPaletteNavItem {
  path: string;
  label: string;
  group: string;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  language: "ka" | "en";
  items: CommandPaletteNavItem[];
  urgent: WorkspaceUrgentItem[];
  onToggleTheme: () => void;
  onToggleLanguage: () => void;
  theme: "light" | "dark";
}

export default function CommandPalette({
  open,
  onClose,
  language,
  items,
  urgent,
  onToggleTheme,
  onToggleLanguage,
  theme,
}: CommandPaletteProps) {
  const ka = language === "ka";
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 10);
    return () => window.clearTimeout(id);
  }, [open]);

  const entries = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list: {
      id: string;
      label: string;
      meta: string;
      run: () => void;
    }[] = [
      ...items.map((item) => ({
        id: `nav:${item.path}`,
        label: item.label,
        meta: item.group,
        run: () => {
          navigate(item.path);
          onClose();
        },
      })),
      ...urgent.map((u) => ({
        id: `urgent:${u.kind}:${u.id}`,
        label: u.title,
        meta: ka
          ? u.kind === "task"
            ? "დავალება"
            : u.kind === "event"
              ? "ღონისძიება"
              : "პული"
          : u.kind,
        run: () => {
          navigate(u.route, {
            state: {
              inbox: {
                source: u.kind === "task" ? "work" : u.kind,
                organizationId: u.organizationId,
                id: u.id,
              },
            },
          });
          onClose();
        },
      })),
      {
        id: "action:account",
        label: ka ? "ანგარიშის უსაფრთხოება" : "Account security",
        meta: ka ? "პარამეტრი" : "Settings",
        run: () => {
          navigate("/account");
          onClose();
        },
      },
      {
        id: "action:theme",
        label:
          theme === "dark"
            ? ka
              ? "ნათელი თემის ჩართვა"
              : "Switch to light theme"
            : ka
              ? "მუქი თემის ჩართვა"
              : "Switch to dark theme",
        meta: ka ? "იერსახე" : "Appearance",
        run: () => {
          onToggleTheme();
          onClose();
        },
      },
      {
        id: "action:language",
        label: ka ? "Switch language to English (EN)" : "ენის შეცვლა ქართულზე (KA)",
        meta: ka ? "ენა" : "Language",
        run: () => {
          onToggleLanguage();
          onClose();
        },
      },
    ];
    if (!q) return list;
    return list.filter(
      (entry) =>
        entry.label.toLowerCase().includes(q) ||
        entry.meta.toLowerCase().includes(q),
    );
  }, [items, urgent, query, ka, navigate, onClose, theme, onToggleTheme, onToggleLanguage]);

  const safeIndex =
    entries.length === 0 ? -1 : Math.min(selectedIndex, entries.length - 1);

  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" && entries.length > 0) {
      event.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % entries.length);
      return;
    }
    if (event.key === "ArrowUp" && entries.length > 0) {
      event.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + entries.length) % entries.length);
      return;
    }
    if (event.key === "Enter" && safeIndex >= 0 && entries[safeIndex]) {
      event.preventDefault();
      entries[safeIndex].run();
    }
  };

  return (
    <div
      className="command-palette-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={ka ? "სწრაფი ნავიგაცია და ძიება" : "Quick command palette"}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="command-palette-panel">
        <div className="command-palette-input-row">
          <Search size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder={
              ka
                ? "მოძებნე მოდული, მოქმედება ან მოთხოვნა…"
                : "Jump to a module, urgent item, or action…"
            }
            aria-label={ka ? "სწრაფი ძიება" : "Quick search"}
          />
          <button
            type="button"
            className="command-palette-close"
            onClick={onClose}
            aria-label={ka ? "დახურვა" : "Close"}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <ul className="command-palette-list" role="listbox">
          {entries.length === 0 ? (
            <li className="command-palette-empty">
              {ka ? "შედეგი ვერ მოიძებნა" : "No matching commands"}
            </li>
          ) : (
            entries.map((entry, idx) => (
              <li key={entry.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={idx === safeIndex}
                  className={idx === safeIndex ? "active" : undefined}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  onClick={entry.run}
                >
                  <span>{entry.label}</span>
                  <small>{entry.meta}</small>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
