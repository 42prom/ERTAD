import { useCallback, useEffect, useRef, useState } from "react";

/** Key every scope/filter/version; pass a memoized loader. Old-scope data is never exposed while loading. */
export function useAsyncResource<T>(key: string, load: () => Promise<T>) {
  const generation = useRef(0);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    load: typeof load;
    data: T | null;
    failed: boolean;
    cause?: unknown;
  } | null>(null);
  useEffect(() => {
    let live = true;
    const current = ++generation.current;
    Promise.resolve()
      .then(load)
      .then(
        (data) => {
          if (live && current === generation.current)
            setSnapshot({ key, load, data, failed: false });
        },
        (cause: unknown) => {
          if (live && current === generation.current)
            setSnapshot({ key, load, data: null, failed: true, cause });
        },
      );
    return () => {
      live = false;
    };
  }, [key, load]);
  const current =
    snapshot?.key === key && snapshot.load === load ? snapshot : null;
  // Used after denied/uncertain mutations. Do not let an older read disclose data again.
  const clear = useCallback(() => {
    generation.current++;
    setSnapshot({ key, load, data: null, failed: false });
  }, [key, load]);
  return {
    data: current?.data ?? null,
    loading: current === null,
    failed: current?.failed ?? false,
    cause: current?.cause,
    clear,
  };
}
