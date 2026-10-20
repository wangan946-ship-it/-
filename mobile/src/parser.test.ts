import { describe, expect, it, vi } from "vitest";
import { douyinId, extractDouyin, extractDouyinPage, extractLinks, extractXhs, hosts, parseShare, readDouyinJSON, readState, validateUrl, xhsOriginalVideo } from "./parser";
const id = "6961737553342991651", noteId = "0123456789abcdef01234567";
const video = "https://sns-video-v4.xhscdn.com/test.mp4", image = "https://sns-webpic-qc.xhscdn.com/test.jpg";
const dyVideo = "https://v5-se-jltc-colds.douyinvod.com/test.mp4";
const settings = { directHosts: ["media.example.com"], maxDownloadMB: 500 };
const originKey = "pre_post/" + "a".repeat(40), original = `https://sns-video-bd.xhscdn.com/${originKey}`;
const md5 = "0123456789abcdef0123456789abcdef";
const note = () => ({ noteId, type: "video", title: "视频测试", imageList: [{ urlDefault: image }],
  video: { consumer: { originVideoKey: originKey },
    mediaV2: JSON.stringify({ video: { md5 }, stream: { h264: [{ master_url: video, height: 1280, width: 720, stream_type: 259 }] } }) } });
const item = () => ({ aweme_id: id, status: { allow_share: true }, video_control: { allow_download: true }, desc: "公开视频",
  video: { play_addr: { url_list: [dyVideo], height: 1280, width: 720 }, cover: { url_list: ["https://p5-sign.douyinpic.com/cover.jpg"] } } });
const shareUrl = `https://www.iesdouyin.com/share/video/${id}/`;
const shareHtml = (items: unknown[] = [item()], extra = {}) => `<script>window._ROUTER_DATA=${JSON.stringify({
  loaderData: { "video_(id)/page": { itemId: id, lastPath: id, videoInfoRes: { status_code: 0, item_list: items }, ...extra } }, errors: null,
})};</script>`;
// Shape of the user's 2026-10-20 public note response; URLs are test fixtures.
const userWork = "7666481628718787003";
const dyDownload = "https://p5-sign.douyinpic.com/published-download.jpg";
const publicNote = () => ({
  aweme_id: userWork, desc: "就是这样变脸", aweme_type: 2,
  risk_infos: { warn: false, type: 0, reflow_unplayable: 0 },
  images: [{ url_list: ["https://p5-sign.douyinpic.com/preview.jpg"], download_url_list: [dyDownload] }],
});
const publicNoteUrl = `https://www.iesdouyin.com/share/note/${userWork}/`;
const publicNoteHtml = (items: unknown[] = [publicNote()]) => `<script nonce="fixture">window._ROUTER_DATA=${JSON.stringify({
  loaderData: { "note_(id)/page": { itemId: userWork, lastPath: userWork,
    videoInfoRes: { status_code: 0, item_list: items } } }, errors: null,
})};</script>`;
describe("分享与来源边界", () => {
  it("提取完整分享链接、保留 token 并去重", () => {
    expect(extractLinks("复制 https://xhslink.cn/o/test?token=a%2Bb。 https://xhslink.cn/o/test?token=a%2Bb")).toEqual(["https://xhslink.cn/o/test?token=a%2Bb"]);
  });
  it.each(["", "没有链接", "x".repeat(8193)])("拒绝无效文本", text => expect(() => extractLinks(text)).toThrow());
  it.each(["http://media.example.com/a.mp4", "https://127.0.0.1/a", "https://2130706433/a", "https://[::1]/a",
    "https://user:pass@media.example.com/a", "https://media.example.com:444/a", "https://media.example.com/a#fragment",
    "https://media.example.com.evil.test/a", "https://media.example.com\\@evil.test/a", "https://media.example.com/a\nx"])
    ("拒绝不安全或未允许的 URL %s", url => expect(() => validateUrl(url, settings.directHosts)).toThrow());
  it("仅原址升级 HTTPS，不修改参数", () => {
    expect(validateUrl("http://media.example.com/a?watermark=1&sign=x", settings.directHosts, true))
      .toBe("https://media.example.com/a?watermark=1&sign=x");
  });
  it("不把授权 HTML 当 JSON 执行", () => {
    expect(() => readState("<script>window.__INITIAL_STATE__=alert(1)</script>")).toThrow();
    expect(() => readState('<script>window.__INITIAL_STATE__={};alert(1)</script>')).toThrow();
    expect(() => readState('<script src="remote">window.__INITIAL_STATE__={}</script>')).toThrow();
    expect(readState('<script>window.__INITIAL_STATE__={"value":undefined,"text":"undefined"};</script>'))
      .toEqual({ value: null, text: "undefined" });
  });
});
describe("小红书", () => {
  it.each(["Ab09_-".repeat(6) + "Ab09", "pre_post/" + "Ab09_-".repeat(6) + "Ab09"])(
    "保留已发布的裸存储键或带前缀存储键，不增删路径：%s", key => {
      const n = note(); n.video.consumer.originVideoKey = key;
      const result = extractXhs({ noteData: { data: { noteData: n } } }, `https://xiaohongshu.com/explore/${noteId}`, hosts.media);
      expect(result.media_urls).toEqual([`https://sns-video-bd.xhscdn.com/${key}`]);
      expect(result.expected_md5s).toEqual([md5]);
      expect(result.watermark_status).toBe("source_original");
    });
  it("兼容移动页、桌面页与新版 mediaV2", () => {
    for (const state of [{ noteData: { data: { noteData: note() } } }, { note: { noteDetailMap: { [noteId]: { note: note() } } } }]) {
      const result = extractXhs(state, `https://www.xiaohongshu.com/explore/${noteId}`, hosts.media);
      expect(result.media_type).toBe("video"); expect(result.media_urls).toEqual([original]); expect(result.cover).toBe(image);
      expect(result.expected_md5s).toEqual([md5]); expect(result.watermark_status).toBe("source_original");
    }
  });
  it("不使用错配笔记或禁分享数据", () => {
    for (const n of [{ ...note(), noteId: "f".repeat(24) }, { ...note(), shareInfo: { unShare: true } }]) {
      expect(() => extractXhs({ noteData: { data: { noteData: n } } }, `https://xiaohongshu.com/explore/${noteId}`, hosts.media)).toThrow();
    }
  });
  it("支持图片列表", () => {
    const result = extractXhs({ noteData: { data: { noteData: { ...note(), type: "normal", imageList: [{ infoList: [{ imageScene: "H5_DTL", url: image }] }] } } } },
      `https://xiaohongshu.com/explore/${noteId}`, hosts.media);
    expect(result.media_type).toBe("images"); expect(result.media_urls).toEqual([image]);
  });
  it("未知标识不推算地址；原片元数据不能覆盖 DRM 拒绝", () => {
    expect(() => xhsOriginalVideo({ video: { originVideoKey: "identifier" } })).toThrow();
    expect(() => xhsOriginalVideo({ video: { ...note().video, media: { video: { drm: true } } } })).toThrow("DRM");
  });
  it("没有原片时不回退到任何 masterUrl/backupUrls 或封面", () => {
    const n = note(); n.video.consumer.originVideoKey = "";
    expect(() => xhsOriginalVideo(n)).toThrow("无法取得无平台水印版本");
  });
  it.each(["pre_post/../secret", "pre_post/" + "a".repeat(40) + "?watermark=0", "//evil.example/file",
    "https://evil.example/file", "pre_post/%2e%2e%2fsecret", "other/" + "a".repeat(40), "pre_post/a",
    "a".repeat(40) + "/../secret", "a".repeat(40) + "?wm=0", "a".repeat(40) + "#x", "a".repeat(40) + ".mp4",
    "a".repeat(15), "a".repeat(129)])("拒绝不可信原片 key %s", key => {
    const n = note(); n.video.consumer.originVideoKey = key;
    expect(() => xhsOriginalVideo(n)).toThrow("原始视频");
  });
  it.each([{}, { md5: "" }, { md5: "wrong" }, { md5: 123 }])("缺少有效原片校验信息时拒绝 %#", meta => {
    for (const key of [originKey, "a".repeat(40)]) {
      const n = note(); n.video.consumer.originVideoKey = key; n.video.mediaV2 = JSON.stringify({ video: meta });
      expect(() => xhsOriginalVideo(n)).toThrow("原始视频");
    }
  });
  it("兼容 media/mediaV2，拒绝二者校验值冲突，并严格使用固定 CDN 白名单", () => {
    expect(xhsOriginalVideo({ video: { consumer: { originVideoKey: originKey }, media: { video: { md5 } } } }))
      .toEqual({ url: original, md5 });
    expect(() => xhsOriginalVideo({ video: { ...note().video, media: { video: { md5: "f".repeat(32) } } } })).toThrow();
    expect(() => extractXhs({ noteData: { data: { noteData: note() } } }, `https://xiaohongshu.com/explore/${noteId}`,
      ["sns-video-v4.xhscdn.com"])).toThrow("域名");
  });
  it("原片探测失败直接失败，不尝试小程序水印视频；成功时保留校验参数", async () => {
    const transport = { request: vi.fn().mockResolvedValue({ url: `https://xiaohongshu.com/explore/${noteId}`,
      body: `<script>window.__INITIAL_STATE__=${JSON.stringify({ noteData: { data: { noteData: note() } } })}</script>` }),
      probe: vi.fn().mockRejectedValue(new Error("原片不可访问")) };
    await expect(parseShare("https://xhslink.cn/o/example", transport, settings)).rejects.toThrow("原片不可访问");
    expect(transport.probe).toHaveBeenCalledExactlyOnceWith({ url: original });
    transport.probe.mockResolvedValue({ mime: "video/mp4", size: 120000000 });
    const result = await parseShare("https://xhslink.cn/o/example", transport, settings);
    expect(result.watermark_status).toBe("source_original"); expect(result.expected_md5s).toEqual([md5]);
  });
});
describe("抖音", () => {
  it("识别标准链接和 modal_id，拒绝冲突编号", () => {
    expect(douyinId(`https://www.douyin.com/video/${id}`)).toBe(id);
    expect(douyinId(`https://www.douyin.com/user/person?modal_id=${id}`)).toBe(id);
    expect(douyinId(`https://www.douyin.com/?modal_id=${id}`)).toBe(id);
    expect(() => douyinId(`https://www.douyin.com/user/person?modal_id=${id}&vid=1111111111111111`)).toThrow();
    expect(() => douyinId(`https://www.douyin.com/video/${id}?aweme_id=1111111111111111`)).toThrow();
  });
  it("只选择指定作品，忽略推荐视频", () => {
    const result = extractDouyin({ status_code: 0, aweme_list: [{ ...item(), aweme_id: "1111111111111111" }, item()] }, id, hosts.media);
    expect(result.media_urls).toEqual([dyVideo]); expect(result.media_type).toBe("video");
    expect(extractDouyin({ status_code: 0, aweme_list: [item(), item()] }, id, hosts.media).media_urls).toEqual([dyVideo]);
    expect(() => extractDouyin({ status_code: 0, aweme_list: [item(), { ...item(), desc: "冲突" }] }, id, hosts.media)).toThrow("冲突");
    expect(() => extractDouyin({ status_code: 0, aweme_list: [] }, id, hosts.media)).toThrow();
  });
  it("19 位数字 ID 在 JSON 解析前保持精度，字符串内部不被替换", () => {
    const raw = JSON.stringify({ status_code: 0, aweme_list: [{ ...item(), status: { aweme_id: id, allow_share: true },
      desc: '字符串中有 "aweme_id":6961737553342991651' }] }).replaceAll(`"${id}"`, id);
    const data = readDouyinJSON(raw);
    const result = extractDouyin(data, id, hosts.media);
    expect(result.media_urls).toEqual([dyVideo]);
    expect(result.title).toBe('字符串中有 "aweme_id":6961737553342991651');
    expect(() => extractDouyin({ status_code: 0, aweme_list: [{ ...item(), aweme_id: Number(id) }] }, id, hosts.media)).toThrow();
  });
  it("去重不依赖对象属性顺序，但权限或媒体冲突仍然拒绝", () => {
    const original = item(), reordered = Object.fromEntries(Object.entries(original).reverse());
    expect(extractDouyin({ status_code: 0, aweme_list: [original, reordered] }, id, hosts.media).media_urls).toEqual([dyVideo]);
    expect(() => extractDouyin({ status_code: 0, aweme_list: [original, { ...item(), video_control: { allow_download: false } }] }, id, hosts.media)).toThrow("冲突");
  });
  it("读取公开分享页的指定作品，不收集其他路由的推荐条目", () => {
    expect(extractDouyinPage(shareHtml([{ ...item(), aweme_id: "1111111111111111" }, item()]), shareUrl, id, hosts.media).media_urls).toEqual([dyVideo]);
    const html = `<script>window._ROUTER_DATA=${JSON.stringify({ loaderData: { recommendations: { videoInfoRes: { item_list: [item()] } } } })}</script>`;
    expect(() => extractDouyinPage(html, shareUrl, id, hosts.media)).toThrow();
  });
  it.each([
    () => shareHtml([item()], { itemId: "1111111111111111" }),
    () => shareHtml([item()], { lastPath: "1111111111111111" }),
    () => shareHtml([{ ...item(), video_control: { allow_download: false } }]),
    () => shareHtml([{ ...item(), video: { drm: true } }]),
    () => '<script>window._ROUTER_DATA={};doSomething()</script>',
    () => '<script src="remote">window._ROUTER_DATA={}</script>',
  ])("分享页仍校验 ID、权限、DRM，且不执行脚本 %#", html => {
    expect(() => extractDouyinPage(html(), shareUrl, id, hosts.media)).toThrow();
  });
  it("分享页最终 URL 仍必须属于允许平台且匹配作品", () => {
    for (const url of ["https://evil.example/video/" + id, shareUrl.replace(id, "1111111111111111")])
      expect(() => extractDouyinPage(shareHtml(), url, id, hosts.media)).toThrow();
  });
  it("实际图文页省略 APP 权限字段时，只使用公开提供的下载版本", () => {
    const result = extractDouyinPage(publicNoteHtml(), publicNoteUrl, userWork, hosts.media);
    expect(result.title).toBe("就是这样变脸");
    expect(result.media_type).toBe("images");
    expect(result.media_urls).toEqual([dyDownload]);
    // The same omission in the Feed API is not treated as permission.
    expect(() => extractDouyin({ status_code: 0, aweme_list: [publicNote()] }, userWork, hosts.media)).toThrow("未允许下载");
  });
  it.each([
    { status: { allow_share: false } },
    { status: { allow_share: null } },
    { status: { is_private: true } },
    { video_control: { allow_download: false } },
    { prevent_download: true },
    { video_control: { prevent_download_type: 1 } },
    { risk_infos: { reflow_unplayable: 1 } },
    { images: [{ url_list: [dyDownload] }] },
    { images: [{ download_url_list: [dyDownload] }, { url_list: [dyDownload] }] },
  ])("公开下载地址不能覆盖访问/下载限制，也不能使用没有下载版本的图文 %#", patch => {
    expect(() => extractDouyinPage(publicNoteHtml([{ ...publicNote(), ...patch }]), publicNoteUrl, userWork, hosts.media)).toThrow();
  });
  it.each([
    { status: { allow_share: true, is_private: true } },
    { status: { allow_share: false } },
    { video_control: { allow_download: false } },
    { video_control: { allow_download: true, prevent_download_type: 1 } },
    { video: { drm: true } },
    { video: { need_set_token: true } },
    { aweme_type: 68, images: [] },
  ])("拒绝权限/DRM/缺失图片 %#", patch => {
    expect(() => extractDouyin({ status_code: 0, aweme_list: [{ ...item(), ...patch }] }, id, hosts.media)).toThrow();
  });
});
describe("不依赖服务端的完整解析", () => {
  it("截图短链的图文保持 note 路由，空壳回退到同作品公开页，不选择推荐视频", async () => {
    const short = "https://v.douyin.com/CyXS6O9dtUM/";
    const emptyPage = `<script>window._ROUTER_DATA=${JSON.stringify({
      loaderData: { "note_(id)/page": { itemId: userWork, lastPath: userWork } }, errors: null,
    })}</script>`;
    const request = vi.fn().mockResolvedValueOnce({ url: publicNoteUrl + "?from_ssr=1", body: emptyPage })
      .mockResolvedValueOnce({ url: "", body: JSON.stringify({ status_code: 0, aweme_list: [item()] }) })
      .mockResolvedValueOnce({ url: publicNoteUrl, body: publicNoteHtml() });
    const probe = vi.fn().mockResolvedValue({ mime: "image/jpeg", size: 1234 });
    const result = await parseShare(`复制打开抖音，看看【ai ma的图文作品】就是这样变脸 ${short}`, { request, probe }, settings);
    expect(result.title).toBe("就是这样变脸"); expect(result.media_type).toBe("images");
    expect(request.mock.calls[2][0]).toEqual({ scope: "douyinPage", url: publicNoteUrl });
    expect(request).toHaveBeenCalledTimes(3);
    expect(probe).toHaveBeenCalledExactlyOnceWith({ url: dyDownload });
  });
  it.each(["note", "slides"])("桌面 %s 链接不会被改为视频分享页", async kind => {
    const expected = `https://www.iesdouyin.com/share/${kind}/${userWork}/`;
    const request = vi.fn().mockResolvedValueOnce({ url: "", body: '{"status_code":0,"aweme_list":[]}' })
      .mockResolvedValueOnce({ url: expected, body: publicNoteHtml() });
    const probe = vi.fn().mockResolvedValue({ mime: "image/jpeg", size: 1234 });
    expect((await parseShare(`https://www.douyin.com/${kind}/${userWork}`, { request, probe }, settings)).media_type).toBe("images");
    expect(request.mock.calls[1][0]).toEqual({ scope: "douyinPage", url: expected });
  });
  it("完整分享页先保留参数，空壳才读取规范公开页；明确拒绝不会继续", async () => {
    const original = publicNoteUrl + "?share_token=provided";
    const request = vi.fn().mockResolvedValueOnce({ url: "", body: '{"status_code":0,"aweme_list":[]}' })
      .mockResolvedValueOnce({ url: original, body: "<html>empty</html>" })
      .mockResolvedValueOnce({ url: publicNoteUrl, body: publicNoteHtml() });
    const probe = vi.fn().mockResolvedValue({ mime: "image/jpeg", size: 1234 });
    await parseShare(original, { request, probe }, settings);
    expect(request.mock.calls.slice(1).map(c => c[0].url)).toEqual([original, publicNoteUrl]);
    request.mockReset().mockResolvedValueOnce({ url: "", body: '{"status_code":0,"aweme_list":[]}' })
      .mockResolvedValueOnce({ url: original, body: publicNoteHtml([{ ...publicNote(), status: { is_private: true } }]) });
    probe.mockClear();
    await expect(parseShare(original, { request, probe }, settings)).rejects.toThrow("公开可下载");
    expect(request).toHaveBeenCalledTimes(2); expect(probe).not.toHaveBeenCalled();
  });
  it("Feed 只返回推荐视频时读取公开分享页，并探测目标视频", async () => {
    const request = vi.fn().mockResolvedValueOnce({ body: JSON.stringify({ status_code: 0,
      aweme_list: [{ ...item(), aweme_id: "1111111111111111" }] }), url: "" })
      .mockResolvedValueOnce({ body: shareHtml(), url: shareUrl });
    const probe = vi.fn().mockResolvedValue({ mime: "video/mp4", size: 1000 });
    const result = await parseShare(`https://www.douyin.com/video/${id}`, { request, probe }, settings);
    expect(result.media_urls).toEqual([dyVideo]);
    expect(request.mock.calls[1][0]).toEqual({ scope: "douyinPage", url: shareUrl });
    expect(probe).toHaveBeenCalledExactlyOnceWith({ url: dyVideo });
  });
  it.each(["dns_failed", "blocked_address", "tls_or_network_error", "network_error", "timeout"])(
    "匿名接口网络不可用（%s）时独立校验同作品公开页", async code => {
      const request = vi.fn().mockRejectedValueOnce(Object.assign(new Error("API unavailable"), { code }))
        .mockResolvedValueOnce({ body: shareHtml(), url: shareUrl });
      const probe = vi.fn().mockResolvedValue({ mime: "video/mp4", size: 1000 });
      const result = await parseShare(`https://www.douyin.com/video/${id}`, { request, probe }, settings);
      expect(result.media_urls).toEqual([dyVideo]);
      expect(request.mock.calls[1][0]).toEqual({ scope: "douyinPage", url: shareUrl });
      expect(probe).toHaveBeenCalledExactlyOnceWith({ url: dyVideo });
    });
  it.each(["source_denied", "access_denied", "cancelled", "unsafe_url", "host_not_allowed"])(
    "匿名接口明确拒绝或取消（%s）时不继续请求", async code => {
      const error = Object.assign(new Error("terminal"), { code });
      const request = vi.fn().mockRejectedValue(error), probe = vi.fn();
      await expect(parseShare(`https://www.douyin.com/video/${id}`, { request, probe }, settings)).rejects.toBe(error);
      expect(request).toHaveBeenCalledTimes(1); expect(probe).not.toHaveBeenCalled();
    });
  it("接口不可用时仍拒绝公开页的推荐作品和下载限制", async () => {
    const request = vi.fn().mockRejectedValueOnce({ code: "blocked_address" })
      .mockResolvedValueOnce({ body: shareHtml([{ ...item(), aweme_id: "1111111111111111" }]), url: shareUrl });
    const probe = vi.fn();
    await expect(parseShare(`https://www.douyin.com/video/${id}`, { request, probe }, settings)).rejects.toThrow(`（${id}）`);
    expect(probe).not.toHaveBeenCalled();
    request.mockReset().mockRejectedValueOnce({ code: "dns_failed" })
      .mockResolvedValueOnce({ body: shareHtml([{ ...item(), video_control: { allow_download: false } }]), url: shareUrl });
    await expect(parseShare(`https://www.douyin.com/video/${id}`, { request, probe }, settings)).rejects.toThrow();
    expect(probe).not.toHaveBeenCalled();
  });
  it("短链已经返回可用分享页时复用，不再次请求", async () => {
    const request = vi.fn().mockResolvedValueOnce({ body: shareHtml(), url: shareUrl })
      .mockResolvedValueOnce({ body: '{"status_code":0,"aweme_list":[]}', url: "" });
    const probe = vi.fn().mockResolvedValue({ mime: "video/mp4", size: 1000 });
    expect((await parseShare("https://v.douyin.com/abcd/", { request, probe }, settings)).media_type).toBe("video");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("数字 ID 响应不再因 Number 精度丢失被判定为推荐视频", async () => {
    const body = JSON.stringify({ status_code: 0, aweme_list: [item()] }).replace(`"${id}"`, id);
    const request = vi.fn().mockResolvedValue({ body, url: "" });
    const probe = vi.fn().mockResolvedValue({ mime: "video/mp4", size: 1000 });
    expect((await parseShare(`https://www.douyin.com/video/${id}`, { request, probe }, settings)).media_type).toBe("video");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([
    { status_code: 0, aweme_list: [{ ...item(), video_control: { allow_download: false } }] },
    { status_code: 0, aweme_list: [{ ...item(), status: { allow_share: true, is_private: true } }] },
    { status_code: 0, aweme_list: [item(), { ...item(), desc: "conflict" }] },
    { status_code: 1, aweme_list: [] },
  ])("明确拒绝或数据冲突时不尝试其他入口 %#", async data => {
    const request = vi.fn().mockResolvedValue({ body: JSON.stringify(data), url: "" }), probe = vi.fn();
    await expect(parseShare(`https://www.douyin.com/video/${id}`, { request, probe }, settings)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1); expect(probe).not.toHaveBeenCalled();
  });
  it("接口与分享页都无数据时给出准确作品编号，不探测推荐文件", async () => {
    const request = vi.fn().mockResolvedValueOnce({ body: '{"status_code":0,"aweme_list":[]}', url: "" })
      .mockResolvedValueOnce({ body: shareHtml([]), url: shareUrl });
    const probe = vi.fn();
    await expect(parseShare(`https://www.douyin.com/video/${id}`, { request, probe }, settings)).rejects.toThrow(`（${id}）`);
    expect(request).toHaveBeenCalledTimes(2); expect(probe).not.toHaveBeenCalled();
  });
  it("抖音短链经原生请求解析；不使用 /api 或 localhost", async () => {
    const request = vi.fn().mockResolvedValueOnce({ url: `https://www.douyin.com/video/${id}`, body: "" })
      .mockResolvedValueOnce({ url: "https://api5-normal-c-hl.amemv.com/", body: JSON.stringify({ status_code: 0, aweme_list: [item()] }) });
    const probe = vi.fn().mockResolvedValue({ mime: "video/mp4", size: 1000 });
    const result = await parseShare("https://v.douyin.com/abcd/", { request, probe }, settings);
    expect(result.platform).toBe("douyin"); expect(result.watermark_status).toBe("unknown");
    expect(request.mock.calls.map(c => c[0].scope)).toEqual(["douyinPage", "douyinApi"]);
    expect(probe).toHaveBeenCalledWith({ url: dyVideo });
  });
  it("直接媒体验证实际类型，视频不能混入多图", async () => {
    const transport = { request: vi.fn(), probe: vi.fn().mockResolvedValue({ mime: "video/mp4", size: 123 }) };
    expect((await parseShare("https://media.example.com/a.mp4", transport, settings)).media_type).toBe("video");
    expect(transport.request).not.toHaveBeenCalled();
    await expect(parseShare("https://media.example.com/a.mp4 https://media.example.com/b.mp4", transport, settings)).rejects.toThrow();
  });
  it("视频返回图片 MIME 时不伪装成功", async () => {
    const transport = { request: vi.fn().mockResolvedValue({ url: "", body: JSON.stringify({ status_code: 0, aweme_list: [item()] }) }),
      probe: vi.fn().mockResolvedValue({ mime: "image/jpeg", size: 123 }) };
    await expect(parseShare(`https://www.douyin.com/video/${id}`, transport, settings)).rejects.toThrow("类型");
  });
  it("混合平台和未知域名在网络请求之前失败", async () => {
    const transport = { request: vi.fn(), probe: vi.fn() };
    await expect(parseShare("https://v.douyin.com/a https://xhslink.cn/o/b", transport, settings)).rejects.toThrow();
    await expect(parseShare("https://unknown.example/a.mp4", transport, settings)).rejects.toThrow();
    expect(transport.request).not.toHaveBeenCalled(); expect(transport.probe).not.toHaveBeenCalled();
  });
});
