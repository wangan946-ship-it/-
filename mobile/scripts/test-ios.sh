#!/bin/bash
# Run only on a Mac. Every run creates and later deletes its own simulator.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Darwin ]] || { echo "iOS tests require macOS and Xcode 26+."; exit 1; }
live="${LIUYING_LIVE_NETWORK:-0}"
[[ "$live" == 0 || "$live" == 1 ]] || { echo "LIUYING_LIVE_NETWORK must be 0 or 1"; exit 1; }
out="${IOS_QA_OUTPUT:-$PWD/artifacts/ios-qa-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
xcodebuild -version > "$out/xcode-version.txt"
python3 - "$out/xcode-version.txt" <<'PY'
import re, sys
assert int(re.search(r"Xcode (\d+)", open(sys.argv[1]).read())[1]) >= 26, "Xcode 26+ required"
PY
plutil -lint ios/App/App.xcodeproj/project.pbxproj ios/App/App/Info.plist ios/App/App/PrivacyInfo.xcprivacy
xcrun simctl list runtimes available -j > "$out/runtimes.json"
xcrun simctl list devicetypes -j > "$out/device-types.json"
# Prefer the user's exact phone. Fail explicitly if the installed Xcode lacks
# its simulator definition; silently testing a different device is misleading.
read -r device_type runtime < <(python3 - "$out" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
types = json.loads((p/"device-types.json").read_text())["devicetypes"]
device = next(x for x in types if x["name"] == "iPhone 14 Pro Max")
runtimes = [x for x in json.loads((p/"runtimes.json").read_text())["runtimes"]
            if x.get("isAvailable") and x["identifier"].startswith("com.apple.CoreSimulator.SimRuntime.iOS-")]
runtime = max(runtimes, key=lambda x: tuple(map(int, x["version"].split("."))))
print(device["identifier"], runtime["identifier"])
PY
)
simulator="$(xcrun simctl create "Liuying-QA-$(uuidgen)" "$device_type" "$runtime")"
cleanup() {
  xcrun simctl shutdown "$simulator" >/dev/null 2>&1 || true
  xcrun simctl delete "$simulator" >/dev/null 2>&1 || true
}
trap cleanup EXIT
printf '%s\n' "$simulator" > "$out/simulator-id.txt"
xcrun simctl boot "$simulator"
xcrun simctl bootstatus "$simulator" -b
project="ios/App/App.xcodeproj"
derived="$out/DerivedData"
xcodebuild -project "$project" -scheme App -configuration Debug \
  -destination "platform=iOS Simulator,id=$simulator" -derivedDataPath "$derived" \
  CODE_SIGNING_ALLOWED=NO LIUYING_LIVE_NETWORK="$live" build-for-testing \
  > "$out/build-simulator.log" 2>&1 || { tail -n 100 "$out/build-simulator.log"; exit 1; }
xcrun simctl install "$simulator" "$derived/Build/Products/Debug-iphonesimulator/App.app"
xcrun simctl privacy "$simulator" grant photos-add app.liuying.personal
# Patch the actual test-run environment, so CI never depends on scheme-variable
# expansion to enable the live tests. No screenshots or media are uploaded.
python3 - "$derived/Build/Products" "$live" <<'PY'
import pathlib, plistlib, sys
files = list(pathlib.Path(sys.argv[1]).glob("*.xctestrun"))
assert len(files) == 1, "Expected exactly one XCTest run specification"
p = files[0]
value = plistlib.loads(p.read_bytes())
count = 0
def patch(node):
    global count
    if isinstance(node, dict):
        if "TestBundlePath" in node:
            node.setdefault("EnvironmentVariables", {})["LIUYING_LIVE_NETWORK"] = sys.argv[2]
            count += 1
        for item in node.values(): patch(item)
    elif isinstance(node, list):
        for item in node: patch(item)
patch(value)
assert count == 1, f"Expected one hosted test target, got {count}"
p.write_bytes(plistlib.dumps(value))
PY
specs=("$derived/Build/Products/"*.xctestrun)
xcodebuild test-without-building -xctestrun "${specs[0]}" \
  -destination "platform=iOS Simulator,id=$simulator" -parallel-testing-enabled NO \
  -test-timeouts-enabled YES -default-test-execution-time-allowance 480 -maximum-test-execution-time-allowance 600 \
  -resultBundlePath "$out/tests.xcresult" \
  > "$out/tests.log" 2>&1 || { tail -n 100 "$out/tests.log"; exit 1; }
# A Release build catches code excluded from the Debug simulator build.
xcodebuild -project "$project" -scheme App -configuration Release -sdk iphoneos \
  -destination "generic/platform=iOS" -derivedDataPath "$derived" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build \
  > "$out/build-device.log" 2>&1 || { tail -n 100 "$out/build-device.log"; exit 1; }
python3 - "$out" "$live" "$runtime" <<'PY'
import json, pathlib, re, sys
p = pathlib.Path(sys.argv[1])
log = (p/"tests.log").read_text()
required = ["testNativeBridgeSettingsAndURLRejection", "testLocalFilePreviewPhotosAndShare"]
if sys.argv[2] == "1":
    required += ["testLiveXiaohongshuOriginalPlaybackAndPhotos",
                 "testLiveDouyinExactWorkAndImagePreview", "testLiveDouyinVideoPlaybackAndPhotos"]
for name in required:
    assert re.search(r"Test Case .*" + name + r".* passed ", log), f"Required test did not pass: {name}"
result = {"simulator_model": "iPhone 14 Pro Max", "runtime": sys.argv[3],
          "live_platform_tests": "passed" if sys.argv[2] == "1" else "not_run",
          "device_release_compile": "passed", "physical_iphone": "not_tested",
          "signing": "unsigned", "required_tests": required}
(p/"verification.json").write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
PY
