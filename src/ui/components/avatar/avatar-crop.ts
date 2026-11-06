export interface Crop {
  x: number;
  y: number;
  zoom: number;
}
export interface ImageDimensions {
  width: number;
  height: number;
}
export function clampCrop(image: ImageDimensions, crop: Crop): Crop {
  const zoom = Math.max(1, Math.min(5, crop.zoom));
  const half = Math.min(image.width, image.height) / zoom / 2;
  return {
    zoom,
    x: Math.max(half, Math.min(image.width - half, crop.x)),
    y: Math.max(half, Math.min(image.height - half, crop.y)),
  };
}
export function cropRectangle(image: ImageDimensions, crop: Crop) {
  const bounded = clampCrop(image, crop),
    side = Math.min(image.width, image.height) / bounded.zoom;
  return { x: bounded.x - side / 2, y: bounded.y - side / 2, side };
}
