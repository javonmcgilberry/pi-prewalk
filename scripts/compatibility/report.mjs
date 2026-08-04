import { readFile } from "node:fs/promises";
import { upsertLedger, validateCandidateResult } from "./contracts.mjs";

const [bodyPath, resultPath] = process.argv.slice(2);
if (!bodyPath || !resultPath) throw new Error("usage: report.mjs <ledger-body.md> <result.json>");
const body = await readFile(bodyPath, "utf8").catch(() => "# Prewalk Pi compatibility ledger\n");
const result = validateCandidateResult(JSON.parse(await readFile(resultPath, "utf8")));
process.stdout.write(upsertLedger(body, result));
