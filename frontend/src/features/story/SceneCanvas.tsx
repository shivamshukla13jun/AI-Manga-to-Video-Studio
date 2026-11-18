import { useCallback, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { BBox, ComicImage, DetectedScene } from '@/lib/types';

const SCENE_COLORS = ['#4f8ff7', '#f7954f', '#4fc46e', '#c05df2', '#f2c14e', '#e5534b', '#3bc2b9', '#9d7bff'];

/** Normalized rect -> percentage style */
const rectStyle = (b: BBox) => ({ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.width * 100}%`, height: `${b.height * 100}%` });

type Drag =
  | { kind: 'move' | 'resize'; sceneId: string; regionIndex: number; startX: number; startY: number; orig: BBox }
  | { kind: 'draw'; imageId: string; startX: number; startY: number; curX: number; curY: number };

/**
 * One page of the chapter: the (usually tall) image plus overlays for every
 * scene region that lives on it. Regions of the selected scene are editable —
 * drag to move, corner handle to resize. In draw mode, dragging creates a new
 * bounding box passed to `onDraw`.
 */
export const SceneCanvas = ({
  image,
  scenes,
  selectedId,
  editing,
  drawMode,
  onSelect,
  onChangeRegion,
  onDraw,
}: {
  image: ComicImage;
  scenes: DetectedScene[];
  selectedId?: string;
  editing: boolean;
  drawMode: boolean;
  onSelect: (sceneId: string) => void;
  onChangeRegion: (sceneId: string, regionIndex: number, bbox: BBox) => void;
  onDraw: (imageId: string, bbox: BBox) => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [preview, setPreview] = useState<{ sceneId: string; regionIndex: number; bbox: BBox } | null>(null);

  const toNorm = useCallback((clientX: number, clientY: number) => {
    const r = ref.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (clientY - r.top) / r.height)),
    };
  }, []);

  const regions = scenes.flatMap((s, si) =>
    s.regions.map((r, ri) => ({ scene: s, sceneIndex: si, region: r, regionIndex: ri })).filter((x) => x.region.image === image.id)
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (!drawMode) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toNorm(e.clientX, e.clientY);
    setDrag({ kind: 'draw', imageId: image.id, startX: p.x, startY: p.y, curX: p.x, curY: p.y });
  };

  const startDrag = (e: React.PointerEvent, kind: 'move' | 'resize', sceneId: string, regionIndex: number, bbox: BBox) => {
    if (!editing) return;
    e.stopPropagation();
    e.preventDefault();
    const p = toNorm(e.clientX, e.clientY);
    setDrag({ kind, sceneId, regionIndex, startX: p.x, startY: p.y, orig: { ...bbox } });
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = toNorm(e.clientX, e.clientY);
    if (drag.kind === 'draw') {
      setDrag({ ...drag, curX: p.x, curY: p.y });
      return;
    }
    const dx = p.x - drag.startX;
    const dy = p.y - drag.startY;
    let b = { ...drag.orig };
    if (drag.kind === 'move') {
      b.x = Math.min(1 - b.width, Math.max(0, b.x + dx));
      b.y = Math.min(1 - b.height, Math.max(0, b.y + dy));
    } else {
      b.width = Math.min(1 - b.x, Math.max(0.01, b.width + dx));
      b.height = Math.min(1 - b.y, Math.max(0.01, b.height + dy));
    }
    setPreview({ sceneId: drag.sceneId, regionIndex: drag.regionIndex, bbox: b });
  };

  const onPointerUp = () => {
    if (!drag) return;
    if (drag.kind === 'draw') {
      const x = Math.min(drag.startX, drag.curX);
      const y = Math.min(drag.startY, drag.curY);
      const w = Math.abs(drag.curX - drag.startX);
      const h = Math.abs(drag.curY - drag.startY);
      if (w > 0.01 && h > 0.01) onDraw(drag.imageId, { x, y, width: w, height: h });
    } else if (preview) {
      onChangeRegion(preview.sceneId, preview.regionIndex, preview.bbox);
    }
    setDrag(null);
    setPreview(null);
  };

  return (
    <div
      ref={ref}
      className={cn('relative select-none overflow-hidden rounded border border-line bg-panel-2', drawMode && 'cursor-crosshair')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {image.url || image.thumbnailUrl ? (
        <img src={image.url || image.thumbnailUrl || ''} alt={`page ${image.index + 1}`} className="block w-full" draggable={false} />
      ) : (
        <div className="flex h-48 items-center justify-center text-xs text-danger">broken page</div>
      )}
      <div className="absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">p.{image.index + 1}</div>

      {regions.map(({ scene, sceneIndex, region, regionIndex }) => {
        const sel = scene.id === selectedId;
        const color = SCENE_COLORS[sceneIndex % SCENE_COLORS.length];
        const bbox = preview && preview.sceneId === scene.id && preview.regionIndex === regionIndex ? preview.bbox : region.bbox;
        return (
          <div
            key={`${scene.id}-${regionIndex}`}
            className={cn('absolute border-2 transition-colors', sel ? 'z-10' : 'opacity-70 hover:opacity-100', editing && sel && 'cursor-move')}
            style={{
              ...rectStyle(bbox),
              borderColor: sel ? color : `${color}99`,
              background: sel ? `${color}26` : `${color}14`,
            }}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(scene.id);
            }}
            onPointerDown={(e) => sel && startDrag(e, 'move', scene.id, regionIndex, region.bbox)}
          >
            <span
              className="absolute -top-5 left-0 rounded-sm px-1 text-[10px] font-medium text-black"
              style={{ background: color }}
            >
              {scene.order}
            </span>
            {sel && editing && (
              <div
                className="absolute -bottom-1.5 -right-1.5 size-3 cursor-nwse-resize rounded-sm border border-black"
                style={{ background: color }}
                onPointerDown={(e) => startDrag(e, 'resize', scene.id, regionIndex, region.bbox)}
              />
            )}
          </div>
        );
      })}

      {drag?.kind === 'draw' && drag.imageId === image.id && (
        <div
          className="absolute border-2 border-dashed border-accent bg-accent/15"
          style={{
            left: `${Math.min(drag.startX, drag.curX) * 100}%`,
            top: `${Math.min(drag.startY, drag.curY) * 100}%`,
            width: `${Math.abs(drag.curX - drag.startX) * 100}%`,
            height: `${Math.abs(drag.curY - drag.startY) * 100}%`,
          }}
        />
      )}
    </div>
  );
};
