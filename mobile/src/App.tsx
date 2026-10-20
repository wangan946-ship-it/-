import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Clapperboard, Film, FolderOpen, Image as ImageIcon, LoaderCircle, Play,
  Plus, Settings as SettingsIcon, Share2, ShieldCheck, Smartphone, Trash2, X } from "lucide-react";
import { Native, isNative, localUrl, type LocalMedia, type Progress, type Settings } from "./bridge";
import { parseShare, type Parsed } from "./parser";
import { version } from "../package.json";
import "./style.css";

export const bytes = (n: number | null) => n === null ? "大小未知" : n < 1024 ? `${n} B`
  : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const platformNames = { douyin: "抖音", xiaohongshu: "小红书", direct: "媒体直链" };
const message = (e: unknown) => e instanceof Error ? e.message : String((e as { message?: string })?.message || "操作未完成，请重试。");

function MediaView({ item }: { item: LocalMedia }) {
  const [failed, setFailed] = useState(false);
  return <div className="media">
    {item.mime.startsWith("video/") ?
      <video src={localUrl(item.path)} controls playsInline preload="metadata" aria-label={`${item.title} 视频预览`}
        onError={() => setFailed(true)} /> :
      <img src={localUrl(item.path)} alt={item.title} onError={() => setFailed(true)} />}
    {failed && <p role="alert">手机不支持此文件的预览编码，可以导出后用其他播放器打开。</p>}
  </div>;
}
function ExportButtons({ item, notify }: { item: LocalMedia; notify: (s: string) => void }) {
  const [busy, setBusy] = useState(false);
  async function perform(action: "photos" | "share") {
    if (busy) return;
    setBusy(true);
    try {
      await Native[action]({ id: item.id });
      notify(action === "photos" ? "已保存到系统相册。" : "已打开系统分享菜单。");
    } catch (e) { notify(message(e)); }
    finally { setBusy(false); }
  }
  return <div className="actions">
    <button disabled={busy} onClick={() => void perform("photos")}><ImageIcon size={17} />保存到相册</button>
    <button disabled={busy} onClick={() => void perform("share")}><Share2 size={17} />分享 / 导出文件</button>
  </div>;
}
function Asset({ result, index, notify, refresh }: {
  result: Parsed; index: number; notify: (s: string) => void; refresh: () => Promise<void>;
}) {
  const [item, setItem] = useState<LocalMedia | null>(null);
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState("");
  const operation = useRef<string | null>(null), alive = useRef(true), current = useRef<LocalMedia | null>(null);
  useEffect(() => {
    alive.current = true;
    const listener = Native.addListener("progress", event => {
      if (alive.current && event.operationId === operation.current) setProgress(event);
    });
    return () => {
      alive.current = false;
      void listener.then(l => l.remove()).catch(() => {});
      if (operation.current) void Native.cancel({ operationId: operation.current }).catch(() => {});
      if (current.current?.temporary) void Native.remove({ id: current.current.id }).catch(() => {});
    };
  }, []);
  async function prepare(save: boolean) {
    if (operation.current) return;
    setError("");
    if (item) {
      if (save && item.temporary) {
        setBusy(true);
        try {
          const kept = await Native.promote({ id: item.id });
          current.current = kept;
          if (alive.current) { setItem(kept); notify("已保存到本机，未重复下载。"); }
          await refresh();
        } catch (e) { if (alive.current) setError(message(e)); }
        finally { if (alive.current) setBusy(false); }
      }
      return;
    }
    if (Date.now() > result.expiresAt) { setError("素材链接已过期，请重新解析。"); return; }
    const id = crypto.randomUUID(); operation.current = id; setBusy(true);
    setProgress({ operationId: id, bytes: 0, total: result.infos[index].size });
    try {
      const file = await Native.prepare({ url: result.media_urls[index],
        title: result.title + (result.media_urls.length > 1 ? `_${String(index + 1).padStart(2, "0")}` : ""),
        platform: result.platform, expectedMime: result.infos[index].mime,
        expectedSize: result.infos[index].size, expectedMd5: result.expected_md5s?.[index],
        temporary: !save, operationId: id });
      current.current = file;
      if (!alive.current) {
        if (file.temporary) await Native.remove({ id: file.id });
        return;
      }
      setItem(file);
      if (save) { notify("已下载到本机，可继续保存到相册或分享。"); await refresh(); }
    } catch (e) { if (alive.current) setError(message(e)); }
    finally { operation.current = null; if (alive.current) setBusy(false); }
  }
  const video = result.media_type === "video";
  return <article className="asset">
    {item ? <MediaView item={item} /> : <div className="preview-placeholder">
      {video ? <Film size={36} /> : <ImageIcon size={36} />}
      <strong>{video ? "视频预览" : `图片 ${index + 1}`}</strong>
      <p>准备临时文件后即可查看<br />保留到本机时无需重复下载</p>
      <button disabled={busy} onClick={() => void prepare(false)}><Play size={17} />{video ? "加载视频预览" : "加载图片预览"}</button>
    </div>}
    <div className="asset-detail"><span>{result.infos[index].mime}</span><strong>{bytes(result.infos[index].size)}</strong></div>
    {busy && <div className="transfer" role="status">
      <div><LoaderCircle size={16} className="spin" />正在准备 · {bytes(progress?.bytes ?? 0)} / {bytes(progress?.total ?? null)}</div>
      <progress value={progress?.total ? progress.bytes : undefined} max={progress?.total || 1} />
      {operation.current && <button onClick={() => void Native.cancel({ operationId: operation.current! })}>取消传输</button>}
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
    <button className="primary full" disabled={busy || !!item && !item.temporary} onClick={() => void prepare(true)}>
      <ArrowDownToLine size={18} />{item && !item.temporary ? "已保存到本机" : video ? "下载视频到本机" : "下载图片到本机"}
    </button>
    {item && !item.temporary && <ExportButtons item={item} notify={notify} />}
  </article>;
}
function Saved({ item, notify, refresh }: { item: LocalMedia; notify: (s: string) => void; refresh: () => Promise<void> }) {
  const [preview, setPreview] = useState(false), [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false);
  async function remove() {
    if (busy) return; setBusy(true);
    try { await Native.remove({ id: item.id }); await refresh(); notify("已删除本机记录与文件。已导出的相册副本不受影响。"); }
    catch (e) { notify(message(e)); }
    finally { setBusy(false); }
  }
  return <article className="card saved">
    <div className="saved-heading">{item.mime.startsWith("video/") ? <Film /> : <ImageIcon />}<div>
      <h3>{item.title}</h3><p>{platformNames[item.platform]} · {bytes(item.bytes)} · {new Date(item.createdAt).toLocaleDateString()}</p>
    </div></div>
    {preview && <MediaView item={item} />}
    <div className="actions"><button onClick={() => setPreview(!preview)}><Play size={16} />{preview ? "收起预览" : "本机预览"}</button>
      <button onClick={() => setConfirm(!confirm)}><Trash2 size={16} />删除</button></div>
    <ExportButtons item={item} notify={notify} />
    {confirm && <div className="delete-confirm"><p>删除这条记录及 APP 内的文件？</p>
      <button onClick={() => setConfirm(false)}>保留</button><button className="danger" disabled={busy} onClick={() => void remove()}>确认删除</button></div>}
  </article>;
}
export default function App() {
  const [page, setPage] = useState<"import" | "library" | "settings">("import");
  const [settings, setSettings] = useState<Settings>({ directHosts: [], maxDownloadMB: 500 });
  const [records, setRecords] = useState<LocalMedia[]>([]), [ready, setReady] = useState(false);
  const [text, setText] = useState(""), [result, setResult] = useState<Parsed | null>(null), [parsing, setParsing] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [hostsText, setHostsText] = useState(""), [maxMB, setMaxMB] = useState(500), [savingSettings, setSavingSettings] = useState(false);
  const sequence = useRef(0);
  async function refresh() { setRecords((await Native.list()).items); }
  useEffect(() => {
    if (!isNative) return;
    Promise.all([Native.settings(), Native.list()]).then(([values, library]) => {
      setSettings(values); setHostsText(values.directHosts.join("\n")); setMaxMB(values.maxDownloadMB);
      setRecords(library.items); setReady(true);
    }).catch(e => setError(message(e)));
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  function changeText(value: string) {
    sequence.current++; setText(value); setResult(null); setError(""); setParsing(false);
  }
  async function parse() {
    if (!ready || parsing) return;
    const current = ++sequence.current; setParsing(true); setError(""); setResult(null);
    try {
      const parsed = await parseShare(text, Native, settings);
      if (sequence.current === current) setResult(parsed);
    } catch (e) { if (sequence.current === current) setError(message(e)); }
    finally { if (sequence.current === current) setParsing(false); }
  }
  async function saveSettings() {
    if (!ready || savingSettings) return;
    setSavingSettings(true);
    try {
      const values = await Native.configure({ directHosts: [...new Set(hostsText.split(/[\s,，]+/).filter(Boolean))], maxDownloadMB: maxMB });
      setSettings(values); setResult(null); setNotice("设置已保存在这台手机。");
    } catch (e) { setNotice(message(e)); }
    finally { setSavingSettings(false); }
  }
  const pages = [["import", "添加素材", Plus], ["library", "本机素材", FolderOpen], ["settings", "设置", SettingsIcon]] as const;
  return <div className="shell">
    <header><div className="brand"><span><Clapperboard size={25} /></span><div><strong>留影</strong><small>手机独立版 · v{version}</small></div></div>
      <div className="local-badge"><Smartphone size={14} />本机存储</div></header>
    <main>
      {!isNative && <div className="banner" role="status">这是手机 APP 的界面预览。解析、下载与相册功能需要安装安卓或 iOS 版；此页面不会连接电脑后端。</div>}
      {page === "import" && <>
        <div className="intro"><p>YOUR PERSONAL COLLECTION</p><h1>好素材，随手留。</h1><span>粘贴链接，在手机里预览、下载和整理。</span></div>
        <section className="card"><div className="section-heading"><h2>添加素材</h2><span>01 / 导入</span></div>
          <label htmlFor="share-text">分享文字或媒体链接</label>
          <textarea id="share-text" rows={5} maxLength={8192} value={text}
            placeholder={"粘贴抖音、小红书的完整分享文字…\n也支持已配置域名的 HTTPS 媒体直链"}
            onChange={e => changeText(e.target.value)} />
          <div className="text-meta"><span>抖音 · 小红书 · 媒体直链</span><span>{text.length} / 8192</span></div>
          <button className="primary full" disabled={!ready || !text.trim() || parsing} onClick={() => void parse()}>
            {parsing ? <LoaderCircle size={18} className="spin" /> : <Plus size={18} />}{parsing ? "正在解析…" : "解析素材"}</button>
          {error && <p className="error" role="alert">{error}</p>}
        </section>
        {result && <section className="card" aria-label="解析结果">
          <div className="result-heading"><span className="tag">{platformNames[result.platform]}</span><span className="muted">{result.watermark_status === "source_original" ? "原始上传版本" : "水印状态未知"}</span></div>
          <h2>{result.title}</h2>
          <p className="muted">{result.media_type === "video" ? "视频素材" : `图文素材 · ${result.media_urls.length} 张图片`}</p>
          <p className="muted">{result.watermark_status === "source_original"
            ? "获取原始上传文件，避开平台播放版本附加的水印；下载完成后核对文件校验值。作者原本加入的文字或标志会保留。原片可能较大，部分手机不支持其预览编码。"
            : "来源公开提供的版本，水印状态尚未验证。"}</p>
          {result.media_urls.map((url, index) => <Asset key={`${result.expiresAt}-${index}-${url}`} result={result} index={index} notify={setNotice} refresh={refresh} />)}
          <p className="fine">点击下载即确认你拥有素材或已获授权。传输时请保持 APP 在前台；切到后台会停止未完成的传输。</p>
        </section>}
        <div className="card facts"><ShieldCheck size={23} /><div><strong>素材只留在你的手机</strong><p>无需服务器与账号登录 · 单文件最大 {settings.maxDownloadMB} MB<br />临时预览一小时后清理，已保存素材由你管理</p></div></div>
      </>}
      {page === "library" && <>
        <div className="intro"><p>ON THIS DEVICE</p><h1>本机素材</h1><span>{records.length} 份素材 · {bytes(records.reduce((sum, item) => sum + item.bytes, 0))}</span></div>
        {!records.length && <div className="card empty"><FolderOpen size={42} /><h2>第一份灵感，从链接开始</h2><p>已保存的素材离线也能预览。卸载 APP 会删除尚未导出的文件。</p><button onClick={() => setPage("import")}>去添加素材</button></div>}
        {records.map(item => <Saved key={item.id} item={item} notify={setNotice} refresh={refresh} />)}
      </>}
      {page === "settings" && <>
        <div className="intro"><p>MADE FOR YOUR PHONE</p><h1>本机设置</h1><span>配置只保存在当前设备，不会同步到其他手机。</span></div>
        <section className="card">
          <h2>下载与来源</h2><label htmlFor="max-size">单文件大小上限（MB）</label>
          <input id="max-size" type="number" min="1" max="500" value={maxMB} onChange={e => setMaxMB(Number(e.target.value))} />
          <label htmlFor="hosts">额外可信媒体域名</label><textarea id="hosts" rows={4} value={hostsText} onChange={e => setHostsText(e.target.value)}
            placeholder="cdn.your-domain.com，每行一个精确域名" />
          <p className="muted">抖音、小红书常用媒体域名已内置。只添加你信任的来源；不支持通配符、内网或 IP 地址。</p>
          <button className="primary full" disabled={!ready || savingSettings} onClick={() => void saveSettings()}>保存设置</button>
        </section>
        <section className="card guide"><h2>保存到照片与文件</h2><ol>
          <li>解析素材，可先加载临时预览。</li><li>点击“下载到本机”，保留 APP 内的副本。</li>
          <li>点“保存到相册”，首次使用时允许添加照片。</li><li>也可点“分享 / 导出文件”，交给系统或其他应用保存。</li></ol>
          <p className="muted">APP 只申请添加相册权限，不读取已有照片。部分视频编码无法写入相册时，可导出到文件。已经导出的相册副本不随 APP 记录删除。</p>
        </section>
        <section className="card guide"><h2>独立运行的边界</h2><p>页面、解析器、下载器和记录均在手机内运行。解析平台链接仍需要互联网；登录、验证、私密内容、禁止下载或 DRM 内容会明确失败。</p>
          <p>本机最多 500 份素材、总额度 2 GB；同一时间准备一份媒体，五分钟超时。预览先完整准备临时文件再播放，大文件需要等待。不提供后台下载、自动去水印或账号 Cookie 功能。</p></section>
      </>}
      <footer><ShieldCheck size={13} />无服务器 · 无第三方解析 API · 无媒体云同步</footer>
    </main>
    <nav>{pages.map(([id, label, Icon]) => <button key={id} aria-current={page === id ? "page" : undefined}
      className={page === id ? "active" : ""} onClick={() => setPage(id)}><Icon size={22} /><span>{label}</span></button>)}</nav>
    {notice && <div className="toast" role="status"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="关闭提示"><X size={18} /></button></div>}
  </div>;
}
