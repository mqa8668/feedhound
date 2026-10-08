// Tiny fixture server for the compose `demo` profile. Hand-written, fictional content.
// Item timestamps are computed per request (minutes ago), so every feed always looks fresh.
// Routes: /deals.xml (RSS 2.0), /homelab.atom (Atom 1.0), /news.json (JSON Feed 1.1), /healthz.

const PORT = Number(process.env.PORT ?? 8080);
const BASE = (process.env.DEMO_FEEDS_BASE ?? `http://demo-feeds:${PORT}`).replace(/\/+$/, "");

interface Item {
  id: string;
  title: string;
  body: string;
  minutesAgo: number;
}

const DEALS: Item[] = [
  {
    id: "deal-1001",
    title: "Used RTX 4070 Super 12GB, one year old, original box",
    body: "Selling a lightly used RTX 4070 Super 12GB graphics card. Quiet fans, no mining. Asking 8.900.000 VND, pickup only. GPU deal, first come first served.",
    minutesAgo: 5,
  },
  {
    id: "deal-1002",
    title: "RTX 4080 Super 16GB, sealed",
    body: "Brand new RTX 4080 Super 16GB, sealed box, invoice included. Price 24.500.000 VND, firm.",
    minutesAgo: 25,
  },
  {
    id: "deal-1003",
    title: "27 inch 1440p monitor, 144Hz",
    body: "Gaming monitor, no dead pixels, includes stand and cables. 3.200.000 VND.",
    minutesAgo: 70,
  },
  {
    id: "deal-1004",
    title: "Mechanical keyboard, hot-swappable, brown switches",
    body: "Barely used, keycaps in good shape. 850.000 VND.",
    minutesAgo: 140,
  },
];

const HOMELAB: Item[] = [
  {
    id: "lab-2001",
    title: "Synology DS923+ NAS with four 4TB drives, boxed",
    body: "Selling my Synology NAS (DS923+) with four 4TB drives. Runs Docker containers well, bought last spring. Pickup or courier.",
    minutesAgo: 8,
  },
  {
    id: "lab-2002",
    title: "Moving my photo library to a self-hosted server",
    body: "Notes on replacing a cloud photo service with a small self-hosted stack on a mini PC: storage layout, backups and what broke.",
    minutesAgo: 45,
  },
  {
    id: "lab-2003",
    title: "Quiet 8-port gigabit switch, fanless",
    body: "Unmanaged switch, metal case, works fine in a closet. 450.000 VND.",
    minutesAgo: 95,
  },
];

const NEWS: Item[] = [
  {
    id: "news-3001",
    title: "A weekend guide to self-hosted DNS filtering",
    body: "How to run a network-wide DNS filter on a Raspberry Pi, with a fallback resolver so the household never loses internet.",
    minutesAgo: 12,
  },
  {
    id: "news-3002",
    title: "Backup strategies for a home server",
    body: "A short comparison of snapshot, file-level and offsite backups, and how often to test a restore.",
    minutesAgo: 60,
  },
];

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const at = (minutesAgo: number): Date => new Date(Date.now() - minutesAgo * 60_000);

function rss(): string {
  const items = DEALS.map(
    (i) => `    <item>
      <title>${esc(i.title)}</title>
      <link>${BASE}/deals/${i.id}</link>
      <guid isPermaLink="false">${i.id}</guid>
      <pubDate>${at(i.minutesAgo).toUTCString()}</pubDate>
      <description>${esc(i.body)}</description>
    </item>`,
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Demo Deals</title>
    <link>${BASE}/deals</link>
    <description>Fictional second-hand hardware listings for the feedhound demo.</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}

function atom(): string {
  const entries = HOMELAB.map(
    (i) => `  <entry>
    <title>${esc(i.title)}</title>
    <id>urn:feedhound-demo:${i.id}</id>
    <link href="${BASE}/homelab/${i.id}"/>
    <updated>${at(i.minutesAgo).toISOString()}</updated>
    <published>${at(i.minutesAgo).toISOString()}</published>
    <summary>${esc(i.body)}</summary>
  </entry>`,
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Demo Homelab</title>
  <id>urn:feedhound-demo:homelab</id>
  <link href="${BASE}/homelab"/>
  <updated>${new Date().toISOString()}</updated>
${entries}
</feed>
`;
}

function jsonFeed(): string {
  return JSON.stringify({
    version: "https://jsonfeed.org/version/1.1",
    title: "Demo Self-hosting News",
    home_page_url: `${BASE}/news`,
    feed_url: `${BASE}/news.json`,
    items: NEWS.map((i) => ({
      id: i.id,
      url: `${BASE}/news/${i.id}`,
      title: i.title,
      content_text: i.body,
      date_published: at(i.minutesAgo).toISOString(),
    })),
  });
}

const routes: Record<string, () => Response> = {
  "/deals.xml": () => new Response(rss(), { headers: { "content-type": "application/rss+xml; charset=utf-8" } }),
  "/homelab.atom": () => new Response(atom(), { headers: { "content-type": "application/atom+xml; charset=utf-8" } }),
  "/news.json": () => new Response(jsonFeed(), { headers: { "content-type": "application/feed+json; charset=utf-8" } }),
  "/healthz": () => Response.json({ ok: true, service: "demo-feeds" }),
  "/robots.txt": () => new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } }),
};

Bun.serve({
  port: PORT,
  fetch(req) {
    const handler = routes[new URL(req.url).pathname];
    return handler ? handler() : new Response("not found", { status: 404 });
  },
});
console.log(`demo-feeds listening on :${PORT}`);
