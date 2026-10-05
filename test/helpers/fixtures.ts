/**
 * Reads the stored raw messages (`fixtures/messages/*.eml`) and their
 * BODYSTRUCTURE as an IMAP server sends it (`fixtures/structures/*.bs`).
 *
 * The wire text goes through imapflow's own parser, so the part tree under test
 * is the one production sees — including its quirks, such as giving an
 * encapsulated message the same part number as its wrapper.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MessageStructureObject } from "imapflow";

const require = createRequire(import.meta.url);
// imapflow's package.json has no `exports` map, so its lib/ files are reachable.
const { parser } = require("imapflow/lib/handler/imap-handler");
const tools = require("imapflow/lib/tools");

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export const readMessage = (name: string): Promise<Buffer> =>
  readFile(path.join(fixtures, "messages", `${name}.eml`));

/** `variant` selects `<name>.<variant>.bs`, e.g. "truncated". */
export async function readStructure(
  name: string,
  variant?: string
): Promise<MessageStructureObject> {
  const file = variant ? `${name}.${variant}.bs` : `${name}.bs`;
  const wire = (await readFile(path.join(fixtures, "structures", file), "utf8")).trim();
  return parseStructure(wire);
}

export async function parseStructure(wire: string): Promise<MessageStructureObject> {
  const response = await parser(Buffer.from(`* 1 FETCH (UID 1 BODYSTRUCTURE ${wire})`), {});
  const attributes = response.attributes[1] as Array<{ value?: string }>;
  const at = attributes.findIndex((a) => a.value === "BODYSTRUCTURE");
  return tools.parseBodystructure(attributes[at + 1]);
}
