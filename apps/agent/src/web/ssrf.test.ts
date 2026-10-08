import { describe, expect, test } from "bun:test";
import { checkHostAddresses, isBlockedAddress } from "./ssrf";

const v4 = (...n: number[]): string => n.join(".");

describe("isBlockedAddress", () => {
  const blocked = [
    v4(0, 0, 0, 0), v4(0, 1, 2, 3), v4(127, 0, 0, 1), v4(127, 255, 255, 254),
    v4(10, 0, 0, 1), v4(10, 255, 255, 255),
    v4(172, 16, 0, 1), v4(172, 31, 255, 255),
    v4(192, 168, 0, 1), v4(192, 168, 255, 255),
    v4(100, 64, 0, 1), v4(100, 127, 255, 255),
    v4(169, 254, 0, 1), v4(169, 254, 169, 254),
    v4(224, 0, 0, 1), v4(239, 255, 255, 250), v4(255, 255, 255, 255),
    "::1", "::", "fe80::1", "febf::1", "fc00::1", "fd12:3456::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:a00:1",
    "64:ff9b::7f00:1", "2002:7f00:1::1", "0:0:0:0:0:0:0:1",
    "not-an-ip",
  ];
  for (const ip of blocked) test(`blocks ${ip}`, () => expect(isBlockedAddress(ip)).toBe(true));

  const allowed = [
    v4(93, 184, 216, 34), v4(8, 8, 8, 8), v4(172, 15, 0, 1), v4(172, 32, 0, 1),
    v4(100, 63, 255, 255), v4(100, 128, 0, 1), v4(169, 253, 0, 1), v4(192, 167, 0, 1),
    "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "2a00::1",
  ];
  for (const ip of allowed) test(`allows ${ip}`, () => expect(isBlockedAddress(ip)).toBe(false));
});

describe("checkHostAddresses", () => {
  test("refuses when any answer is private, allows all-public", async () => {
    expect((await checkHostAddresses("a.example.test", async () => ["8.8.8.8", "::1"])).ok).toBe(false);
    expect((await checkHostAddresses("a.example.test", async () => ["8.8.8.8", "2606:4700:4700::1111"])).ok).toBe(true);
  });
  test("literal ip hosts skip DNS", async () => {
    const never = async (): Promise<string[]> => {
      throw new Error("no dns expected");
    };
    expect(await checkHostAddresses("[::1]", never)).toMatchObject({ ok: false, kind: "blocked" });
    expect(await checkHostAddresses("127.0.0.1", never)).toMatchObject({ ok: false, kind: "blocked" });
    expect((await checkHostAddresses("8.8.8.8", never)).ok).toBe(true);
  });
  test("empty or failing resolution is unresolved", async () => {
    expect(await checkHostAddresses("x.example.test", async () => [])).toMatchObject({ ok: false, kind: "unresolved" });
    expect(await checkHostAddresses("x.example.test", async () => { throw new Error("x"); })).toMatchObject({ ok: false, kind: "unresolved" });
  });
});
