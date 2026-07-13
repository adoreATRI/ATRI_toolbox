import assert from "node:assert/strict";
import { test } from "node:test";

import { createUndoTimeline } from "../public/drawio-history.js";

test("undo timeline keeps manual edits after an AI snapshot granular", () => {
  const timeline = createUndoTimeline();
  timeline.pushSnapshot({ xml: "before-ai", title: "Map" });
  timeline.pushEditorChange();

  assert.equal(timeline.pop().type, "drawio");
  assert.deepEqual(timeline.pop(), {
    type: "snapshot",
    snapshot: { xml: "before-ai", title: "Map" },
  });
});

test("undo timeline preserves chronology across consecutive AI edits", () => {
  const timeline = createUndoTimeline();
  timeline.pushSnapshot({ xml: "before-first-ai", title: "Map" });
  timeline.pushEditorChange();
  timeline.pushSnapshot({ xml: "before-second-ai", title: "Map" });

  assert.equal(timeline.pop().snapshot.xml, "before-second-ai");
  assert.equal(timeline.pop().type, "drawio");
  assert.equal(timeline.pop().snapshot.xml, "before-first-ai");
});

test("undo timeline can restore a failed entry without changing order", () => {
  const timeline = createUndoTimeline(2);
  const first = timeline.pushSnapshot({ xml: "one" });
  timeline.pushEditorChange();
  const latest = timeline.pop();
  timeline.restore(latest);

  assert.equal(timeline.pop(), latest);
  assert.equal(timeline.pop(), first);
});
