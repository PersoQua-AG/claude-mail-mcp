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

import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ImapFlow, ImapFlowOptions, FetchMessageObject } from "imapflow";
import { simpleParser, ParsedMail } from "mailparser";
import { config } from "./config.js";
import {
  AttachmentPart,
  assertWithinLimit,
  collectAttachmentParts,
  resolveInside,
  safeFilename,
  selectAttachment,
  setQuarantine,
  tnefNote,
  uniquePath,
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
  matches: Array<{
    index: number;
    filename: string | null;
    content_type: string;
    size: number;
    inline: boolean;
  }>;
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
        attachments: (parsed.attachments ?? []).map((a, index) => ({
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
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const msg = await client.fetchOne(
        `${uid}`,
        { bodyStructure: true },
        { uid: true }
      );
      if (!msg) throw new Error(`Message UID ${uid} not found in ${mailbox}`);

      const parts = collectAttachmentParts(msg.bodyStructure);
      let selected: AttachmentPart | null = null;
      if (parts.length > 0) {
        const selection = selectAttachment(parts, query);
        if (selection.kind === "ambiguous") {
          return {
            ambiguous: true,
            filename: query.filename as string,
            matches: selection.matches.map((m) => ({
              index: m.index,
              filename: m.filename,
              content_type: m.contentType,
              size: m.size,
              inline: m.inline,
            })),
          };
        }
        selected = selection.part;
      }
      if (!selected) return await this.fallbackAttachment(client, uid, query);

      assertWithinLimit(selected.size, config.maxAttachmentMb);
      const dl = await client.download(`${uid}`, selected.part, { uid: true });
      const name = safeFilename(
        dl.meta.filename ?? selected.filename,
        dl.meta.contentType ?? selected.contentType,
        selected.index
      );
      return await this.deliver(dl.content, {
        name,
        contentType: dl.meta.contentType ?? selected.contentType,
        size: dl.meta.expectedSize ?? selected.size,
        inline: selected.inline,
        strategy: "part",
        asBase64: query.asBase64 === true,
      });
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
    const parts: AttachmentPart[] = (parsed.attachments ?? []).map((a, index) => ({
      index,
      part: "",
      filename: a.filename ?? null,
      contentType: a.contentType,
      size: a.size,
      inline: a.contentDisposition?.toLowerCase() === "inline",
    }));
    const selection = selectAttachment(parts, query);
    if (selection.kind === "ambiguous") {
      return {
        ambiguous: true,
        filename: query.filename as string,
        matches: selection.matches.map((m) => ({
          index: m.index,
          filename: m.filename,
          content_type: m.contentType,
          size: m.size,
          inline: m.inline,
        })),
      };
    }
    const chosen = selection.part;
    assertWithinLimit(chosen.size, config.maxAttachmentMb);
    const content = (parsed.attachments ?? [])[chosen.index].content;
    return await this.deliver(Readable.from(content), {
      name: safeFilename(chosen.filename, chosen.contentType, chosen.index),
      contentType: chosen.contentType,
      size: chosen.size,
      inline: chosen.inline,
      strategy: "fallback",
      asBase64: query.asBase64 === true,
    });
  }

  private async deliver(
    source: Readable,
    meta: {
      name: string;
      contentType: string;
      size: number;
      inline: boolean;
      strategy: "part" | "fallback";
      asBase64: boolean;
    }
  ): Promise<AttachmentResult> {
    const base: AttachmentResult = {
      filename: meta.name,
      content_type: meta.contentType,
      size: meta.size,
      inline: meta.inline,
      strategy: meta.strategy,
      note: tnefNote(meta.contentType, meta.name),
    };

    if (meta.asBase64) {
      if (meta.size > MAX_BASE64_BYTES) {
        throw new Error(
          `Attachment is ${meta.size} bytes, over the ${MAX_BASE64_BYTES}-byte base64 limit. Call without as_base64 to save it to disk instead.`
        );
      }
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(chunk as Buffer);
      return { ...base, content_base64: Buffer.concat(chunks).toString("base64") };
    }

    await mkdir(path.resolve(config.attachmentDir), { recursive: true });
    const target = uniquePath(resolveInside(config.attachmentDir, meta.name));
    try {
      await pipeline(source, createWriteStream(target));
    } catch (err) {
      // Never leave half a file behind when the stream dies mid-transfer.
      await rm(target, { force: true });
      throw err;
    }
    return {
      ...base,
      filename: path.basename(target),
      saved_to: target,
      quarantined: await setQuarantine(target),
    };
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
