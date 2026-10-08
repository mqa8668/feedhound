// Fixture `airpods-spike`: 200 posts containing only "airpods" inside hour H.
import type { DbHandle } from "../../../packages/db/src/index";
import { insertPosts, type PostSeed } from "./flat-baseline";

export async function seedAirpodsSpike(handle: DbHandle, sourceId: string, hour: Date): Promise<void> {
  const posts: PostSeed[] = [];
  for (let i = 0; i < 200; i++) posts.push({ sourceId, text: "airpods", firstSeenAt: new Date(hour.getTime() + (i % 50) * 60_000) });
  await insertPosts(handle, posts);
}
