// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentUpload } from "./DocumentUpload";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("attaches the document only after indexing succeeds", async () => {
  const uploaded = vi.fn();
  const fetcher = vi.fn(async () =>
    Response.json({ name: "notes.md", chunks: 2 }),
  );
  vi.stubGlobal("fetch", fetcher);
  render(<DocumentUpload onUploaded={uploaded} />);
  fireEvent.change(screen.getByLabelText(/上传 RAG/), {
    target: { files: [new File(["evidence"], "notes.md")] },
  });
  await waitFor(() => expect(uploaded).toHaveBeenCalledWith("notes.md"));
  expect(screen.getByText(/notes.md 已索引/)).toBeTruthy();
  expect(fetcher.mock.calls).toHaveLength(1);
});
it("shows indexing failure without attaching the file", async () => {
  const uploaded = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ error: "embedding 不可用" }, { status: 503 }),
    ),
  );
  render(<DocumentUpload onUploaded={uploaded} />);
  fireEvent.change(screen.getByLabelText(/上传 RAG/), {
    target: { files: [new File(["evidence"], "notes.md")] },
  });
  expect(await screen.findByText("embedding 不可用")).toBeTruthy();
  expect(uploaded).not.toHaveBeenCalled();
});
