import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { CREDENTIALS_PATH, APPDATA_DIR } from "../db/client.js";
import { join } from "node:path";

const SERVICE_NAME = "OmniDisk";
const SCRYPT_KEYLEN = 32; // AES-256
const GCM_IV_LENGTH = 12;
const LOCAL_VAULT_KEY_PATH = join(APPDATA_DIR, ".vaultkey");
const KEYTAR_PROBE_REF = "__omnidisk_keytar_probe__";

interface EncryptedBlobFile {
  salt: string; // hex
  entries: Record<string, { iv: string; authTag: string; ciphertext: string }>;
}

/**
 * Preference order, per spec section 9:
 *   1. OS keychain via `keytar` (Credential Manager / Keychain / libsecret)
 *   2. AES-256-GCM encrypted `credentials.enc`, key derived via scrypt from
 *      a random key generated on first use (persisted at
 *      `<AppData>/.vaultkey`) plus an optional user passphrase.
 *
 * `keytar` ships as an optional native dependency. Two distinct failure
 * modes both need to fall through to the encrypted file, not just one:
 *   a) the native module fails to load at all (unsupported platform), or
 *   b) it loads fine but the actual OS call fails at runtime — this is the
 *      common case on headless Linux, where the module builds and imports
 *      cleanly but there's no D-Bus session / Secret Service running to
 *      talk to. Import success alone is not a reliable availability signal.
 * Both are probed once (lazily, on first real use) and cached for the life
 * of this instance.
 *
 * The "user passphrase prompted once per session" flow from the spec isn't
 * wired up yet (no session/first-run UI exists at this stage) — until a
 * caller supplies one via setPassphrase(), the encrypted-file backend uses
 * a random key generated on first use and persisted at
 * `<AppData>/.vaultkey` (0600) as the key material instead. This
 * keeps the fallback fully functional out of the box; swapping in a real
 * user passphrase later is a pure improvement, not a breaking change to
 * this format, since the derivation still just uses whatever
 * passphraseMaterial() returns.
 */
export class CredentialVault {
  private keytarModule: typeof import("keytar") | null | undefined;
  private keytarUsable: boolean | undefined;
  private passphrase: string | undefined;

  constructor(passphrase?: string) {
    this.passphrase = passphrase;
  }

  setPassphrase(passphrase: string): void {
    this.passphrase = passphrase;
    this.keytarUsable = undefined; // allow re-probing if the caller wants OS keychain retried later
  }

  /** Reports which backend is active, for the Settings page status line. */
  async getBackend(): Promise<"os_keychain" | "encrypted_file"> {
    return (await this.probeKeytar()) ? "os_keychain" : "encrypted_file";
  }

  async setCredential(credentialRef: string, secret: string): Promise<void> {
    if (await this.probeKeytar()) {
      try {
        await this.keytarModule!.setPassword(SERVICE_NAME, credentialRef, secret);
        return;
      } catch {
        this.keytarUsable = false; // fall through to encrypted file below
      }
    }
    this.setCredentialEncrypted(credentialRef, secret);
  }

  async getCredential(credentialRef: string): Promise<string | null> {
    if (await this.probeKeytar()) {
      try {
        return await this.keytarModule!.getPassword(SERVICE_NAME, credentialRef);
      } catch {
        this.keytarUsable = false;
      }
    }
    return this.getCredentialEncrypted(credentialRef);
  }

  async deleteCredential(credentialRef: string): Promise<void> {
    if (await this.probeKeytar()) {
      try {
        await this.keytarModule!.deletePassword(SERVICE_NAME, credentialRef);
        return;
      } catch {
        this.keytarUsable = false;
      }
    }
    this.deleteCredentialEncrypted(credentialRef);
  }

  // -- OS keychain backend --------------------------------------------------

  private async loadKeytar(): Promise<typeof import("keytar") | null> {
    if (this.keytarModule !== undefined) return this.keytarModule;
    try {
      this.keytarModule = await import("keytar");
    } catch {
      this.keytarModule = null; // not installed / unsupported platform
    }
    return this.keytarModule;
  }

  /**
   * Confirms keytar not only imports but actually works, by round-tripping
   * a throwaway entry. Cached after the first probe so a dead D-Bus
   * connection doesn't retry (and time out) on every credential access.
   */
  private async probeKeytar(): Promise<boolean> {
    if (this.keytarUsable !== undefined) return this.keytarUsable;

    const keytar = await this.loadKeytar();
    if (!keytar) {
      this.keytarUsable = false;
      return false;
    }

    try {
      await keytar.setPassword(SERVICE_NAME, KEYTAR_PROBE_REF, "probe");
      await keytar.deletePassword(SERVICE_NAME, KEYTAR_PROBE_REF);
      this.keytarUsable = true;
    } catch {
      this.keytarUsable = false;
    }
    return this.keytarUsable;
  }

  // -- Encrypted-file fallback backend --------------------------------------

  private getOrCreateLocalVaultKey(): string {
    if (existsSync(LOCAL_VAULT_KEY_PATH)) {
      return readFileSync(LOCAL_VAULT_KEY_PATH, "utf-8").trim();
    }
    mkdirSync(APPDATA_DIR, { recursive: true });
    const key = randomBytes(32).toString("hex");
    writeFileSync(LOCAL_VAULT_KEY_PATH, key, { mode: 0o600 });
    return key;
  }

  private passphraseMaterial(): string {
    return this.passphrase ?? this.getOrCreateLocalVaultKey();
  }

  private deriveKey(salt: Buffer): Buffer {
    // Previously also mixed in hostname() as a "machine-bound" factor.
    // Dropped: it silently broke decryption for anyone whose AppData
    // directory legitimately moves or is restored on a different machine
    // — including Colab, where a fresh VM gets a new random hostname every
    // session even though credentials.enc and .vaultkey both persist fine
    // on Drive. The persisted random key material already IS the secret;
    // hostname added no real security, only a portability footgun.
    return scryptSync(this.passphraseMaterial(), salt, SCRYPT_KEYLEN);
  }

  private loadBlobFile(): EncryptedBlobFile {
    if (!existsSync(CREDENTIALS_PATH)) {
      return { salt: randomBytes(16).toString("hex"), entries: {} };
    }
    const raw = readFileSync(CREDENTIALS_PATH, "utf-8");
    return JSON.parse(raw) as EncryptedBlobFile;
  }

  private saveBlobFile(blob: EncryptedBlobFile): void {
    writeFileSync(CREDENTIALS_PATH, JSON.stringify(blob), {
      mode: 0o600,
    });
  }

  private setCredentialEncrypted(credentialRef: string, secret: string): void {
    const blob = this.loadBlobFile();
    const salt = Buffer.from(blob.salt, "hex");
    const key = this.deriveKey(salt);
    const iv = randomBytes(GCM_IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(secret, "utf-8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    blob.entries[credentialRef] = {
      iv: iv.toString("hex"),
      authTag: authTag.toString("hex"),
      ciphertext: ciphertext.toString("hex"),
    };
    this.saveBlobFile(blob);
  }

  private getCredentialEncrypted(credentialRef: string): string | null {
    const blob = this.loadBlobFile();
    const entry = blob.entries[credentialRef];
    if (!entry) return null;

    const salt = Buffer.from(blob.salt, "hex");
    const key = this.deriveKey(salt);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(entry.iv, "hex"),
    );
    decipher.setAuthTag(Buffer.from(entry.authTag, "hex"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(entry.ciphertext, "hex")),
      decipher.final(),
    ]);
    return plaintext.toString("utf-8");
  }

  private deleteCredentialEncrypted(credentialRef: string): void {
    const blob = this.loadBlobFile();
    delete blob.entries[credentialRef];
    this.saveBlobFile(blob);
  }
}
