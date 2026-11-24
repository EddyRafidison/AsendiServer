"use strict";

const fs = require("node:fs");
const path = require("node:path");
const solc = require("solc");

function resolveImport(importPath) {
  const normalized = String(importPath).replace(/^\/+/, "");
  const candidates = [
    path.resolve(process.cwd(), "node_modules", normalized),
    path.resolve(__dirname, "..", "node_modules", normalized),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { contents: fs.readFileSync(candidate, "utf8") };
  }
  return { error: `Unable to resolve Solidity import: ${importPath}` };
}

function compileOneXToken() {
  const contractPath = path.resolve(__dirname, "..", "contracts", "OneXToken.sol");
  const source = fs.readFileSync(contractPath, "utf8");
  const input = {
    language: "Solidity",
    sources: { "contracts/OneXToken.sol": { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "metadata"] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: resolveImport }));
  const errors = (output.errors || []).filter((item) => item.severity === "error");
  if (errors.length) throw new Error(errors.map((item) => item.formattedMessage).join("\n"));
  const contract = output.contracts?.["contracts/OneXToken.sol"]?.OneXToken;
  if (!contract?.evm?.bytecode?.object) throw new Error("Solidity compiler did not produce the OneXToken bytecode.");
  return {
    contractName: "OneXToken",
    compilerVersion: solc.version(),
    sourceHash: require("node:crypto").createHash("sha256").update(source).digest("hex"),
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}`,
    metadata: contract.metadata,
  };
}

if (require.main === module) {
  try {
    const artifact = compileOneXToken();
    const outputDirectory = path.resolve(__dirname, "..", "artifacts");
    fs.mkdirSync(outputDirectory, { recursive: true });
    const outputPath = path.join(outputDirectory, "OneXToken.json");
    fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`Compiled OneXToken with ${artifact.compilerVersion}. Artifact: ${path.relative(process.cwd(), outputPath)}\n`);
  } catch (error) {
    process.stderr.write(`XTU contract compilation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { compileOneXToken };
