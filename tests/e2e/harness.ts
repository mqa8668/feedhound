import { schema, type DbHandle } from "../../packages/db/src/index";
import { PgBoss } from "../../apps/api/node_modules/pg-boss";
import type { Subprocess } from "bun";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;

/** Throws unless the database name (URL path) ends in `_test`. Runs before any connection or spawn. */
export function assertTestDatabase(url: string): void {
  let name: string;
  try {
    name = new URL(url).pathname.replace(/^\//, "");
  } catch {
    throw new Error("e2e: TEST_DATABASE_URL is not a valid URL");
  }
  if (!name.endsWith("_test")) throw new Error(`e2e: refusing to run against non-test database: ${name || "unknown"}`);
}

export interface RunFixture {
  run: string;
  teamId: string;
  userId: string;
  chatId: number;
  notifierId: string;
  sourceId: string;
  apiKey: string;
  watchId: string;
  term: string;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function createFixture(handle: DbHandle): Promise<RunFixture> {
  const run = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const term = `e2e${run}`;
  const chatId = 100_000_000 + Math.floor(Math.random() * 800_000_000);
  const [team] = await handle.db.insert(schema.team).values({ name: `e2e-${run}` }).returning({ id: schema.team.id });
  const teamId = team!.id;
  const [user] = await handle.db
    .insert(schema.user)
    .values({ teamId, email: `e2e-${run}@example.com`, role: "hunter", telegramChatId: String(chatId) })
    .returning({ id: schema.user.id });
  const userId = user!.id;
  const [notifier] = await handle.db
    .insert(schema.notifier)
    .values({ userId, kind: "telegram", config: { chatId, mode: "instant" }, enabled: true })
    .returning({ id: schema.notifier.id });
  const notifierId = notifier!.id;
  const apiKey = `sk_e2e_${crypto.randomUUID().replaceAll("-", "")}`;
  const [key] = await handle.db
    .insert(schema.apiKey)
    .values({ userId, name: `e2e-${run}`, prefix: apiKey.slice(0, 8), hash: await sha256Hex(apiKey), scopes: ["ingest"] })
    .returning({ id: schema.apiKey.id });
  const [source] = await handle.db
    .insert(schema.source)
    .values({ teamId, kind: "web", platformId: `e2e-${run}`, name: `e2e ${run}`, url: `https://feeds.example.test/e2e-${run}`, assignedKeyId: key!.id })
    .returning({ id: schema.source.id });
  const sourceId = source!.id;
  const [watch] = await handle.db
    .insert(schema.watch)
    .values({ userId, name: `e2e-${run}`, enabled: true, include: [term], sourceIds: [sourceId], notifierIds: [notifierId] })
    .returning({ id: schema.watch.id });
  return { run, teamId, userId, chatId, notifierId, sourceId, apiKey, watchId: watch!.id, term };
}

export function bossFor(url: string, schemaName: string): PgBoss {
  return new PgBoss({ connectionString: url, schema: schemaName });
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = s.port!;
  await s.stop(true);
  return port;
}

async function pump(stream: ReadableStream<Uint8Array> | null | undefined, lines: string[]): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    rest += decoder.decode(chunk, { stream: true });
    const parts = rest.split("\n");
    rest = parts.pop() ?? "";
    lines.push(...parts);
    if (lines.length > 200) lines.splice(0, lines.length - 200);
  }
}

const spawned = new Set<Subprocess>();
function killSpawned(): void {
  for (const p of spawned) p.kill("SIGKILL");
}
process.on("exit", killSpawned);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    killSpawned();
    process.exit(130);
  });
}

export async function spawnAgent(env: Record<string, string>): Promise<{ proc: Subprocess; port: number; logTail(): string }> {
  const port = await freePort();
  const lines: string[] = [];
  const proc = Bun.spawn([process.execPath, "tests/e2e/agent.fixture.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env, AGENT_PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  spawned.add(proc);
  void proc.exited.then(() => spawned.delete(proc));
  void pump(proc.stdout as ReadableStream<Uint8Array>, lines);
  void pump(proc.stderr as ReadableStream<Uint8Array>, lines);
  const logTail = () => lines.slice(-40).join("\n");
  let exited = false;
  void proc.exited.then(() => {
    exited = true;
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`agent exited during boot\n${logTail()}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (res.status === 200) return { proc, port, logTail };
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill("SIGKILL");
  throw new Error(`agent not ready within 15 s\n${logTail()}`);
}

export async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() >= deadline) throw new Error(`timeout after ${timeoutMs} ms waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Idempotent: removes the run's rows and its pg-boss schema. Agents/boss/mocks are closed by the caller. */
export async function teardown(handle: DbHandle, fx: RunFixture, bossSchema: string | undefined): Promise<void> {
  const { sql } = handle;
  if (bossSchema !== undefined) {
    if (!/^pgboss_e2e_[0-9a-f]+$/.test(bossSchema)) throw new Error(`refusing to drop schema ${bossSchema}`);
    await sql.unsafe(`drop schema if exists "${bossSchema}" cascade`);
  }
  await sql`delete from notification where user_id = ${fx.userId} or match_id in (select id from match where watch_id = ${fx.watchId})`;
  await sql`delete from match where watch_id = ${fx.watchId}`;
  await sql`delete from enrichment where post_id in (select id from post where source_id = ${fx.sourceId})`;
  await sql`delete from post_revision where post_id in (select id from post where source_id = ${fx.sourceId})`;
  await sql`delete from post where source_id = ${fx.sourceId}`;
  await sql`delete from watch where id = ${fx.watchId}`;
  await sql`delete from notifier where id = ${fx.notifierId}`;
  await sql`delete from source where id = ${fx.sourceId}`;
  await sql`delete from api_key where user_id = ${fx.userId}`;
  await sql`delete from "user" where id = ${fx.userId}`;
  await sql`delete from team where id = ${fx.teamId}`;
}
