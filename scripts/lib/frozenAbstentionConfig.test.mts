import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadFrozenAbstentionConfig } from "./frozenAbstentionConfig.mts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_CONFIG_PATH = path.join(HERE, "..", "..", "config", "abstention.json");

describe("loadFrozenAbstentionConfig", () => {
  it("loads the real committed config and returns a numeric threshold", () => {
    const config = loadFrozenAbstentionConfig(REAL_CONFIG_PATH);
    expect(typeof config.abstentionThreshold).toBe("number");
    expect(config.thresholdGrid).toContain(config.abstentionThreshold);
    expect(config.calibrationCurve.length).toBe(config.thresholdGrid.length);
  });

  it("throws when the file does not exist", () => {
    expect(() => loadFrozenAbstentionConfig("/nonexistent/path/abstention.json")).toThrow();
  });

  it("refuses to load a config whose content was modified without updating selfHash (tamper detection)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "abstention-tamper-"));
    const tamperedPath = path.join(dir, "abstention.json");
    const original = JSON.parse(readFileSync(REAL_CONFIG_PATH, "utf-8"));

    // Simulate exactly the scenario the loader must catch: someone hand-edits
    // the frozen threshold after the fact, leaving the old selfHash in place.
    const tampered = { ...original, abstentionThreshold: 0 };
    writeFileSync(tamperedPath, JSON.stringify(tampered, null, 2));

    expect(() => loadFrozenAbstentionConfig(tamperedPath)).toThrow(/modified since it was frozen/);
  });

  it("loads successfully when selfHash is correctly recomputed after a legitimate change", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "abstention-legit-"));
    const legitPath = path.join(dir, "abstention.json");
    const original = JSON.parse(readFileSync(REAL_CONFIG_PATH, "utf-8"));

    const { selfHash: _oldSelfHash, ...rest } = original;
    const changed = { ...rest, abstentionThreshold: 0 };
    const selfHash = createHash("sha256").update(JSON.stringify(changed)).digest("hex");
    writeFileSync(legitPath, JSON.stringify({ ...changed, selfHash }, null, 2));

    const loaded = loadFrozenAbstentionConfig(legitPath);
    expect(loaded.abstentionThreshold).toBe(0);
  });

  it("refuses to load a config missing selfHash entirely", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "abstention-nohash-"));
    const noHashPath = path.join(dir, "abstention.json");
    const original = JSON.parse(readFileSync(REAL_CONFIG_PATH, "utf-8"));
    const { selfHash: _drop, ...rest } = original;
    writeFileSync(noHashPath, JSON.stringify(rest, null, 2));

    expect(() => loadFrozenAbstentionConfig(noHashPath)).toThrow(/no selfHash/);
  });
});
