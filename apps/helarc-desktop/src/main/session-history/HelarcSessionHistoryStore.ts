import {
  createHelarcSessionHistoryRecord,
  type HelarcSessionHistoryRecord,
} from "@agent-anything/helarc";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface HelarcSessionHistoryStore {
  listRecords(): Promise<HelarcSessionHistoryRecord[]>;
  appendRecord(record: HelarcSessionHistoryRecord): Promise<HelarcSessionHistoryRecord[]>;
}

export class FileHelarcSessionHistoryStore implements HelarcSessionHistoryStore {
  constructor(
    private readonly filePath: string,
    private readonly maxRecords = 100,
  ) {}

  async listRecords(): Promise<HelarcSessionHistoryRecord[]> {
    return sortRecords(await this.readRecords());
  }

  async appendRecord(record: HelarcSessionHistoryRecord): Promise<HelarcSessionHistoryRecord[]> {
    const current = await this.readRecords();
    const nextRecords = sortRecords([
      record,
      ...current.filter((item) => item.id !== record.id),
    ]).slice(0, this.maxRecords);
    await this.writeRecords(nextRecords);
    return nextRecords;
  }

  private async readRecords(): Promise<HelarcSessionHistoryRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.flatMap((item) => {
        const result = createHelarcSessionHistoryRecord(item as Parameters<typeof createHelarcSessionHistoryRecord>[0]);
        return result.ok ? [result.record] : [];
      });
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }
  }

  private async writeRecords(records: readonly HelarcSessionHistoryRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(records, null, 2), "utf8");
  }
}

function sortRecords(records: readonly HelarcSessionHistoryRecord[]): HelarcSessionHistoryRecord[] {
  return [...records].sort((left, right) => right.endedAt.localeCompare(left.endedAt));
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
