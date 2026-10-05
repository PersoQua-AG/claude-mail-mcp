/**
 * Messages that must be built rather than stored: the cases about size need
 * megabytes of payload, and a 33 MB fixture file has no place in the repository.
 * Same shape as the stored ones — a raw message plus its part tree.
 */

import type { MessageStructureObject } from "imapflow";
import type { FakeMessage } from "./fake-imap.ts";

export const MB = 1024 * 1024;

/** RFC 2045 base64: 76 characters per line, CRLF between lines. */
export function base64Lines(payload: Buffer, lineLength = 76): string {
  return payload.toString("base64").replace(new RegExp(`.{${lineLength}}(?!$)`, "g"), "$&\r\n");
}

/** Quoted-printable for text whose every line is short enough to need no soft break. */
export function quotedPrintable(text: string): string {
  return Buffer.from(text, "utf8").reduce(
    (out, byte) =>
      byte === 0x0d || byte === 0x0a || (byte >= 0x20 && byte <= 0x7e && byte !== 0x3d)
        ? out + String.fromCharCode(byte)
        : out + `=${byte.toString(16).toUpperCase().padStart(2, "0")}`,
    ""
  );
}

export interface GeneratedOptions {
  filename?: string;
  type?: string;
  encoding: "base64" | "quoted-printable";
  /** The attachment body exactly as it travels. */
  encodedBody: string;
  /** What the server's BODYSTRUCTURE claims; defaults to the real encoded length. */
  declaredSize?: number;
}

/** `multipart/mixed[ text/plain, <one attachment> ]`. */
export function generatedMessage(o: GeneratedOptions): FakeMessage {
  const filename = o.filename ?? "data.bin";
  const type = o.type ?? "application/octet-stream";
  const boundary = "=_generated";
  const source = [
    "From: absender@example.test",
    "Subject: generated",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    "Hallo.",
    `--${boundary}`,
    `Content-Type: ${type}; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    `Content-Transfer-Encoding: ${o.encoding}`,
    "",
    o.encodedBody,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const structure: MessageStructureObject = {
    type: "multipart/mixed",
    childNodes: [
      { part: "1", type: "text/plain", encoding: "7bit", size: 6 },
      {
        part: "2",
        type,
        encoding: o.encoding,
        size: o.declaredSize ?? o.encodedBody.length,
        disposition: "attachment",
        dispositionParameters: { filename },
      },
    ],
  };
  return { source: Buffer.from(source, "latin1"), structure };
}

/** Deterministic, incompressible-looking bytes — no RNG, so every run is identical. */
export function payloadOf(size: number): Buffer {
  const out = Buffer.allocUnsafe(size);
  let x = 0x2545f491;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}
