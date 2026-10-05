/**
 * What each stored message must yield, written out by hand.
 *
 * `part` is the RFC 3501 number a server would accept for BODY[<part>]; it is
 * deliberately spelled out rather than computed, because computing it is exactly
 * what the code under test does. `content` is the decoded payload (null for a
 * `message/rfc822` wrapper, whose bytes are the whole embedded message).
 */

export interface Expected {
  index: number;
  part: string;
  filename: string | null;
  contentType: string;
  inline: boolean;
  content: string | null;
}

const pdf = (index: number, part: string, filename: string): Expected => ({
  index,
  part,
  filename,
  contentType: "application/pdf",
  inline: false,
  content: `%PDF-1.4 fake ${filename}\n`,
});

const eml = (index: number, part: string, filename: string): Expected => ({
  index,
  part,
  filename,
  contentType: "message/rfc822",
  inline: false,
  content: null,
});

const logo = (index: number, part: string, filename: string | null): Expected => ({
  index,
  part,
  filename,
  contentType: "image/png",
  inline: true,
  content: "PNG-fake-logo\n",
});

export const EXPECTED: Record<string, Expected[]> = {
  "single-attachment": [pdf(0, "2", "report.pdf")],
  "two-attachments": [pdf(0, "2", "A.pdf"), pdf(1, "3", "B.pdf")],
  "same-names": [
    { ...pdf(0, "2", "scan.pdf"), content: "first scan\n" },
    { ...pdf(1, "3", "scan.pdf"), content: "second scan\n" },
  ],
  // The signature logo has no filename and sits inside multipart/related.
  "inline-logo": [logo(0, "1.2", null), pdf(1, "2", "A.pdf"), pdf(2, "3", "B.pdf")],
  "forward-multipart": [eml(0, "2", "fwd.eml"), pdf(1, "2.2", "report.pdf")],
  "forward-singlepart": [eml(0, "2", "fwd.eml"), pdf(1, "2.1", "report.pdf")],
  "forward-twice-singlepart": [
    eml(0, "2", "fwd.eml"),
    eml(1, "2.1", "inner.eml"),
    pdf(2, "2.1.1", "report.pdf"),
  ],
  "forward-thrice-singlepart": [
    eml(0, "2", "fwd.eml"),
    eml(1, "2.1", "inner.eml"),
    eml(2, "2.1.1", "innermost.eml"),
    pdf(3, "2.1.1.1", "report.pdf"),
  ],
  "forward-twice-multipart": [
    eml(0, "2", "fwd.eml"),
    eml(1, "2.1", "inner.eml"),
    pdf(2, "2.1.2", "report.pdf"),
  ],
  "logo-and-forward": [
    logo(0, "2", "logo.png"),
    eml(1, "3", "fwd.eml"),
    pdf(2, "3.2", "report.pdf"),
  ],
  "no-attachment": [],
  "text-attachment": [
    {
      index: 0,
      part: "2",
      filename: "notes.txt",
      contentType: "text/plain",
      inline: false,
      content: "meine notizen\n",
    },
  ],
  "empty-attachment": [{ ...pdf(0, "2", "empty.pdf"), content: "" }],
};
