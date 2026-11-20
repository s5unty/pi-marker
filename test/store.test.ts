import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ENTRY_TYPE, MarkerStore, parseOperation, type MarkerOperation } from "../src/store.ts";
import { hashText } from "../src/text-map.ts";
import { assistantEntry } from "./helpers.ts";

const mark = { entryId: "answer", blockIndex: 0, start: 1, end: 3, sourceHash: hashText("source"), displayHash: hashText("display"), rangeHash: hashText("is") };
const add = (id: string): MarkerOperation => ({ version: 1, kind: "add", group: { id, spans: [{ ...mark }] } });

test("clear and erase can be undone, including after operation replay", () => {
  const store = new MarkerStore();
  for (const op of [add("a"), add("b"), { version: 1, kind: "clear" }, { version: 1, kind: "undo" }] as MarkerOperation[]) store.apply(op);
  assert.deepEqual(store.groups.map((group) => group.id), ["a", "b"]);
  assert.deepEqual(store.intersectingGroups([{ ...mark, start: 2, end: 4 }]), ["a", "b"]);
  assert.deepEqual(store.intersectingGroups([{ ...mark, start: 3, end: 4 }]), []);
  store.apply({ version: 1, kind: "remove", groupIds: ["b"] });
  assert.equal(store.groups.length, 1);
  store.apply({ version: 1, kind: "undo" });
  assert.equal(store.groups.length, 2);
});

test("saved operations survive reopening, honor branches, and never change model context", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-marker-store-"));
  try {
    const manager = SessionManager.create(directory, directory);
    const answerId = manager.appendMessage(assistantEntry("answer text").message);
    const before = manager.buildSessionProjection().messages;
    const storedLeaf = manager.appendCustomEntry(ENTRY_TYPE, add("original"));
    assert.deepEqual(manager.buildSessionProjection().messages, before);
    const file = manager.getSessionFile()!;
    const reopened = SessionManager.open(file, directory);
    const store = new MarkerStore();
    assert.equal(store.restore(reopened.getBranch()).invalid, 0);
    assert.equal(store.groups[0].id, "original");
    reopened.branch(answerId);
    reopened.appendCustomEntry(ENTRY_TYPE, add("alternative"));
    store.restore(reopened.getBranch());
    assert.deepEqual(store.groups.map((group) => group.id), ["alternative"]);
    assert.ok(reopened.getEntries().length > reopened.getBranch().length);
    reopened.branch(storedLeaf);
    store.restore(reopened.getBranch());
    assert.deepEqual(store.groups.map((group) => group.id), ["original"]);
    reopened.appendCustomEntry(ENTRY_TYPE, { version: 1, kind: "clear" });
    const reloaded = SessionManager.open(file, directory);
    store.restore(reloaded.getBranch());
    assert.equal(store.groups.length, 0);
    reloaded.appendCustomEntry(ENTRY_TYPE, { version: 1, kind: "undo" });
    store.restore(reloaded.getBranch());
    assert.deepEqual(store.groups.map((group) => group.id), ["original"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("malformed and future-version data is rejected rather than rendered", () => {
  assert.equal(parseOperation(null), undefined);
  assert.equal(parseOperation({ version: 2, kind: "clear" }), undefined);
  assert.equal(parseOperation({ version: 1, kind: "add", group: { id: "bad", spans: [{ ...mark, start: -1 }] } }), undefined);
  assert.equal(parseOperation({ version: 1, kind: "add", group: { id: "bad", spans: [{ ...mark, end: Infinity }] } }), undefined);
  assert.equal(parseOperation({ version: 1, kind: "add", group: { id: "bad", spans: [{ ...mark, rangeHash: "oops" }] } }), undefined);
  assert.deepEqual(parseOperation(add("good")), add("good"));
});
