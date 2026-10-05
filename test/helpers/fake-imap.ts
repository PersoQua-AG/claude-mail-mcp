/**
 * Stands in for the one ImapFlow connection `ImapClient` holds, so the real
 * `getMessage` / `downloadAttachment` run against stored messages.
 *
 * It answers only the three calls those methods make. The part lookup is an
 * independent implementation of RFC 3501 §6.4.5 part numbering over the raw
 * message — that is what lets a test notice when production derives a wrong
 * number: the server would answer with different bytes, or with nothing.
 */

import { createRequire } from "node:module";
import { Readable } from "node:stream";
import type { MessageStructureObject } from "imapflow";
import { ImapClient } from "./load.ts";

const require = createRequire(import.meta.url);
// The real byte limiter that `client.download` applies to its output.
const { LimitedPassthrough } = require("imapflow/lib/limited-passthrough.js");

interface Entity {
  headers: Map<string, string>;
  body: Buffer;
}

function parseEntity(raw: Buffer): Entity {
  const text = raw.toString("latin1");
  const split = /\r?\n\r?\n/.exec(text);
  const head = split ? text.slice(0, split.index) : text;
  const body = split ? text.slice(split.index + split[0].length) : "";
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return { headers, body: Buffer.from(body, "latin1") };
}

const paramOf = (header: string | undefined, name: string): string | undefined =>
  new RegExp(`${name}="?([^";]*)"?`, "i").exec(header ?? "")?.[1];

function multipartChildren(entity: Entity): Entity[] | null {
  const type = entity.headers.get("content-type") ?? "text/plain";
  if (!/^multipart\//i.test(type)) return null;
  const boundary = (paramOf(type, "boundary") ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pieces = entity.body
    .toString("latin1")
    .split(new RegExp(`(?:^|\\r?\\n)--${boundary}(?:--)?[ \\t]*(?=\\r?\\n|$)`));
  // [preamble, part, part, …, epilogue]; each part still starts with the line break.
  return pieces.slice(1, -1).map((p) => parseEntity(Buffer.from(p.replace(/^\r?\n/, ""), "latin1")));
}

/** RFC 3501 numbering. The message itself counts as an encapsulated message. */
function entityAt(message: Entity, part: string): Entity | undefined {
  let current: Entity = message;
  let enclosed = true; // `current` is a message whose body is what the next number indexes
  for (const n of part.split(".").map(Number)) {
    let container = current;
    // A single-part body can only be addressed as ".1" of a message, never of a leaf.
    let singlePartAllowed = enclosed;
    if (!enclosed && /^message\/rfc822/i.test(current.headers.get("content-type") ?? "")) {
      container = parseEntity(current.body);
      singlePartAllowed = true;
    }
    const kids = multipartChildren(container) ?? (singlePartAllowed ? [container] : []);
    const next = kids[n - 1];
    if (!next) return undefined;
    current = next;
    enclosed = false;
  }
  return current;
}

function decodeQuotedPrintable(body: Buffer): Buffer {
  const text = body.toString("latin1").replace(/=\r?\n/g, "");
  return Buffer.from(text.replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
}

export interface FakeMessage {
  source: Buffer;
  /** Leave out to model a server that sends no BODYSTRUCTURE at all. */
  structure?: MessageStructureObject;
}

export interface FakeOptions {
  /** Replaces the whole answer of `download`, e.g. `{}` for "server sent nothing". */
  download?: (part: string, opts: { maxBytes?: number }) => unknown;
}

export interface FakeServer {
  client: unknown;
  /** Keys of every `fetchOne` query, in order — to see whether the source was loaded. */
  fetches: string[][];
  downloads: Array<{ part: string; maxBytes: number | undefined }>;
}

export function fakeServer(message: FakeMessage, options: FakeOptions = {}): FakeServer {
  const server: FakeServer = { client: null, fetches: [], downloads: [] };
  const entity = parseEntity(message.source);
  server.client = {
    usable: true,
    getMailboxLock: async () => ({ release() {} }),
    fetchOne: async (_range: string, query: Record<string, unknown>) => {
      server.fetches.push(Object.keys(query));
      return {
        uid: 1,
        seq: 1,
        flags: new Set<string>(),
        internalDate: new Date("2026-10-05T09:00:00Z"),
        size: message.source.length,
        ...(query.source ? { source: message.source } : {}),
        ...(query.bodyStructure && message.structure ? { bodyStructure: message.structure } : {}),
      };
    },
    download: async (_range: string, part: string, opts: { maxBytes?: number }) => {
      server.downloads.push({ part, maxBytes: opts.maxBytes });
      if (options.download) return options.download(part, opts);
      const found = entityAt(entity, part);
      if (!found) return {};
      const type = found.headers.get("content-type");
      const disposition = found.headers.get("content-disposition");
      const encoding = found.headers.get("content-transfer-encoding")?.toLowerCase();
      const decoded =
        encoding === "base64"
          ? Buffer.from(found.body.toString("latin1"), "base64")
          : encoding === "quoted-printable"
            ? decodeQuotedPrintable(found.body)
            : found.body;
      return {
        meta: {
          contentType: type?.split(";")[0].trim().toLowerCase(),
          filename: paramOf(disposition, "filename") ?? paramOf(type, "name"),
          encoding,
        },
        content: Readable.from([decoded]).pipe(new LimitedPassthrough({ maxBytes: opts.maxBytes })),
      };
    },
  };
  return server;
}

/** A real `ImapClient` whose connection is the fake — nothing opens a socket. */
export function connect(server: FakeServer): InstanceType<typeof ImapClient> {
  const imap = new ImapClient({ host: "imap.invalid", port: 993, secure: true, user: "u", pass: "p" });
  (imap as unknown as { client: unknown }).client = server.client;
  return imap;
}
