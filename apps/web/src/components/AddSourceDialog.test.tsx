import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "@/api/client";
import { AddSourceDialog } from "./AddSourceDialog";

const addAsync = vi.fn(async (_input: unknown) => ({}));
const previewAsync = vi.fn(async (_input: unknown): Promise<unknown> => ({}));

vi.mock("@/api/queries", () => ({
  useAddSource: () => ({ mutateAsync: addAsync, isPending: false }),
  usePreviewFeed: () => ({ mutateAsync: previewAsync, isPending: false }),
}));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast: () => undefined }) }));

async function open(url = "https://feeds.example.test/rss.xml"): Promise<void> {
  render(createElement(AddSourceDialog));
  fireEvent.click(screen.getByText("Add feed source"));
  fireEvent.change(await screen.findByLabelText("Feed URL"), { target: { value: url } });
}

describe("AddSourceDialog (feed url)", () => {
  beforeEach(() => {
    addAsync.mockClear();
    previewAsync.mockReset();
  });

  test("Preview lists the first five items, then Add sends url and optional name", async () => {
    previewAsync.mockResolvedValue({
      title: "Example Deals",
      url: "https://feeds.example.test/rss.xml",
      items: Array.from({ length: 7 }, (_, i) => ({ title: `Deal ${i + 1}`, url: `https://deals.example.test/${i + 1}`, postedAt: "2026-10-05T04:45:00.000Z" })),
    });
    await open();
    fireEvent.click(screen.getByText("Preview"));
    expect(await screen.findByText("Deal 1")).toBeTruthy();
    expect(screen.getByText("Deal 5")).toBeTruthy();
    expect(screen.queryByText("Deal 6")).toBeNull();
    expect(previewAsync).toHaveBeenCalledWith({ url: "https://feeds.example.test/rss.xml" });

    fireEvent.change(screen.getByLabelText("Name (optional)"), { target: { value: "  " } });
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(addAsync).toHaveBeenCalledWith({ url: "https://feeds.example.test/rss.xml", name: undefined }));
  });

  test("a preview failure shows the readable reason", async () => {
    previewAsync.mockRejectedValue(new ApiError(422, { error: "invalid_feed", message: "this URL is an HTML page, not a feed" }));
    await open();
    fireEvent.click(screen.getByText("Preview"));
    expect((await screen.findByRole("alert")).textContent).toContain("HTML page");
    expect(screen.queryByTestId("feed-preview")).toBeNull();
  });

  test("an add failure (duplicate) surfaces the server message and keeps the dialog open", async () => {
    addAsync.mockRejectedValueOnce(new ApiError(409, { error: "conflict", message: "this feed has already been added" }));
    await open();
    fireEvent.click(screen.getByText("Add"));
    expect((await screen.findByRole("alert")).textContent).toContain("already been added");
    expect(screen.getByLabelText("Feed URL")).toBeTruthy();
  });

  test("a non-http url is rejected locally without a request", async () => {
    await open("ftp://feeds.example.test/x");
    fireEvent.click(screen.getByText("Add"));
    expect((await screen.findByRole("alert")).textContent).toContain("http");
    expect(addAsync).not.toHaveBeenCalled();
  });
});
