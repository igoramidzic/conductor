import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyResponseLink,
  resolveResponseFilePath,
} from "./response-links.ts";

test("classifies browser, file, and in-page links", () => {
  assert.deepEqual(classifyResponseLink("https://example.com/docs"), {
    kind: "external",
    url: "https://example.com/docs",
  });
  assert.deepEqual(classifyResponseLink("src/main.ts:42"), {
    kind: "file",
    href: "src/main.ts:42",
  });
  assert.deepEqual(classifyResponseLink("#details"), { kind: "anchor" });
  assert.throws(
    () => classifyResponseLink("vscode://file/example.ts"),
    /not supported/,
  );
});

test("resolves relative and encoded absolute files with line locations", () => {
  const temporaryFolder = fs.mkdtempSync(
    path.join(os.tmpdir(), "conductor-response-link-"),
  );
  try {
    const sourceFolder = path.join(temporaryFolder, "project");
    const nestedFolder = path.join(sourceFolder, "src");
    const linkedFile = path.join(nestedFolder, "linked file.ts");
    fs.mkdirSync(nestedFolder, { recursive: true });
    fs.writeFileSync(linkedFile, "export {};\n");

    assert.equal(
      resolveResponseFilePath(
        "src/linked%20file.ts:12:3",
        sourceFolder,
        temporaryFolder,
      ),
      linkedFile,
    );
    assert.equal(
      resolveResponseFilePath(
        `${encodeURI(linkedFile)}#L12C3`,
        undefined,
        temporaryFolder,
      ),
      linkedFile,
    );
  } finally {
    fs.rmSync(temporaryFolder, { recursive: true, force: true });
  }
});
