import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Resolves a hostname to every address it points at. Injectable for tests. */
export type HostResolver = (host: string) => Promise<string[]>;

export const systemResolver: HostResolver = async (host) => {
  const rows = await lookup(host, { all: true, verbatim: true });
  return rows.map((r) => r.address);
};

function v4Blocked(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true; // 0/8, 10/8, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // private /16
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function parseV4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  if (nums.some((n) => !(n >= 0 && n <= 255))) return null;
  return nums as [number, number, number, number];
}

/** Expands an IPv6 literal into eight 16-bit groups (embedded dotted IPv4 supported). */
function parseV6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseV4(tail);
    if (!v4) return null;
    text = `${text.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const rest = halves.length === 2 ? (halves[1] === "" ? [] : (halves[1] ?? "").split(":")) : [];
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array<string>(fill).fill("0"), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN));
  return out.some(Number.isNaN) ? null : out;
}

/** True when `ip` (a literal v4 or v6 address) must never be fetched. Unparsable input counts as blocked. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const v4 = parseV4(ip);
    return v4 === null ? true : v4Blocked(v4[0], v4[1], v4[2]);
  }
  if (kind !== 6) return true;
  const g = parseV6(ip);
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  if (g.every((x) => x === 0)) return true; // ::
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return true; // ::1
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  const embedded = (hi: number, lo: number): boolean => v4Blocked(hi >> 8, hi & 0xff, lo >> 8);
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return embedded(g6, g7); // ::ffff:a.b.c.d
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return embedded(g6, g7); // deprecated ::a.b.c.d
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return embedded(g6, g7); // NAT64
  if (g0 === 0x2002) return embedded(g1, g2); // 6to4
  return false;
}

/** Hostname as URL reports it, without IPv6 brackets. */
export function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export type AddressCheck = { ok: true; addresses: string[] } | { ok: false; kind: "blocked" | "unresolved"; reason: string };

/**
 * Checks every address a host points at. A name is refused when ANY of its addresses is blocked.
 * On success `addresses` is the validated set; callers connect to one of these (see the fetcher's pinning).
 * Literal IPs are checked directly. A name that does not resolve is reported as "unresolved".
 */
export async function checkHostAddresses(hostname: string, resolve: HostResolver): Promise<AddressCheck> {
  const host = bareHost(hostname);
  if (isIP(host) !== 0) {
    return isBlockedAddress(host) ? { ok: false, kind: "blocked", reason: `address ${host} is not a public address` } : { ok: true, addresses: [host] };
  }
  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch {
    return { ok: false, kind: "unresolved", reason: `could not resolve ${host}` };
  }
  if (addrs.length === 0) return { ok: false, kind: "unresolved", reason: `could not resolve ${host}` };
  const bad = addrs.find((a) => isBlockedAddress(a));
  return bad === undefined ? { ok: true, addresses: addrs } : { ok: false, kind: "blocked", reason: `${host} resolves to a non-public address (${bad})` };
}
