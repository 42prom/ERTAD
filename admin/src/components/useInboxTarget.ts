import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { InboxSource } from "../api/inbox";

/** Opaque navigation state stays out of URLs and never substitutes for domain authorization. */
export function useInboxTarget(
  source: InboxSource,
  org: string,
  open: (id: string) => void,
) {
  const location = useLocation(),
    navigate = useNavigate(),
    consumed = useRef("");
  useEffect(() => {
    const target = location.state?.inbox;
    if (
      !org ||
      target?.source !== source ||
      target.organizationId !== org ||
      typeof target.id !== "string" ||
      !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(target.id) ||
      consumed.current === location.key
    )
      return;
    consumed.current = location.key;
    open(target.id);
    navigate(location.pathname + location.search, {
      replace: true,
      state: null,
    });
  }, [source, org, open, location, navigate]);
}
