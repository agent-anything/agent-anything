const {app} = require("electron");
const assert = require("node:assert/strict");
const {mkdtemp, realpath, writeFile, rm} = require("node:fs/promises");
const {tmpdir} = require("node:os");
const {join, resolve, dirname, basename} = require("node:path");
const {pathToFileURL} = require("node:url");

async function main() {
  const source = resolve(__dirname, "../../../local-environment/dist/filesystem");
  const {searchWorkspaceFiles} = await import(pathToFileURL(join(source, "FileSearch.js")));
  const {readFileTextPage} = await import(pathToFileURL(join(source, "FileTextRead.js")));
  const {resolveFileSystemLimits} = await import(pathToFileURL(join(source, "FileSystemLimits.js")));
  const root = await realpath(await mkdtemp(join(tmpdir(), "helarc-file-tools-")));
  const signal = new AbortController().signal;
  try {
    const path = join(root, "large.txt");
    await writeFile(path, "\uFEFFfirst\r\n" + "tail\r\n".repeat(200000));
    const page = await readFileTextPage({path, offset: 1, limit: 1, maxBytes: 20, maxInspectionBytes: 2000000, signal});
    assert.equal(page.content, "\uFEFFfirst\r\n");
    assert.equal(page.next_offset, 2);
    const request = {operation: "grep", root, target: root, pattern: "needle", glob: null,
      mode: "content", offset: 1, limit: 10, caseSensitive: true, multiline: false, before: 0, after: 0};
    await writeFile(join(root, "text.txt"), "needle\r\n");
    const result = await searchWorkspaceFiles(request, resolveFileSystemLimits(), signal);
    assert.equal(result.entries.length, 1);
    assert.equal(result.scan.complete, false);
    assert.equal(result.omitted_count, null);
    assert(result.scan.skipped.some(entry => entry.reason === "file_byte_limit"));
    await writeFile(join(root, "regex.txt"), "a".repeat(10000) + "!");
    const timed = await searchWorkspaceFiles({...request, target: join(root, "regex.txt"), pattern: "(a+)+$"},
      resolveFileSystemLimits({maxSearchRegexMs: 500}), signal);
    assert.equal(timed.scan.stop_reason, "file_search_regex_timeout");
    const next = await searchWorkspaceFiles({...request, target: join(root, "text.txt")}, resolveFileSystemLimits(), signal);
    assert.equal(next.scan.complete, true);
    assert.equal(next.entries.length, 1);
    process.stdout.write("Real Electron file paging and bounded regex Worker passed.\n");
  } finally {
    if (dirname(root) !== await realpath(tmpdir()) || !basename(root).startsWith("helarc-file-tools-")) throw new Error("Unexpected cleanup target");
    await rm(root, {recursive: true, force: true});
  }
}

app.whenReady().then(main).then(() => app.exit(0), error => {process.stderr.write(`${error.stack}\n`); app.exit(1);});
