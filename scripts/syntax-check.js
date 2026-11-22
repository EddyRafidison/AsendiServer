"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const excludedDirectories = new Set(["node_modules", ".git", "coverage"]);
const files = [];

function collectJavaScript(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) collectJavaScript(path.join(directory, entry.name));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) files.push(path.join(directory, entry.name));
  }
}

collectJavaScript(root);
files.sort();
let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(`${path.relative(root, file)}\n${result.stderr || result.stdout}`);
  }
}
if (failed) process.exit(1);
process.stdout.write(`Syntax check passed for ${files.length} JavaScript files.\n`);
