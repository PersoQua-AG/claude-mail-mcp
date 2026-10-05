/**
 * Attachment part selection, filename hardening and target-path resolution.
 *
 * Deliberately free of IMAP I/O so it can be tested against stored body
 * structures without a mailbox.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { MessageStructureObject } from "imapflow";

const execFileAsync = promisify(execFile);

export interface AttachmentPart {
  /** Position in the attachment list — the `index` get_attachment takes. */
  index: number;
  /** IMAP body part number, e.g. "2" or "2.1". */
  part: string;
  filename: string | null;
  contentType: string;
  size: number;
  inline: boolean;
}

export type Selection =
  | { kind: "match"; part: AttachmentPart }
  | { kind: "ambiguous"; matches: AttachmentPart[] };

/** Fallback extensions for attachments that arrive without a usable name. */
const EXT_BY_TYPE: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/json": ".json",
  "application/ms-tnef": ".dat",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "text/plain": ".txt",
  "text/html": ".html",
  "text/csv": ".csv",
  "text/calendar": ".ics",
  "message/rfc822": ".eml",
};

/**
 * Walk the body structure depth-first and collect every part that looks like
 * an attachment. Recurses into `message/rfc822` — a forwarded mail carrying
 * the attachment is the common real-world case.
 */
export function collectAttachmentParts(
  root: MessageStructureObject | undefined
): AttachmentPart[] {
  const found: Omit<AttachmentPart, "index">[] = [];
  const walk = (node: MessageStructureObject, fallbackPart: string): void => {
    const type = (node.type ?? "application/octet-stream").toLowerCase();
    const disposition = node.disposition?.toLowerCase();
    const filename =
      node.dispositionParameters?.filename ?? node.parameters?.name ?? null;
    if (!type.startsWith("multipart/") && (filename || disposition === "attachment")) {
      found.push({
        part: node.part ?? fallbackPart,
        filename,
        contentType: type,
        size: node.size ?? 0,
        inline: disposition === "inline",
      });
    }
    for (const child of node.childNodes ?? []) walk(child, fallbackPart);
  };
  if (root) walk(root, "1");
  return found.map((p, index) => ({ ...p, index }));
}

/** Resolve `index` XOR `filename` against the collected parts. */
export function selectAttachment(
  parts: AttachmentPart[],
  by: { index?: number; filename?: string }
): Selection {
  const hasIndex = by.index !== undefined;
  const hasName = by.filename !== undefined;
  if (hasIndex === hasName) {
    throw new Error("Provide exactly one of `index` or `filename`.");
  }
  if (parts.length === 0) {
    throw new Error("This message has no attachments.");
  }
  if (hasIndex) {
    const part = parts[by.index as number];
    if (!part) {
      throw new Error(
        `Attachment index ${by.index} is out of range — this message has ${parts.length} attachment(s), indexes 0..${parts.length - 1}.`
      );
    }
    return { kind: "match", part };
  }
  const matches = parts.filter((p) => p.filename === by.filename);
  if (matches.length === 0) {
    throw new Error(
      `No attachment named "${by.filename}". Available: ${parts
        .map((p) => `${p.index}: ${p.filename ?? "(unnamed)"}`)
        .join(", ")}`
    );
  }
  if (matches.length > 1) return { kind: "ambiguous", matches };
  return { kind: "match", part: matches[0] };
}

/**
 * Build a new filename instead of trusting the one from the mail: NFKC first
 * so full-width separators collapse onto real ones before they are stripped.
 */
export function safeFilename(
  raw: string | null | undefined,
  contentType: string,
  index: number
): string {
  const stripped = path
    .basename(
      String(raw ?? "")
        .normalize("NFKC")
        .replace(/\\/g, "/")
    )
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^[.\s]+/, "")
    .trim();
  const ext = EXT_BY_TYPE[contentType] ?? ".bin";
  if (!stripped || /^\.+$/.test(stripped)) return `attachment-${index}${ext}`;
  const named = /\.[A-Za-z0-9]{1,8}$/.test(stripped) ? stripped : stripped + ext;
  return clampLength(named);
}

function clampLength(name: string): string {
  if (name.length <= 200) return name;
  const ext = path.extname(name).slice(0, 16);
  return name.slice(0, 200 - ext.length) + ext;
}

/**
 * Second check after `safeFilename`: resolve and prove the result still sits
 * under the configured directory. One check alone misses symlinks and
 * normalisation tricks.
 */
export function resolveInside(dir: string, filename: string): string {
  const root = path.resolve(dir);
  const full = path.resolve(root, filename);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(
      `Refusing to write "${filename}" — resolved path escapes ${root}.`
    );
  }
  if (full === root) {
    throw new Error(`Refusing to write "${filename}" — resolves to the directory itself.`);
  }
  return full;
}

/** First writer keeps the plain name; later ones get `-1`, `-2`, … */
export function uniquePath(full: string): string {
  if (!existsSync(full)) return full;
  const dir = path.dirname(full);
  const ext = path.extname(full);
  const stem = path.basename(full, ext);
  for (let n = 1; n < 1000; n += 1) {
    const candidate = path.join(dir, `${stem}-${n}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`Too many files named like ${path.basename(full)}.`);
}

/** Reject on the size from the part tree, before any byte is streamed. */
export function assertWithinLimit(size: number, maxMb: number): void {
  const limit = maxMb * 1024 * 1024;
  if (size > limit) {
    throw new Error(
      `Attachment is ${size} bytes (${(size / 1048576).toFixed(1)} MB), over the ${maxMb} MB limit. Raise MAX_ATTACHMENT_MB to fetch it.`
    );
  }
}

/**
 * Mark the file the way a browser download is marked, so the OS keeps asking
 * before anything opens it. Best effort: no-op off macOS.
 */
export async function setQuarantine(full: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const stamp = Math.floor(Date.now() / 1000).toString(16);
  try {
    await execFileAsync("xattr", [
      "-w",
      "com.apple.quarantine",
      `0081;${stamp};claude-mail-mcp;`,
      full,
    ]);
    return true;
  } catch {
    return false;
  }
}

/** winmail.dat is handed over as one file; this tool never unpacks it. */
export function tnefNote(contentType: string, filename: string): string | undefined {
  const isTnef =
    contentType === "application/ms-tnef" ||
    filename.toLowerCase() === "winmail.dat";
  return isTnef
    ? "TNEF container (winmail.dat) — saved as a single file, not unpacked."
    : undefined;
}
