// Writes the PNG out of a rea capture result file. Local evidence helper, dev-only.
//   node apps/web/uji/simpan-tangkapan.mjs <hasil.txt> <tujuan.png>
import { readFileSync, writeFileSync } from "node:fs";

const [, , source, target] = process.argv;
const result = JSON.parse(readFileSync(source, "utf8"));
const step = result.normalized_result.steps.at(-1);
const shot = step.artifacts.screenshot;
if (shot.state !== "captured") throw new Error(`screenshot ${shot.state}`);
writeFileSync(target, Buffer.from(shot.value.data_base64, "base64"));
console.log(`${target} ${shot.value.bytes} bytes sha256=${shot.value.sha256.slice(0, 16)}`);
