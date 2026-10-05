/**
 * Five defects that go into the PR open, on purpose (G2 round 3, findings 3–7).
 * Each test below pins what the code does TODAY, so that fixing one turns its
 * test red instead of leaving it unnoticed. When you fix a gap: change the
 * assertion to the correct behaviour and rename the test — do not delete it.
 *
 * None of them endangers the size ceiling, the target directory or the filename.
 */

import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { describe, test } from "node:test";
import { connect, fakeServer } from "./helpers/fake-imap.ts";
import { base64Lines, generatedMessage, MB, payloadOf } from "./helpers/generated.ts";
import { decodedSize, withAttachmentDir } from "./helpers/load.ts";

const require = createRequire(import.meta.url);
const { LimitedPassthrough } = require("imapflow/lib/limited-passthrough.js");

const get = (server: ReturnType<typeof fakeServer>, query: { index: number; asBase64?: boolean }) =>
  connect(server).downloadAttachment("INBOX", 1, query);

describe("known gaps — current behaviour, to be flipped when fixed", () => {
  test("KNOWN GAP 1: the base64 estimate is no lower bound for lines shorter than 76 octets", async () => {
    // decodedSize assumes the longest legal line (57 source bytes per 78 octets).
    // A sender that wraps at 72 makes it overshoot, and since the estimate is
    // checked BEFORE the download, a legal attachment is refused for good.
    // Fix: a real lower bound (e.g. size * 45 / 62), then expect delivery here.
    const payload = payloadOf(1 * MB - 1000); // under the 1 MB limit
    const encodedBody = base64Lines(payload, 72);
    const message = generatedMessage({ encoding: "base64", encodedBody });

    const estimate = decodedSize(encodedBody.length, "base64")!;
    assert.ok(estimate > payload.length, `estimate ${estimate} overshoots the real ${payload.length}`);

    const server = fakeServer(message);
    await withAttachmentDir(async (dir) => {
      await assert.rejects(get(server, { index: 0 }), /Attachment is \d+ bytes.*over the 1 MB limit/);
      assert.deepEqual(await readdir(dir), []);
    }, 1);
    assert.deepEqual(server.downloads, [], "refused before the stream, so the post-write check never gets a say");
  });

  test("KNOWN GAP 2: an oversized quoted-printable part is reported as ceiling+1, not its real size", async () => {
    // maxBytes cuts the stream one byte past the limit, and the after-write check
    // then measures the cut file. The message misleads: raising the limit by one
    // byte does not help. Fix: report the true size (needs the length seen on the
    // wire), then expect it here instead of 1048577.
    const encodedBody = `${"x".repeat(70)}\r\n`.repeat(Math.ceil((2 * MB) / 72));
    const message = generatedMessage({ encoding: "quoted-printable", type: "text/plain", filename: "big.txt", encodedBody });
    await withAttachmentDir(async (dir) => {
      await assert.rejects(
        get(fakeServer(message), { index: 0 }),
        /Attachment is 1048577 bytes \(1\.0 MB\), over the 1 MB limit/
      );
      assert.deepEqual(await readdir(dir), [], "the cut file is removed");
    }, 1);
  });

  test("KNOWN GAP 3: a download without metadata ends in a bare TypeError", async () => {
    // imapflow answers `{}` when the server returns nothing for a part (a part
    // number that does not exist, an odd server). `dl.meta` is used unchecked.
    // Fix: a message that says the part could not be fetched.
    const message = generatedMessage({ encoding: "base64", encodedBody: base64Lines(payloadOf(100)) });
    await withAttachmentDir(async (dir) => {
      await assert.rejects(
        get(fakeServer(message, { download: () => ({}) }), { index: 0 }),
        (err: unknown) => err instanceof TypeError && /Cannot read properties of undefined/.test(err.message)
      );
      assert.deepEqual(await readdir(dir), []);
    });
  });

  test("KNOWN GAP 4: maxBytes only stops the reader — the whole part still crosses the wire", async () => {
    // imapflow's LimitedPassthrough drops the chunks past the cap without
    // stopping the FETCH, so a 500 MB quoted-printable attachment is pulled in
    // full before it is refused. Disk use is bounded (limit + 1), time and
    // bandwidth are not. Fix would have to abort the transfer; no cheap one exists.
    const chunk = Buffer.alloc(512 * 1024, "x");
    let pulledFromServer = 0;
    const message = generatedMessage({ encoding: "quoted-printable", type: "text/plain", filename: "big.txt", encodedBody: "x" });
    const server = fakeServer(message, {
      download: (_part, opts) => ({
        meta: { contentType: "text/plain", encoding: "quoted-printable" },
        content: Readable.from(
          (function* () {
            for (let i = 0; i < 5; i++) {
              pulledFromServer += chunk.length;
              yield chunk;
            }
          })()
        ).pipe(new LimitedPassthrough({ maxBytes: opts.maxBytes })),
      }),
    });
    await withAttachmentDir(async () => {
      await assert.rejects(get(server, { index: 0 }), /Attachment is 1048577 bytes/);
    }, 1);
    assert.equal(server.downloads[0].maxBytes, 1 * MB + 1);
    assert.equal(pulledFromServer, 5 * chunk.length, "all 2.5 MB were pulled although only 1 MB + 1 was kept");
  });

  test("KNOWN GAP 4 (dependency): the limiter discards silently, it never signals an error", () => {
    // What gap 4 and gap 2 rest on. If an imapflow update makes the limiter
    // throw or stop the transfer, this fails and both gaps need a second look.
    const limiter = new LimitedPassthrough({ maxBytes: 10 });
    let failed = false;
    limiter.on("error", () => (failed = true));
    for (let i = 0; i < 5; i++) assert.equal(limiter.write(Buffer.alloc(8)), true);
    assert.equal(limiter.processed, 10);
    assert.equal(limiter.limited, true);
    assert.equal(failed, false);
  });

  test("KNOWN GAP 5: MAX_ATTACHMENT_MB=0 does not block as_base64 on quoted-printable (or tiny base64) parts", async () => {
    // config.int() has no lower bound, and the as_base64 branch of deliver()
    // never compares with maxAttachmentMb — only the pre-check and the
    // after-write check do, and neither runs here. Misconfiguration, not an
    // attack. Fix: reject MAX_ATTACHMENT_MB < 1 in config.ts, then expect a
    // rejection here.
    const qp = generatedMessage({ encoding: "quoted-printable", type: "text/plain", filename: "a.txt", encodedBody: "hello\r\n" });
    // Under 57 bytes the base64 estimate is 0, which is not "> 0 MB".
    const b64 = generatedMessage({ encoding: "base64", encodedBody: base64Lines(payloadOf(20)) });
    await withAttachmentDir(async () => {
      for (const message of [qp, b64]) {
        const result = await get(fakeServer(message), { index: 0, asBase64: true });
        assert.ok("content_base64" in result && result.content_base64.length > 0);
      }
    }, 0);
  });

  test("KNOWN GAP 5 (contrast): with MAX_ATTACHMENT_MB=0 the same part is refused when saved to disk", async () => {
    // Shows the hole is specific to as_base64.
    const qp = generatedMessage({ encoding: "quoted-printable", type: "text/plain", filename: "a.txt", encodedBody: "hello\r\n" });
    await withAttachmentDir(async (dir) => {
      await assert.rejects(get(fakeServer(qp), { index: 0 }), /over the 0 MB limit/);
      assert.deepEqual(await readdir(dir), []);
    }, 0);
  });
});
