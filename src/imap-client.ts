/**
 * IMAP client wrapper around imapflow.
 *
 * Holds a single long-lived connection that auto-reconnects on demand.
 * Each operation acquires a mailbox lock so concurrent tool calls don't
 * collide on the IMAP `SELECT` state.
 *
 * Tool handlers stay thin: they call high-level methods here, get back
 * plain JSON-shaped objects, and don't see imapflow internals.
 */

import { mkdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { pipeline } from "node:stream/promises";
import { ImapFlow, ImapFlowOptions, FetchMessageObject } from "imapflow";
import { simpleParser, ParsedMail } from "mailparser";
import { config } from "./config.js";
import {
  AttachmentPart,
  assertWithinLimit,
  collectAttachmentParts,
  decodedSize,
  mayHideAttachments,
  openUnique,
  resolveInside,
  safeFilename,
  selectAttachment,
  setQuarantine,
} from "./attachments.js";

export interface ImapAuth {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure: boolean;
}

export interface MailboxSummary {
  path: string;
  name: string;
  delimiter: string;
  flags: string[];
  specialUse?: string;
  subscribed: boolean;
  listed: boolean;
}

export interface MessageSummary {
  uid: number;
  seq: number;
  flags: string[];
  date: string | null;
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  size: number | null;
  preview: string | null;
}

export interface MessageDetail extends MessageSummary {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: Array<{
    /** Position to pass to get_attachment. */
    index: number;
    filename: string | null;
    contentType: string;
    size: number;
    contentId: string | null;
    /** Inline parts are usually signature logos, not real attachments. */
    inline: boolean;
  }>;
}

/** 256 KB hard ceiling on inlined base64 — bodies this big belong in a file. */
const MAX_BASE64_BYTES = 256 * 1024;

export interface AttachmentResult {
  filename: string;
  content_type: string;
  size: number;
  inline: boolean;
  /** Which of the two retrieval paths produced this result. */
  strategy: "part" | "fallback";
  saved_to?: string;
  quarantined?: boolean;
  content_base64?: string;
  note?: string;
}

export interface AmbiguousAttachments {
  ambiguous: true;
  filename: string;
  matches: Array<
    Pick<AttachmentPart, "index" | "filename" | "size" | "inline"> & { content_type: string }
  >;
}

/**
 * mailparser never descends into `message/rfc822`, so do it here: the embedded
 * parts land directly behind their wrapper, which is exactly where the body
 * structure walk numbers them — so get_message and get_attachment agree on
 * `index` by construction (spec §2 addendum, 2026-10-05).
 */
async function flattenAttachments(
  list: ParsedMail["attachments"],
  depth = 0
): Promise<ParsedMail["attachments"]> {
  const flat: ParsedMail["attachments"] = [];
  for (const a of list) {
    flat.push(a);
    // Mail is untrusted input; eight wrappers deep is already absurd.
    if (depth < 8 && a.contentType?.toLowerCase() === "message/rfc822") {
      const inner = await simpleParser(a.content as Buffer);
      flat.push(...(await flattenAttachments(inner.attachments ?? [], depth + 1)));
    }
  }
  return flat;
}

/** Several parts carry the requested name: hand back the list instead of guessing. */
function ambiguous(filename: string, matches: AttachmentPart[]): AmbiguousAttachments {
  return {
    ambiguous: true,
    filename,
    matches: matches.map((m) => ({
      index: m.index,
      filename: m.filename,
      content_type: m.contentType,
      size: m.size,
      inline: m.inline,
    })),
  };
}

export interface AttachmentQuery {
  index?: number;
  filename?: string;
  asBase64?: boolean;
}

export interface SearchCriteria {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  since?: string; // YYYY-MM-DD
  before?: string; // YYYY-MM-DD
  unread?: boolean;
  flagged?: boolean;
}

export class ImapClient {
  private client: ImapFlow | null = null;
  private connecting: Promise<ImapFlow> | null = null;
  private readonly opts: ImapFlowOptions;

  constructor(auth: ImapAuth) {
    this.opts = {
      host: auth.host,
      port: auth.port,
      secure: auth.secure,
      auth: { user: auth.user, pass: auth.pass },
      logger: false,
    };
  }

  private async ensureConnected(): Promise<ImapFlow> {
    if (this.client && this.client.usable) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async (): Promise<ImapFlow> => {
      const client = new ImapFlow(this.opts);
      client.on("error", () => {
        // Mark unusable so next call reconnects.
        if (this.client === client) this.client = null;
      });
      await client.connect();
      this.client = client;
      this.connecting = null;
      return client;
    })();
    return this.connecting;
  }

  async close(): Promise<void> {
    if (this.client) {
      const c = this.client;
      this.client = null;
      try {
        await c.logout();
      } catch {
        // best effort
      }
    }
  }

  async listMailboxes(): Promise<MailboxSummary[]> {
    const client = await this.ensureConnected();
    const list = await client.list();
    return list.map((m) => ({
      path: m.path,
      name: m.name,
      delimiter: m.delimiter ?? "/",
      flags: Array.from(m.flags ?? []),
      specialUse: m.specialUse ?? undefined,
      subscribed: Boolean(m.subscribed),
      listed: Boolean(m.listed),
    }));
  }

  async listMessages(
    mailbox: string,
    opts: { limit?: number; unreadOnly?: boolean } = {}
  ): Promise<MessageSummary[]> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const status = await client.status(mailbox, { messages: true });
      const total = status.messages ?? 0;
      if (total === 0) return [];
      const limit = Math.min(opts.limit ?? 25, 200);

      let uids: number[] = [];
      if (opts.unreadOnly) {
        const found = await client.search({ seen: false }, { uid: true });
        const arr = Array.isArray(found) ? found : [];
        uids = arr.slice(-limit).reverse();
      } else {
        // Fetch the newest `limit` by sequence number.
        const from = Math.max(1, total - limit + 1);
        const messages = await this.fetchRange(client, `${from}:*`, false);
        return messages.reverse();
      }
      if (uids.length === 0) return [];
      return await this.fetchRange(client, uids.join(","), true);
    } finally {
      lock.release();
    }
  }

  async searchMessages(
    mailbox: string,
    criteria: SearchCriteria,
    limit = 25
  ): Promise<MessageSummary[]> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const query: Record<string, unknown> = {};
      if (criteria.from) query.from = criteria.from;
      if (criteria.to) query.to = criteria.to;
      if (criteria.subject) query.subject = criteria.subject;
      if (criteria.body) query.body = criteria.body;
      if (criteria.since) query.since = new Date(criteria.since);
      if (criteria.before) query.before = new Date(criteria.before);
      if (criteria.unread === true) query.seen = false;
      if (criteria.unread === false) query.seen = true;
      if (criteria.flagged === true) query.flagged = true;
      if (criteria.flagged === false) query.unflagged = true;

      const found = await client.search(query, { uid: true });
      const uids = Array.isArray(found) ? found : [];
      if (uids.length === 0) return [];
      const slice = uids.slice(-Math.min(limit, 200)).reverse();
      return await this.fetchRange(client, slice.join(","), true);
    } finally {
      lock.release();
    }
  }

  async getMessage(mailbox: string, uid: number): Promise<MessageDetail> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const msg = await client.fetchOne(
        `${uid}`,
        { source: true, envelope: true, flags: true, internalDate: true, size: true },
        { uid: true }
      );
      if (!msg) {
        throw new Error(`Message UID ${uid} not found in ${mailbox}`);
      }
      const parsed: ParsedMail = await simpleParser(msg.source as Buffer);
      const attachments = await flattenAttachments(parsed.attachments ?? []);
      return {
        uid: msg.uid as number,
        seq: msg.seq as number,
        flags: Array.from(msg.flags ?? []),
        date:
          (msg.internalDate as Date | undefined)?.toISOString() ?? null,
        subject: parsed.subject ?? null,
        from: parsed.from?.text ?? null,
        to: Array.isArray(parsed.to)
          ? parsed.to.map((a) => a.text).join(", ")
          : parsed.to?.text ?? null,
        cc: Array.isArray(parsed.cc)
          ? parsed.cc.map((a) => a.text).join(", ")
          : parsed.cc?.text ?? null,
        size: (msg.size as number | undefined) ?? null,
        preview: parsed.text ? parsed.text.slice(0, 200) : null,
        messageId: parsed.messageId ?? null,
        inReplyTo: parsed.inReplyTo ?? null,
        references: Array.isArray(parsed.references)
          ? parsed.references
          : parsed.references
            ? [parsed.references]
            : [],
        bodyText: parsed.text ?? null,
        bodyHtml: typeof parsed.html === "string" ? parsed.html : null,
        attachments: attachments.map((a, index) => ({
          index,
          filename: a.filename ?? null,
          contentType: a.contentType,
          size: a.size,
          contentId: a.cid ?? null,
          inline: a.contentDisposition?.toLowerCase() === "inline",
        })),
      };
    } finally {
      lock.release();
    }
  }

  /**
   * Fetch exactly one attachment. Primary path walks the part tree and
   * streams only that part; if the tree yields nothing usable it falls back
   * to parsing the full source, which is what get_message already does.
   */
  async downloadAttachment(
    mailbox: string,
    uid: number,
    query: AttachmentQuery
  ): Promise<AttachmentResult | AmbiguousAttachments> {
    const result = await this.fetchAttachment(mailbox, uid, query);
    // Quarantining spawns `xattr`; do it once the mailbox lock is gone.
    if ("saved_to" in result && result.saved_to) {
      result.quarantined = await setQuarantine(result.saved_to);
    }
    return result;
  }

  private async fetchAttachment(
    mailbox: string,
    uid: number,
    query: AttachmentQuery
  ): Promise<AttachmentResult | AmbiguousAttachments> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const msg = await client.fetchOne(
        `${uid}`,
        { bodyStructure: true },
        { uid: true }
      );
      if (!msg) throw new Error(`Message UID ${uid} not found in ${mailbox}`);

      // An empty tree is only an answer when the tree could not have hidden
      // anything: a message without attachments must not pull the whole source
      // just to say so, while a truncated BODYSTRUCTURE must reach the parser.
      const parts = collectAttachmentParts(msg.bodyStructure);
      if (parts.length === 0 && mayHideAttachments(msg.bodyStructure)) {
        return await this.fallbackAttachment(client, uid, query);
      }
      const selection = selectAttachment(parts, query);
      if (Array.isArray(selection)) return ambiguous(query.filename as string, selection);

      // The body structure reports encoded octets; the limit is about real bytes.
      // Not every encoding can be converted back without them — then maxBytes
      // caps the stream and the check after the write reports the true size.
      const estimate = decodedSize(selection.size, selection.encoding);
      if (estimate !== undefined) assertWithinLimit(estimate, config.maxAttachmentMb);
      const ceiling = query.asBase64 === true
        ? MAX_BASE64_BYTES
        : config.maxAttachmentMb * 1024 * 1024;
      const dl = await client.download(`${uid}`, selection.part, {
        uid: true,
        // Second line of defence for servers that report no part size: stop one
        // byte past the ceiling, so an oversized part cannot be streamed in full.
        maxBytes: ceiling + 1,
      });
      const contentType = dl.meta.contentType ?? selection.contentType;
      return await this.deliver(
        dl.content,
        {
          filename: safeFilename(
            dl.meta.filename ?? selection.filename,
            contentType,
            selection.index
          ),
          content_type: contentType,
          inline: selection.inline,
          strategy: "part",
        },
        query.asBase64 === true
      );
    } finally {
      lock.release();
    }
  }

  /** Broken or disposition-less structures: parse the whole message instead. */
  private async fallbackAttachment(
    client: ImapFlow,
    uid: number,
    query: AttachmentQuery
  ): Promise<AttachmentResult | AmbiguousAttachments> {
    const msg = await client.fetchOne(`${uid}`, { source: true }, { uid: true });
    if (!msg) throw new Error(`Message UID ${uid} not found`);
    const parsed: ParsedMail = await simpleParser(msg.source as Buffer);
    const flat = await flattenAttachments(parsed.attachments ?? []);
    const parts: AttachmentPart[] = flat.map((a, index) => ({
      index,
      part: "",
      filename: a.filename ?? null,
      contentType: a.contentType,
      // mailparser already decoded, so this is the real byte count.
      size: a.size,
      encoding: "",
      inline: a.contentDisposition?.toLowerCase() === "inline",
    }));
    const selection = selectAttachment(parts, query);
    if (Array.isArray(selection)) return ambiguous(query.filename as string, selection);
    assertWithinLimit(selection.size, config.maxAttachmentMb);
    const content = flat[selection.index].content;
    return await this.deliver(
      Readable.from(content),
      {
        filename: safeFilename(selection.filename, selection.contentType, selection.index),
        content_type: selection.contentType,
        inline: selection.inline,
        strategy: "fallback",
      },
      query.asBase64 === true
    );
  }

  /**
   * Write the bytes (or inline them) and report the size that actually
   * arrived — the part tree only knows encoded octets, and the message size
   * imapflow offers is the whole message, not this part.
   */
  private async deliver(
    source: Readable,
    base: Omit<AttachmentResult, "size">,
    asBase64: boolean
  ): Promise<AttachmentResult> {
    const tnef =
      base.content_type === "application/ms-tnef" ||
      base.filename.toLowerCase() === "winmail.dat";
    const head = {
      ...base,
      // winmail.dat is handed over as one file; this tool never unpacks it.
      note: tnef
        ? "TNEF container (winmail.dat) — saved as a single file, not unpacked."
        : undefined,
    };

    if (asBase64) {
      const bytes = await buffer(source);
      if (bytes.length > MAX_BASE64_BYTES) {
        throw new Error(
          `Attachment is ${bytes.length} bytes (${(bytes.length / 1048576).toFixed(1)} MB), over the ${MAX_BASE64_BYTES / 1024} KB base64 limit. Call without as_base64 to save it to disk instead.`
        );
      }
      return { ...head, size: bytes.length, content_base64: bytes.toString("base64") };
    }

    await mkdir(config.attachmentDir, { recursive: true }).catch((err: Error) => {
      throw new Error(`Cannot use ATTACHMENT_DIR ${config.attachmentDir}: ${err.message} — a dangling symlink or an unwritable parent?`);
    });
    // realpath first, so a symlinked ATTACHMENT_DIR cannot widen the containment check.
    const root = await realpath(config.attachmentDir);
    const { handle, target } = await openUnique(resolveInside(root, base.filename));
    try {
      await pipeline(source, handle.createWriteStream());
      const size = (await stat(target)).size;
      assertWithinLimit(size, config.maxAttachmentMb);
      return { ...head, filename: path.basename(target), size, saved_to: target };
    } catch (err) {
      // Never leave half a file — or an over-limit one — behind, and never let
      // the cleanup error replace the one that caused it.
      await rm(target, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async markRead(
    mailbox: string,
    uid: number,
    read: boolean
  ): Promise<void> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      if (read) {
        await client.messageFlagsAdd(`${uid}`, ["\\Seen"], { uid: true });
      } else {
        await client.messageFlagsRemove(`${uid}`, ["\\Seen"], { uid: true });
      }
    } finally {
      lock.release();
    }
  }

  async moveMessage(
    sourceMailbox: string,
    uid: number,
    destinationMailbox: string
  ): Promise<void> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(sourceMailbox);
    try {
      await client.messageMove(`${uid}`, destinationMailbox, { uid: true });
    } finally {
      lock.release();
    }
  }

  async deleteMessage(mailbox: string, uid: number): Promise<void> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      await client.messageDelete(`${uid}`, { uid: true });
    } finally {
      lock.release();
    }
  }

  /**
   * Append a raw RFC 822 message to a folder — used for drafts and for
   * keeping a copy of sent messages.
   */
  async append(
    mailbox: string,
    raw: string | Buffer,
    flags: string[]
  ): Promise<void> {
    const client = await this.ensureConnected();
    await client.append(mailbox, raw, flags);
  }

  private async fetchRange(
    client: ImapFlow,
    range: string,
    byUid: boolean
  ): Promise<MessageSummary[]> {
    const out: MessageSummary[] = [];
    const fetchOpts = {
      envelope: true,
      flags: true,
      internalDate: true,
      size: true,
      bodyParts: ["1"],
    };
    for await (const msg of client.fetch(range, fetchOpts, { uid: byUid })) {
      out.push(summarize(msg));
    }
    return out;
  }
}

function addrText(
  addr:
    | { name?: string; address?: string }[]
    | { name?: string; address?: string }
    | undefined
): string | null {
  if (!addr) return null;
  const list = Array.isArray(addr) ? addr : [addr];
  return (
    list
      .map((a) => {
        const name = a?.name?.trim();
        const email = a?.address?.trim();
        if (name && email) return `${name} <${email}>`;
        return email ?? name ?? null;
      })
      .filter((v): v is string => Boolean(v))
      .join(", ") || null
  );
}

function summarize(msg: FetchMessageObject): MessageSummary {
  const env = msg.envelope;
  // Try to grab a short text preview from bodyParts if present.
  let preview: string | null = null;
  const bodyParts = msg.bodyParts;
  if (bodyParts && bodyParts.size > 0) {
    const part = bodyParts.values().next().value;
    if (part) {
      const text = Buffer.isBuffer(part) ? part.toString("utf8") : String(part);
      preview = text.replace(/\s+/g, " ").slice(0, 200);
    }
  }
  return {
    uid: msg.uid as number,
    seq: msg.seq as number,
    flags: Array.from(msg.flags ?? []),
    date: env?.date ? new Date(env.date).toISOString() : null,
    subject: env?.subject ?? null,
    from: addrText(env?.from),
    to: addrText(env?.to),
    cc: addrText(env?.cc),
    size: (msg.size as number | undefined) ?? null,
    preview,
  };
}
