import { mock } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as knownFolder from "../../src/codex/windows-local-appdata";
import { isTestHomeGuardArmed, protectedRemovalReason } from "../../src/lib/test-home-guard";
import { repoPath } from "./repo-root";

// Match test-home-guard's nearest-existing-ancestor resolution for paths not created yet.
function canonicalize(path: string): string {
  let current = resolve(path);
  const unresolved: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...unresolved.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      unresolved.push(basename(current));
      current = parent;
    }
  }
}

function isStrictlyInside(root: string, target: string): boolean {
  const fold = (path: string) => process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;
  const rel = relative(fold(root), fold(target));
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

const fixtureHome = process.env.OPENCODEX_HOME;
if (!fixtureHome?.trim() || !isAbsolute(fixtureHome) || !isTestHomeGuardArmed()) {
  throw new Error("Windows runtime fixture requires an absolute guarded OPENCODEX_HOME");
}
const localAppData = join(dirname(fixtureHome), "local-appdata");
for (const target of [fixtureHome, localAppData]) {
  const reason = protectedRemovalReason(target);
  if (reason !== null) throw new Error(`refusing Windows runtime fixture in ${reason}`);
}
const canonicalHome = canonicalize(fixtureHome);
const canonicalLocalAppData = canonicalize(localAppData);
const ownedRoots = [tmpdir(), repoPath(".tmp")].map(canonicalize);
if (!ownedRoots.some(root => isStrictlyInside(root, canonicalHome) && isStrictlyInside(root, canonicalLocalAppData))) {
  throw new Error("refusing Windows runtime fixture outside an owned test root (tmpdir or checkout .tmp)");
}
mkdirSync(localAppData, { recursive: true });

// The production known-folder API deliberately ignores HOME/LOCALAPPDATA. Give fixture
// children one shared private namespace while retaining the real SID, locks and ACL work.
mock.module("../../src/codex/windows-local-appdata", () => ({
  ...knownFolder,
  resolveWindowsLocalAppData: () => localAppData,
}));
