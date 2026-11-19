import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { collectiveApi } from "../api/collective";
import { useCollectiveWrite } from "../components/CollectiveWrite";
vi.mock("../api/collective", () => ({ collectiveApi: { write: vi.fn() } }));
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
const updated = vi.fn();
function Harness() {
  const { send, locked, feedback } = useCollectiveWrite(false, updated);
  return (
    <>
      {feedback}
      <button
        disabled={locked}
        onClick={() =>
          void send({
            operation: "pledge",
            organizationId: "organization",
            workId: "work",
            key: "immutable-command",
            amount: "1250",
          })
        }
      >
        Pledge
      </button>
    </>
  );
}
beforeEach(() => vi.clearAllMocks());
it("retries the immutable command after an uncertain response and blocks a duplicate new write", async () => {
  vi.mocked(collectiveApi.write)
    .mockRejectedValueOnce(new Error("Connection lost after commit"))
    .mockResolvedValueOnce({ id: "pledge" });
  render(<Harness />);
  fireEvent.click(screen.getByText("Pledge"));
  await screen.findByText("Retry same request");
  expect(screen.getByText("Pledge")).toBeDisabled();
  expect(updated).not.toHaveBeenCalled();
  const original = structuredClone(
    vi.mocked(collectiveApi.write).mock.calls[0][0],
  );
  fireEvent.click(screen.getByText("Retry same request"));
  await waitFor(() => expect(updated).toHaveBeenCalledTimes(1));
  expect(vi.mocked(collectiveApi.write).mock.calls[1][0]).toEqual(original);
  expect(screen.getByText("Pledge")).not.toBeDisabled();
});
