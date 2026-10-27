import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { helperPath, repoPath } from "../helpers/repo-root";

let root: string;
let ownedTemp: string;
let realHome: string;
const extraRoots: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-preload-admission-"));
  ownedTemp = join(root, "temp");
  realHome = join(ownedTemp, "real-user");
  mkdirSync(realHome, { recursive: true });
});

afterEach(() => {
  // Only these exclusively created fixture roots belong to this test.
  for (const path of [root, ...extraRoots.splice(0)]) {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

function load(fixtureHome: string | undefined, guard = "1") {
  const env = {
    ...process.env,
    TEMP: ownedTemp, TMP: ownedTemp, TMPDIR: ownedTemp,
    HOME: realHome, USERPROFILE: realHome,
    OCX_TEST_HOME_GUARD: guard, OCX_REAL_HOME: realHome,
    OCX_REAL_CLAUDE_CONFIG_DIR: join(realHome, ".claude"),
    CLAUDE_CONFIG_DIR: join(realHome, ".claude"),
    OPENCODEX_HOME: fixtureHome,
    OCX_FIXTURE_KNOWN_FOLDER: repoPath("src", "codex", "windows-local-appdata.ts"),
  };
  return spawnSync(process.execPath, ["--preload", helperPath("fixture-windows-runtime-preload.ts"), "-e",
    'console.log("FIXTURE_ADMITTED=" + require(process.env.OCX_FIXTURE_KNOWN_FOLDER).resolveWindowsLocalAppData())',
  ], { cwd: root, env, encoding: "utf8", timeout: 10_000 });
}

function refuses(fixtureHome: string, guard = "1") {
  const target = join(dirname(fixtureHome), "local-appdata");
  const homeExisted = existsSync(fixtureHome);
  expect(existsSync(target)).toBe(false);
  const result = load(fixtureHome, guard);
  expect(result.error).toBeUndefined();
  expect({ status: result.status, stderr: result.stderr }).not.toMatchObject({ status: 0 });
  expect(result.stderr).toMatch(/refus|requires/i);
  expect(result.stdout).not.toContain("FIXTURE_ADMITTED=");
  expect(existsSync(target)).toBe(false);
  expect(existsSync(fixtureHome)).toBe(homeExisted);
}

test.each([
  ["protected home", [".opencodex"]],
  ["protected descendant", [".opencodex", "nested"]],
  ["protected ancestor", []],
  ["Codex descendant", [".codex", "nested"]],
  ["Claude descendant", [".claude", "nested"]],
  ["LaunchAgents descendant", ["Library", "LaunchAgents", "nested"]],
] as const)("refuses %s before mkdir or mock registration", (_label, parts) => {
  refuses(join(realHome, ...parts));
});

test("refuses an unowned custom home outside the child's tmpdir and checkout .tmp", () => {
  refuses(join(root, "custom", "ocx"));
});

test("refuses the owned temp root itself rather than treating equality as containment", () => {
  refuses(ownedTemp);
});

test("requires the armed home guard even for an owned fixture", () => {
  refuses(join(ownedTemp, "fixture", "ocx"), "0");
});

test.each([undefined, "", "   ", "relative-home"])("refuses missing, blank or relative home: %s", home => {
  const result = load(home);
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/refus|requires/i);
  expect(result.stdout).not.toContain("FIXTURE_ADMITTED=");
  expect(existsSync(join(root, "local-appdata"))).toBe(false);
});

test("accepts a mkdtemp home strictly inside the canonical temp root", () => {
  const home = mkdtempSync(join(ownedTemp, "fixture-"));
  const result = load(home);
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(result.stdout).toContain(`FIXTURE_ADMITTED=${join(ownedTemp, "local-appdata")}`);
  expect(existsSync(join(ownedTemp, "local-appdata"))).toBe(true);
});

test("accepts a not-yet-created fixture below an existing temp ancestor", () => {
  const home = join(ownedTemp, "new-parent", "ocx");
  const result = load(home);
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(existsSync(join(dirname(home), "local-appdata"))).toBe(true);
});

test("accepts the checkout .tmp fixture root used by Windows catalog tests", () => {
  mkdirSync(repoPath(".tmp"), { recursive: true });
  const fixture = mkdtempSync(repoPath(".tmp", "preload-admission-"));
  extraRoots.push(fixture);
  const result = load(join(fixture, "ocx"));
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(existsSync(join(fixture, "local-appdata"))).toBe(true);
});

test("refuses an owned-root alias whose missing child resolves outside that root", () => {
  const outside = join(root, "outside");
  mkdirSync(outside);
  const alias = join(ownedTemp, "alias");
  symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir");
  refuses(join(alias, "missing", "ocx"));
  expect(readdirSync(outside)).toEqual([]);
});

test("refuses a protected local-appdata target even when the fixture home is owned", () => {
  const fixture = mkdtempSync(join(ownedTemp, "fixture-"));
  const protectedTarget = join(realHome, ".opencodex");
  mkdirSync(protectedTarget);
  symlinkSync(protectedTarget, join(fixture, "local-appdata"), process.platform === "win32" ? "junction" : "dir");
  const result = load(join(fixture, "ocx"));
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/refus/i);
  expect(result.stdout).not.toContain("FIXTURE_ADMITTED=");
  expect(readdirSync(protectedTarget)).toEqual([]);
});
