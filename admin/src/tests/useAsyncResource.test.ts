import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useAsyncResource } from "../components/useAsyncResource";

function pending<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
it("hides old scope before the next fetch completes and ignores late responses", async () => {
  const first = pending<string>(),
    second = pending<string>();
  const loadA = vi.fn(() => first.promise),
    loadB = vi.fn(() => second.promise);
  const view = renderHook(({ key, load }) => useAsyncResource(key, load), {
    initialProps: { key: "org-a", load: loadA },
  });
  await waitFor(() => expect(loadA).toHaveBeenCalledTimes(1));
  view.rerender({ key: "org-b", load: loadB });
  expect(view.result.current.data).toBeNull();
  expect(view.result.current.loading).toBe(true);
  await act(async () => {
    second.resolve("B");
  });
  expect(view.result.current.data).toBe("B");
  await act(async () => {
    first.resolve("A");
  });
  expect(view.result.current.data).toBe("B");
});
it("refresh immediately hides previous data and a denied refresh cannot retain it", async () => {
  const next = pending<string>();
  const load = vi
    .fn()
    .mockResolvedValueOnce("visible")
    .mockReturnValueOnce(next.promise);
  const view = renderHook(({ key }) => useAsyncResource<string>(key, load), {
    initialProps: { key: "v1" },
  });
  await waitFor(() => expect(view.result.current.data).toBe("visible"));
  view.rerender({ key: "v2" });
  expect(view.result.current.data).toBeNull();
  await act(async () => {
    next.reject({ response: { status: 403 } });
  });
  expect(view.result.current.data).toBeNull();
  expect(view.result.current.failed).toBe(true);
  expect(view.result.current.loading).toBe(false);
});
it("clearing after a failed mutation invalidates an in-flight read", async () => {
  const next = pending<string>(),
    load = vi.fn(() => next.promise);
  const view = renderHook(() => useAsyncResource("one", load));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  act(() => view.result.current.clear());
  await act(async () => {
    next.resolve("stale");
  });
  expect(view.result.current.data).toBeNull();
  expect(view.result.current.loading).toBe(false);
});
it("synchronous loader failures and unmounted requests cannot escape the resource boundary", async () => {
  const load = () => {
    throw Error("unavailable");
  };
  const view = renderHook(() => useAsyncResource("one", load));
  await waitFor(() => expect(view.result.current.failed).toBe(true));
  const next = pending<string>(),
    pendingLoad = () => next.promise;
  const second = renderHook(() => useAsyncResource("two", pendingLoad));
  second.unmount();
  await act(async () => next.reject(Error("late")));
  expect(view.result.current.data).toBeNull();
});
