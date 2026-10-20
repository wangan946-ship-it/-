"""Export reviewed source files only, never an entire Windows working directory."""
import hashlib
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MOBILE = ROOT / "mobile"


def selected_files():
    names = {
        ".github/workflows/ios-candidate.yml",
        "mobile/package.json", "mobile/pnpm-lock.yaml", "mobile/pnpm-workspace.yaml", "mobile/capacitor.config.ts",
        "mobile/policy.json", "mobile/tsconfig.json", "mobile/vite.config.ts", "mobile/index.html",
        "mobile/ios/debug.xcconfig", "mobile/ios/App/App.xcodeproj/project.pbxproj",
        "mobile/ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme",
        "mobile/ios/App/CapApp-SPM/Package.swift",
        "mobile/ios/App/CapApp-SPM/Sources/CapApp-SPM/CapApp-SPM.swift",
        "mobile/scripts/prepare-native.mjs", "mobile/scripts/check-ios.mjs",
        "mobile/scripts/test-ios.sh", "mobile/scripts/package-ios.py", "mobile/scripts/export-ios-source.py",
        "mobile/IOS_WINDOWS.md", "mobile/THIRD_PARTY.md",
    }
    groups = [
        ("mobile/src", {".ts", ".tsx", ".css"}),
        ("mobile/ios/App/AppTests", {".swift"}),
        ("mobile/ios/App/App", {".swift", ".plist", ".xcprivacy", ".storyboard", ".png", ".json", ".xml"}),
    ]
    for relative, suffixes in groups:
        folder = ROOT / relative
        for file in folder.rglob("*"):
            if not file.is_file():
                continue
            parts = file.relative_to(folder).parts
            if "public" in parts or "xcuserdata" in parts or file.name in ("capacitor.config.json", "policy.json"):
                continue
            if file.suffix in suffixes:
                names.add(file.relative_to(ROOT).as_posix())
    return sorted(names)


def main():
    output = MOBILE / "artifacts"
    output.mkdir(exist_ok=True)
    archive = output / "liuying-ios-source.zip"
    entries = []
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for name in selected_files():
            file = ROOT / name
            if file.is_symlink() or not file.is_file() or not file.resolve().is_relative_to(ROOT.resolve()):
                raise SystemExit(f"Unsafe or missing source file: {name}")
            body = file.read_bytes()
            # Refuse a native executable even if renamed as a source/resource.
            if body.startswith((b"MZ", b"\x7fELF", b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf")):
                raise SystemExit(f"Unexpected executable: {name}")
            bundle.writestr(name, body)
            entries.append({"path": name, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()})
        bundle.writestr(".gitignore", "node_modules/\n.local/\n.env\nmobile/dist/\nmobile/artifacts/\nmobile/ios/App/App/public/\nmobile/ios/App/App/capacitor.config.json\n**/xcuserdata/\n")
        bundle.writestr("SOURCE-MANIFEST.json", json.dumps(entries, ensure_ascii=False, indent=2))
    manifest = output / "ios-source-manifest.json"
    manifest.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
    with archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    (output / "liuying-ios-source.zip.sha256").write_text(digest + "  " + archive.name + "\n", encoding="utf-8")
    print(f"Prepared {len(entries)} reviewed source/resource files ({archive.stat().st_size} bytes).")
    print("Not uploaded. No Windows executables, SDKs, credentials, local records or downloaded media included.")


if __name__ == "__main__":
    main()
