/**
 * Pure functions of src/attachments.ts: filename building, containment,
 * limits, collision handling, part-tree walk, selection.
 * End-to-end behaviour through ImapClient lives in get-attachment.test.ts.
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { EXPECTED } from "./helpers/expected.ts";
import { readStructure } from "./helpers/fixtures.ts";
import {
  assertWithinLimit,
  collectAttachmentParts,
  decodedSize,
  mayHideAttachments,
  openUnique,
  resolveInside,
  safeFilename,
  selectAttachment,
} from "./helpers/load.ts";

const target = path.join(os.tmpdir(), "claude-mail-mcp-containment");

async function inTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "claude-mail-mcp-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("safeFilename", () => {
  test("strips path separators of both kinds and keeps only the last segment", () => {
    assert.equal(safeFilename("a/b/c.pdf", "application/pdf", 0), "c.pdf");
    assert.equal(safeFilename("a\\b\\c.pdf", "application/pdf", 0), "c.pdf");
    assert.equal(safeFilename("/etc/passwd", "application/pdf", 0), "passwd.pdf");
    assert.equal(safeFilename("C:\\Windows\\evil.pdf", "application/pdf", 0), "evil.pdf");
  });

  test("traversal sequences cannot survive, the §5.1 example lands as authorized_keys", () => {
    // No extension of its own and an unknown type: ".bin" is appended.
    assert.equal(
      safeFilename("../../.ssh/authorized_keys", "application/octet-stream", 0),
      "authorized_keys.bin"
    );
    assert.equal(safeFilename("..\\..\\x.pdf", "application/pdf", 0), "x.pdf");
    assert.equal(safeFilename("....//....//x.pdf", "application/pdf", 0), "x.pdf");
  });

  test("NUL byte is removed, so nothing after it can truncate the name in a C API", () => {
    const name = safeFilename("report.pdf\u0000.exe", "application/pdf", 0);
    assert.ok(!name.includes("\u0000"));
    assert.equal(name, "report.pdf.exe.pdf");
  });

  test("control characters are removed", () => {
    for (let code = 0; code < 0x20; code++) {
      const name = safeFilename(`a${String.fromCharCode(code)}b.pdf`, "application/pdf", 0);
      // \t \n \r are whitespace for the trimming step but still inside the name here.
      assert.ok(!/[\u0000-\u001f\u007f]/.test(name), `U+${code.toString(16)} survived: ${JSON.stringify(name)}`);
    }
    assert.equal(safeFilename("a\u007fb.pdf", "application/pdf", 0), "ab.pdf");
  });

  test("empty, blank and missing names become attachment-<index> plus the type's extension", () => {
    for (const raw of ["", "   ", null, undefined, "\u0000\u0001"]) {
      assert.equal(safeFilename(raw, "application/pdf", 3), "attachment-3.pdf", JSON.stringify(raw));
    }
    assert.equal(safeFilename("", "image/png", 0), "attachment-0.png");
    assert.equal(safeFilename("", "application/x-unknown", 0), "attachment-0.bin");
  });

  test("a name made only of dots is treated as no name", () => {
    for (const raw of [".", "..", "...", "....", ". . ."]) {
      assert.equal(safeFilename(raw, "application/pdf", 1), "attachment-1.pdf", raw);
    }
  });

  test("a 500-character name is cut to 200 and keeps its extension", () => {
    const name = safeFilename(`${"x".repeat(496)}.pdf`, "application/pdf", 0);
    assert.equal(name.length, 200);
    assert.ok(name.endsWith(".pdf"));
    // Without an extension of its own, the appended one must also survive the cut.
    const bare = safeFilename("y".repeat(500), "application/pdf", 0);
    assert.ok(bare.length <= 200);
    assert.ok(bare.endsWith(".pdf"));
  });

  test("extension is checked against the declared type (§5.1)", () => {
    assert.equal(safeFilename("invoice.pdf.exe", "application/pdf", 0), "invoice.pdf.exe.pdf");
    assert.equal(safeFilename("report.2026", "application/pdf", 0), "report.2026.pdf");
    assert.equal(safeFilename("a.jpeg", "image/jpeg", 0), "a.jpeg");
    assert.equal(safeFilename("a.PDF", "application/pdf", 0), "a.PDF");
    assert.equal(safeFilename("x.", "application/pdf", 0), "x.pdf");
  });

  test("bidi formatting characters are stripped, legitimate names are untouched", () => {
    const bidi = [
      "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", // embeddings and overrides
      "\u2066", "\u2067", "\u2068", "\u2069", // isolates
      "\u200e", "\u200f", "\u061c", // marks
    ];
    for (const c of bidi) {
      assert.equal(
        safeFilename(`${c}exe.pdf`, "application/pdf", 0),
        "exe.pdf",
        `U+${c.codePointAt(0)!.toString(16)} survived`
      );
    }
    // The classic: the override makes this display as "...fdp.exe".
    assert.equal(safeFilename("invoice\u202Efdp.exe", "application/pdf", 0), "invoicefdp.exe.pdf");
    for (const legal of ["חשבון.pdf", "Rechnung Müller.pdf", "normal.pdf", "日本語.pdf"]) {
      assert.equal(safeFilename(legal, "application/pdf", 0), legal);
    }
  });
});

describe("path containment", () => {
  // Names an attacker can put in a mail. After safeFilename AND resolveInside the
  // result must be a direct child of the target directory — no exception to catch.
  const hostile = [
    "../../.ssh/authorized_keys",
    "..\\..\\evil.pdf",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    // NFKC folds these onto "/", "\\" and "."; NFKC must run before the strip.
    "\uff0e\uff0e\uff0f\uff0e\uff0e\uff0fescape.pdf", // ．．／．．／
    "\u2025\uff0fescape.pdf", // ‥／
    "..\uff3c..\uff3cescape.pdf", // ..＼..＼
    "\uff0f\uff0f\uff0fabs.pdf",
    // Look-alikes NFKC leaves alone: harmless for the file system, must not break containment.
    "..\u2215..\u2215escape.pdf", // DIVISION SLASH
    "..\u29f8escape.pdf", // BIG SOLIDUS
    "a\u0000/../../b.pdf",
    "....",
    "",
  ];

  test("every hostile name resolves to a direct child of the target directory", () => {
    const root = path.resolve(target);
    for (const raw of hostile) {
      const name = safeFilename(raw, "application/pdf", 0);
      const full = resolveInside(root, name);
      assert.equal(path.dirname(full), root, `${JSON.stringify(raw)} -> ${JSON.stringify(name)} -> ${full}`);
    }
  });

  test("full-width separators collapse onto real ones before they are stripped", () => {
    assert.equal(safeFilename("\uff0e\uff0e\uff0f\uff0e\uff0e\uff0fescape.pdf", "application/pdf", 0), "escape.pdf");
    assert.equal(safeFilename("..\uff3c..\uff3cescape.pdf", "application/pdf", 0), "escape.pdf");
  });

  test("resolveInside is a second line of defence: it refuses what safeFilename would never pass", () => {
    const root = path.resolve(target);
    for (const bad of ["../x", "../../x", "a/../../x", path.resolve("/etc/passwd"), ".", ""]) {
      assert.throws(() => resolveInside(root, bad), /Refusing to write/, JSON.stringify(bad));
    }
  });

  test("a sibling directory that merely shares the prefix is outside", () => {
    assert.throws(() => resolveInside(target, `../${path.basename(target)}-evil/x.pdf`), /escapes/);
  });
});

describe("size limit", () => {
  test("rejects above the limit and names the size in bytes and MB", () => {
    const limit = 25 * 1024 * 1024;
    assert.throws(
      () => assertWithinLimit(limit + 1, 25),
      (err: Error) =>
        err.message.includes(String(limit + 1)) &&
        err.message.includes("25.0 MB") &&
        err.message.includes("MAX_ATTACHMENT_MB")
    );
  });

  test("exactly the limit passes, zero bytes pass", () => {
    assertWithinLimit(25 * 1024 * 1024, 25);
    assertWithinLimit(0, 25);
  });

  test("decodedSize: base64 is a lower estimate of the real bytes for standard 76-octet lines", () => {
    // 1 MiB of payload as RFC 2045 base64: 57 bytes -> 76 chars + CRLF.
    const payload = 1024 * 1024;
    const encoded = Math.ceil(payload / 57) * 78;
    const estimate = decodedSize(encoded, "base64")!;
    assert.ok(estimate <= payload, `${estimate} should not exceed ${payload}`);
    assert.ok(estimate > payload - 200, `${estimate} is too far below ${payload}`);
  });

  test("decodedSize: quoted-printable cannot be told from the size, other encodings pass through", () => {
    assert.equal(decodedSize(1000, "quoted-printable"), undefined);
    assert.equal(decodedSize(1000, "7bit"), 1000);
    assert.equal(decodedSize(1000, ""), 1000);
    assert.equal(decodedSize(10, "base64"), 0);
  });
});

describe("openUnique", () => {
  test("the second file of the same name gets a suffix, the first stays untouched", async () => {
    await inTempDir(async (dir) => {
      const full = path.join(dir, "report.pdf");
      const first = await openUnique(full);
      await first.handle.writeFile("FIRST");
      await first.handle.close();
      const second = await openUnique(full);
      await second.handle.writeFile("SECOND");
      await second.handle.close();
      const third = await openUnique(full);
      await third.handle.close();

      assert.equal(first.target, full);
      assert.equal(second.target, path.join(dir, "report-1.pdf"));
      assert.equal(third.target, path.join(dir, "report-2.pdf"));
      assert.equal(await readFile(full, "utf8"), "FIRST");
      assert.equal(await readFile(second.target, "utf8"), "SECOND");
    });
  });

  test("a name without extension gets the suffix at the end", async () => {
    await inTempDir(async (dir) => {
      const full = path.join(dir, "README");
      await (await openUnique(full)).handle.close();
      const second = await openUnique(full);
      await second.handle.close();
      assert.equal(second.target, path.join(dir, "README-1"));
    });
  });

  test("hands out the 1000th name, then gives up with a readable message and leaks no descriptor", async () => {
    await inTempDir(async (dir) => {
      await writeFile(path.join(dir, "a.pdf"), "");
      for (let n = 1; n < 999; n++) await writeFile(path.join(dir, `a-${n}.pdf`), "");
      const fdCount = async (): Promise<number | null> =>
        readdir("/dev/fd").then((l) => l.length, () => null);

      // 999 names taken (a.pdf, a-1 … a-998): the last one inside the bound is a-999.
      const last = await openUnique(path.join(dir, "a.pdf"));
      await last.handle.close();
      assert.equal(last.target, path.join(dir, "a-999.pdf"));

      const before = await fdCount();
      await assert.rejects(openUnique(path.join(dir, "a.pdf")), /Too many files named like a\.pdf/);
      const after = await fdCount();
      if (before !== null && after !== null) assert.equal(after, before, "open descriptors changed");
      assert.equal((await readdir(dir)).length, 1000, "no 1001st file may appear");
    });
  });

  test("a planted symlink at the target name is not followed", async () => {
    const { symlink } = await import("node:fs/promises");
    await inTempDir(async (dir) => {
      const victim = path.join(dir, "victim.txt");
      await writeFile(victim, "ORIGINAL");
      await symlink(victim, path.join(dir, "a.pdf"));
      const opened = await openUnique(path.join(dir, "a.pdf"));
      await opened.handle.writeFile("NEW");
      await opened.handle.close();
      assert.equal(opened.target, path.join(dir, "a-1.pdf"));
      assert.equal(await readFile(victim, "utf8"), "ORIGINAL");
    });
  });
});

describe("collectAttachmentParts — part tree", () => {
  for (const [name, expected] of Object.entries(EXPECTED)) {
    test(`${name}: indexes, part numbers, names and inline flag`, async () => {
      const parts = collectAttachmentParts(await readStructure(name));
      assert.deepEqual(
        parts.map(({ index, part, filename, contentType, inline }) => ({
          index,
          part,
          filename,
          contentType,
          inline,
        })),
        expected.map(({ index, part, filename, contentType, inline }) => ({
          index,
          part,
          filename,
          contentType,
          inline,
        }))
      );
    });
  }

  test("an inline image is marked inline and still listed", async () => {
    const [logo] = collectAttachmentParts(await readStructure("inline-logo"));
    assert.equal(logo.inline, true);
    assert.equal(logo.filename, null);
  });

  test("no tree, no parts", () => {
    assert.deepEqual(collectAttachmentParts(undefined), []);
  });

  test("a single-part message is addressed as part 1, an embedded message as 1.1 (RFC 3501)", async () => {
    const pdf = { type: "application/pdf", size: 10, disposition: "attachment" };
    assert.equal(collectAttachmentParts(pdf)[0].part, "1");
    const wrapped = collectAttachmentParts({ type: "message/rfc822", size: 20, childNodes: [pdf] });
    assert.deepEqual(wrapped.map((p) => p.part), ["1", "1.1"]);
  });

  test("the imapflow numbers differ from the RFC ones — the code must not read node.part", async () => {
    // Documents why the walk derives numbers itself: this is what the parser hands over.
    const root = await readStructure("forward-singlepart");
    const wrapper = root.childNodes![1];
    assert.equal(wrapper.part, "2");
    assert.equal(wrapper.childNodes![0].part, "2", "imapflow reuses the wrapper's number");
    assert.equal(collectAttachmentParts(root)[1].part, "2.1");
  });
});

describe("mayHideAttachments", () => {
  test("a plain multipart/alternative body hides nothing — its children are variants of one text", async () => {
    assert.equal(mayHideAttachments(await readStructure("no-attachment")), false);
  });

  test("no tree at all, or a text part without disposition next to siblings, may hide one", async () => {
    assert.equal(mayHideAttachments(undefined), true);
    assert.equal(mayHideAttachments(await readStructure("text-attachment", "truncated")), true);
  });
});

describe("selectAttachment", () => {
  const parts = [
    { index: 0, part: "1.2", filename: null, contentType: "image/png", size: 1, encoding: "base64", inline: true },
    { index: 1, part: "2", filename: "A.pdf", contentType: "application/pdf", size: 1, encoding: "base64", inline: false },
    { index: 2, part: "3", filename: "A.pdf", contentType: "application/pdf", size: 1, encoding: "base64", inline: false },
    { index: 3, part: "4", filename: "B.pdf", contentType: "application/pdf", size: 1, encoding: "base64", inline: false },
  ];

  test("by index", () => {
    assert.equal((selectAttachment(parts, { index: 3 }) as { part: string }).part, "4");
    assert.equal((selectAttachment(parts, { index: 0 }) as { part: string }).part, "1.2");
  });

  test("index out of range: names the valid range", () => {
    for (const index of [4, 99, -1]) {
      assert.throws(
        () => selectAttachment(parts, { index }),
        (err: Error) => err.message.includes(`index ${index}`) && err.message.includes("0..3"),
        String(index)
      );
    }
  });

  test("filename without a match: lists what is available, unnamed ones marked", () => {
    assert.throws(
      () => selectAttachment(parts, { filename: "C.pdf" }),
      (err: Error) =>
        err.message.includes('"C.pdf"') &&
        err.message.includes("0: (unnamed)") &&
        err.message.includes("3: B.pdf")
    );
  });

  test("filename with two matches: returns both, does not guess", () => {
    const result = selectAttachment(parts, { filename: "A.pdf" });
    assert.ok(Array.isArray(result));
    assert.deepEqual(result.map((p: { index: number }) => p.index), [1, 2]);
  });

  test("filename with one match: that part", () => {
    assert.equal((selectAttachment(parts, { filename: "B.pdf" }) as { index: number }).index, 3);
  });

  test("index XOR filename", () => {
    assert.throws(() => selectAttachment(parts, {}), /exactly one/);
    assert.throws(() => selectAttachment(parts, { index: 1, filename: "A.pdf" }), /exactly one/);
  });

  test("a message without attachments says so, before looking at the selector", () => {
    assert.throws(() => selectAttachment([], { index: 0 }), /no attachments/);
    assert.throws(() => selectAttachment([], { filename: "x" }), /no attachments/);
  });
});
