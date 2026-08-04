import { readFile } from "node:fs/promises";
import { validateCandidateResult } from "./contracts.mjs";

const [file] = process.argv.slice(2);
if (!file) throw new Error("usage: validate-result.mjs <result.json>");
const result = validateCandidateResult(JSON.parse(await readFile(file, "utf8")));
process.stdout.write(`${JSON.stringify(result)}\n`);
