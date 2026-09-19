import { ProviderAccountBase } from "../../server/core/provider-account-base.js";
import type {
  FileBlock,
  ProviderAccountIdentity,
} from "../../server/core/models.js";

export interface MockAccountOptions {
  providerName: string;
  accountIndex?: number;
  freeSpace: number;
  latencyMs?: number;
  speedBps?: number;
  /** If true, every store() call fails until this many attempts have been made. */
  failFirstNStores?: number;
  /** Artificial delay for store()/retrieve() — lets tests assert on real concurrency (wall-clock time), not just correctness. */
  storeDelayMs?: number;
  retrieveDelayMs?: number;
}

/**
 * In-memory ProviderAccountBase used by unit/integration tests, per spec
 * section 13 ("mock ProviderAccountBase implementations with fixed
 * free-space values" / "in-memory mock provider accounts, no real network
 * calls in CI").
 */
export class MockProviderAccount extends ProviderAccountBase {
  readonly identity: ProviderAccountIdentity;
  readonly baseUrl = "mock://local";

  private storage = new Map<string, Buffer>();
  private freeSpace: number;
  private latencyMs: number;
  private speedBps: number;
  private failFirstNStores: number;
  private storeAttempts = new Map<string, number>();
  private storeDelayMs: number;
  private retrieveDelayMs: number;

  constructor(options: MockAccountOptions) {
    super();
    this.identity = {
      providerName: options.providerName,
      accountIndex: options.accountIndex ?? 0,
    };
    this.freeSpace = options.freeSpace;
    this.latencyMs = options.latencyMs ?? 10;
    this.speedBps = options.speedBps ?? 10_000_000;
    this.failFirstNStores = options.failFirstNStores ?? 0;
    this.storeDelayMs = options.storeDelayMs ?? 0;
    this.retrieveDelayMs = options.retrieveDelayMs ?? 0;
  }

  async getStorableSpace(): Promise<number> {
    return this.freeSpace;
  }

  async store(block: FileBlock, data: Buffer): Promise<FileBlock> {
    if (this.storeDelayMs > 0) await new Promise((r) => setTimeout(r, this.storeDelayMs));
    const attempts = (this.storeAttempts.get(block.blockId) ?? 0) + 1;
    this.storeAttempts.set(block.blockId, attempts);

    if (attempts <= this.failFirstNStores) {
      throw new Error(`Simulated transient failure (attempt ${attempts})`);
    }

    this.storage.set(block.remotePath, data);
    this.freeSpace -= data.length;
    this.storeCallCount++;
    return block;
  }

  /** Lets tests assert that a partial update re-uploaded only what changed. */
  storeCallCount = 0;

  async retrieve(block: FileBlock): Promise<Buffer> {
    if (this.retrieveDelayMs > 0) await new Promise((r) => setTimeout(r, this.retrieveDelayMs));
    const data = this.storage.get(block.remotePath);
    if (!data) throw new Error(`No stored data for ${block.remotePath}`);
    this.retrieveCallCount++;
    return data;
  }

  /** Lets tests assert that a ranged read fetched only the blocks it needed. */
  retrieveCallCount = 0;

  async delete(block: FileBlock): Promise<void> {
    this.storage.delete(block.remotePath);
  }

  async pingLatency(): Promise<number> {
    return this.latencyMs;
  }

  async measureThroughput(): Promise<number> {
    return this.speedBps;
  }
}
