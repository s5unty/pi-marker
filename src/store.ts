import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { MarkGroup, MarkSpan, SpanReplacement } from "./types.ts";

export const ENTRY_TYPE = "pi-marker:v1";
export type MarkerOperation =
  | { version: 1; kind: "add"; group: MarkGroup }
  | { version: 1; kind: "remove"; groupIds: string[] }
  | { version: 1; kind: "replace"; groups: MarkGroup[] }
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
  if (value.kind === "replace" && Array.isArray(value.groups) && value.groups.length > 0 &&
      value.groups.every((group) => record(group) && id(group.id) && Array.isArray(group.spans) && group.spans.every(span)) &&
      new Set(value.groups.map((group) => group.id)).size === value.groups.length) {
    // Splitting an existing stroke can grow beyond the 128-block creation limit.
    return { version: 1, kind: "replace", groups: value.groups.map((group) => ({
      id: group.id, spans: group.spans.map((item: MarkSpan) => ({ ...item })),
    })) };
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
      case "replace": return operation.groups.some((next) => this.current.some((group) =>
        group.id === next.id && JSON.stringify(group.spans) !== JSON.stringify(next.spans)));
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
        case "replace": {
          const replacements = new Map(operation.groups.map((group) => [group.id, group]));
          this.current = this.current.flatMap((group) => {
            const next = replacements.get(group.id) ?? group;
            return next.spans.length ? [next] : [];
          });
          break;
        }
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

  /** Replace only touched spans, keeping stroke IDs, order and untouched blocks.
   * Persist the resulting operation once so an entire drag is one undo step.
   */
  replaceSpans(replacements: readonly SpanReplacement[]): MarkerOperation {
    const bySpan = new Map(replacements.map(({ span, remaining }) => [span, remaining]));
    const groups = this.current.filter((group) => group.spans.some((span) => bySpan.has(span)))
      .map((group) => ({ ...group, spans: group.spans.flatMap((span) => bySpan.get(span) ?? [span]) }));
    return { version: 1, kind: "replace", groups };
  }

  /** Legacy whole-stroke lookup; old remove operations remain replayable. */
  intersectingGroups(selection: readonly MarkSpan[]): string[] {
    return this.current.filter((group) => group.spans.some((mark) => selection.some((selected) =>
      mark.entryId === selected.entryId && mark.blockIndex === selected.blockIndex &&
      mark.sourceHash === selected.sourceHash && mark.displayHash === selected.displayHash &&
      mark.start < selected.end && mark.end > selected.start,
    ))).map((group) => group.id);
  }
}
