import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseShare, hosts } from "./parser";
import type { MediaInfo, Scope } from "./bridge";
const run = process.env.MOBILE_NETWORK_TEST === "1";
function native<T>(mode: string, url: string, allowed: string[], expectedMd5?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.MOBILE_JAVA!, ["-cp", process.env.MOBILE_CLASSES!, "app.liuying.personal.NativeProbe"],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", error = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Native transport timeout")); }, mode === "download" ? 305_000 : 65_000);
    child.stdout.setEncoding("utf8").on("data", text => {
      output += text;
      if (output.length > 5 * 1024 * 1024) { child.kill(); reject(new Error("Output limit")); }
    });
    child.stderr.setEncoding("utf8").on("data", text => { error += text; });
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(error || "Native transport failed"));
      else try { resolve(JSON.parse(output)); } catch { reject(new Error("Invalid native response")); }
    });
    child.stdin.end(`${mode}\n${url}\n${allowed.join(",")}\n${expectedMd5 ?? ""}\n`);
  });
}
describe.skipIf(!run)("真实网络：共用解析器 + 安卓原生传输源代码", () => {
  const transport = {
    request: ({ url, scope }: { url: string; scope: Scope }) =>
      native<{ url: string; body: string }>(scope === "douyinApi" ? "json" : "page", url, hosts[scope]),
    probe: ({ url }: { url: string }) => native<MediaInfo>("probe", url, hosts.media),
  };
  it("用户截图中的小红书裸存储键：原始视频完整下载、MD5 和 SHA-256 均匹配", async () => {
    const result = await parseShare("https://xhslink.cn/o/5DgIAnhxxhB", transport, { directHosts: [], maxDownloadMB: 500 });
    expect(result.platform).toBe("xiaohongshu");
    expect(result.title).toMatch(/^今日粉粉/);
    expect(result.media_type).toBe("video");
    expect(result.watermark_status).toBe("source_original");
    expect(result.expected_md5s).toEqual(["d9a61a4b9b72890fdf059d21fedffafa"]);
    expect(result.infos).toEqual([{ mime: "video/mp4", size: 15269927 }]);
    expect(new URL(result.media_urls[0]).pathname).toMatch(/^\/[A-Za-z0-9_-]{40}$/);
    const file = await native<{ mime: string; size: number; sha256: string }>(
      "download", result.media_urls[0], hosts.media, result.expected_md5s?.[0]);
    expect(file.size).toBe(15269927);
    expect(file.sha256).toBe("7fde256caaa12ffadbbb8564525b4d5cd49fe5f3c17c74c8d8f3f40ad5aabf53");
  }, 400_000);
  it("用户截图中的抖音图文：匿名会话、精确作品匹配和完整图片下载", async () => {
    const result = await parseShare("https://v.douyin.com/CyXS6O9dtUM/", transport, { directHosts: [], maxDownloadMB: 500 });
    expect(result.platform).toBe("douyin");
    expect(result.title).toBe("就是这样变脸");
    expect(result.media_type).toBe("images");
    expect(result.media_urls).toHaveLength(1);
    const file = await native<{ mime: string; size: number; sha256: string }>("download", result.media_urls[0], hosts.media);
    console.log(`用户图文：${file.mime}, ${file.size} bytes, SHA-256 ${file.sha256}`);
    expect(file.mime).toBe("image/webp");
    expect(file.size).toBe(136566);
    expect(file.sha256).toBe("d110063ee5d086c5272c31e54f8f33635bf0d5bed5022f395637aee59eea3c81");
    expect(result.infos[0].size).toBe(file.size);
  }, 150_000);
  it("直接媒体通过精确可信域名解析和完整下载", async () => {
    const directHosts = ["interactive-examples.mdn.mozilla.net"];
    const url = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
    const result = await parseShare(url, {
      ...transport, probe: ({ url }) => native<MediaInfo>("probe", url, directHosts),
    }, { directHosts, maxDownloadMB: 500 });
    expect(result.platform).toBe("direct");
    expect(result.media_type).toBe("video");
    const file = await native<{ mime: string; size: number; sha256: string }>("download", result.media_urls[0], directHosts);
    expect(file.size).toBe(1128375);
    expect(file.sha256).toBe("0cd83d944a6ca7822b4a8306cecc60a36e859b041f6702c6a1ad9ead78924451");
  }, 150_000);
  for (const [platform, url, expectedSize] of [
    ["xiaohongshu", "https://xhslink.cn/o/bvWzm6LGVx", 121010691],
    ["douyin", "https://www.douyin.com/video/6961737553342991651", 3676544],
  ] as const) {
    it(`${platform} 真实解析和完整下载`, async () => {
      const result = await parseShare(url, transport, { directHosts: [], maxDownloadMB: 500 });
      expect(result.title).not.toContain("\uFFFD");
      expect(result.platform).toBe(platform); expect(result.media_type).toBe("video");
      expect(result.infos[0]).toEqual({ mime: "video/mp4", size: expectedSize });
      if (platform === "xiaohongshu") {
        expect(result.watermark_status).toBe("source_original");
        expect(result.expected_md5s).toEqual(["4b185a2128297b47db96281422beff3d"]);
      }
      const file = await native<{ mime: string; size: number; sha256: string }>("download", result.media_urls[0], hosts.media, result.expected_md5s?.[0]);
      expect(file.size).toBe(expectedSize);
      expect(file.sha256).toBe(platform === "xiaohongshu" ? "c83d1d5a19dd312e371bd6eb6f1df4e17f1a0b8600cd08cc7ee9d2ee887d53dc"
        : "af479be42a1f90e57b9305a57807732393324c62c8fa80930780fea023f13881");
      console.log(`${platform}: ${file.mime}, ${file.size} bytes, SHA-256 verified, no Python backend`);
    }, 400_000);
  }
});
