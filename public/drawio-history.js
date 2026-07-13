export function createUndoTimeline(limit = 80) {
  const entries = [];
  const maximum = Math.max(1, Number(limit) || 80);

  function push(entry) {
    if (!entry) {
      return null;
    }

    entries.push(entry);

    if (entries.length > maximum) {
      entries.splice(0, entries.length - maximum);
    }

    return entry;
  }

  return {
    clear() {
      entries.length = 0;
    },
    get size() {
      return entries.length;
    },
    pop() {
      return entries.pop() || null;
    },
    pushEditorChange() {
      return push({ type: "drawio" });
    },
    pushSnapshot(snapshot) {
      if (!snapshot?.xml) {
        return null;
      }

      return push({
        type: "snapshot",
        snapshot: {
          xml: snapshot.xml,
          title: snapshot.title || "",
        },
      });
    },
    restore(entry) {
      return push(entry);
    },
    remove(entry) {
      const index = entries.lastIndexOf(entry);

      if (index >= 0) {
        entries.splice(index, 1);
      }
    },
  };
}
