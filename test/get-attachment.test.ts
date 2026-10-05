/**
 * get_message / get_attachment end to end: the real ImapClient against stored
 * raw messages, with the IMAP connection replaced by helpers/fake-imap.ts.
 */

import assert from "node:assert/strict";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { EXPECTED } from "./helpers/expected.ts";
import { connect, fakeServer, type FakeMessage } from "./helpers/fake-imap.ts";
import { readMessage, readStructure } from "./helpers/fixtures.ts";
import {
  base64Lines,
  generatedMessage,
  MB,
  payloadOf,
  quotedPrintable,
} from "./helpers/generated.ts";
import { collectAttachmentParts, withAttachmentDir } from "./helpers/load.ts";

type Query = { index?: number; filename?: string; asBase64?: boolean };

async function stored(name: string, variant?: string | false): Promise<FakeMessage> {
  return {
    source: await readMessage(name),
    structure: variant === false ? undefined : await readStructure(name, variant),
  };
}

/**
 * Run one get_attachment call into a fresh temporary ATTACHMENT_DIR. The
 * directory is gone when this returns, so everything that looks at the saved
 * file belongs in `check`.
 */
async function fetchAttachment<T>(
  message: FakeMessage,
  query: Query,
  check: (seen: {
    result: Awaited<ReturnType<ReturnType<typeof connect>["downloadAttachment"]>>;
    server: ReturnType<typeof fakeServer>;
    dir: string;
  }) => T | Promise<T>,
  { limitMb = 25 }: { limitMb?: number } = {}
): Promise<T> {
  return withAttachmentDir(async (dir) => {
    const server = fakeServer(message);
    const result = await connect(server).downloadAttachment("INBOX", 1, query);
    return check({ result, server, dir });
  }, limitMb);
}

describe("get_message and get_attachment share one index row", () => {
  for (const [name, expected] of Object.entries(EXPECTED)) {
    test(`${name}: both lists, side by side`, async () => {
      const message = await stored(name);
      const listed = (await connect(fakeServer(message)).getMessage("INBOX", 1)).attachments;
      const walked = collectAttachmentParts(message.structure);
      const row = (a: { index: number; filename: string | null; contentType: string; inline: boolean }) =>
        [a.index, a.filename, a.contentType, a.inline];

      assert.deepEqual(listed.map(row), walked.map(row));
      assert.deepEqual(listed.map(row), expected.map(row));
    });
  }

  test("signature logo without a filename: index 1 is A.pdf on both sides (was blocker B1)", async () => {
    const message = await stored("inline-logo");
    const listed = (await connect(fakeServer(message)).getMessage("INBOX", 1)).attachments;
    assert.equal(listed[0].filename, null);
    assert.equal(listed[0].inline, true);
    assert.equal(listed[1].filename, "A.pdf");

    await fetchAttachment(message, { index: 1 }, ({ result }) => {
      assert.equal("filename" in result && result.filename, "A.pdf");
    });
  });

  test("an embedded part has a real index, not null, and get_message lists it (was the interim null)", async () => {
    const message = await stored("forward-multipart");
    const listed = (await connect(fakeServer(message)).getMessage("INBOX", 1)).attachments;
    const embedded = listed.find((a) => a.filename === "report.pdf");
    assert.ok(embedded, "get_message must list the embedded report.pdf");
    assert.equal(embedded.index, 1);
    assert.equal(typeof embedded.index, "number");
  });
});

describe("get_attachment by part", () => {
  for (const [name, expected] of Object.entries(EXPECTED)) {
    for (const want of expected) {
      test(`${name}[${want.index}] ${want.filename ?? "(unnamed)"} -> BODY[${want.part}]`, async () => {
        await fetchAttachment(await stored(name), { index: want.index }, async ({ result, server, dir }) => {
          assert.ok("saved_to" in result && result.saved_to);

          // The fake only knows RFC 3501 numbers: a wrong one returns another part or nothing.
          assert.deepEqual(server.downloads.map((d) => d.part), [want.part]);
          assert.equal(result.strategy, "part");
          assert.equal(result.content_type, want.contentType);
          assert.equal(result.inline, want.inline);
          assert.equal(path.dirname(result.saved_to), await realpath(dir));

          const onDisk = await readFile(result.saved_to);
          assert.equal(result.size, onDisk.length);
          if (want.content !== null) assert.equal(onDisk.toString("utf8"), want.content);
          else assert.match(onDisk.toString("utf8"), /^From: weiter@example\.test/);
        });
      });
    }
  }

  test("an unnamed inline image is saved under an index-based name (spec §8)", async () => {
    await fetchAttachment(await stored("inline-logo"), { index: 0 }, ({ result }) => {
      assert.ok("saved_to" in result);
      assert.equal(result.filename, "attachment-0.png");
      assert.equal(result.inline, true);
    });
  });

  test("by filename: a unique name is found", async () => {
    await fetchAttachment(await stored("two-attachments"), { filename: "B.pdf" }, async ({ result }) => {
      assert.ok("saved_to" in result);
      assert.equal(result.filename, "B.pdf");
      assert.equal(await readFile(result.saved_to, "utf8"), "%PDF-1.4 fake B.pdf\n");
    });
  });

  test("an embedded attachment can also be fetched by filename", async () => {
    await fetchAttachment(await stored("forward-twice-multipart"), { filename: "report.pdf" }, async ({ result, server }) => {
      assert.ok("saved_to" in result);
      assert.deepEqual(server.downloads.map((d) => d.part), ["2.1.2"]);
      assert.equal(await readFile(result.saved_to, "utf8"), "%PDF-1.4 fake report.pdf\n");
    });
  });

  test("a zero-byte attachment is written and reported, not an error (spec §8)", async () => {
    await withAttachmentDir(async (dir) => {
      const result = await connect(fakeServer(await stored("empty-attachment"))).downloadAttachment(
        "INBOX",
        1,
        { index: 0 }
      );
      assert.ok("saved_to" in result);
      assert.equal(result.size, 0);
      assert.equal((await stat(result.saved_to)).size, 0);
      assert.equal((await readdir(dir)).length, 1);
    });
  });

  test("reported size is the decoded size on disk, not the encoded size from the tree (was blocker B3)", async () => {
    const message = await stored("single-attachment");
    const encoded = collectAttachmentParts(message.structure)[0].size;
    await fetchAttachment(message, { index: 0 }, async ({ result }) => {
      assert.ok("saved_to" in result);
      assert.equal(result.size, "%PDF-1.4 fake report.pdf\n".length);
      assert.equal(result.size, (await stat(result.saved_to)).size);
      assert.ok(encoded > result.size, "the fixture must be one where the two differ");
    });
  });

  test("a small part in a big message is judged by the part, not the message (was blocker B4)", async () => {
    // 100 KB attachment: far under the 256 KB inline ceiling, in a message of any size.
    const payload = payloadOf(100 * 1024);
    const message = generatedMessage({ encoding: "base64", encodedBody: base64Lines(payload) });
    await fetchAttachment(message, { index: 0, asBase64: true }, ({ result }) => {
      assert.ok("content_base64" in result);
      assert.equal(result.size, payload.length);
      assert.equal(result.content_base64, payload.toString("base64"));
      assert.equal(result.saved_to, undefined);
    });
  });

  test("as_base64 above 256 KB is refused, names the size and writes nothing", async () => {
    const message = generatedMessage({ encoding: "base64", encodedBody: base64Lines(payloadOf(300 * 1024)) });
    await withAttachmentDir(async (dir) => {
      await assert.rejects(
        connect(fakeServer(message)).downloadAttachment("INBOX", 1, { index: 0, asBase64: true }),
        /Attachment is \d+ bytes \(0\.3 MB\), over the 256 KB base64 limit/
      );
      assert.deepEqual(await readdir(dir), []);
    });
  });

  test("the hostile name from the mail ends up as a plain file inside the target directory", async () => {
    await withAttachmentDir(async (dir) => {
      const result = await connect(fakeServer(await stored("hostile-name"))).downloadAttachment("INBOX", 1, {
        index: 0,
      });
      assert.ok("saved_to" in result);
      assert.equal(result.filename, "authorized_keys.pdf");
      assert.equal(result.saved_to, path.join(await realpath(dir), "authorized_keys.pdf"));
      assert.deepEqual(await readdir(dir), ["authorized_keys.pdf"]);
      // Nothing beside the target directory (e.g. a ".ssh" two levels up) was touched.
      assert.ok(!(await readdir(path.dirname(dir))).includes(".ssh"));
    });
  });
});

describe("name collisions on disk", () => {
  test("fetching the same attachment twice: second gets -1, first stays byte-identical", async () => {
    await withAttachmentDir(async (dir) => {
      const imap = connect(fakeServer(await stored("single-attachment")));
      const first = await imap.downloadAttachment("INBOX", 1, { index: 0 });
      const before = await readFile((first as { saved_to: string }).saved_to);
      const second = await imap.downloadAttachment("INBOX", 1, { index: 0 });

      assert.ok("saved_to" in first && "saved_to" in second);
      assert.equal(path.basename(first.saved_to), "report.pdf");
      assert.equal(path.basename(second.saved_to), "report-1.pdf");
      assert.equal(second.filename, "report-1.pdf");
      assert.deepEqual(await readFile(first.saved_to), before);
      assert.deepEqual((await readdir(dir)).sort(), ["report-1.pdf", "report.pdf"]);
    });
  });

  test("two parts with the same name in one mail land in two files with their own contents", async () => {
    await withAttachmentDir(async () => {
      const imap = connect(fakeServer(await stored("same-names")));
      const a = await imap.downloadAttachment("INBOX", 1, { index: 0 });
      const b = await imap.downloadAttachment("INBOX", 1, { index: 1 });
      assert.ok("saved_to" in a && "saved_to" in b);
      assert.equal(await readFile(a.saved_to, "utf8"), "first scan\n");
      assert.equal(await readFile(b.saved_to, "utf8"), "second scan\n");
      assert.notEqual(a.saved_to, b.saved_to);
    });
  });
});

describe("selection through the client", () => {
  test("index out of range is refused before any download", async () => {
    const message = await stored("two-attachments");
    const server = fakeServer(message);
    await withAttachmentDir(async () => {
      await assert.rejects(
        connect(server).downloadAttachment("INBOX", 1, { index: 2 }),
        /index 2 is out of range.*0\.\.1/
      );
    });
    assert.deepEqual(server.downloads, []);
  });

  test("a filename without a match lists what exists", async () => {
    await withAttachmentDir(async () => {
      await assert.rejects(
        connect(fakeServer(await stored("two-attachments"))).downloadAttachment("INBOX", 1, { filename: "C.pdf" }),
        /No attachment named "C\.pdf".*0: A\.pdf, 1: B\.pdf/
      );
    });
  });

  test("a filename with two matches returns the list with indexes and downloads nothing", async () => {
    const server = fakeServer(await stored("same-names"));
    await withAttachmentDir(async (dir) => {
      const result = await connect(server).downloadAttachment("INBOX", 1, { filename: "scan.pdf" });
      assert.ok("ambiguous" in result);
      assert.deepEqual(result.matches.map((m) => m.index), [0, 1]);
      assert.deepEqual(await readdir(dir), []);
    });
    assert.deepEqual(server.downloads, []);
  });
});

describe("size limit through the client", () => {
  test("over the limit: refused before the stream starts, message carries the size, nothing written", async () => {
    const payload = payloadOf(2 * MB);
    const message = generatedMessage({ encoding: "base64", encodedBody: base64Lines(payload) });
    const server = fakeServer(message);
    await withAttachmentDir(async (dir) => {
      await assert.rejects(
        connect(server).downloadAttachment("INBOX", 1, { index: 0 }),
        (err: Error) => {
          const size = Number(/Attachment is (\d+) bytes/.exec(err.message)?.[1]);
          // The tree only has encoded octets; the estimate must still be close to the real 2 MB.
          return size > 1.99 * MB && size <= payload.length && /over the 1 MB limit/.test(err.message);
        }
      );
      assert.deepEqual(await readdir(dir), []);
    }, 1);
    assert.deepEqual(server.downloads, [], "no BODY[] fetch may start for a refused attachment");
  });

  test("base64 attachment of 24.5 MB passes a 25 MB limit (was MAJOR C: the old estimate refused it)", async () => {
    const payload = payloadOf(Math.floor(24.5 * MB));
    const message = generatedMessage({ encoding: "base64", encodedBody: base64Lines(payload) });
    await fetchAttachment(message, { index: 0 }, async ({ result }) => {
      assert.ok("saved_to" in result);
      assert.equal(result.size, payload.length);
      assert.ok((await readFile(result.saved_to)).equals(payload), "bytes on disk differ from the payload");
    });
  });

  test("quoted-printable CSV of 16 MB passes a 25 MB limit although its encoded size is over it (was MAJOR B)", async () => {
    const line = "Müller;Größe;Äpfel;Übung;€\r\n";
    const times = Math.ceil((16 * MB) / Buffer.byteLength(line));
    const encodedLine = quotedPrintable(line);
    const encodedBody = encodedLine.repeat(times);
    const decodedLength = Buffer.byteLength(line) * times;
    assert.ok(decodedLength >= 16 * MB && decodedLength < 25 * MB, "precondition: payload under the limit");
    assert.ok(encodedBody.length > 25 * MB, "precondition: encoded size over the limit");

    const message = generatedMessage({ encoding: "quoted-printable", filename: "export.csv", type: "text/csv", encodedBody });
    await withAttachmentDir(async () => {
      const result = await connect(fakeServer(message)).downloadAttachment("INBOX", 1, { index: 0 });
      assert.ok("saved_to" in result);
      assert.equal(result.size, decodedLength);
      assert.equal(result.filename, "export.csv");
    });
  });

  test("download is capped one byte past the limit for a part whose size cannot be trusted", async () => {
    const message = generatedMessage({
      encoding: "quoted-printable",
      type: "text/csv",
      filename: "a.csv",
      encodedBody: "a,b\r\n",
    });
    const server = fakeServer(message);
    await withAttachmentDir(async () => {
      await connect(server).downloadAttachment("INBOX", 1, { index: 0 });
    }, 3);
    assert.deepEqual(server.downloads.map((d) => d.maxBytes), [3 * MB + 1]);
  });
});

describe("fallback path", () => {
  const names = Object.entries(EXPECTED).filter(([, e]) => e.length > 0);

  for (const [name, expected] of names) {
    for (const want of expected.filter((e) => e.content !== null)) {
      test(`${name}[${want.index}]: parser path returns the same file as the part path`, async () => {
        const viaPart = await withAttachmentDir(async () => {
          const r = await connect(fakeServer(await stored(name))).downloadAttachment("INBOX", 1, { index: want.index });
          assert.ok("saved_to" in r);
          return { r, bytes: await readFile(r.saved_to) };
        });
        const server = fakeServer(await stored(name, false));
        const viaParser = await withAttachmentDir(async () => {
          const r = await connect(server).downloadAttachment("INBOX", 1, { index: want.index });
          assert.ok("saved_to" in r);
          return { r, bytes: await readFile(r.saved_to) };
        });

        assert.equal(viaPart.r.strategy, "part");
        assert.equal(viaParser.r.strategy, "fallback");
        assert.deepEqual(server.downloads, [], "the fallback must not use BODY[] at all");
        assert.deepEqual(viaParser.bytes, viaPart.bytes);
        for (const key of ["filename", "content_type", "size", "inline"] as const) {
          assert.equal(viaParser.r[key], viaPart.r[key], key);
        }
      });
    }
  }

  test("a part tree cut off after the disposition hides a text/plain attachment — the parser path still delivers it", async () => {
    // Without the guard in mayHideAttachments the tree is empty and the tool says
    // "no attachments" (was MAJOR 1 of round 3).
    const message = await stored("text-attachment", "truncated");
    assert.deepEqual(collectAttachmentParts(message.structure), [], "precondition: the tree really shows nothing");

    const server = fakeServer(message);
    await withAttachmentDir(async () => {
      const result = await connect(server).downloadAttachment("INBOX", 1, { index: 0 });
      assert.ok("saved_to" in result);
      assert.equal(result.strategy, "fallback");
      assert.equal(result.filename, "notes.txt");
      assert.equal(await readFile(result.saved_to, "utf8"), "meine notizen\n");
    });
  });

  test("the parser path enforces the limit on the decoded size", async () => {
    const message = generatedMessage({ encoding: "base64", encodedBody: base64Lines(payloadOf(2 * MB)) });
    await withAttachmentDir(async (dir) => {
      await assert.rejects(
        connect(fakeServer({ source: message.source })).downloadAttachment("INBOX", 1, { index: 0 }),
        /Attachment is 2097152 bytes \(2\.0 MB\), over the 1 MB limit/
      );
      assert.deepEqual(await readdir(dir), []);
    }, 1);
  });
});

describe("a message without attachments", () => {
  test("is answered from the part tree alone: the full source is never loaded (was MINOR E)", async () => {
    const server = fakeServer(await stored("no-attachment"));
    await withAttachmentDir(async () => {
      await assert.rejects(connect(server).downloadAttachment("INBOX", 1, { index: 0 }), /no attachments/);
    });
    assert.deepEqual(server.fetches, [["bodyStructure"]]);
    assert.ok(!server.fetches.flat().includes("source"));
    assert.deepEqual(server.downloads, []);
  });

  test("with no part tree from the server it does fall back — and gives the same answer", async () => {
    const server = fakeServer(await stored("no-attachment", false));
    await withAttachmentDir(async () => {
      await assert.rejects(connect(server).downloadAttachment("INBOX", 1, { index: 0 }), /no attachments/);
    });
    assert.deepEqual(server.fetches, [["bodyStructure"], ["source"]]);
  });
});
