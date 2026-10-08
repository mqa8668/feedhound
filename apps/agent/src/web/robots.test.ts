import { describe, expect, test } from "bun:test";
import { parseRobots, robotsFromResponse } from "./robots";

describe("robots", () => {
  const rules = parseRobots("User-agent: *\nDisallow: /api\nAllow: /api/public$", "feedhound");

  test("longest match with $ and prefix", () => {
    expect(rules.allowed("/api/x")).toBe(false);
    expect(rules.allowed("/api/public")).toBe(true);
    expect(rules.allowed("/api/public/more")).toBe(false);
    expect(rules.allowed("/v1/x")).toBe(true);
  });

  test("a feedhound group beats the * group; * wildcard", () => {
    const r = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: feedhound\nDisallow: /private*/x", "feedhound");
    expect(r.allowed("/anything")).toBe(true);
    expect(r.allowed("/private-1/x")).toBe(false);
  });

  test("RFC 9309 matching: full product token, case-insensitive; an empty token never matches", () => {
    const body = "User-agent: *\nDisallow: /\n\nUser-agent: feedhound\nAllow: /\n\nUser-agent: feedhoun\nDisallow: /x\n\nUser-agent:\nDisallow: /y";
    const r = parseRobots(body, "feedhound");
    expect(r.allowed("/x")).toBe(true);
    expect(r.allowed("/y")).toBe(true);
    const other = parseRobots("User-agent: feedhoun\nDisallow: /\n\nUser-agent: *\nAllow: /", "feedhound");
    expect(other.allowed("/a")).toBe(true);
  });

  test("404 allows, 503 and network failure disallow", () => {
    expect(robotsFromResponse(404, "", "feedhound").allowed("/api/x")).toBe(true);
    expect(robotsFromResponse(503, "", "feedhound").allowed("/v1/x")).toBe(false);
    expect(robotsFromResponse(null, "", "feedhound").allowed("/v1/x")).toBe(false);
  });
});
