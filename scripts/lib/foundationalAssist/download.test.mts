import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getHfToken, downloadFoundationalAssistFile } from "./download.mts";

const originalHfToken = process.env.HF_TOKEN;
const originalHubToken = process.env.HUGGING_FACE_HUB_TOKEN;

afterEach(() => {
  if (originalHfToken === undefined) delete process.env.HF_TOKEN;
  else process.env.HF_TOKEN = originalHfToken;
  if (originalHubToken === undefined) delete process.env.HUGGING_FACE_HUB_TOKEN;
  else process.env.HUGGING_FACE_HUB_TOKEN = originalHubToken;
  vi.unstubAllGlobals();
});

describe("getHfToken", () => {
  it("throws a clear error when no token env var is set", () => {
    delete process.env.HF_TOKEN;
    delete process.env.HUGGING_FACE_HUB_TOKEN;
    expect(() => getHfToken()).toThrow(/No HuggingFace access token/);
  });

  it("reads HF_TOKEN when set", () => {
    process.env.HF_TOKEN = "test-token-value";
    delete process.env.HUGGING_FACE_HUB_TOKEN;
    expect(getHfToken()).toBe("test-token-value");
  });

  it("falls back to HUGGING_FACE_HUB_TOKEN when HF_TOKEN is unset", () => {
    delete process.env.HF_TOKEN;
    process.env.HUGGING_FACE_HUB_TOKEN = "legacy-token-value";
    expect(getHfToken()).toBe("legacy-token-value");
  });
});

describe("downloadFoundationalAssistFile", () => {
  it("throws before attempting any network call when no token is present", async () => {
    delete process.env.HF_TOKEN;
    delete process.env.HUGGING_FACE_HUB_TOKEN;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(downloadFoundationalAssistFile("interactions.csv", "/tmp/whatever.csv")).rejects.toThrow(/No HuggingFace access token/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the token as a Bearer Authorization header, never in the URL", async () => {
    process.env.HF_TOKEN = "secret-token-abc";
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode("a,b\n1,2\n").buffer });
    vi.stubGlobal("fetch", fetchSpy);

    const dir = mkdtempSync(path.join(tmpdir(), "fa-download-"));
    const dest = path.join(dir, "interactions.csv");
    await downloadFoundationalAssistFile("interactions.csv", dest);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).not.toContain("secret-token-abc"); // never in the URL
    expect((init as RequestInit).headers).toEqual({ Authorization: "Bearer secret-token-abc" });
    expect(readFileSync(dest, "utf-8")).toBe("a,b\n1,2\n");
  });

  it("fails loudly (throws, writes nothing) on a non-2xx response instead of silently writing a partial file", async () => {
    process.env.HF_TOKEN = "secret-token-abc";
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" });
    vi.stubGlobal("fetch", fetchSpy);

    const dir = mkdtempSync(path.join(tmpdir(), "fa-download-fail-"));
    const dest = path.join(dir, "interactions.csv");
    await expect(downloadFoundationalAssistFile("interactions.csv", dest)).rejects.toThrow(/HTTP 403/);
    expect(() => readFileSync(dest)).toThrow(); // nothing was written
  });
});
