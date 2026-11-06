import type { DesktopEnvelope as Envelope } from "../../../shared/desktop/desktop-commands.js";
import type { DesktopCommand as Command } from "../../../shared/desktop/desktop-commands.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Bot } from "../../../shared/chat/bots.js";
import type { CommandResult } from "../../../shared/core.js";
import { AppError } from "../../../shared/core.js";
import { cropRectangle, type Crop } from "./avatar-crop.js";
import { encodeAvatarCanvas, readAvatarSource } from "./avatar-image.js";
import { envelope, errorMessage } from "../../lib/client.js";

export function useAvatarEditor({
  anchor,
  bot,
  act,
  onClose,
}: {
  anchor: HTMLElement;
  bot: Bot;
  act(command: Command, request?: Envelope): Promise<CommandResult | undefined>;
  onClose(): void;
}) {
  const root = useRef<HTMLDivElement>(null),
    picker = useRef<HTMLInputElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const ownedImage = useRef<ImageBitmap | null>(null),
    generation = useRef(0),
    loadTimer = useRef<number | undefined>(undefined),
    request = useRef<Envelope | null>(null);
  const [tab, setTab] = useState<"bot" | "generate" | "upload">("bot"),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [error, setError] = useState("");
  const [source, setSource] = useState<ImageBitmap | null>(null),
    [sourceName, setSourceName] = useState(""),
    [crop, setCrop] = useState<Crop>({ x: 0, y: 0, zoom: 1 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    // The file chooser can return focus to body while its trigger is disabled.
    if (!busy && document.activeElement === document.body)
      root.current?.focus({ preventScroll: true });
  }, [busy]);
  useEffect(
    () => () => {
      generation.current++;
      window.clearTimeout(loadTimer.current);
      ownedImage.current?.close();
    },
    [],
  );
  useLayoutEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx || !source) return;
    const rect = cropRectangle(source, crop);
    ctx.clearRect(0, 0, 256, 256);
    ctx.drawImage(source, rect.x, rect.y, rect.side, rect.side, 0, 0, 256, 256);
  }, [source, crop, tab]);
  const save = async (command: Command) => {
    if (busy) return;
    const current = generation.current;
    setBusy(true);
    setError("");
    if (
      !request.current ||
      JSON.stringify(request.current.command) !== JSON.stringify(command)
    )
      request.current = envelope(command);
    try {
      const result = await act(command, request.current);
      if (!result) throw Error("头像保存尚未确认，请重试。");
      request.current = null;
      if (current === generation.current) setUncertain(false);
    } catch (e) {
      if (current === generation.current) {
        const rejected =
          e instanceof AppError &&
          [
            "invalid_input",
            "not_found",
            "conflict",
            "capacity",
            "unauthorized",
          ].includes(e.code);
        if (rejected) request.current = null;
        setUncertain(!rejected);
        setError(errorMessage(e));
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const character = (shape = bot.avatar.shape, color = bot.avatar.color) => {
    void save({
      type: "bot.avatar.character",
      botId: bot.id,
      revision: bot.avatar.revision,
      shape,
      color,
    });
  };
  const load = async (file: File | undefined) => {
    if (!file || busy || uncertain) return;
    const current = ++generation.current;
    setBusy(true);
    setError("");
    window.clearTimeout(loadTimer.current);
    const timeout = window.setTimeout(() => {
      if (current !== generation.current) return;
      generation.current++;
      setBusy(false);
      setError("图片解码超过 10 秒，请选择其他图片；迟到结果不会应用。");
    }, 10000);
    loadTimer.current = timeout;
    try {
      const bitmap = await readAvatarSource(file);
      if (current !== generation.current) {
        bitmap.close();
        return;
      }
      ownedImage.current?.close();
      ownedImage.current = bitmap;
      setSource(bitmap);
      setSourceName(file.name);
      setCrop({ x: bitmap.width / 2, y: bitmap.height / 2, zoom: 1 });
      setTab("upload");
    } catch (e) {
      if (current === generation.current) setError(errorMessage(e));
    } finally {
      window.clearTimeout(timeout);
      if (loadTimer.current === timeout) loadTimer.current = undefined;
      if (current === generation.current) setBusy(false);
    }
  };
  const saveCrop = async () => {
    const surface = canvas.current;
    if (!surface || busy || !source) return;
    try {
      const data = encodeAvatarCanvas(surface);
      await save({
        type: "bot.avatar.image",
        botId: bot.id,
        revision: bot.avatar.revision,
        data,
      });
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return {
    bot,
    root,
    picker,
    canvas,
    ownedImage,
    generation,
    request,
    tab,
    setTab,
    busy,
    uncertain,
    error,
    source,
    setSource,
    sourceName,
    setSourceName,
    crop,
    setCrop,
    drag,
    anchor,
    onClose,
    save,
    character,
    load,
    saveCrop,
  };
}
export type AvatarEditorViewModel = ReturnType<typeof useAvatarEditor>;
