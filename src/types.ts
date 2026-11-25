export type MarkerMode = "off" | "mark" | "erase";

/** Offsets are graphemes in the normalized rendered text, NOT screen coordinates. */
export interface MarkSpan {
  entryId: string;
  blockIndex: number;
  sourceHash: string;
  displayHash: string;
  start: number;
  end: number;
  rangeHash: string;
}

export interface MarkGroup {
  id: string;
  spans: MarkSpan[];
}

/** In-memory edit: span is the original saved object; remaining has fresh anchors. */
export interface SpanReplacement {
  span: MarkSpan;
  remaining: MarkSpan[];
}
