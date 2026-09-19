import type { ProviderAccountBase } from "./provider-account-base.js";

/**
 * Holds the live, connected `ProviderAccountBase` instances for the
 * currently-running process. Empty at the Phase 0 skeleton stage — no
 * concrete adapters exist yet (see server/providers/, populated in
 * Phase 1+). The API layer and PriorityManager both read through this
 * registry rather than instantiating adapters themselves, so wiring up a
 * new provider later never touches the router or the routes.
 */
export class AccountRegistry {
  private accounts = new Map<string, ProviderAccountBase>();

  private key(providerName: string, accountIndex: number): string {
    return `${providerName}:${accountIndex}`;
  }

  register(account: ProviderAccountBase): void {
    const { providerName, accountIndex } = account.identity;
    this.accounts.set(this.key(providerName, accountIndex), account);
  }

  unregister(providerName: string, accountIndex: number): void {
    this.accounts.delete(this.key(providerName, accountIndex));
  }

  /** Drops every registered adapter — used by the "Clear all storage" reset. */
  clear(): void {
    this.accounts.clear();
  }

  resolve(providerName: string, accountIndex: number): ProviderAccountBase {
    const account = this.accounts.get(this.key(providerName, accountIndex));
    if (!account) {
      throw new Error(
        `No connected adapter for ${providerName} (account ${accountIndex}). ` +
          `Either the account was never authenticated in this session, or its ` +
          `provider adapter isn't implemented yet.`,
      );
    }
    return account;
  }

  tryResolve(providerName: string, accountIndex: number): ProviderAccountBase | null {
    return this.accounts.get(this.key(providerName, accountIndex)) ?? null;
  }

  all(): ProviderAccountBase[] {
    return [...this.accounts.values()];
  }
}
