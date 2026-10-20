"""Package an unsigned, verified device build. No Apple account is used."""
import hashlib
import json
import os
import plistlib
import subprocess
import sys
import tempfile
from pathlib import Path


def main():
    out = Path(sys.argv[1]).resolve()
    verification = json.loads((out / "verification.json").read_text(encoding="utf-8"))
    if verification["live_platform_tests"] != "passed" or verification["device_release_compile"] != "passed":
        raise SystemExit("Live platform tests and device compilation must pass before packaging.")
    app = out / "DerivedData/Build/Products/Release-iphoneos/App.app"
    info = plistlib.loads((app / "Info.plist").read_bytes())
    if info.get("CFBundleSupportedPlatforms") != ["iPhoneOS"]:
        raise SystemExit("Cannot package a simulator build for installation.")
    for name in ("App", "public/index.html", "policy.json", "PrivacyInfo.xcprivacy", "capacitor.config.json"):
        if not (app / name).is_file():
            raise SystemExit(f"Missing bundled file: {name}")
    version = info["CFBundleShortVersionString"]
    ipa = out / f"liuying-ios-{version}-unsigned.ipa"
    # ditto preserves the permissions and symlinks expected by Apple's tooling.
    with tempfile.TemporaryDirectory(prefix="liuying-ipa-") as folder:
        payload = Path(folder) / "Payload"
        payload.mkdir()
        subprocess.run(["ditto", str(app), str(payload / "App.app")], check=True)
        subprocess.run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(payload), str(ipa)], check=True)
    with ipa.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    (out / f"{ipa.name}.sha256").write_text(digest + "  " + ipa.name + "\n", encoding="utf-8")
    (out / "INSTALL.txt").write_text(
        "This IPA is UNSIGNED. It cannot be installed by opening it on an iPhone.\n"
        "Sign it with your own Apple account through a supported Windows installation tool.\n"
        "Simulator checks passed; installation and operation on your physical iPhone are still unverified.\n"
        "Do not send your Apple password, verification codes or certificates to the developer.\n",
        encoding="utf-8")
    verification.update(version=version, build=info["CFBundleVersion"], source_commit=os.getenv("GITHUB_SHA"))
    (out / "verification.json").write_text(json.dumps(verification, indent=2), encoding="utf-8")
    print(f"Created {ipa.name}; physical iPhone verification is still required.")


if __name__ == "__main__":
    main()
