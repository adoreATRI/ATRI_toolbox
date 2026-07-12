const fs = require("node:fs");
const path = require("node:path");

let temporaryFileCounter = 0;

async function atomicWriteFile(filePath, content, options = {}) {
  const fsPromises = options.fsPromises || fs.promises;
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${temporaryFileCounter += 1}.tmp`,
  );

  await fsPromises.mkdir(directory, { recursive: true });

  try {
    await fsPromises.writeFile(temporaryPath, content, {
      encoding: "utf8",
      mode: options.mode,
    });
    await fsPromises.rename(temporaryPath, filePath);
  } catch (error) {
    await fsPromises.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

module.exports = { atomicWriteFile };
