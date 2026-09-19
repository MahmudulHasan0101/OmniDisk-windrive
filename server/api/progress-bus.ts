import { EventEmitter } from "node:events";
import type { FileBlock } from "../core/models.js";

export interface ProgressEvent {
  fileUuid: string;
  block: FileBlock;
}

/**
 * Backs the SSE endpoint `/api/files/:fileUuid/progress` (spec section 10)
 * so the UI can show live per-block progress bars without polling.
 * Single-process, in-memory — fine for a local single-user app (spec
 * section 2 non-goals).
 */
class ProgressBus extends EventEmitter {
  publish(event: ProgressEvent): void {
    this.emit(event.fileUuid, event.block);
  }

  subscribe(fileUuid: string, listener: (block: FileBlock) => void): () => void {
    this.on(fileUuid, listener);
    return () => this.off(fileUuid, listener);
  }
}

export const progressBus = new ProgressBus();
progressBus.setMaxListeners(50);
