import { useEffect, useRef } from "react";

export type RealtimeTopic =
  | "workspace"
  | "inbox"
  | "channel"
  | "work"
  | "event"
  | "decision"
  | "review"
  | "unit"
  | "collective";

export interface RealtimeSignal {
  topic: RealtimeTopic;
  organizationId?: string;
  channelId?: string;
  at: string;
}

export const REALTIME_EVENT = "ertad-realtime";

export function useRealtimeStream(
  enabled: boolean,
  onSignal: (signal: RealtimeSignal) => void,
) {
  const callbackRef = useRef(onSignal);
  useEffect(() => {
    callbackRef.current = onSignal;
  }, [onSignal]);

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;

    let live = true;
    let source: EventSource | null = null;
    let reconnectTimer: number | null = null;
    let debounceTimer: number | null = null;
    let reconnectDelay = 1500;
    const queuedTopics = new Map<string, RealtimeSignal>();

    const flush = () => {
      debounceTimer = null;
      if (!live) return;
      for (const signal of queuedTopics.values()) {
        callbackRef.current(signal);
        window.dispatchEvent(
          new CustomEvent<RealtimeSignal>(REALTIME_EVENT, { detail: signal }),
        );
      }
      queuedTopics.clear();
    };

    const connect = () => {
      if (!live) return;
      try {
        source = new EventSource("/api/v1/admin/stream", {
          withCredentials: true,
        });
      } catch {
        return;
      }

      source.addEventListener("ready", () => {
        reconnectDelay = 1500;
      });

      source.addEventListener("invalidate", (event) => {
        if (!live) return;
        try {
          const parsed = JSON.parse(
            (event as MessageEvent<string>).data,
          ) as RealtimeSignal;
          if (!parsed?.topic) return;
          const key = `${parsed.topic}:${parsed.organizationId ?? ""}:${parsed.channelId ?? ""}`;
          queuedTopics.set(key, parsed);
          if (debounceTimer === null) {
            debounceTimer = window.setTimeout(flush, 120);
          }
        } catch {
          // Ignore malformed event payloads safely.
        }
      });

      source.addEventListener("session_ended", () => {
        live = false;
        source?.close();
        source = null;
      });

      source.onerror = () => {
        source?.close();
        source = null;
        if (!live) return;
        const delay = reconnectDelay;
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    const startTimer = window.setTimeout(connect, 50);

    return () => {
      live = false;
      window.clearTimeout(startTimer);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      source?.close();
    };
  }, [enabled]);
}

