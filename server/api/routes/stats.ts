import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/client.js";
import { ProviderAccountRepository, FileRepository } from "../../db/repository.js";

interface ProviderBreakdown {
  providerName: string;
  accountIndex: number;
  label?: string;
  freeSpace: number;
  usedSpace: number;
  blockCount: number;
  enabled: boolean;
}

export function registerStatsRoutes(app: FastifyInstance): void {
  const db = getDb();
  const providerRepo = new ProviderAccountRepository(db);
  const fileRepo = new FileRepository(db);

  app.get("/api/stats", async () => {
    const accounts = providerRepo.list();
    const files = fileRepo.listFiles();

    const blockCounts = db
      .prepare(
        `SELECT provider_name, account_index, COUNT(*) AS n
         FROM file_blocks GROUP BY provider_name, account_index`,
      )
      .all() as { provider_name: string; account_index: number; n: number }[];

    const blockCountByAccount = new Map(
      blockCounts.map((row) => [`${row.provider_name}:${row.account_index}`, row.n]),
    );

    const perProvider: ProviderBreakdown[] = accounts.map((a) => ({
      providerName: a.providerName,
      accountIndex: a.accountIndex,
      label: a.label,
      freeSpace: (a.totalSpace ?? 0) - (a.usedSpace ?? 0),
      usedSpace: a.usedSpace ?? 0,
      blockCount: blockCountByAccount.get(`${a.providerName}:${a.accountIndex}`) ?? 0,
      enabled: a.enabled,
    }));

    const totalSpace = accounts
      .filter((a) => a.enabled)
      .reduce((sum, a) => sum + (a.totalSpace ?? 0), 0);
    const totalUsed = accounts
      .filter((a) => a.enabled)
      .reduce((sum, a) => sum + (a.usedSpace ?? 0), 0);

    return {
      totalSpace,
      totalUsed,
      totalFree: totalSpace - totalUsed,
      totalBlockCount: blockCounts.reduce((sum, row) => sum + row.n, 0),
      totalFiles: files.length,
      filesByStatus: {
        complete: files.filter((f) => f.status === "complete").length,
        partial: files.filter((f) => f.status === "partial").length,
        failed: files.filter((f) => f.status === "failed").length,
        pending: files.filter((f) => f.status === "pending" || f.status === "uploading").length,
      },
      perProvider,
    };
  });
}
