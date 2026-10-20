import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
export type Scope = "xhsPage" | "douyinPage" | "douyinApi";
export type Platform = "douyin" | "xiaohongshu" | "direct";
export type MediaInfo = { mime: string; size: number | null };
export type LocalMedia = {
  id: string; title: string; platform: Platform; mime: string; bytes: number;
  createdAt: number; temporary: boolean; path: string;
};
export type Settings = { directHosts: string[]; maxDownloadMB: number };
export type Progress = { operationId: string; bytes: number; total: number | null };
export interface NativeMedia {
  settings(): Promise<Settings>;
  configure(options: Settings): Promise<Settings>;
  request(options: { url: string; scope: Scope }): Promise<{ body: string; url: string }>;
  probe(options: { url: string }): Promise<MediaInfo>;
  prepare(options: {
    url: string; title: string; platform: Platform; expectedMime: string;
    expectedSize: number | null; expectedMd5?: string; temporary: boolean; operationId: string;
  }): Promise<LocalMedia>;
  promote(options: { id: string }): Promise<LocalMedia>;
  list(): Promise<{ items: LocalMedia[] }>;
  remove(options: { id: string }): Promise<void>;
  cancel(options: { operationId: string }): Promise<void>;
  share(options: { id: string }): Promise<void>;
  photos(options: { id: string }): Promise<void>;
  addListener(event: "progress", listener: (progress: Progress) => void): Promise<PluginListenerHandle>;
}
export const Native = registerPlugin<NativeMedia>("LocalMedia");
export const isNative = Capacitor.isNativePlatform();
export const localUrl = (path: string) => Capacitor.convertFileSrc(path);
