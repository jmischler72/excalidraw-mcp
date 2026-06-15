/**
 * Dev-only: record the streaming Excalidraw animation to a .webm video.
 *
 * Approach (no screen-share, no ffmpeg):
 *   - Rasterize the live `.excalidraw-container` SVG to an offscreen <canvas>
 *     once per animation frame.
 *   - `canvas.captureStream(fps)` → `MediaRecorder` → `.webm` download.
 *
 * Why we bake animation state ourselves:
 *   The on-screen fade-in / stroke draw-on are CSS animations (see
 *   src/global.css `@keyframes svgFadeIn` / `strokeDraw`). When an SVG with
 *   `animation:` rules is serialized and drawn as an <img>, the browser
 *   RESTARTS those animations at t=0 — the live clock isn't inherited. So for
 *   each frame we clone the SVG, compute each element's progress from when it
 *   first appeared, and write the eased value into inline attributes
 *   (opacity / stroke-dashoffset), then disable CSS animation in the clone.
 *
 * IMPORTANT: the durations/easing below mirror src/global.css. If those
 * @keyframes change, update FADE_MS / DRAW_MS / the easing here to match.
 */
import {captureAudioStream, stopAudioCapture} from "./pencil-audio";

// Mirror of src/global.css animation timings, but intentionally slower for
// recording — the on-screen animations feel longer because elements reveal
// progressively; the baked recording needs more time per element to match.
const FADE_MS = 1000; // svgFadeIn (CSS: 0.5s)
const DRAW_MS = 1500; // strokeDraw (CSS: 0.6s)
const DASH = 1000; // strokeDraw stroke-dasharray / initial offset

// Excalidraw's exported SVG wraps each element in a top-level <g>. We fade
// those groups (one opacity per element — no compounding) and draw-on the
// stroke descendants. Matches the CSS selectors in src/global.css.
const STROKE_SEL = "path, line, polyline, polygon";

// ease-out (cubic) — visually matches CSS `ease-out`.
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

export interface RecordHandle {
  /** Stop recording, finalize the webm, and trigger the download. */
  stop(): void;
}

/**
 * Inline the Excalifont woff2 as a base64 data URL so text renders correctly
 * when the SVG is drawn as an <img> (external font URLs don't load in that
 * context, and document.fonts isn't available to the image). Cached.
 */
let fontStylePromise: Promise<string> | null = null;
function getInlineFontStyle(): Promise<string> {
  if (fontStylePromise) return fontStylePromise;
  const fontUrl =
    "https://esm.sh/@excalidraw/excalidraw@0.18.0/dist/prod/fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2";
  fontStylePromise = fetch(fontUrl)
    .then((r) => r.blob())
    .then(
      (blob) =>
        new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(blob);
        }),
    )
    .then(
      (dataUrl) =>
        `@font-face{font-family:"Excalifont";src:url(${dataUrl}) format("woff2");}`,
    )
    .catch(() => ""); // fall back to default font if the fetch fails
  return fontStylePromise;
}

function triggerDownload(blob: Blob, name: string) {
  // Sanitize to a safe filename; fall back to a timestamp.
  const safe =
    name.trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") ||
    `excalidraw-${Date.now()}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safe}.webm`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Start recording the SVG inside `container`. Call the returned `stop()` when
 * the animation finishes.
 */
export function recordContainer(
  container: HTMLElement,
  opts: {
    fps?: number;
    filename?: string;
    onStop?: () => void;
    onReady?: () => void;
  } = {},
): RecordHandle {
  const fps = opts.fps ?? 30;
  const rect = container.getBoundingClientRect();
  // Render at the screen's pixel density (crisp strokes/text on retina),
  // capped so a huge container doesn't make per-frame SVG decode too slow.
  const MAX_W = 2560;
  const dpr = window.devicePixelRatio || 1;
  const target = Math.min(rect.width * dpr, MAX_W);
  const scale = target / rect.width;
  // libvpx is happiest with even dimensions.
  const w = Math.max(2, Math.round((rect.width * scale) / 2) * 2);
  const h = Math.max(2, Math.round((rect.height * scale) / 2) * 2);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  // Smooth downscaling of the rasterized SVG.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // Paint one frame up-front so the stream has content before recording.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);

  const stream = canvas.captureStream(fps);

  // Capture the pencil-stroke audio into the recording too.
  const audioTrack = captureAudioStream();
  if (audioTrack) stream.addTrack(audioTrack);

  const mimeType = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mimeType) throw new Error("No supported video/webm codec");
  // High bitrate so the hand-drawn strokes don't turn to compression mush.
  // Scale roughly with pixel count (~0.2 bits/px/frame), clamped to a sane
  // ceiling, plus a small audio allowance.
  const videoBitsPerSecond = Math.min(
    24_000_000,
    Math.round(w * h * fps * 0.2),
  );
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond,
    audioBitsPerSecond: 128_000,
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = () => {
    stopAudioCapture();
    stream.getTracks().forEach((t) => t.stop());
    const bytes = chunks.reduce((n, c) => n + c.size, 0);
    console.log("[record] stop —", chunks.length, "chunks,", bytes, "bytes");
    if (bytes > 0)
      triggerDownload(new Blob(chunks, {type: mimeType}), opts.filename ?? "");
    opts.onStop?.();
  };

  // First-appearance timestamps, keyed by an ORIGIN-INVARIANT per-element
  // signature.
  //
  // Index keying fails: each Excalidraw element emits MULTIPLE top-level <g>
  // (shape group + its bound-text group) plus masks/defs, so index N is not a
  // stable element identity.
  //
  // Transform keying fails too: exportToSvg lays the scene out as
  // `SVG_x = scene_x - sceneMinX + padding` (computeSceneBounds in
  // mcp-app.tsx), so the translate() shifts for ALL elements when the scene
  // min bound grows — that resets every appear-time at once (the flash).
  //
  // Element identity by APPEARANCE ORDER, not content/position.
  //
  // Every content-based key we tried is unstable: path `d` re-randomizes each
  // render (rough.js seed, mcp-app.tsx:515); rotate() center collides for
  // same-size elements; absolute translate() shifts for everyone when the scene
  // grows (the flash); origin-relative position jumps when a new leftmost
  // element appears.
  //
  // What IS stable: Excalidraw APPENDS new element groups (morphdom keeps the
  // existing prefix, adds at the end), so the Nth real element group is always
  // the same element. We track appear-time per ordinal N. New trailing groups
  // get a fresh timestamp; existing ones keep theirs — no flash, no re-fade.
  //
  // "Real element group" = a top-level <g>. Shapes/text carry a
  // translate+rotate transform; ARROWS render as a transform-less <g> (with a
  // <mask> sibling) — so we must NOT require a transform or arrows get dropped
  // (no fade/draw-on). The non-element siblings in the structure dump
  // (metadata, defs, mask) are not <g>, so `:scope > g` already excludes them.
  const appeared: number[] = [];

  let fontStyle = "";
  let running = true;
  let drawing = false;
  let framesDrawn = 0;

  const serializer = new XMLSerializer();

  const renderFrame = async () => {
    if (!running) return;
    const liveSvg = container.querySelector("svg");
    if (!liveSvg) {
      requestAnimationFrame(renderFrame);
      return;
    }
    if (drawing) {
      requestAnimationFrame(renderFrame);
      return;
    }
    drawing = true;
    const now = performance.now();

    const clone = liveSvg.cloneNode(true) as SVGSVGElement;

    // DEBUG: one-time dump of top-level child structure.
    if (!(window as any).__recDumped) {
      (window as any).__recDumped = true;
      const kids = Array.from(liveSvg.children).map(
        (c) =>
          `${c.tagName}.${c.getAttribute("class") ?? ""}[${c.childElementCount}] t=${c.getAttribute("transform") ?? "-"}`,
      );
      console.log("[record] top-level children:\n" + kids.join("\n"));
    }

    // Top-level <g>, in append order — one per element (shapes, text, arrows).
    const els = clone.querySelectorAll<SVGElement>(":scope > g");

    els.forEach((el, idx) => {
      // Nth element keeps its appear-time; only new trailing ordinals get a
      // fresh stamp (Excalidraw appends, so existing ordinals are stable).
      if (appeared[idx] == null) appeared[idx] = now;
      const t0 = appeared[idx];
      const fade = easeOut(clamp01((now - t0) / FADE_MS));
      el.style.opacity = String(fade);

      // Stroke draw-on for any stroke geometry in this element's group.
      const draw = easeOut(clamp01((now - t0) / DRAW_MS));
      el.querySelectorAll<SVGElement>(STROKE_SEL).forEach((s) => {
        s.style.strokeDasharray = String(DASH);
        s.style.strokeDashoffset = String(DASH * (1 - draw));
      });
    });

    // Kill CSS animations in the clone + inline the font.
    const style = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "style",
    );
    style.textContent = `*{animation:none!important;transition:none!important;}${fontStyle}`;
    clone.insertBefore(style, clone.firstChild);

    // Ensure the rasterized image has explicit pixel dims.
    clone.setAttribute("width", String(w));
    clone.setAttribute("height", String(h));

    const svgText = serializer.serializeToString(clone);
    const svgUrl =
      "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgText);

    // Decode via <img> — most reliable cross-browser SVG rasterization
    // (createImageBitmap on an SVG blob is flaky and can yield a 0×0 image).
    try {
      await new Promise<void>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          ctx.clearRect(0, 0, w, h);
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          resolve();
        };
        img.onerror = () => reject(new Error("SVG image decode failed"));
        img.src = svgUrl;
      });
      framesDrawn++;
    } catch (e) {
      console.warn("[record] frame skipped:", e);
    }

    drawing = false;
    if (running) requestAnimationFrame(renderFrame);
  };

  // Apply the inlined font as soon as it resolves (frames before then just
  // render text in a fallback font). Capturing starts immediately below so we
  // don't miss the first streamed elements while the font fetch is in flight.
  getInlineFontStyle().then((style) => {
    fontStyle = style;
  });

  recorder.start(200); // timeslice → periodic dataavailable chunks
  console.log(
    "[record] started",
    mimeType,
    `${w}x${h}`,
    `${Math.round(videoBitsPerSecond / 1e6)}Mbps`,
  );
  requestAnimationFrame(renderFrame);
  opts.onReady?.();

  return {
    stop() {
      if (!running) return;
      running = false;
      console.log("[record] frames drawn:", framesDrawn);
      // Give the recorder a beat to capture the last drawn frame, then stop.
      setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, 100);
    },
  };
}
