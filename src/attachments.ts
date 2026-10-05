/**
 * Attachment part selection, filename hardening and target-path resolution.
 *
 * Deliberately free of IMAP I/O so it can be tested against stored body
 * structures without a mailbox.
 */

import { execFile } from "node:child_process";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { MessageStructureObject } from "imapflow";

const execFileAsync = promisify(execFile);

export interface AttachmentPart {
  /** Position in get_message's attachment list — embedded parts included. */
  index: number;
  /** IMAP body part number, e.g. "2" or "2.1". */
  part: string;
  filename: string | null;
  contentType: string;
  /** Encoded octet count from the body structure, not the decoded size. */
  size: number;
  encoding: string;
  inline: boolean;
}

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

/** mailparser's text types: these count as attachments only when dispositioned so. */
const TEXT_TYPES = ["text/plain", "text/html", "message/delivery-status"];

const isMultipart = (node: MessageStructureObject): boolean =>
  (node.type ?? "").toLowerCase().startsWith("multipart/");

/**
 * Walk the body structure depth-first and collect every part that counts as an
 * attachment, entering `message/rfc822` as spec §8 requires. get_message walks
 * mailparser's output in the same order, so `index` means the same thing there.
 */
export function collectAttachmentParts(
  root: MessageStructureObject | undefined
): AttachmentPart[] {
  const found: AttachmentPart[] = [];
  let next = 0;
  // Part numbers are derived here, never read off `node.part`: imapflow gives an
  // encapsulated message its wrapper's number, which is only right as long as
  // nothing deeper follows.
  const walk = (node: MessageStructureObject, part: string): void => {
    const type = (node.type ?? "application/octet-stream").toLowerCase();
    const disposition = node.disposition?.toLowerCase();
    const multipart = isMultipart(node);
    const isAttachment =
      !TEXT_TYPES.includes(type) || (disposition !== undefined && disposition !== "inline");
    if (!multipart && isAttachment) {
      found.push({
        index: next++,
        part,
        filename: node.dispositionParameters?.filename ?? node.parameters?.name ?? null,
        contentType: type,
        size: node.size ?? 0,
        encoding: (node.encoding ?? "").toLowerCase(),
        inline: disposition === "inline",
      });
    }
    const children = node.childNodes ?? [];
    if (multipart) {
      // RFC 3501: a multipart's children are numbered inside its own number;
      // the outermost multipart has none, so its children start at "1".
      children.forEach((child, i) => walk(child, part ? `${part}.${i + 1}` : `${i + 1}`));
    } else if (type === "message/rfc822") {
      // The encapsulated body of <n> is <n>.1 when single-part; a multipart one
      // *is* <n>, so its own children become <n>.1, <n>.2, … one level deeper.
      for (const child of children) walk(child, isMultipart(child) ? part : `${part}.1`);
    }
  };
  if (root) walk(root, isMultipart(root) ? "" : "1");
  return found;
}

/** A text part that only a disposition could have marked as an attachment. */
const couldBeTruncated = (node: MessageStructureObject): boolean =>
  node.disposition === undefined &&
  TEXT_TYPES.includes((node.type ?? "").toLowerCase()) &&
  (node.dispositionParameters?.filename ?? node.parameters?.name) === undefined;

/**
 * RFC 3501 lets a server end BODYSTRUCTURE right after the disposition, and
 * imapflow then drops it — a `text/plain` attachment becomes indistinguishable
 * from the body text and the walk above finds nothing. An empty result is only
 * an answer when no part looks like that: a text part with neither disposition
 * nor name that has siblings outside a `multipart/alternative`, where every
 * child is a variant of the same body anyway.
 */
export function mayHideAttachments(root: MessageStructureObject | undefined): boolean {
  if (!root) return true;
  const children = root.childNodes ?? [];
  if (
    (root.type ?? "").toLowerCase() !== "multipart/alternative" &&
    children.length > 1 &&
    children.some(couldBeTruncated)
  ) {
    return true;
  }
  return children.some(mayHideAttachments);
}

/** Resolve `index` XOR `filename`; several name matches come back as a list. */
export function selectAttachment(
  parts: AttachmentPart[],
  by: { index?: number; filename?: string }
): AttachmentPart | AttachmentPart[] {
  if ((by.index === undefined) === (by.filename === undefined)) {
    throw new Error("Provide exactly one of `index` or `filename`.");
  }
  if (parts.length === 0) {
    throw new Error("This message has no attachments.");
  }
  if (by.index !== undefined) {
    const part = parts.find((p) => p.index === by.index);
    if (!part) {
      throw new Error(
        `Attachment index ${by.index} is out of range — this message has ${parts.length} attachment(s), indexes 0..${parts.length - 1}.`
      );
    }
    return part;
  }
  const matches = parts.filter((p) => p.filename === by.filename);
  if (matches.length === 0) {
    throw new Error(
      `No attachment named "${by.filename}". Available: ${parts
        .map((p) => `${p.index}: ${p.filename ?? "(unnamed)"}`)
        .join(", ")}`
    );
  }
  return matches.length > 1 ? matches : matches[0];
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
    // Control characters, plus the bidi overrides that survive NFKC and make
    // "<U+202E>exe.pdf" show up as "fdp.exe" in Finder.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  const known = EXT_BY_TYPE[contentType];
  const ext = known ?? ".bin";
  if (!stripped) return `attachment-${index}${ext}`;
  const own = path.extname(stripped).toLowerCase();
  // Spec §5.1: the extension has to agree with the declared type, so
  // invoice.pdf.exe cannot keep .exe. Unknown types keep a plausible one.
  const agrees = known
    ? own === known || (known === ".jpg" && own === ".jpeg")
    : /^\.[a-z0-9]{1,8}$/.test(own);
  const named = agrees ? stripped : stripped + ext;
  if (named.length <= 200) return named;
  const tail = path.extname(named).slice(0, 16);
  return named.slice(0, 200 - tail.length) + tail;
}

/**
 * Second check after `safeFilename`: prove the result still sits under the
 * target directory. Callers pass a `realpath`-resolved root, so a symlinked
 * ATTACHMENT_DIR cannot widen it; this lexical test catches the rest.
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

/**
 * First writer keeps the plain name; later ones get `-1`, `-2`, … `wx` makes
 * check and create one step, so neither a parallel call nor a planted symlink
 * can take over the first file.
 */
export async function openUnique(
  full: string
): Promise<{ handle: FileHandle; target: string }> {
  const dir = path.dirname(full);
  const ext = path.extname(full);
  const stem = path.basename(full, ext);
  for (let n = 0; n < 1000; n += 1) {
    const target = n === 0 ? full : path.join(dir, `${stem}-${n}${ext}`);
    try {
      return { handle: await open(target, "wx"), target };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`Too many files named like ${path.basename(full)}.`);
}

/**
 * Body-structure sizes are encoded octets (RFC 3501). base64 carries 57 source
 * bytes per 78-octet line (RFC 2045), so estimate low rather than reject a legal
 * attachment. quoted-printable inflates by a factor only the bytes reveal —
 * `undefined` says "cannot tell", and `maxBytes` plus the post-write check decide.
 */
export function decodedSize(size: number, encoding: string): number | undefined {
  // The last line is padded, so drop one line's worth and stay a lower bound.
  if (encoding === "base64") return Math.max(0, Math.floor((size * 57) / 78) - 57);
  return encoding === "quoted-printable" ? undefined : size;
}

/** Reject on the decoded size — before the stream starts, and again after it. */
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
