// bun run --cwd apps/agent web:source-add --connector <id> --url <url> --name <name> [--category <slug>] [--team <uuid>]
// Example: web:source-add --connector feed --url https://example.com/feed.xml --name "Example blog"
import { createDb } from "@feedhound/db";
import { addWebSource } from "../src/web/source-add";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const connector = arg("connector");
const url = arg("url");
const name = arg("name");
if (!connector || !url || !name) {
  console.error("usage: web:source-add --connector <id> --url <url> --name <name> [--category <slug>] [--team <uuid>]");
  process.exit(1);
}

const handle = createDb();
try {
  const r = await addWebSource(handle, { connector, url, name, category: arg("category"), team: arg("team") });
  if (!r.ok) {
    console.error(`error: ${r.error}`);
    process.exitCode = 1;
  } else {
    console.log(r.created ? `created ${r.id}` : `exists ${r.id}`);
  }
} finally {
  await handle.close();
}
