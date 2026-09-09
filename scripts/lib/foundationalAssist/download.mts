// Phase 3 -- downloads the three FoundationalASSIST files from the gated
// HuggingFace dataset, authenticated with a token read from an environment
// variable only. The token is NEVER embedded in code or config, and this
// module never logs it. Uses Node's built-in `fetch` -- no dependency
// added; HF's resolve endpoint is a plain authenticated HTTPS GET, nothing
// an HF-hub client library provides that stdlib fetch doesn't already do
// for this narrow use case.
//
// Not exercised end-to-end this session: access to the dataset is pending
// and it is not on disk. This module is written and unit-tested for its
// error-handling path (missing token, non-2xx response) only.

import { writeFileSync } from "node:fs";

const DATASET_REPO = "ASSISTments/FoundationalASSIST";
const RESOLVE_BASE = `https://huggingface.co/datasets/${DATASET_REPO}/resolve/main`;

export type FoundationalAssistFile = "interactions.csv" | "problems.csv" | "skills.csv";

/** Reads the HF token from the environment. Supports both common env var names; never a literal fallback. Throws if neither is set. */
export function getHfToken(): string {
  const token = process.env.HF_TOKEN ?? process.env.HUGGING_FACE_HUB_TOKEN;
  if (!token) {
    throw new Error(
      "No HuggingFace access token found. Set the HF_TOKEN (or HUGGING_FACE_HUB_TOKEN) environment variable -- " +
        "this dataset is gated and requires an approved access request. The token must never be hardcoded in code or config."
    );
  }
  return token;
}

export interface DownloadResult {
  file: FoundationalAssistFile;
  destPath: string;
  byteLength: number;
}

/**
 * Downloads one of the three documented files to `destPath`. Fails loudly
 * (throws, does not silently write a partial/empty file) on any non-2xx
 * response, since a gated dataset commonly returns 401/403 rather than a
 * network error when access hasn't been granted yet or the token is stale.
 */
export async function downloadFoundationalAssistFile(file: FoundationalAssistFile, destPath: string): Promise<DownloadResult> {
  const token = getHfToken();
  const url = `${RESOLVE_BASE}/${file}`;

  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(
      `Failed to download ${file} from ${DATASET_REPO}: HTTP ${response.status} ${response.statusText}. ` +
        `If this is 401/403, the access request may not be approved yet, or the token may be stale/incorrect.`
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(destPath, buffer);
  return { file, destPath, byteLength: buffer.byteLength };
}
