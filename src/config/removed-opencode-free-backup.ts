import { chmodSync, closeSync, fchmodSync, ftruncateSync, linkSync, lstatSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { nextAtomicTempSequence } from "./atomic-write";
import { forgetEphemeralSecretPath, hardenSecretPath } from "../lib/windows-secret-acl";

let warned = false;

function protectExistingBackup(path: string): void {
  if (!lstatSync(path).isFile()) throw new Error("Recovery copy is not a regular file");
  if (process.platform === "win32") hardenSecretPath(path, { required: true });
  else chmodSync(path, 0o600);
}

/** Publish the exact bytes read from disk without replacing the first recovery copy. */
function backupOriginal(configPath: string, rawBytes: Uint8Array): string | null {
  const backup = `${configPath}.pre-opencode-free-removal.bak`;
  const temp = `${backup}.ocx.${process.pid}.${nextAtomicTempSequence()}.tmp`;
  let descriptor: number | undefined;
  let published = false;
  try {
    try {
      protectExistingBackup(backup);
      return backup;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    descriptor = openSync(temp, "wx", 0o600);
    // Like config.json writes, harden the empty file BEFORE it receives secrets.
    if (process.platform === "win32") hardenSecretPath(temp, { required: true, timeoutMemoKey: backup });
    else fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, rawBytes);
    try {
      linkSync(temp, backup);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      protectExistingBackup(backup);
    }
    return backup;
  } catch {
    console.warn("Could not preserve the original config before OpenCode Free removal.");
    return null;
  } finally {
    if (descriptor !== undefined) {
      // A published hard link shares its bytes with temp: never truncate that inode.
      if (!published) {
        try { ftruncateSync(descriptor, 0); } catch { /* still attempt removal */ }
      }
      try { closeSync(descriptor); } catch { /* still attempt removal */ }
      try {
        unlinkSync(temp);
        forgetEphemeralSecretPath(temp);
      } catch {
        console.warn("Could not remove an OpenCode Free recovery temporary file.");
      }
    }
  }
}

/** Disk-load boundary only; imported text and pure projections never create backups or notices. */
export function preserveRemovedOpenCodeFree(configPath: string, rawBytes: Uint8Array): void {
  const backup = backupOriginal(configPath, rawBytes);
  if (warned) return;
  warned = true;
  const recovery = backup
    ? `the original file was saved to ${backup} (restore by copying it back over config.json, for example after downgrading).`
    : "copy config.json now if you need the old entry.";
  console.warn(`opencode-free support was removed because every free model now returns 403 permission_denied under OpenCode's upstream free-tier gate (#7255); the entry and dependent references are disabled. The next configuration save removes them from config.json; ${recovery} Use opencode-go, or another provider such as opencode-zen or openrouter.`);
}
