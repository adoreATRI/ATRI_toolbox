function shouldSuppressElectronLogLine(line) {
  const text = String(line || "");
  return /^MESA-LOADER: failed to open dri: .*\/gbm\/dri_gbm\.so:/.test(text)
    || /atom_cache\.cc:\d+\] Add application\/vnd\.portal\.(?:filetransfer|files) to kAtomsToCache/.test(text);
}

function createLineFilter(write, shouldSuppress = shouldSuppressElectronLogLine) {
  let buffered = "";

  function push(chunk) {
    buffered += String(chunk || "");
    const lines = buffered.split("\n");
    buffered = lines.pop() || "";

    for (const line of lines) {
      if (!shouldSuppress(line.replace(/\r$/, ""))) {
        write(`${line}\n`);
      }
    }
  }

  function flush() {
    if (buffered && !shouldSuppress(buffered.replace(/\r$/, ""))) {
      write(buffered);
    }

    buffered = "";
  }

  return { flush, push };
}

module.exports = {
  createLineFilter,
  shouldSuppressElectronLogLine,
};
