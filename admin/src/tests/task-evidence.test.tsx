import { beforeEach, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import TaskEvidence from "../components/TaskEvidence";
import { evidenceApi } from "../api/evidence";
import { materialFilesApi } from "../api/materialFiles";
vi.mock("../api/materialFiles", () => ({
  materialFilesApi: {
    list: vi.fn(),
    upload: vi.fn(),
    download: vi.fn(),
    remove: vi.fn(),
  },
}));
vi.mock("../api/evidence", () => ({
  evidenceApi: { list: vi.fn(), upload: vi.fn(), download: vi.fn() },
}));
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
const scope = { organizationId: "org", workId: "task", version: 1 };
const row = {
  id: "report",
  bytes: 12,
  createdAt: "2026-10-21T12:00:00Z",
  expiresAt: "2027-01-19T12:00:00Z",
  mine: true,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(evidenceApi.list).mockResolvedValue({ canUpload: true, items: [] });
  vi.mocked(evidenceApi.upload).mockResolvedValue({ id: "report" });
});
const choose = async (
  file = new File(["Synthetic report"], "report.txt", { type: "text/plain" }),
) =>
  fireEvent.change(await screen.findByLabelText("Text report"), {
    target: { files: [file] },
  });
it("shares material controls according to server authority without using private report endpoints", async () => {
  vi.mocked(materialFilesApi.list).mockResolvedValue({
    canUpload: false,
    canRemove: false,
    items: [{ ...row, mediaType: "application/pdf" }],
  });
  render(<TaskEvidence {...scope} material />);
  expect(
    await screen.findByRole("button", { name: "Download file" }),
  ).toBeVisible();
  expect(screen.queryByLabelText("Photo or PDF")).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove file" })).toBeNull();
  expect(evidenceApi.list).not.toHaveBeenCalled();
  expect(
    screen.getByText(/text selection, forms and links are lost/),
  ).toBeVisible();
});
it("retries a material upload with its original file and key", async () => {
  vi.mocked(materialFilesApi.list).mockResolvedValue({
    canUpload: true,
    canRemove: true,
    items: [],
  });
  vi.mocked(materialFilesApi.upload)
    .mockRejectedValueOnce({ response: { status: 503 } })
    .mockResolvedValue({ id: "file" });
  render(<TaskEvidence {...scope} material />);
  const file = new File(["synthetic"], "synthetic.pdf", {
    type: "application/pdf",
  });
  fireEvent.change(await screen.findByLabelText("Photo or PDF"), {
    target: { files: [file] },
  });
  fireEvent.click(screen.getByRole("button", { name: "Upload file" }));
  const retry = await screen.findByRole("button", {
    name: "Retry same upload",
  });
  await waitFor(() => expect(retry).toBeEnabled());
  fireEvent.click(retry);
  await screen.findByText("File uploaded.");
  expect(vi.mocked(materialFilesApi.upload).mock.calls[1]).toEqual(
    vi.mocked(materialFilesApi.upload).mock.calls[0],
  );
  expect(evidenceApi.upload).not.toHaveBeenCalled();
});
it("rejects unsupported or oversized shared materials before submitting", async () => {
  vi.mocked(materialFilesApi.list).mockResolvedValue({
    canUpload: true,
    items: [],
  });
  render(<TaskEvidence {...scope} material />);
  const input = await screen.findByLabelText("Photo or PDF");
  for (const file of [
    new File(["x"], "x.svg"),
    new File([new Uint8Array(5242881)], "x.png"),
  ]) {
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose PNG/JPEG or PDF up to 5 MiB.",
    );
  }
  expect(materialFilesApi.upload).not.toHaveBeenCalled();
});
it("requires confirmation before removal and hides stale controls on denial", async () => {
  vi.mocked(materialFilesApi.list).mockResolvedValue({
    canUpload: true,
    canRemove: true,
    items: [{ ...row, mediaType: "image/png" }],
  });
  vi.mocked(materialFilesApi.remove).mockRejectedValue({
    response: { status: 403 },
  });
  const confirm = vi
    .spyOn(window, "confirm")
    .mockReturnValueOnce(false)
    .mockReturnValue(true);
  render(<TaskEvidence {...scope} material />);
  const remove = await screen.findByRole("button", { name: "Remove file" });
  fireEvent.click(remove);
  expect(materialFilesApi.remove).not.toHaveBeenCalled();
  fireEvent.click(remove);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Removal was not confirmed",
  );
  expect(screen.queryByRole("button", { name: "Download file" })).toBeNull();
  confirm.mockRestore();
});
it("shows report controls only when the server allows upload", async () => {
  vi.mocked(evidenceApi.list).mockResolvedValue({
    canUpload: false,
    items: [row],
  });
  render(<TaskEvidence {...scope} />);
  expect(
    await screen.findByRole("button", { name: "Download report" }),
  ).toBeVisible();
  expect(screen.queryByLabelText("Text report")).toBeNull();
  expect(evidenceApi.download).not.toHaveBeenCalled();
});
it("rejects unsupported and oversized files before upload", async () => {
  render(<TaskEvidence {...scope} />);
  await choose(new File(["x"], "report.pdf"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Choose a .txt file",
  );
  await choose(new File([new Uint8Array(65537)], "report.txt"));
  expect(evidenceApi.upload).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Upload report" })).toBeNull();
});
it("retries uncertain storage responses with identical key and immutable file", async () => {
  vi.mocked(evidenceApi.upload)
    .mockRejectedValueOnce(new Error("lost response"))
    .mockResolvedValue({ id: "report" });
  render(<TaskEvidence {...scope} />);
  await choose();
  fireEvent.click(screen.getByRole("button", { name: "Upload report" }));
  const retry = await screen.findByRole("button", {
    name: "Retry same upload",
  });
  await waitFor(() => expect(retry).toBeEnabled());
  fireEvent.click(retry);
  await screen.findByText("Report uploaded.");
  expect(vi.mocked(evidenceApi.upload).mock.calls[1]).toEqual(
    vi.mocked(evidenceApi.upload).mock.calls[0],
  );
  expect(
    screen.queryByRole("button", { name: "Retry same upload" }),
  ).toBeNull();
});
it("clears report controls when download authority is revoked", async () => {
  vi.mocked(evidenceApi.list).mockResolvedValue({
    canUpload: true,
    items: [row],
  });
  vi.mocked(evidenceApi.download).mockRejectedValue({
    response: { status: 403 },
  });
  render(<TaskEvidence {...scope} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Download report" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Download failed or access was revoked.",
  );
  expect(screen.queryByRole("button", { name: "Download report" })).toBeNull();
});
it("ignores late responses after the task changes", async () => {
  let resolve!: (value: { canUpload: boolean; items: (typeof row)[] }) => void;
  vi.mocked(evidenceApi.list)
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValue({ canUpload: false, items: [] });
  const view = render(<TaskEvidence {...scope} />);
  view.rerender(<TaskEvidence {...scope} workId="other" />);
  await screen.findByText("No reports yet.");
  await act(async () => resolve({ canUpload: true, items: [row] }));
  expect(screen.queryByRole("button", { name: "Download report" })).toBeNull();
});
it("does not create a download after unmount", async () => {
  let resolve!: (value: Blob) => void;
  vi.mocked(evidenceApi.list).mockResolvedValue({
    canUpload: false,
    items: [row],
  });
  vi.mocked(evidenceApi.download).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const view = render(<TaskEvidence {...scope} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Download report" }),
  );
  view.unmount();
  await act(async () => resolve(new Blob(["Synthetic"])));
});
