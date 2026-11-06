import { IconButton } from "../icon-button.js";
import { Button, Tabs, ToggleButton } from "@heroui/react";
import { AnchoredPopover } from "../anchored-popover.js";
import {
  avatarColors,
  avatarShapes,
  defaultAvatar,
} from "../../../shared/avatar.js";
import { clampCrop, cropRectangle } from "./avatar-crop.js";
import { Avatar, avatarPaint, colorLabels, shapeLabels } from "./avatar.js";
import { Icon } from "../icons.js";
import type { AvatarEditorViewModel } from "./use-avatar-editor.js";
export function AvatarEditorView({
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
}: AvatarEditorViewModel) {
  return (
    <AnchoredPopover
      anchor={anchor}
      onClose={onClose}
      label="头像编辑器"
      className="avatar-popover"
    >
      <div
        ref={root}
        tabIndex={-1}
        className="avatar-editor"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          void load(e.dataTransfer.files[0]);
        }}
        onPaste={(e) => {
          if (e.clipboardData.files.length) {
            e.preventDefault();
            void load(e.clipboardData.files[0]);
          }
        }}
      >
        <div className="avatar-editor-header">
          <Tabs
            selectedKey={tab}
            onSelectionChange={(key) => {
              if (key === "bot" || key === "generate" || key === "upload")
                setTab(key);
            }}
            isDisabled={busy || uncertain}
          >
            <Tabs.List className="avatar-editor-tabs" aria-label="头像来源">
              <Tabs.Tab id="bot">Bot</Tabs.Tab>
              <Tabs.Tab id="generate">生成</Tabs.Tab>
              <Tabs.Tab id="upload">上传</Tabs.Tab>
            </Tabs.List>
          </Tabs>
          {tab === "bot" && (
            <Button
              variant="ghost"
              size="sm"
              className="avatar-reset"
              aria-label="将角色重置为默认"
              isDisabled={busy || uncertain}
              onPress={() =>
                character(defaultAvatar.shape, defaultAvatar.color)
              }
            >
              重置
            </Button>
          )}
        </div>
        {tab === "bot" ? (
          <>
            <div className="avatar-shapes" role="group" aria-label="角色形状">
              {avatarShapes.options.map((shape) => (
                <ToggleButton
                  key={shape}
                  variant="ghost"
                  isDisabled={busy || uncertain}
                  aria-label={`${shapeLabels[shape]}角色形状`}
                  isSelected={
                    bot.avatar.imageHash === null && bot.avatar.shape === shape
                  }
                  onChange={() => character(shape)}
                >
                  <Avatar
                    appearance={{ ...bot.avatar, shape, imageHash: null }}
                  />
                </ToggleButton>
              ))}
            </div>
            <div className="avatar-colors" role="group" aria-label="角色颜色">
              {avatarColors.options.map((color) => (
                <ToggleButton
                  key={color}
                  variant="ghost"
                  isDisabled={busy || uncertain}
                  aria-label={`${colorLabels[color]}角色颜色`}
                  isSelected={
                    bot.avatar.imageHash === null && bot.avatar.color === color
                  }
                  onChange={() => character(bot.avatar.shape, color)}
                >
                  <span style={{ background: avatarPaint[color] }} />
                </ToggleButton>
              ))}
            </div>
          </>
        ) : tab === "generate" ? (
          <p className="avatar-unavailable">
            图像生成提供方尚未接入。可以选择角色或上传图片。
          </p>
        ) : (
          <>
            <input
              hidden
              className="avatar-file-input"
              ref={picker}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,.bmp"
              aria-label="选择头像图片"
              onChange={(e) => {
                void load(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            {source ? (
              <div className="avatar-crop">
                <canvas
                  ref={canvas}
                  width={256}
                  height={256}
                  tabIndex={0}
                  role="img"
                  aria-label="头像裁剪预览，可拖动或使用方向键移动"
                  style={{ touchAction: "none" }}
                  onPointerDown={(e) => {
                    if (busy || uncertain) return;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    drag.current = { x: e.clientX, y: e.clientY };
                  }}
                  onPointerMove={(e) => {
                    const previous = drag.current;
                    if (!previous || busy || uncertain) return;
                    const ratio =
                      cropRectangle(source, crop).side /
                      e.currentTarget.getBoundingClientRect().width;
                    const dx = (e.clientX - previous.x) * ratio,
                      dy = (e.clientY - previous.y) * ratio;
                    setCrop((old) =>
                      clampCrop(source, {
                        ...old,
                        x: old.x - dx,
                        y: old.y - dy,
                      }),
                    );
                    drag.current = { x: e.clientX, y: e.clientY };
                  }}
                  onPointerUp={(e) => {
                    drag.current = null;
                    if (e.currentTarget.hasPointerCapture(e.pointerId))
                      e.currentTarget.releasePointerCapture(e.pointerId);
                  }}
                  onLostPointerCapture={() => {
                    drag.current = null;
                  }}
                  onKeyDown={(e) => {
                    if (
                      busy ||
                      uncertain ||
                      ![
                        "ArrowLeft",
                        "ArrowRight",
                        "ArrowUp",
                        "ArrowDown",
                      ].includes(e.key)
                    )
                      return;
                    e.preventDefault();
                    setCrop((old) =>
                      clampCrop(source, {
                        ...old,
                        x:
                          old.x +
                          (e.key === "ArrowRight"
                            ? 5
                            : e.key === "ArrowLeft"
                              ? -5
                              : 0),
                        y:
                          old.y +
                          (e.key === "ArrowDown"
                            ? 5
                            : e.key === "ArrowUp"
                              ? -5
                              : 0),
                      }),
                    );
                  }}
                />
                <p className="avatar-source-caption">
                  {sourceName} · {source.width}×{source.height}
                </p>
                <p className="avatar-drag-caption">拖动以调整位置</p>
                <label className="avatar-zoom">
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label="缩小"
                    isDisabled={busy || uncertain || crop.zoom <= 1}
                    onPress={() =>
                      setCrop(
                        clampCrop(source, { ...crop, zoom: crop.zoom - 0.25 }),
                      )
                    }
                  >
                    <Icon name="minus" size={14} />
                  </IconButton>
                  <input
                    type="range"
                    aria-label="头像缩放"
                    min={1}
                    max={5}
                    step={0.05}
                    value={crop.zoom}
                    disabled={busy || uncertain}
                    onChange={(e) =>
                      setCrop(
                        clampCrop(source, {
                          ...crop,
                          zoom: Number(e.target.value),
                        }),
                      )
                    }
                  />
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label="放大"
                    isDisabled={busy || uncertain || crop.zoom >= 5}
                    onPress={() =>
                      setCrop(
                        clampCrop(source, { ...crop, zoom: crop.zoom + 0.25 }),
                      )
                    }
                  >
                    <Icon name="plus" size={14} />
                  </IconButton>
                </label>
                <div className="avatar-crop-actions">
                  <Button
                    variant="secondary"
                    className="secondary"
                    isDisabled={busy || uncertain}
                    onPress={() => {
                      generation.current++;
                      ownedImage.current?.close();
                      ownedImage.current = null;
                      setSource(null);
                      setSourceName("");
                    }}
                  >
                    重新开始
                  </Button>
                  <Button
                    variant="primary"
                    className="primary"
                    isDisabled={busy || uncertain}
                    onPress={() => {
                      void saveCrop();
                    }}
                  >
                    {busy ? "保存中…" : "设置头像"}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="avatar-upload-empty">
                <p>拖拽或粘贴图片</p>
                <p>或</p>
                <Button
                  variant="secondary"
                  className="secondary"
                  isDisabled={busy || uncertain}
                  onPress={() => picker.current?.click()}
                >
                  {busy ? "读取中…" : "选择本地图片"}
                </Button>
              </div>
            )}
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {uncertain && (
          <Button
            variant="secondary"
            className="secondary"
            isDisabled={busy}
            onPress={() => {
              const pending = request.current;
              if (pending) void save(pending.command);
            }}
          >
            重试原保存请求
          </Button>
        )}
      </div>
    </AnchoredPopover>
  );
}
