import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { armClaudeCodeBaseline, getConfigPath, getDefaultConfig, loadConfig, mutatePersistedConfig, saveConfigPreservingClaudeCode } from "../../src/config";
import { configDiagnosticsFromRaw, readConfigAdmissionSnapshot, readConfigDiagnostics } from "../../src/config/diagnostics";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { buildClaudeReplayConfig } from "../../src/server/claude-messages";
import { parseRequest } from "../../src/responses/parser";
import { planVisionSidecar, shouldResolveOpenAiVisionSidecar } from "../../src/vision/plan";
import { planWebSearch, shouldResolveOpenAiWebSearchSidecar } from "../../src/web-search";
import { createTempHome } from "../helpers/temp-home";
import { repoPath } from "../helpers/repo-root";
import { runPassiveRead } from "../../src/lib/passive-read";

test("retired OpenCode Free entries warn once on load and an unrelated save persists their removal", () => {
  const home = createTempHome("ocx-removed-provider-");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const provider = { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/v1", keyOptional: true };
    const raw = {
      ...getDefaultConfig(),
      defaultProvider: "opencode-free",
      providers: {
        "opencode-free": provider,
        typed: { ...provider, type: "opencode-free" },
        adapter: { ...provider, adapter: "opencode-free" },
        nestedPreset: { ...provider, preset: { id: "opencode-free" } },
        preset: { ...provider, presetId: "opencode-free" },
        healthy: { adapter: "openai-chat", baseUrl: "https://example.test/v1", defaultModel: "keep", note: "opencode-free" },
      },
      combos: {
        mixed: { targets: [{ provider: "opencode-free", model: "big-pickle" }, { provider: "healthy", model: "keep" }] },
        retired: { targets: [{ provider: "typed", model: "big-pickle" }] },
        dependentJudge: { strategy: "jev", decisionModel: "combo/judge", targets: [{ provider: "healthy", model: "keep" }] },
        judge: { strategy: "jev", decisionModel: "opencode-free/big-pickle", targets: [{ provider: "healthy", model: "keep" }] },
      },
      routingProfiles: {
        mixed: { candidates: [{ provider: "preset", model: "big-pickle" }, { provider: "healthy", model: "keep" }] },
        retired: { candidates: [{ provider: "opencode-free", model: "big-pickle" }] },
      },
      subagentModels: ["opencode-free/big-pickle", "healthy/keep"],
      subagentModelFallback: ["typed/big-pickle", "combo/retired", "policy/retired", "healthy/keep"],
      subagentModelFallbackByModel: { "opencode-free/big-pickle": ["healthy/keep"], "healthy/keep": ["preset/big-pickle", "healthy/keep"], "healthy/empty": ["preset/big-pickle"] },
      claudeCode: { enabled: false, subagentModelForce: "opencode-free/big-pickle", model: "opencode-free/big-pickle", tierModels: { opus: "healthy/keep" } },
      modelPickerOrder: ["opencode-free/big-pickle", "healthy/keep"],
    };
    const bytes = "\uFEFF" + JSON.stringify(raw, null, 2) + "\r\n";
    writeFileSync(getConfigPath(), bytes, "utf8");
    const loaded = loadConfig();
    expect(Object.keys(loaded.providers).sort()).toEqual(["healthy", "openai"]);
    expect(loaded.defaultProvider).toBe("openai");
    expect(loaded.providers.healthy.defaultModel).toBe("keep");
    expect(loaded.providers.healthy.note).toBe("opencode-free");
    expect(loaded.combos).toEqual({ mixed: { targets: [{ provider: "healthy", model: "keep" }] } });
    expect(loaded.routingProfiles).toEqual({ mixed: { candidates: [{ provider: "healthy", model: "keep" }] } });
    expect(loaded.subagentModels).toEqual(["healthy/keep"]);
    expect(loaded.subagentModelFallback).toEqual(["healthy/keep"]);
    expect(loaded.subagentModelFallbackByModel).toEqual({ "healthy/keep": ["healthy/keep"] });
    expect(loaded.claudeCode?.subagentModelForce).toBeUndefined();
    expect(loaded.claudeCode?.model).toBeUndefined();
    expect(loaded.claudeCode?.tierModels).toEqual({ opus: "healthy/keep" });
    expect(loaded.modelPickerOrder).toEqual(["healthy/keep"]);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
    expect(() => loadConfig()).not.toThrow();
    expect(readConfigDiagnostics().config.providers).toEqual(loaded.providers);
    const warnings = warn.mock.calls.filter(([message]) => String(message).includes("opencode-free support was removed"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]![0]).toContain("403");
    expect(warnings[0]![0]).toContain("#7255");
    expect(warnings[0]![0]).toContain("opencode-go");
    expect(warnings[0]![0]).not.toMatch(/\b\d+\.\d+\.\d+\b/);
    expect(PROVIDER_REGISTRY.some(entry => entry.id === "opencode-free")).toBe(false);
    const outcome = mutatePersistedConfig(config => {
      config.port = 19876;
      return { changed: true, value: undefined };
    });
    expect(outcome.status).toBe("committed");
    const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8"));
    expect(persisted.port).toBe(19876);
    expect(persisted.providers["opencode-free"]).toBeUndefined();
    expect(Object.keys(persisted.providers).sort()).toEqual(["healthy", "openai"]);
    expect(persisted.providers.healthy).toEqual(loaded.providers.healthy);
    expect(persisted.subagentModels).toEqual(["healthy/keep"]);
    expect(warnings[0]![0]).toContain("next configuration save removes them from config.json");
    const backup = `${getConfigPath()}.pre-opencode-free-removal.bak`;
    expect(existsSync(backup)).toBe(true);
    expect(readFileSync(backup)).toEqual(Buffer.from(bytes));
    expect(warnings[0]![0]).toContain("the original file was saved to");
    expect(warnings[0]![0]).toContain("config.json.pre-opencode-free-removal.bak");
    expect(warnings[0]![0]).toContain("restore by copying it back over config.json");
    // A later retired config must retain the first recovery point, even after another save.
    writeFileSync(getConfigPath(), bytes + "\n");
    loadConfig();
    expect(mutatePersistedConfig(config => {
      config.port = 10101;
      return { changed: true, value: undefined };
    }).status).toBe("committed");
    expect(readFileSync(backup)).toEqual(Buffer.from(bytes));
  } finally { warn.mockRestore(); home.remove(); }
});

test.each(["diagnostics", "admission"])("%s disk reads preserve original retired bytes before a mutation", reader => {
  withLegacyConfig({}, bytes => {
    const backup = `${getConfigPath()}.pre-opencode-free-removal.bak`;
    const diagnostics = reader === "diagnostics" ? readConfigDiagnostics() : readConfigAdmissionSnapshot().diagnostics;
    expect(diagnostics.source).toBe("file");
    expect(diagnostics.config.providers["opencode-free"]).toBeUndefined();
    expect(readFileSync(backup)).toEqual(Buffer.from(bytes));
  });
});

test.skipIf(process.platform === "win32")("retirement backup is owner-only on POSIX", () => {
  withLegacyConfig({}, () => {
    loadConfig();
    expect(statSync(`${getConfigPath()}.pre-opencode-free-removal.bak`).mode & 0o777).toBe(0o600);
  });
});

test("healthy config and imported retired text create no recovery copy", () => {
  const home = createTempHome("ocx-no-retired-backup-");
  try {
    writeFileSync(getConfigPath(), JSON.stringify(getDefaultConfig()));
    configDiagnosticsFromRaw(JSON.stringify({ ...getDefaultConfig(), providers: { "opencode-free": {} } }));
    loadConfig();
    readConfigDiagnostics();
    expect(mutatePersistedConfig(config => {
      config.port = 10101;
      return { changed: true, value: undefined };
    }).status).toBe("committed");
    expect(existsSync(`${getConfigPath()}.pre-opencode-free-removal.bak`)).toBe(false);
  } finally { home.remove(); }
});

test("an occupied backup name never crashes loading or overwrites the occupant", () => {
  withLegacyConfig({}, bytes => {
    const backup = `${getConfigPath()}.pre-opencode-free-removal.bak`;
    mkdirSync(backup);
    expect(loadConfig().providers["opencode-free"]).toBeUndefined();
    expect(readConfigDiagnostics().source).toBe("file");
    expect(statSync(backup).isDirectory()).toBe(true);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
  });
});

test("a failed recovery copy warns without exposing paths or secret bytes", () => {
  const home = createTempHome("ocx-failed-retirement-backup-");
  try {
    const path = getConfigPath();
    const module = pathToFileURL(repoPath("src/config/removed-opencode-free-backup.ts")).href;
    const script = `import { mock } from 'bun:test'; import * as fs from 'node:fs';
      const real = { ...fs }; mock.module('node:fs', () => ({ ...real, linkSync() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }));
      const { preserveRemovedOpenCodeFree } = await import(${JSON.stringify(module)});
      preserveRemovedOpenCodeFree(${JSON.stringify(path)}, Buffer.from("synthetic-secret-must-not-be-logged"));`;
    const child = Bun.spawnSync([process.execPath, "--eval", script], { env: { ...process.env } });
    expect(child.exitCode).toBe(0);
    const output = child.stdout.toString() + child.stderr.toString();
    expect(output).toContain("copy config.json now if you need the old entry");
    expect(output).toContain("no recovery copy was made");
    expect(output).not.toContain("the original file was saved to");
    expect(output).not.toContain(path);
    expect(output).not.toContain("synthetic-secret-must-not-be-logged");
  } finally { home.remove(); }
});

function withLegacyConfig(patch: Record<string, unknown>, check: (bytes: string) => void): void {
  const home = createTempHome("ocx-removed-references-");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const bytes = JSON.stringify({
      ...getDefaultConfig(), defaultProvider: "healthy",
      providers: {
        "opencode-free": { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/v1", alias: " retired-alias " },
        healthy: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      ...patch,
    });
    writeFileSync(getConfigPath(), bytes);
    check(bytes);
  } finally { warn.mockRestore(); home.remove(); }
}

test.each(["file", "directory"])("an unrelated %s at the recovery name gets an exclusive sibling", kind => {
  withLegacyConfig({}, bytes => {
    const backup = `${getConfigPath()}.pre-opencode-free-removal.bak`;
    if (kind === "file") writeFileSync(backup, "unrelated occupant");
    else mkdirSync(backup);
    loadConfig();
    readConfigDiagnostics();
    const siblings = readdirSync(process.env.OPENCODEX_HOME!).filter(name => /\.pre-opencode-free-removal\..+\.bak$/.test(name));
    expect(siblings).toHaveLength(1);
    expect(readFileSync(`${process.env.OPENCODEX_HOME}/${siblings[0]}`)).toEqual(Buffer.from(bytes));
    if (kind === "file") expect(readFileSync(backup, "utf8")).toBe("unrelated occupant");
    else expect(statSync(backup).isDirectory()).toBe(true);
  });
});

test("an identical original recovery copy is reused without another sibling", () => {
  withLegacyConfig({}, bytes => {
    const backup = `${getConfigPath()}.pre-opencode-free-removal.bak`;
    writeFileSync(backup, bytes);
    loadConfig();
    expect(readFileSync(backup)).toEqual(Buffer.from(bytes));
    expect(readdirSync(process.env.OPENCODEX_HOME!).filter(name => name.endsWith(".bak"))).toHaveLength(1);
  });
});

test("late retired disk edits are preserved byte for byte by live saves", () => {
  const home = createTempHome("ocx-late-retired-");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    writeFileSync(getConfigPath(), JSON.stringify(getDefaultConfig()));
    const live = loadConfig();
    armClaudeCodeBaseline(live);
    const raw = Buffer.from("\uFEFF" + JSON.stringify({ ...getDefaultConfig(), providers: {
      "opencode-free": { apiKey: "synthetic-late-key", baseUrl: "https://example.test/v1" },
    } }) + "\r\n");
    writeFileSync(getConfigPath(), raw);
    live.port = 10101;
    saveConfigPreservingClaudeCode(live);
    expect(JSON.parse(readFileSync(getConfigPath(), "utf8")).providers["opencode-free"]).toBeUndefined();
    expect(readFileSync(`${getConfigPath()}.pre-opencode-free-removal.bak`)).toEqual(raw);
  } finally { warn.mockRestore(); home.remove(); }
});

test.each(["loader", "diagnostics", "admission"])("passive %s projects retired data without files or notices", async reader => {
  const home = createTempHome("ocx-passive-retired-");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    writeFileSync(getConfigPath(), JSON.stringify({ ...getDefaultConfig(), defaultProvider: "openai", providers: { ...getDefaultConfig().providers, "opencode-free": {} } }));
    const before = readdirSync(home.root);
    const metadata = statSync(getConfigPath(), { bigint: true });
    await runPassiveRead(async () => {
      const config = reader === "loader" ? loadConfig() : reader === "diagnostics" ? readConfigDiagnostics().config : readConfigAdmissionSnapshot().diagnostics.config;
      expect(config.providers["opencode-free"]).toBeUndefined();
    });
    expect(readdirSync(home.root)).toEqual(before);
    expect(statSync(getConfigPath(), { bigint: true }).ctimeNs).toBe(metadata.ctimeNs);
    expect(warn.mock.calls).toHaveLength(0);
  } finally { warn.mockRestore(); home.remove(); }
});

test("successful recovery notices redact a secret-shaped home and retain the filename", () => {
  const home = createTempHome("ocx-sk-syntheticOnly7800-");
  try {
    const module = pathToFileURL(repoPath("src/config/removed-opencode-free-backup.ts")).href;
    const child = Bun.spawnSync([process.execPath, "--eval", `import { preserveRemovedOpenCodeFree } from ${JSON.stringify(module)};
      preserveRemovedOpenCodeFree(${JSON.stringify(getConfigPath())}, Buffer.from("synthetic-original"));`], { env: { ...process.env } });
    expect(child.exitCode).toBe(0);
    const output = child.stderr.toString();
    expect(output).toContain("config.json.pre-opencode-free-removal.bak");
    expect(output).not.toContain("sk-syntheticOnly7800");
  } finally { home.remove(); }
});

test("a substituted empty recovery temp never receives original secret bytes", () => {
  const home = createTempHome("ocx-recovery-substitution-");
  try {
    const module = pathToFileURL(repoPath("src/config/removed-opencode-free-backup.ts")).href;
    const script = `import { mock } from 'bun:test'; import * as fs from 'node:fs';
      const real = { ...fs }; let stolen;
      mock.module('node:fs', () => ({ ...real, openSync(path, flags, mode) {
        const fd = real.openSync(path, flags, mode);
        if (!stolen && flags === 'wx') {
          stolen = path + '.stolen'; real.renameSync(path, stolen); real.writeFileSync(path, 'replacement');
        } return fd;
      }}));
      const { preserveRemovedOpenCodeFree } = await import(${JSON.stringify(module)});
      preserveRemovedOpenCodeFree(${JSON.stringify(getConfigPath())}, Buffer.from('SYNTHETIC-7800-SECRET'));
      console.log(JSON.stringify({ swapped: !!stolen, leaked: !!stolen && real.readFileSync(stolen).includes(Buffer.from('SYNTHETIC-7800-SECRET')) }));`;
    const child = Bun.spawnSync([process.execPath, "--eval", script], { env: { ...process.env } });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual({ swapped: true, leaked: false });
    expect(child.stderr.toString()).toContain("copy config.json now");
  } finally { home.remove(); }
});

test("retired desktop assignments repair defaults without losing healthy profile state", () => {
  const desktopProfile = {
    version: 1,
    assignments: {
      "opencode-free/opus": { family: "opus", alias: "claude-opus-4-8-20260101" },
      "opencode-free/fable": { family: "fable", alias: "claude-opus-4-8-20260102" },
      "opencode-free/haiku": { family: "haiku", alias: "claude-opus-4-8-20260103" },
      "healthy/z": { family: "opus", alias: "claude-opus-4-8-20260104" },
      "healthy/a": { family: "opus", alias: "claude-opus-4-8-20260105" },
      "healthy/sonnet": { family: "sonnet", alias: "claude-opus-4-8-20260106" },
      "healthy/haiku": { family: "haiku", alias: "claude-opus-4-8-20260107" },
    },
    defaults: { opus: "opencode-free/opus", fable: "opencode-free/fable", sonnet: "healthy/sonnet", haiku: "opencode-free/haiku" },
    appliedFingerprint: "preserved-marker", appliedAt: "2026-10-19T00:00:00Z",
  };
  withLegacyConfig({ claudeCode: { enabled: false, desktopProfile } }, bytes => {
    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("file");
    const expected = {
      ...desktopProfile,
      assignments: Object.fromEntries(Object.entries(desktopProfile.assignments).filter(([route]) => route.startsWith("healthy/"))),
      defaults: { opus: "healthy/a", fable: null, sonnet: "healthy/sonnet", haiku: "healthy/haiku" },
    };
    expect(diagnostics.config.claudeCode?.desktopProfile).toEqual(expected);
    expect(loadConfig().claudeCode?.desktopProfile).toEqual(expected);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
  });
});

test.each([false, true])("unrelated saves cannot resurrect retired Claude routes (healthy disk edit: %s)", diskEdit => {
  withLegacyConfig({ claudeCode: {
    enabled: false, model: "opencode-free/old", subagentModelForce: "retired-alias/old",
    tierModels: { opus: "healthy/keep" },
  } }, bytes => {
    const live = loadConfig();
    armClaudeCodeBaseline(live);
    expect(live.claudeCode?.model).toBeUndefined();
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
    if (diskEdit) {
      const raw = JSON.parse(bytes);
      raw.claudeCode.tierModels.sonnet = "healthy/edited";
      writeFileSync(getConfigPath(), JSON.stringify(raw));
    }
    for (const fastMode of [true, false]) {
      live.fastMode = fastMode;
      saveConfigPreservingClaudeCode(live);
      expect(live.claudeCode?.model).toBeUndefined();
      expect(live.claudeCode?.subagentModelForce).toBeUndefined();
      expect(live.claudeCode?.tierModels).toEqual({ opus: "healthy/keep", ...(diskEdit ? { sonnet: "healthy/edited" } : {}) });
      const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8"));
      expect(persisted.claudeCode).toEqual(live.claudeCode);
      expect(persisted.fastMode).toBe(fastMode);
      expect(persisted.providers["opencode-free"]).toBeUndefined();
    }
  });
});

test.each([false, true])("retired source allowlists and injection dependencies load without degradation (mixed: %s)", mixed => {
  withLegacyConfig({
    compactionRouting: { model: "healthy/keep", sourceModels: ["opencode-free/*", ...(mixed ? ["healthy/*"] : [])] },
    injectionModel: "opencode-free/old", injectionEffort: "high", syncCodexSubagentDefaults: true,
  }, bytes => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < 2; i++) {
        const loaded = loadConfig();
        expect(loaded.compactionRouting).toEqual(mixed ? { model: "healthy/keep", sourceModels: ["healthy/*"] } : undefined);
        expect(loaded.injectionModel).toBeUndefined();
        expect(loaded.injectionEffort).toBeUndefined();
        expect(loaded.syncCodexSubagentDefaults).toBeUndefined();
        expect(readConfigDiagnostics().source).toBe("file");
      }
      expect(warn.mock.calls.filter(([message]) => /compactionRouting|syncCodexSubagentDefaults/.test(String(message)))).toEqual([]);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
    } finally { warn.mockRestore(); }
  });
});

test("all routed reference sites and whitespace aliases are pruned while healthy references remain", () => {
  withLegacyConfig({
    providers: {
      "opencode-free": { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/v1", alias: " retired-alias " },
      healthy: { adapter: "openai-chat", baseUrl: "https://example.test/v1", defaultModel: "retired-alias/old",
        autoReviewModel: "opencode-free/reviewer", autoReviewModelOverrides: {
          model: "retired-alias/reviewer", "opencode-free/source": "healthy/reviewer", keep: "healthy/reviewer",
        } },
    },
    combos: { retired: { alias: " retired-combo ", targets: [{ provider: "opencode-free", model: "old" }] } },
    codexRoleTiers: { fast: ["retired-alias/old", "healthy/keep"], standard: ["opencode-free/old"], frontier: ["retired-combo"] },
    visionSidecar: { backend: "routed", model: "retired-alias/old" },
    webSearchSidecar: { backend: "openai", model: "opencode-free/old" },
    shadowCallIntercept: { enabled: true, model: "healthy/keep", sourceModels: ["opencode-free/*", "healthy/*"] },
  }, bytes => {
    const loaded = loadConfig();
    expect(readConfigDiagnostics().source).toBe("file");
    expect(loaded.codexRoleTiers).toEqual({ fast: ["healthy/keep"], standard: [], frontier: [] });
    expect(loaded.visionSidecar).toEqual({ backend: "routed", enabled: false });
    expect(loaded.webSearchSidecar).toEqual({ backend: "openai", enabled: false });
    expect(loaded.shadowCallIntercept).toEqual({ enabled: true, model: "healthy/keep", sourceModels: ["healthy/*"] });
    expect(loaded.providers.healthy.defaultModel).toBeUndefined();
    expect(loaded.providers.healthy.autoReviewModel).toBeUndefined();
    expect(loaded.providers.healthy.autoReviewModelOverrides).toEqual({ keep: "healthy/reviewer" });
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
  });
  withLegacyConfig({ shadowCallIntercept: { enabled: true, model: "healthy/keep", sourceModels: ["opencode-free/*"] } }, () => {
    expect(loadConfig().shadowCallIntercept).toBeUndefined();
  });
});

test.each([false, true, undefined])("retired sidecar targets stay disabled through load, diagnostics and saves (enabled: %s)", enabled => {
  const routes = {
    combos: { retired: { alias: " retired-combo ", targets: [{ provider: "opencode-free", model: "old" }] } },
    routingProfiles: { retired: { alias: " retired-policy ", candidates: [{ provider: "opencode-free", model: "old" }] } },
  };
  for (const model of ["opencode-free/old", " retired-alias/old ", "combo/retired", "retired-combo", "policy/retired", "retired-policy"]) {
    const settings = { ...(enabled === undefined ? {} : { enabled }), model, timeoutMs: 12_345, reasoning: "low" };
    const vision = { ...settings, backend: "routed", maxDescriptionsPerTurn: 2 };
    const search = { ...settings, backend: "openai", maxSearchesPerTurn: 3 };
    withLegacyConfig({ ...routes, visionSidecar: vision, webSearchSidecar: search }, bytes => {
      const expectedVision = { backend: "routed", enabled: false, timeoutMs: 12_345, reasoning: "low", maxDescriptionsPerTurn: 2 };
      const expectedSearch = { backend: "openai", enabled: false, timeoutMs: 12_345, reasoning: "low", maxSearchesPerTurn: 3 };
      const live = loadConfig();
      const check = (config: ReturnType<typeof loadConfig>) => {
        expect(config.visionSidecar).toEqual(expectedVision);
        expect(config.webSearchSidecar).toEqual(expectedSearch);
      };
      check(live);
      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.source).toBe("file");
      check(diagnostics.config);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
      armClaudeCodeBaseline(live);
      for (const fastMode of [true, false]) {
        live.fastMode = fastMode;
        saveConfigPreservingClaudeCode(live);
        check(live);
        check(JSON.parse(readFileSync(getConfigPath(), "utf8")));
        check(loadConfig());
        expect(loadConfig().fastMode).toBe(fastMode);
      }
    });
  }
}, 60_000);

test.each([false, true, undefined])("healthy sidecar settings keep their activation and targets (enabled: %s)", enabled => {
  const settings = { ...(enabled === undefined ? {} : { enabled }), model: "healthy/keep", reasoning: "low", timeoutMs: 12_345 };
  const visionSidecar = { ...settings, backend: "routed", maxDescriptionsPerTurn: 2 };
  const webSearchSidecar = { ...settings, backend: "openai", maxSearchesPerTurn: 3 };
  withLegacyConfig({ visionSidecar, webSearchSidecar }, bytes => {
    const live = loadConfig();
    expect(live.visionSidecar).toEqual(visionSidecar);
    expect(live.webSearchSidecar).toEqual(webSearchSidecar);
    expect(readConfigDiagnostics().config.visionSidecar).toEqual(visionSidecar);
    expect(readConfigDiagnostics().config.webSearchSidecar).toEqual(webSearchSidecar);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
    armClaudeCodeBaseline(live);
    live.fastMode = true;
    saveConfigPreservingClaudeCode(live);
    expect(loadConfig().visionSidecar).toEqual(visionSidecar);
    expect(loadConfig().webSearchSidecar).toEqual(webSearchSidecar);
  });
});

test.each([false, true, undefined])("Claude retired overrides stay disabled without changing healthy globals (enabled: %s)", enabled => {
  const request = parseRequest({ model: "healthy/blind", tools: [{ type: "web_search" }], input: [{ role: "user", content: [
    { type: "input_text", text: "Describe and search." }, { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
  ] }] });
  const globalVision = { enabled: true, backend: "routed", model: "healthy/vision", timeoutMs: 12_345 };
  const globalSearch = { enabled: true, backend: "exa", model: "healthy/search", exaApiKey: "fixture-exa-key" };
  for (const globals of [false, true]) for (const model of ["opencode-free/old", " retired-alias/old ", "combo/retired", "retired-combo", "policy/retired", "retired-policy"]) {
    const activation = enabled === undefined ? {} : { enabled };
    withLegacyConfig({
      ...(globals ? { visionSidecar: globalVision, webSearchSidecar: globalSearch } : {}),
      combos: { retired: { alias: " retired-combo ", targets: [{ provider: "opencode-free", model: "old" }] } },
      routingProfiles: { retired: { alias: " retired-policy ", candidates: [{ provider: "opencode-free", model: "old" }] } },
      claudeCode: { enabled: true, visionSidecar: { ...activation, backend: "routed", model }, webSearchSidecar: { ...activation, backend: "openai", model } },
    }, bytes => {
      const live = loadConfig();
      live.providers.healthy!.modelInputModalities = { blind: ["text"], vision: ["text", "image"] };
      const check = (config: ReturnType<typeof loadConfig>) => {
        expect(config.visionSidecar).toEqual(globals ? globalVision : undefined);
        expect(config.webSearchSidecar).toEqual(globals ? globalSearch : undefined);
        expect(config.claudeCode?.visionSidecar).toEqual({ enabled: false, backend: "routed" });
        expect(config.claudeCode?.webSearchSidecar).toEqual({ enabled: false, backend: "openai" });
        const effective = buildClaudeReplayConfig(config);
        const provider = { ...config.providers.healthy!, noVisionModels: ["blind"] };
        expect(planVisionSidecar(effective, provider, "blind", request, undefined, { providerName: "healthy" })).toBeUndefined();
        expect(shouldResolveOpenAiVisionSidecar(effective, provider, "blind", request, "healthy")).toBe(false);
        expect(planWebSearch(effective, request, false, provider, "blind")).toBeUndefined();
        expect(shouldResolveOpenAiWebSearchSidecar(effective, request, false)).toBe(false);
      };
      check(live);
      expect(readConfigDiagnostics().source).toBe("file");
      check(readConfigDiagnostics().config);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
      // The same legitimate global/default config remains usable outside the Claude override.
      const provider = live.providers.healthy!;
      expect(planVisionSidecar(live, provider, "blind", request, undefined, { providerName: "healthy" })?.backend).toBe(globals ? "routed" : undefined);
      expect(planWebSearch(live, request, false, provider, "blind")?.backend).toBe(globals ? "exa" : undefined);
      expect(shouldResolveOpenAiVisionSidecar(live, provider, "blind", request, "healthy")).toBe(!globals);
      expect(shouldResolveOpenAiWebSearchSidecar(live, request, false)).toBe(!globals);
      armClaudeCodeBaseline(live);
      for (const fastMode of [true, false]) {
        live.fastMode = fastMode;
        saveConfigPreservingClaudeCode(live);
        check(live);
        check(JSON.parse(readFileSync(getConfigPath(), "utf8")));
        check(loadConfig());
      }
    });
  }
}, 60_000);

test("unrelated providers and config remain unchanged", () => {
  const home = createTempHome("ocx-retained-provider-");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const raw = getDefaultConfig();
    writeFileSync(getConfigPath(), JSON.stringify(raw));
    expect(loadConfig().providers).toEqual(raw.providers);
    expect(warn.mock.calls).toHaveLength(0);
  } finally { warn.mockRestore(); home.remove(); }
});
