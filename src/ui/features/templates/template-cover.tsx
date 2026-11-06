import { Button } from "@heroui/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  readAvatarSource,
  encodeAvatarCanvas,
} from "../../components/avatar/avatar-image.js";
import {
  clampCrop,
  cropRectangle,
  type Crop,
} from "../../components/avatar/avatar-crop.js";
import { errorMessage } from "../../lib/client.js";

export function TemplateCover({
  disabled,
  onChange,
}: {
  disabled: boolean;
  onChange(data: string): void;
}) {
  const picker = useRef<HTMLInputElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const generation = useRef(0),
    owned = useRef<ImageBitmap | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [source, setSource] = useState<ImageBitmap | null>(null);
  const [crop, setCrop] = useState<Crop>({ x: 0, y: 0, zoom: 1 });
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  useEffect(
    () => () => {
      generation.current++;
      window.clearTimeout(timer.current);
      owned.current?.close();
    },
    [],
  );
  useLayoutEffect(() => {
    if (!source || !canvas.current) return;
    const context = canvas.current.getContext("2d"),
      rect = cropRectangle(source, crop);
    context?.clearRect(0, 0, 256, 256);
    context?.drawImage(
      source,
      rect.x,
      rect.y,
      rect.side,
      rect.side,
      0,
      0,
      256,
      256,
    );
  }, [source, crop]);
  const cancel = () => {
    generation.current++;
    window.clearTimeout(timer.current);
    owned.current?.close();
    owned.current = null;
    setSource(null);
    setLoading(false);
  };
  const load = async (file: File) => {
    const current = ++generation.current;
    setLoading(true);
    setError("");
    const deadline = window.setTimeout(() => {
      if (generation.current !== current) return;
      generation.current++;
      setLoading(false);
      setError("图片解码超过 10 秒，请选择其他图片；迟到结果不会应用。");
    }, 10000);
    timer.current = deadline;
    try {
      const bitmap = await readAvatarSource(file);
      if (generation.current !== current) {
        bitmap.close();
        return;
      }
      owned.current?.close();
      owned.current = bitmap;
      setSource(bitmap);
      setCrop({ x: bitmap.width / 2, y: bitmap.height / 2, zoom: 1 });
    } catch (error) {
      if (generation.current === current) setError(errorMessage(error));
    } finally {
      window.clearTimeout(deadline);
      if (generation.current === current) setLoading(false);
    }
  };
  return (
    <section aria-label="模板图片裁剪">
      <input
        ref={picker}
        hidden
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,.bmp"
        aria-label="模板图片文件"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void load(file);
        }}
      />
      <Button
        variant="secondary"
        className="secondary"
        isDisabled={disabled || loading}
        onPress={() => picker.current?.click()}
      >
        上传模板图片
      </Button>
      {loading && <p role="status">正在读取图片…</p>}
      {(source || loading) && (
        <Button variant="ghost" isDisabled={disabled} onPress={cancel}>
          取消裁剪
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
      {source && (
        <>
          <canvas
            ref={canvas}
            width={256}
            height={256}
            role="img"
            aria-label="模板图片裁剪预览"
          />
          <label>
            裁剪缩放
            <input
              type="range"
              min={1}
              max={5}
              step={0.05}
              value={crop.zoom}
              disabled={disabled || loading}
              onChange={(e) =>
                setCrop(
                  clampCrop(source, { ...crop, zoom: Number(e.target.value) }),
                )
              }
            />
          </label>
          <label>
            裁剪水平位置
            <input
              type="range"
              min={0}
              max={source.width}
              value={crop.x}
              disabled={disabled || loading}
              onChange={(e) =>
                setCrop(
                  clampCrop(source, { ...crop, x: Number(e.target.value) }),
                )
              }
            />
          </label>
          <label>
            裁剪垂直位置
            <input
              type="range"
              min={0}
              max={source.height}
              value={crop.y}
              disabled={disabled || loading}
              onChange={(e) =>
                setCrop(
                  clampCrop(source, { ...crop, y: Number(e.target.value) }),
                )
              }
            />
          </label>
          <Button
            variant="primary"
            className="primary"
            isDisabled={disabled || loading}
            onPress={() => {
              if (!canvas.current) return;
              try {
                onChange(encodeAvatarCanvas(canvas.current));
                cancel();
              } catch (error) {
                setError(errorMessage(error));
              }
            }}
          >
            应用裁剪图片
          </Button>
        </>
      )}
    </section>
  );
}
