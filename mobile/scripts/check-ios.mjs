// Cross-platform project preflight; this is NOT a Swift compile or an iPhone test.
import assert from "node:assert/strict";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const read = name => readFileSync(path.join(root, name), "utf8");
const pkg = JSON.parse(read("package.json"));
// Use the exact parsers already shipped with the locked Capacitor CLI.
const requireCLI = createRequire(realpathSync(path.join(root, "node_modules/@capacitor/cli/package.json")));
const xcode = requireCLI("xcode"), plist = requireCLI("plist"), xml = requireCLI("xml2js");
const project = xcode.project(path.join(root, "ios/App/App.xcodeproj/project.pbxproj"));
project.parseSync();
const objects = project.hash.project.objects;
const clean = value => String(value).replace(/^"|"$/g, "");
const id = reference => typeof reference === "string" ? reference : reference.value;
const targets = Object.entries(objects.PBXNativeTarget).filter(([id]) => !id.endsWith("_comment")).map(([, value]) => value);
const app = targets.find(target => clean(target.name) === "App");
const tests = targets.find(target => clean(target.name) === "AppTests");
assert(app && tests, "App and hosted XCTest targets are required");
assert.equal(clean(tests.productType), "com.apple.product-type.bundle.unit-test");
for (const config of objects.XCConfigurationList[app.buildConfigurationList].buildConfigurations) {
  const settings = objects.XCBuildConfiguration[id(config)].buildSettings;
  assert.equal(clean(settings.MARKETING_VERSION), pkg.version, "App metadata version differs from UI");
  assert.equal(clean(settings.PRODUCT_BUNDLE_IDENTIFIER), "app.liuying.personal");
}
for (const [target, directory] of [[app, "App"], [tests, "AppTests"]]) {
  const phases = target.buildPhases.map(ref => objects.PBXSourcesBuildPhase[id(ref)]).filter(Boolean);
  assert.equal(phases.length, 1);
  for (const entry of phases[0].files) {
    const reference = objects.PBXFileReference[objects.PBXBuildFile[id(entry)].fileRef];
    assert(existsSync(path.join(root, "ios/App", directory, clean(reference.path))), `Missing source: ${reference.path}`);
  }
}
const info = plist.parse(read("ios/App/App/Info.plist"));
assert(info.NSPhotoLibraryAddUsageDescription, "Add-only Photos permission description is required");
assert(!info.NSPhotoLibraryUsageDescription, "Do not request read access to existing photos");
assert.deepEqual(info.WKAppBoundDomains, ["localhost"]);
assert(!info.NSAppTransportSecurity?.NSAllowsArbitraryLoads, "TLS exceptions are forbidden");
const privacy = plist.parse(read("ios/App/App/PrivacyInfo.xcprivacy"));
assert.equal(privacy.NSPrivacyTracking, false);
const bundled = JSON.parse(read("ios/App/App/capacitor.config.json"));
assert.equal(bundled.loggingBehavior, "none", "Native bridge logs can disclose share-page data");
assert(!bundled.server?.url, "A phone-independent app must bundle its UI");
assert.deepEqual(JSON.parse(read("policy.json")), JSON.parse(read("ios/App/App/policy.json")));
assert(existsSync(path.join(root, "ios/App/App/public/index.html")), "Run pnpm sync:ios first");
assert(read("ios/App/CapApp-SPM/Package.swift").includes(`exact: "${pkg.dependencies["@capacitor/core"]}"`));
assert.equal(pkg.dependencies["@capacitor/core"], pkg.dependencies["@capacitor/ios"]);
const scheme = await xml.parseStringPromise(read("ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme"));
assert.equal(scheme.Scheme.TestAction[0].Testables[0].TestableReference[0].$.skipped, "NO");
assert.equal(scheme.Scheme.TestAction[0].Testables[0].TestableReference[0].$.parallelizable, "NO");
console.log("iOS project preflight passed: sources, targets, shared scheme, permissions, packaged UI, policy, runtime version.");
console.log("Swift compilation, simulator tests and physical iPhone tests have NOT been performed by this command.");
