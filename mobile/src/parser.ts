import policy from "../policy.json";
import type { MediaInfo, NativeMedia, Platform, Settings } from "./bridge";

export class ParseError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
type Json = Record<string, unknown>;
const obj = (v: unknown): Json => v && typeof v === "object" && !Array.isArray(v) ? v as Json : {};
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown): string => typeof v === "string" ? v : "";
const num = (v: unknown): number => typeof v === "number" && Number.isFinite(v) ? v : 0;
const active = (v: unknown) => ![undefined, null, false, 0, "", "0"].includes(v as never);
const encrypted = (v: unknown) => ["drm", "isDrm", "encrypted", "drmType", "drm_type", "is_drm"]
  .some(k => active(obj(v)[k]));
const fail = (code: string, message: string): never => { throw new ParseError(code, message); };
export const hosts = policy;

export function validateUrl(raw: string, allowed: readonly string[], upgrade = false): string {
  if (!raw || raw.length > 4096 || /[\x00-\x20\x7f\\]/.test(raw)) fail("unsafe_url", "链接含非法字符或过长。");
  let value = raw;
  if (upgrade) value = value.replace(/^\/\//, "https://").replace(/^http:\/\//i, "https://");
  let url: URL;
  try { url = new URL(value); } catch { return fail("unsafe_url", "链接格式无效。"); }
  if (url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password ||
      url.hash || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(url.hostname) ||
      url.hostname.includes("..") || /^[\d.]+$/.test(url.hostname))
    fail("unsafe_url", "仅支持 HTTPS 公网域名，不接受 IP、凭证、片段或非 443 端口。");
  if (!allowed.includes(url.hostname)) fail("host_not_allowed", `未允许媒体域名：${url.hostname}。可在设置中核实并添加精确域名。`);
  return value;
}
export function extractLinks(text: string): string[] {
  if (!text.trim() || text.length > 8192) fail("invalid_input", "请粘贴不超过 8192 字的分享文字。");
  const urls = [...new Set((text.match(/https?:\/\/[^\s<>"'`]+/gi) || [])
    .map(s => s.replace(/[，。！？、；：）》】」』,.!?;:)]+$/u, "")))];
  if (!urls.length || urls.length > 20) fail("invalid_input", "未找到链接，或链接超过 20 个。");
  return urls;
}
function source(values: unknown[], allowed: readonly string[]): string {
  let denied = false;
  for (const value of values.slice(0, 16)) {
    if (typeof value !== "string" || !value) continue;
    try { return validateUrl(value, allowed, true); }
    catch (e) { if (e instanceof ParseError && e.code === "host_not_allowed") denied = true; else throw e; }
  }
  return fail(denied ? "host_not_allowed" : "missing_media", denied
    ? "平台媒体域名不在允许列表内，请核实后更新设置。"
    : "公开数据未提供媒体地址，不会拼接或猜测原片地址。");
}
const urlsFrom = (v: unknown) => arr(obj(v).url_list);
const titleOf = (v: unknown, fallback: string) => (str(v).trim().split(/\r?\n/)[0] || fallback).slice(0, 180);
export type Parsed = {
  platform: Platform; title: string; cover: string | null; media_type: "video" | "images";
  media_urls: string[]; watermark_status: "unknown" | "source_original"; error: null;
  expected_md5s?: string[];
  infos: MediaInfo[]; expiresAt: number;
};
type Extracted = Omit<Parsed, "infos" | "expiresAt" | "watermark_status" | "error"> & {
  watermark_status?: Parsed["watermark_status"];
};
export interface Transport extends Pick<NativeMedia, "request" | "probe"> {}

export function readDouyinJSON(raw: string): Json {
  // IDs can arrive as 19-digit JSON numbers. Preserve their original decimal
  // text before JSON.parse can round them; never rewrite inside JSON strings.
  let previous = "", beforePrevious = "";
  const exact = raw.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\]:,]/g, token => {
    let value = token;
    if (previous === ":" && beforePrevious.startsWith('"') && /^\d{15,22}$/.test(token)) {
      const key = JSON.parse(beforePrevious);
      if (["aweme_id", "itemId", "lastPath"].includes(key)) value = `"${token}"`;
    }
    beforePrevious = previous; previous = token;
    return value;
  });
  try {
    const data: unknown = JSON.parse(exact);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data as Json;
  } catch { return fail("page_changed", "抖音返回的数据格式无效。"); }
}
function assignedState(html: string, name: "__INITIAL_STATE__" | "_ROUTER_DATA"): Json {
  // Read data, never execute platform JavaScript.
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(script[1])) continue;
    const assignment = new RegExp(`^\\s*(?:window\\.)?${name}\\s*=\\s*`).exec(script[2]);
    if (!assignment) continue;
    const raw = script[2].slice(assignment[0].length)
      .replace(/"(?:[^"\\]|\\.)*"|\bundefined\b/g, token => token === "undefined" ? "null" : token)
      .trim().replace(/;+\s*$/, "");
    try {
      if (name === "_ROUTER_DATA") return readDouyinJSON(raw);
      const state: unknown = JSON.parse(raw);
      if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error();
      return state as Json;
    } catch { return fail("page_changed", "平台公开页面的数据格式已变化。"); }
  }
  return fail("page_unavailable", "公开页未返回素材数据，可能需要登录、验证或链接已失效。");
}
export function readState(html: string): Json { return assignedState(html, "__INITIAL_STATE__"); }
function imageSource(v: unknown): string {
  const image = obj(v), variants = arr(image.infoList).map(obj).filter(v => str(v.url));
  for (const scene of ["H5_DTL", "WB_DFT"]) {
    const match = variants.find(v => v.imageScene === scene);
    if (match) return str(match.url);
  }
  return str(image.urlDefault) || str(image.url) || str(variants[0]?.url);
}
export function xhsOriginalVideo(note: Json): { url: string; md5: string } {
  const video = obj(note.video), media = obj(video.media);
  let rawV2 = video.mediaV2;
  if (typeof rawV2 === "string") {
    try { rawV2 = JSON.parse(rawV2); } catch { return fail("page_changed", "视频数据格式已变化。"); }
  }
  const v2 = obj(rawV2);
  if ([video, media, media.video, v2, v2.video].some(encrypted)) fail("protected_media", "不支持加密或 DRM 视频。");
  const key = str(obj(video.consumer).originVideoKey);
  const hashes = [obj(media.video).md5, obj(v2.video).md5].filter(v => v !== undefined && v !== null);
  // Public uploads use either a bare storage key or a pre_post/ key.
  // Preserve the entire published key on the fixed official CDN; never add or
  // remove a namespace. This is not a path derived from a note/video ID.
  // MINI_APP_259/masterUrl can carry a moving platform watermark. Never fall
  // back to those streams. Native download must match the original file MD5.
  if (!/^(?:pre_post\/)?[A-Za-z0-9_-]{16,128}$/.test(key) || !hashes.length ||
      hashes.some(v => !/^[a-f0-9]{32}$/i.test(str(v))) ||
      new Set(hashes.map(v => str(v).toLowerCase())).size !== 1)
    return fail("original_unavailable", "公开页面未提供可核验的原始视频，无法取得无平台水印版本；已停止，不使用带水印或来源不明的播放版本。");
  return { url: `https://sns-video-bd.xhscdn.com/${key}`, md5: str(hashes[0]).toLowerCase() };
}
export function extractXhs(state: Json, finalUrl: string, allowed: readonly string[]): Extracted {
  const id = /\/(?:explore|discovery\/item|user\/profile\/[a-f\d]{24})\/([a-f\d]{24})(?:\/|$)/i
    .exec(new URL(finalUrl).pathname)?.[1]?.toLowerCase();
  if (!id) return fail("unsupported_link", "请使用小红书单条笔记的完整分享链接。");
  const mobile = obj(state.noteData);
  if (mobile.hasError || obj(mobile.errorNoteData).show) fail("page_unavailable", "笔记不可公开访问。");
  let note = obj(obj(mobile.data).noteData);
  if (!Object.keys(note).length) note = obj(obj(obj(obj(state.note).noteDetailMap)[id]).note);
  if (str(note.noteId).toLowerCase() !== id) fail("page_unavailable", "平台未返回对应笔记的数据。");
  if (obj(note.shareInfo).unShare) fail("access_denied", "平台禁止分享此笔记。");
  const images = arr(note.imageList), title = titleOf(note.title || note.desc, "小红书素材");
  if (note.type === "video") {
    const original = xhsOriginalVideo(note);
    return {
      platform: "xiaohongshu", title, media_type: "video",
      media_urls: [source([original.url], allowed)], expected_md5s: [original.md5],
      watermark_status: "source_original",
      cover: images.length ? source([imageSource(images[0])], allowed) : null,
    };
  }
  if (note.type !== "normal") return fail("unsupported_type", "暂不支持此类小红书内容。");
  if (!images.length || images.length > 20) fail("image_count", "图集为空或超过 20 张。");
  const urls = images.map(i => source([imageSource(i)], allowed));
  return { platform: "xiaohongshu", title, media_type: "images", media_urls: urls, cover: urls[0] };
}
export function douyinId(url: string): string | null {
  const parsed = new URL(url);
  const match = /^\/(?:share\/)?(?:video|note|slides)\/(\d{15,22})\/?$/.exec(parsed.pathname);
  if (match || parsed.pathname === "/" || parsed.pathname.startsWith("/user/")) {
    const ids = [...(match ? [match[1]] : []), ...parsed.searchParams.getAll("modal_id"), ...parsed.searchParams.getAll("vid"),
      ...parsed.searchParams.getAll("aweme_id")];
    if (ids.length && (new Set(ids).size !== 1 || !/^\d{15,22}$/.test(ids[0])))
      fail("invalid_item", "作品编号无效或冲突。");
    return ids[0] || null;
  }
  return null;
}
function identity(value: unknown): string | null {
  if (typeof value === "string" && /^\d{15,22}$/.test(value)) return value;
  // A value that already passed through a lossy parser is never reconstructed.
  if (typeof value === "number" && Number.isSafeInteger(value) && /^\d{15,22}$/.test(String(value))) return String(value);
  return null;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
export function extractDouyin(data: Json, target: string, allowed: readonly string[]): Extracted {
  return extractDouyinData(data, target, allowed, false);
}
function extractDouyinData(data: Json, target: string, allowed: readonly string[], publicPage: boolean): Extracted {
  if (data.status_code !== 0) fail("page_unavailable", "平台未返回公开作品，可能限流或需要授权。");
  const matching = arr(data.aweme_list).map(obj).filter(i => identity(i.aweme_id) === target);
  const matches = [...new Map(matching.map(i => [canonical(i), i])).values()];
  if (!matches.length) fail("target_not_found", "抖音接口暂未返回这条作品的数据。");
  if (matches.length > 1) fail("ambiguous_item", "同一作品返回了相互冲突的数据，请稍后重新解析。");
  const item = matches[0], status = obj(item.status), control = obj(item.video_control);
  if (status.aweme_id !== undefined && identity(status.aweme_id) !== target) fail("invalid_item", "作品编号不一致。");
  if (["is_delete", "is_private", "is_prohibited", "self_see", "part_see", "private_status", "in_reviewing"]
    .some(k => active(status[k]))) fail("access_denied", "此作品不是公开可下载内容。");
  const video = obj(item.video), images = arr(item.images), title = titleOf(item.desc || item.item_title, "抖音素材");
  // Public image pages omit app-only status/video_control. Their explicit
  // download_url_list is the published download version, not the preview URL.
  // This evidence is accepted only for matched public-page images. A present
  // denial always wins, and Feed still requires both affirmative permissions.
  const publishedImages = publicPage && images.length > 0 &&
    images.every(image => arr(obj(image).download_url_list).some(url => str(url)));
  if (status.allow_share !== undefined && status.allow_share !== true ||
      control.allow_download !== undefined && control.allow_download !== true ||
      !publishedImages && (status.allow_share !== true || control.allow_download !== true) ||
      active(item.prevent_download) || active(control.prevent_download_type) || active(obj(control.download_info).level))
    fail("download_not_allowed", "平台未允许下载这条作品。");
  if (active(obj(item.risk_infos).reflow_unplayable) || active(obj(item.risk_infos).warn))
    fail("access_denied", "平台限制了这条作品的公开访问。");
  if (images.length) {
    if (images.length > 20) fail("image_count", "图集超过 20 张。");
    const urls = images.map(v => source(publishedImages ? arr(obj(v).download_url_list) : urlsFrom(v), allowed));
    return { platform: "douyin", title, cover: urls[0], media_type: "images", media_urls: urls };
  }
  if ([2, 68, 150].includes(num(item.aweme_type))) fail("missing_media", "图文缺少图片，不将配乐当作视频。");
  if (encrypted(video) || active(video.need_set_token)) fail("protected_media", "不支持加密或额外授权视频。");
  const candidates = arr(video.bit_rate).map(obj)
    .filter(s => !encrypted(s) && (!s.format || s.format === "mp4"))
    .map(s => ({ addr: obj(s.play_addr), compatible: s.is_h265 !== 1, bitrate: num(s.bit_rate) }));
  for (const key of ["play_addr_h264", "play_addr"])
    candidates.push({ addr: obj(video[key]), compatible: key === "play_addr_h264" || video.is_h265 !== 1, bitrate: 0 });
  const valid = candidates.filter(c => !encrypted(c.addr) && urlsFrom(c.addr).length);
  valid.sort((a, b) => Number(b.compatible) - Number(a.compatible) ||
    num(b.addr.height) * num(b.addr.width) - num(a.addr.height) * num(a.addr.width) ||
    b.bitrate - a.bitrate || num(b.addr.data_size) - num(a.addr.data_size));
  if (!valid.length) fail("missing_media", "平台没有提供视频文件地址。");
  const coverUrls = urlsFrom(video.cover);
  return { platform: "douyin", title, media_type: "video",
    media_urls: [source(urlsFrom(valid[0].addr), allowed)], cover: coverUrls.length ? source(coverUrls, allowed) : null };
}
export function extractDouyinPage(html: string, finalUrl: string, target: string, allowed: readonly string[]): Extracted {
  const checked = validateUrl(finalUrl, hosts.douyinPage);
  if (douyinId(checked) !== target) fail("invalid_item", "分享页跳转后的作品编号不一致。");
  const state = assignedState(html, "_ROUTER_DATA");
  if (active(state.errors) && Object.keys(obj(state.errors)).length)
    fail("page_unavailable", "抖音分享页返回错误，无法获取这条作品。");
  const loader = obj(state.loaderData);
  const items: unknown[] = [];
  for (const key of ["video_(id)/page", "note_(id)/page"]) {
    const page = obj(loader[key]);
    for (const field of ["itemId", "lastPath"]) {
      if (page[field] !== undefined && identity(page[field]) !== target)
        fail("invalid_item", "分享页数据中的作品编号不一致。");
    }
    const response = obj(page.videoInfoRes);
    if (response.status_code !== undefined && response.status_code !== 0)
      fail("page_unavailable", "抖音分享页未允许读取这条作品。");
    items.push(...arr(response.item_list));
  }
  return extractDouyinData({ status_code: 0, aweme_list: items }, target, allowed, true);
}
export async function parseShare(text: string, transport: Transport, settings: Settings): Promise<Parsed> {
  const links = extractLinks(text), hostOf = (url: string) => {
    try { return new URL(url).hostname; } catch { return fail("unsafe_url", "链接格式无效。"); }
  };
  const platforms = links.map(url => hosts.xhsPage.includes(hostOf(url)) ? "xiaohongshu"
    : hosts.douyinPage.includes(hostOf(url)) ? "douyin" : "direct");
  if (new Set(platforms).size !== 1) fail("mixed_platforms", "请一次解析同一平台的素材。");
  const allowed = [...hosts.media, ...settings.directHosts];
  let result: Extracted;
  if (platforms[0] === "xiaohongshu") {
    if (links.length !== 1) fail("multiple_posts", "请一次解析一条小红书笔记。");
    const page = await transport.request({ url: validateUrl(links[0], hosts.xhsPage, true), scope: "xhsPage" });
    result = extractXhs(readState(page.body), page.url, allowed);
  } else if (platforms[0] === "douyin") {
    if (links.length !== 1) fail("multiple_posts", "请一次解析一条抖音作品。");
    const url = validateUrl(links[0], hosts.douyinPage, true);
    let id = douyinId(url);
    let sharedPage: { url: string; body: string } | undefined;
    if (!id && hostOf(url) === "v.douyin.com") {
      sharedPage = await transport.request({ url, scope: "douyinPage" });
      id = douyinId(validateUrl(sharedPage.url, hosts.douyinPage));
    }
    if (!id) return fail("unsupported_link", "仅支持抖音单条作品链接。");
    try {
      const response = await transport.request({
        url: `https://aweme.snssdk.com/aweme/v1/feed/?aweme_id=${id}&aid=1128`, scope: "douyinApi",
      });
      result = extractDouyin(readDouyinJSON(response.body), id, allowed);
    }
    catch (e) {
      // An unavailable anonymous API must not block an independent public page.
      // Never connect to that address: the independent official public page
      // still applies the same DNS, TLS, permission and exact-work checks.
      // Explicit source/download/DRM denials and conflicting data are terminal.
      const unavailable = !(e instanceof ParseError) &&
        ["dns_failed", "blocked_address", "tls_or_network_error", "network_error", "timeout"].includes(str(obj(e).code));
      if (!(e instanceof ParseError && e.code === "target_not_found") && !unavailable) throw e;
      const resolved = new URL(sharedPage?.url ?? url);
      const kind = /^\/(?:share\/)?(note|slides)\//.exec(resolved.pathname)?.[1] ?? "video";
      const canonicalPage = `https://www.iesdouyin.com/share/${kind}/${id}/`;
      // Keep an original share URL's parameters for the first read. Some
      // shared tracking parameters select a client-rendered shell, so an empty
      // response can also use the same work's normal canonical public page.
      const pageUrls = [...new Set([
        ...(!sharedPage && resolved.pathname.startsWith("/share/") ? [resolved.href] : []),
        canonicalPage,
      ])];
      let extracted: Extracted | undefined;
      const tryPage = (page: { body: string; url: string }) => {
        try { return extractDouyinPage(page.body, page.url, id!, allowed); }
        catch (pageError) {
          if (!(pageError instanceof ParseError) || !["target_not_found", "page_unavailable"].includes(pageError.code)) throw pageError;
          return undefined;
        }
      };
      if (sharedPage?.body.includes("_ROUTER_DATA")) extracted = tryPage(sharedPage);
      for (const pageUrl of pageUrls) {
        if (extracted) break;
        if (sharedPage?.url !== pageUrl)
          extracted = tryPage(await transport.request({ url: pageUrl, scope: "douyinPage" }));
      }
      result = extracted ?? fail("target_unavailable", `已识别抖音${kind === "video" ? "作品" : "图文"}（${id}），但公开接口与分享页未提供其素材，当前无法解析。链接已识别，无需重复复制；可在抖音中使用作者允许的保存方式。`);
    }
  } else {
    const urls = links.map(u => validateUrl(u, allowed));
    let name: string;
    try { name = decodeURIComponent(new URL(urls[0]).pathname.split("/").pop() || "媒体素材"); }
    catch { name = "媒体素材"; }
    result = { platform: "direct", title: titleOf(name, "媒体素材"), media_type: "images", media_urls: urls, cover: null };
  }
  const infos: MediaInfo[] = [];
  for (const url of result.media_urls) infos.push(await transport.probe({ url }));
  if (result.platform === "direct") {
    const videos = infos.filter(i => i.mime.startsWith("video/"));
    if (videos.length && infos.length !== 1) fail("mixed_media", "视频请一次解析一个链接。");
    result.media_type = videos.length ? "video" : "images";
    result.cover = videos.length ? null : result.media_urls[0];
  }
  if (infos.some(i => !i.mime.startsWith(result.media_type === "video" ? "video/" : "image/")))
    fail("invalid_media", "实际文件类型与素材声明不符，已停止解析。");
  return { ...result, infos, watermark_status: result.watermark_status ?? "unknown", error: null, expiresAt: Date.now() + 15 * 60_000 };
}
