import { useEffect, useState } from "react";
import {
  avatarContentSchema,
  defaultAvatar,
  isDefaultAvatar,
  type AvatarStyle,
} from "../../../shared/avatar.js";
import { desktop, errorMessage } from "../../lib/client.js";

export const shapeLabels: Record<AvatarStyle["shape"], string> = {
  blob: "团块",
  pebble: "卵石",
  square: "圆角方形",
  pill: "药片",
  wedge: "楔形",
  hexagon: "六边形",
  cloud: "云朵",
  drop: "水滴",
};
export const colorLabels: Record<AvatarStyle["color"], string> = {
  black: "黑色",
  brown: "棕色",
  red: "红色",
  orange: "橙色",
  yellow: "黄色",
  green: "绿色",
  cyan: "青色",
  blue: "蓝色",
  violet: "紫罗兰色",
  magenta: "品红色",
  gray: "灰色",
};
export const avatarPaint: Record<AvatarStyle["color"], string> = {
  black: "var(--avatar-black)",
  brown: "var(--color-amber-700)",
  red: "var(--color-red-500)",
  orange: "var(--color-orange-500)",
  yellow: "var(--color-amber-400)",
  green: "var(--color-emerald-500)",
  cyan: "var(--color-teal-500)",
  blue: "var(--color-blue-500)",
  violet: "var(--color-violet-500)",
  magenta: "var(--color-pink-500)",
  gray: "var(--color-zinc-500)",
};
// Independently drawn silhouettes from the observed eight character shapes.
const silhouettes: Record<AvatarStyle["shape"], string> = {
  blob: "M32 2C47 0 62 16 61 31C65 47 50 61 34 62C17 65 0 51 2 34C-1 17 15 1 32 2Z",
  pebble:
    "M19 7C34-1 48 7 57 20C70 40 58 60 38 61C19 63 2 55 2 38C0 23 7 13 19 7Z",
  square: "M14 5H50Q59 5 59 15V49Q59 59 49 59H14Q5 59 5 49V15Q5 5 14 5Z",
  pill: "M19 12H45C66 12 68 51 45 52H19C-4 51-2 12 19 12Z",
  wedge: "M25 7Q32-3 39 7L61 49Q65 60 53 61H11Q-1 60 3 49Z",
  hexagon:
    "M29 2Q32 0 35 2L57 15Q61 17 61 22V43Q61 47 57 49L35 62Q32 64 29 62L7 49Q3 47 3 43V22Q3 17 7 15Z",
  cloud:
    "M14 53C-4 53-2 30 9 26C7 8 28 1 38 13C53 4 63 19 58 30C72 43 56 61 43 53C35 62 20 62 14 53Z",
  drop: "M32 1C38 12 62 30 61 43C59 68 6 68 3 44C1 30 24 11 32 1Z",
};
export function Avatar({
  small = false,
  name = "Bot",
  appearance = defaultAvatar,
  botId,
}: {
  small?: boolean;
  name?: string;
  appearance?: AvatarStyle;
  botId?: string;
}) {
  const [loaded, setLoaded] = useState<{ hash: string; data: string } | null>(
      null,
    ),
    [failure, setFailure] = useState<{ hash: string; message: string } | null>(
      null,
    );
  const hash = appearance.imageHash;
  const error = hash && failure?.hash === hash ? failure.message : "";
  useEffect(() => {
    let disposed = false;
    if (hash && botId)
      void desktop
        .avatarContent({ botId, hash })
        .then((raw) => {
          const value = avatarContentSchema.parse(raw);
          if (value.hash !== hash || value.botId !== botId)
            throw Error("头像返回的身份或版本不匹配。");
          if (!disposed) {
            setLoaded({ hash: value.hash, data: value.data });
            setFailure(null);
          }
        })
        .catch((e) => {
          if (!disposed) setFailure({ hash, message: errorMessage(e) });
        });
    return () => {
      disposed = true;
    };
  }, [hash, botId]);
  const src =
    hash && loaded?.hash === hash
      ? `data:image/webp;base64,${loaded.data}`
      : isDefaultAvatar(appearance)
        ? "./assets/aster-avatar.png"
        : null;
  return (
    <span
      className={`avatar ${small ? "small" : ""} ${src || hash ? "image-avatar" : ""}`}
      aria-hidden="true"
      title={error ? `${name}：${error}` : name}
      data-avatar-shape={appearance.shape}
      data-avatar-color={appearance.color}
      data-avatar-hash={hash ?? undefined}
    >
      {src ? (
        <img src={src} alt="" />
      ) : (
        <svg viewBox="0 0 64 64" width="100%" height="100%">
          <path
            d={silhouettes[appearance.shape]}
            fill={avatarPaint[appearance.color]}
          />
          <g
            fill={
              appearance.color === "black"
                ? "var(--avatar-eyes)"
                : "var(--white)"
            }
            transform="rotate(-16 32 27)"
          >
            <rect x="24" y="21" width="5" height="12" rx="2.5" />
            <rect x="43" y="22" width="5" height="11" rx="2.5" />
          </g>
        </svg>
      )}
      {hash && !src && (
        <span className="avatar-load-state">{error ? "!" : "…"}</span>
      )}
    </span>
  );
}
