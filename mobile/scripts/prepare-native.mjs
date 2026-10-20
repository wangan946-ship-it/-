import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const androidAssets = path.join(root, "android/app/src/main/assets");
mkdirSync(androidAssets, { recursive: true });
copyFileSync(path.join(root, "policy.json"), path.join(androidAssets, "policy.json"));
copyFileSync(path.join(root, "policy.json"), path.join(root, "ios/App/App/policy.json"));
// Pin the native SPM runtime to the same reviewed version as the JS bridge.
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const spm = path.join(root, "ios/App/CapApp-SPM/Package.swift");
writeFileSync(spm, readFileSync(spm, "utf8").replace(/\.package\(url: "https:\/\/github.com\/ionic-team\/capacitor-swift-pm.git", (?:from|exact): "[^"]+"\)/,
  `.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "${pkg.dependencies["@capacitor/core"]}")`));
console.log("Native policy copied; Swift runtime pinned.");
