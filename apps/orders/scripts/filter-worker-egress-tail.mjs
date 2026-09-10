import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of input) {
  const value = parseJson(line);
  if (value !== null) visit(value);
}

function visit(value) {
  if (value == null) return;
  if (typeof value === "string") {
    if (!value.includes("supabase_egress")) return;
    const parsed = parseJson(value);
    if (parsed !== null) visit(parsed);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visit(item);
    return;
  }
  if (typeof value !== "object") return;
  if (value.supabase_egress && typeof value.supabase_egress === "object") {
    process.stdout.write(`${JSON.stringify(value.supabase_egress)}\n`);
    return;
  }
  for (const child of Object.values(value)) visit(child);
}

function parseJson(value) {
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}
