import { mock } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as knownFolder from "../../src/codex/windows-local-appdata";
import { assertNotRealHomeUnderTest, isTestHomeGuardArmed } from "../../src/lib/test-home-guard";

const fixtureHome = process.env.OPENCODEX_HOME;
if (!fixtureHome || !isTestHomeGuardArmed()) throw new Error("Windows runtime fixture requires a guarded OPENCODEX_HOME");
assertNotRealHomeUnderTest(fixtureHome);
const localAppData = join(dirname(fixtureHome), "local-appdata");
mkdirSync(localAppData, { recursive: true });

// The production known-folder API deliberately ignores HOME/LOCALAPPDATA. Give fixture
// children one shared private namespace while retaining the real SID, locks and ACL work.
mock.module("../../src/codex/windows-local-appdata", () => ({
  ...knownFolder,
  resolveWindowsLocalAppData: () => localAppData,
}));
