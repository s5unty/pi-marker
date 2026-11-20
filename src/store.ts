import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { MarkGroup, MarkSpan } from "./types.ts";

export const ENTRY_TYPE = "pi-marker:v1";
export type MarkerOperation =
  | { version: 1; kind: "add"; group: MarkGroup }
  | { version: 1; kind: "remove"; groupIds: string[] }
  | { version: 1; kind: "clear" }
  | { version: 1; kind: "undo" };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}
function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function span(value: unknown): value is MarkSpan {
  return record(value) && id(value.entryId) && nonnegativeInteger(value.blockIndex) &&
    hash(value.sourceHash) && hash(value.displayHash) && hash(value.rangeHash) &&
    nonnegativeInteger(value.start) && nonnegativeInteger(value.end) && value.end > value.start;
}

export function parseOperation(value: unknown): MarkerOperation | undefined {
  if (!record(value) || value.version !== 1) return undefined;
  if (value.kind === "clear" || value.kind === "undo") return { version: 1, kind: value.kind };
  if (value.kind === "remove" && Array.isArray(value.groupIds) && value.groupIds.length > 0 && value.groupIds.every(id)) {
    return { version: 1, kind: "remove", groupIds: [...new Set(value.groupIds)] };
  }
  if (value.kind === "add" && record(value.group) && id(value.group.id) &&
      Array.isArray(value.group.spans) && value.group.spans.length > 0 && value.group.spans.length <= 128 && value.group.spans.every(span)) {
    return { version: 1, kind: "add", group: { id: value.group.id, spans: value.group.spans.map((item) => ({ ...item })) } };
  }
  return undefined;
}

/** Append-only commands replayed from the ACTIVE branch; never from all entries. */
export class MarkerStore {
  private current: readonly MarkGroup[] = [];
  private history: (readonly MarkGroup[])[] = [];
  private flattened: readonly MarkSpan[] = [];

  get groups(): readonly MarkGroup[] { return this.current; }
  get spans(): readonly MarkSpan[] { return this.flattened; }
  get canUndo(): boolean { return this.history.length > 0; }

  wouldChange(operation: MarkerOperation): boolean {
    switch (operation.kind) {
      case "add": return !this.current.some((group) => group.id === operation.group.id);
      case "remove": return this.current.some((group) => operation.groupIds.includes(group.id));
      case "clear": return this.current.length > 0;
      case "undo": return this.canUndo;
    }
  }

  apply(operation: MarkerOperation): boolean {
    if (!this.wouldChange(operation)) return false;
    if (operation.kind === "undo") {
      this.current = this.history.pop()!;
    } else {
      this.history.push(this.current);
      switch (operation.kind) {
        case "add": this.current = [...this.current, operation.group]; break;
        case "remove": this.current = this.current.filter((group) => !operation.groupIds.includes(group.id)); break;
        case "clear": this.current = []; break;
      }
    }
    this.flattened = this.current.flatMap((group) => group.spans);
    return true;
  }

  restore(branch: readonly SessionEntry[]): { invalid: number } {
    this.current = [];
    this.flattened = [];
    this.history = [];
    let invalid = 0;
    for (const entry of branch) {
      if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
      const operation = parseOperation(entry.data);
      if (operation) this.apply(operation);
      else invalid++;
    }
    return { invalid };
  }

  /** An eraser gesture removes whole strokes, including multi-block strokes. */
  intersectingGroups(selection: readonly MarkSpan[]): string[] {
    return this.current.filter((group) => group.spans.some((mark) => selection.some((selected) =>
      mark.entryId === selected.entryId && mark.blockIndex === selected.blockIndex &&
      mark.sourceHash === selected.sourceHash && mark.displayHash === selected.displayHash &&
      mark.start < selected.end && mark.end > selected.start,
    ))).map((group) => group.id);
  }
}
