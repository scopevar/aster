import { z } from "zod";
import { readFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/core.js";
import type { DesktopShortcut } from "./shortcut.js";
import {
  defaultTimeZone,
  preferencesSchema,
  legacyPreferencesSchema,
  preferencesV2Schema,
  preferencesChangeSchema,
  type Preferences,
  type DesktopPreferences,
  type PreferencesChange,
} from "../../shared/desktop/preferences.js";

/** The single-instance desktop owns this file; worker and renderer never write it. */
export class DesktopPreferenceStore {
  private value: Preferences;
  private readonly appliedHardwareAcceleration: boolean;
  private chain: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closing = false;
  constructor(
    private readonly path: string,
    private readonly shortcut?: DesktopShortcut,
  ) {
    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      const legacy = legacyPreferencesSchema.safeParse(raw);
      const v2 = preferencesV2Schema.safeParse(raw);
      this.value = preferencesSchema.parse(
        legacy.success
          ? { ...legacy.data, version: 3, theme: "light", shortcut: null }
          : v2.success
            ? { ...v2.data, version: 3, shortcut: null }
            : preferencesSchema
                .extend({ remoteOnly: z.boolean().optional() })
                .transform((value) => {
                  delete value.remoteOnly;
                  return value;
                })
                .parse(raw),
      );
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw new AppError(
          "unavailable",
          "桌面偏好文件无法读取，原文件已保留，请修复或从备份恢复 preferences.json。",
        );
      this.value = {
        version: 3,
        revision: 0,
        hardwareAcceleration: true,
        timeZone: defaultTimeZone,
        theme: "system",
        shortcut: null,
      };
    }
    this.appliedHardwareAcceleration = this.value.hardwareAcceleration;
  }
  read(): DesktopPreferences {
    return {
      ...this.value,
      appliedHardwareAcceleration: this.appliedHardwareAcceleration,
      shortcutStatus: this.shortcut?.status(this.value.shortcut) ?? {
        state: this.value.shortcut ? "unavailable" : "disabled",
        detail: this.value.shortcut
          ? "快捷键服务尚未就绪。"
          : "全局快捷键已关闭。",
      },
    };
  }
  save(change: PreferencesChange): Promise<DesktopPreferences> {
    const input = preferencesChangeSchema.parse(change);
    if (this.closing || this.pending >= 16)
      return Promise.reject(
        new AppError("unavailable", "设置正在保存或应用正在退出，请稍后重试。"),
      );
    this.pending++;
    const task = this.chain
      .catch(() => {})
      .then(async () => {
        if (input.revision !== this.value.revision)
          throw new AppError(
            "conflict",
            "设置已发生变化，请重新打开设置后重试。",
          );
        const next = preferencesSchema.parse({
          ...this.value,
          ...input,
          revision: this.value.revision + 1,
        });
        const shortcutChanged =
          JSON.stringify(next.shortcut) !== JSON.stringify(this.value.shortcut);
        const retryShortcut =
          input.shortcut !== undefined &&
          next.shortcut !== null &&
          this.read().shortcutStatus.state !== "active";
        if ((shortcutChanged || retryShortcut) && !this.shortcut)
          throw new AppError("unavailable", "快捷键服务尚未就绪。");
        const reservation =
          shortcutChanged || retryShortcut
            ? this.shortcut?.prepare(next.shortcut)
            : undefined;
        // Compare inside the writer queue, after checking the expected revision.
        // A renderer cache cannot establish that a repeated choice is a no-op.
        if (
          next.theme === this.value.theme &&
          next.timeZone === this.value.timeZone &&
          next.hardwareAcceleration === this.value.hardwareAcceleration &&
          next.updateChannel === this.value.updateChannel &&
          next.autoUpdate === this.value.autoUpdate &&
          !shortcutChanged
        ) {
          reservation?.commit();
          return this.read();
        }
        const temp = `${this.path}.${randomUUID()}.tmp`;
        try {
          await mkdir(dirname(this.path), { recursive: true });
          const file = await open(temp, "wx", 0o600);
          try {
            await file.writeFile(JSON.stringify(next));
            await file.sync();
          } finally {
            await file.close();
          }
          await rename(temp, this.path);
          this.value = next;
          reservation?.commit();
          return this.read();
        } finally {
          reservation?.rollback();
          await unlink(temp).catch((error: unknown) => {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
              )
            )
              throw error;
          });
        }
      })
      .finally(() => {
        this.pending--;
      });
    this.chain = task;
    return task;
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.chain.catch(() => {});
  }
}
