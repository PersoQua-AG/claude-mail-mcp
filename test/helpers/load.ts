/**
 * Single entry point to the production modules under test.
 *
 * `src/config.ts` reads the environment once, while the module is evaluated, and
 * `ATTACHMENT_DIR` / `MAX_ATTACHMENT_MB` are baked into `config` at that moment.
 * Static imports would evaluate before any test could set those variables, so
 * every test file reaches production code through this module and this module
 * alone — it sets the environment first and then imports dynamically.
 *
 * It imports from `dist/`, not `src/`: the sources import each other with `.js`
 * specifiers that only exist after `tsc`, and rewriting them would mean touching
 * production code. `assertBuildIsFresh` keeps that from turning into tests that
 * silently pass against a stale build.
 */

import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");

async function assertBuildIsFresh(): Promise<void> {
  const built = path.join(repo, "dist", "attachments.js");
  let builtAt: number;
  try {
    builtAt = (await stat(built)).mtimeMs;
  } catch {
    throw new Error(`dist/ is missing — run \`npm run build\` before \`node --test\`.`);
  }
  const srcDir = path.join(repo, "src");
  const names = await readdir(srcDir);
  for (const name of names) {
    if (!name.endsWith(".ts")) continue;
    const changedAt = (await stat(path.join(srcDir, name))).mtimeMs;
    if (changedAt > builtAt) {
      throw new Error(
        `dist/ is older than src/${name} — run \`npm run build\` before \`node --test\`.`
      );
    }
  }
}

await assertBuildIsFresh();

// A token is mandatory in config.ts; nothing in these tests sends it anywhere.
process.env.AUTH_TOKEN ??= "test-token-not-a-secret";
// Overridden per test by `withAttachmentDir`; this value only keeps the import
// from pointing at the developer's real ~/Downloads.
process.env.ATTACHMENT_DIR = path.join(os.tmpdir(), "claude-mail-mcp-test-unused");
process.env.MAX_ATTACHMENT_MB = "25";

export const {
  assertWithinLimit,
  collectAttachmentParts,
  decodedSize,
  mayHideAttachments,
  openUnique,
  resolveInside,
  safeFilename,
  selectAttachment,
} = await import("../../dist/attachments.js");

export const { ImapClient } = await import("../../dist/imap-client.js");
export const { config } = await import("../../dist/config.js");

/** `config` is `as const` for callers; tests need the knobs it freezes in types. */
const knobs = config as unknown as { attachmentDir: string; maxAttachmentMb: number };

/**
 * Run `fn` with ATTACHMENT_DIR pointing at a fresh temporary directory, then
 * remove it. Keeps the suite runnable on any machine and off ~/Downloads.
 */
export async function withAttachmentDir<T>(
  fn: (dir: string) => Promise<T>,
  maxAttachmentMb = 25
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "claude-mail-mcp-"));
  const previousDir = knobs.attachmentDir;
  const previousMb = knobs.maxAttachmentMb;
  knobs.attachmentDir = dir;
  knobs.maxAttachmentMb = maxAttachmentMb;
  try {
    return await fn(dir);
  } finally {
    knobs.attachmentDir = previousDir;
    knobs.maxAttachmentMb = previousMb;
    await rm(dir, { recursive: true, force: true });
  }
}
