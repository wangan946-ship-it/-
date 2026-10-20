// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { LocalMedia } from "./bridge";
const mocks = vi.hoisted(() => ({
  settings: vi.fn(), list: vi.fn(), prepare: vi.fn(), promote: vi.fn(), remove: vi.fn(),
  cancel: vi.fn(), photos: vi.fn(), share: vi.fn(), configure: vi.fn(), addListener: vi.fn(),
  parse: vi.fn(),
}));
vi.mock("./bridge", () => ({ Native: mocks, isNative: true, localUrl: (path: string) => path }));
vi.mock("./parser", () => ({ parseShare: mocks.parse }));
import App from "./App";
const file: LocalMedia = { id: "local-file", title: "测试视频", platform: "douyin", mime: "video/mp4",
  bytes: 1024, createdAt: 1, temporary: true, path: "https://localhost/_capacitor_file_/test.mp4" };
const result = () => ({ platform: "douyin", title: "测试视频", cover: null, media_type: "video",
  media_urls: ["https://media.example.com/video.mp4"], watermark_status: "unknown", error: null,
  infos: [{ mime: "video/mp4", size: 1024 }], expiresAt: Date.now() + 60000 });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.settings.mockResolvedValue({ directHosts: [], maxDownloadMB: 500 });
  mocks.list.mockResolvedValue({ items: [] });
  mocks.addListener.mockResolvedValue({ remove: vi.fn() });
  mocks.cancel.mockResolvedValue(undefined); mocks.remove.mockResolvedValue(undefined);
  mocks.photos.mockResolvedValue(undefined); mocks.share.mockResolvedValue(undefined);
  mocks.parse.mockResolvedValue(result());
  mocks.prepare.mockResolvedValue(file);
  mocks.promote.mockResolvedValue({ ...file, temporary: false });
});
afterEach(cleanup);
async function parse() {
  render(<App />);
  fireEvent.change(screen.getByLabelText("分享文字或媒体链接"), { target: { value: "https://www.douyin.com/video/6961737553342991651" } });
  await waitFor(() => expect((screen.getByRole("button", { name: "解析素材" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "解析素材" }));
  await screen.findByRole("region", { name: "解析结果" });
}
it("预览准备临时文件，保存时提升原文件，再调用本机相册", async () => {
  await parse();
  fireEvent.click(screen.getByRole("button", { name: "加载视频预览" }));
  await screen.findByLabelText("测试视频 视频预览");
  expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ temporary: true, expectedMime: "video/mp4", expectedSize: 1024 }));
  expect(mocks.list).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "下载视频到本机" }));
  await screen.findByRole("button", { name: "已保存到本机" });
  expect(mocks.promote).toHaveBeenCalledWith({ id: file.id });
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "保存到相册" }));
  await waitFor(() => expect(mocks.photos).toHaveBeenCalledWith({ id: file.id }));
  fireEvent.click(screen.getByRole("button", { name: "本机素材" }));
  expect(mocks.remove).not.toHaveBeenCalled();
});
it("离开结果会取消未完成预览，并清理随后到达的临时文件", async () => {
  let complete!: (item: LocalMedia) => void;
  mocks.prepare.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  await parse();
  fireEvent.click(screen.getByRole("button", { name: "加载视频预览" }));
  const args = mocks.prepare.mock.calls[0][0];
  fireEvent.click(screen.getByRole("button", { name: "本机素材" }));
  expect(mocks.cancel).toHaveBeenCalledWith({ operationId: args.operationId });
  await act(async () => { complete(file); });
  expect(mocks.remove).toHaveBeenCalledWith({ id: file.id });
});
it("删除必须确认且使用记录 ID，不影响其他文件", async () => {
  mocks.list.mockResolvedValue({ items: [{ ...file, temporary: false }] });
  render(<App />);
  await waitFor(() => expect(mocks.list).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "本机素材" }));
  await screen.findByRole("heading", { name: file.title });
  fireEvent.click(screen.getByRole("button", { name: /^删除$/ }));
  expect(mocks.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(mocks.remove).toHaveBeenCalledExactlyOnceWith({ id: file.id }));
});
it("下载失败显示原因，不生成成功记录或播放器", async () => {
  mocks.prepare.mockRejectedValue(new Error("来源拒绝访问（HTTP 403）"));
  await parse();
  fireEvent.click(screen.getByRole("button", { name: "下载视频到本机" }));
  expect((await screen.findByRole("alert")).textContent).toContain("HTTP 403");
  expect(screen.queryByLabelText("测试视频 视频预览")).toBeNull();
  expect(mocks.list).toHaveBeenCalledTimes(1);
  expect(mocks.promote).not.toHaveBeenCalled();
});
it("小红书原片传递校验值，校验失败不能保存或预览水印替代文件", async () => {
  const md5 = "0123456789abcdef0123456789abcdef";
  mocks.parse.mockResolvedValue({ ...result(), platform: "xiaohongshu", watermark_status: "source_original", expected_md5s: [md5] });
  mocks.prepare.mockRejectedValue(new Error("原片校验值不一致，已丢弃"));
  await parse();
  expect(screen.getByText("原始上传版本")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "加载视频预览" }));
  expect((await screen.findByRole("alert")).textContent).toContain("已丢弃");
  expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ expectedMd5: md5, temporary: true }));
  expect(screen.queryByLabelText("测试视频 视频预览")).toBeNull();
  expect(mocks.list).toHaveBeenCalledTimes(1);
  expect(mocks.promote).not.toHaveBeenCalled();
});
it("图文结果显示图片数量，按真实 WebP 类型下载并提供图片预览", async () => {
  mocks.parse.mockResolvedValue({ ...result(), title: "就是这样变脸", media_type: "images",
    media_urls: ["https://p5-sign.douyinpic.com/published.webp"], infos: [{ mime: "image/webp", size: 136566 }] });
  mocks.prepare.mockResolvedValue({ ...file, title: "就是这样变脸", mime: "image/webp", bytes: 136566,
    path: "https://localhost/_capacitor_file_/image.webp", temporary: false });
  await parse();
  expect(screen.getByText("图文素材 · 1 张图片")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "加载视频预览" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "下载图片到本机" }));
  await screen.findByRole("img", { name: "就是这样变脸" });
  expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({
    temporary: false, expectedMime: "image/webp", expectedSize: 136566,
  }));
  expect(screen.getByRole("button", { name: "保存到相册" })).toBeTruthy();
});
