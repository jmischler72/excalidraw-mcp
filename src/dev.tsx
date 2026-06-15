/**
 * Dev entry point — renders ExcalidrawAppCore with a mock MCP App.
 *
 * Usage: pnpm dev:ui → opens browser with the widget + sample diagram.
 * Click fullscreen button to test the Excalidraw editor.
 *
 * Future: add a control panel to stream elements, test checkpoints, etc.
 */
import {createRoot} from "react-dom/client";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {ExcalidrawAppCore} from "./mcp-app";
import {createMockApp, type MockAppControls} from "./dev-mock";
import {recordContainer, type RecordHandle} from "./dev-record";
import "./global.css";

// Tail after the last element so the final draw-on finishes before we stop
// (longest CSS animation is 0.6s — see src/global.css).
const RECORD_TAIL_MS = 900;

// ── Sample elements (skeleton format with labels, same as LLM output) ────

// @prettier-ignore
// @oxc-ignore
const SAMPLE_ELEMENTS = [
  {
    type: "rectangle",
    id: "client",
    x: 60,
    y: 120,
    width: 180,
    height: 80,
    roundness: {type: 3},
    backgroundColor: "#a5d8ff",
    fillStyle: "solid",
    strokeColor: "#1e1e1e",
    label: {text: "Client App", fontSize: 20},
  },
  {
    type: "rectangle",
    id: "server",
    x: 400,
    y: 120,
    width: 180,
    height: 80,
    roundness: {type: 3},
    backgroundColor: "#b2f2bb",
    fillStyle: "solid",
    strokeColor: "#1e1e1e",
    label: {text: "MCP Server", fontSize: 20},
  },
  {
    type: "rectangle",
    id: "db",
    x: 400,
    y: 320,
    width: 180,
    height: 80,
    roundness: {type: 3},
    backgroundColor: "#d0bfff",
    fillStyle: "solid",
    strokeColor: "#1e1e1e",
    label: {text: "Database", fontSize: 20},
  },
  {
    type: "arrow",
    id: "a1",
    x: 240,
    y: 160,
    width: 160,
    height: 0,
    points: [
      [0, 0],
      [160, 0],
    ],
    strokeColor: "#1e1e1e",
    strokeWidth: 2,
    endArrowhead: "arrow",
    label: {text: "request", fontSize: 14},
  },
  {
    type: "arrow",
    id: "a2",
    x: 490,
    y: 200,
    width: 0,
    height: 120,
    points: [
      [0, 0],
      [0, 120],
    ],
    strokeColor: "#1e1e1e",
    strokeWidth: 2,
    endArrowhead: "arrow",
    label: {text: "query", fontSize: 14},
  },
];

// ── Dev control panel ────────────────────────────────────────────────────

const INTERVALS = [100, 300, 600] as const;

function parseElements(raw: string): any[] {
  const parsed = JSON.parse(raw.trim());
  // Accept both a raw array and { elements: "..." } wrapper
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed.elements === "string")
    return JSON.parse(parsed.elements);
  if (parsed && Array.isArray(parsed.elements)) return parsed.elements;
  throw new Error("Expected a JSON array of elements");
}

function DevControls({mock}: {mock: MockAppControls}) {
  const [open, setOpen] = useState(false);
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [elementCount, setElementCount] = useState<number | null>(null);
  const [interval, setInterval] = useState<100 | 300 | 600>(300);
  const [lastElements, setLastElements] = useState<any[] | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tryParse = useCallback((value: string) => {
    if (!value.trim()) {
      setError(null);
      setElementCount(null);
      return;
    }
    try {
      const els = parseElements(value);
      setError(null);
      setElementCount(els.length);
    } catch (e: any) {
      setError(e.message ?? "Invalid JSON");
      setElementCount(null);
    }
  }, []);

  const handleChange = useCallback(
    (value: string) => {
      setJson(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => tryParse(value), 300);
    },
    [tryParse],
  );

  const stream = useCallback(() => {
    try {
      const els = parseElements(json);
      setLastElements(els);
      setError(null);
      mock.streamElements(els, interval);
    } catch (e: any) {
      setError(e.message ?? "Invalid JSON");
    }
  }, [json, interval, mock]);

  const load = useCallback(() => {
    try {
      const els = parseElements(json);
      setLastElements(els);
      setError(null);
      mock.sendToolInput(els);
    } catch (e: any) {
      setError(e.message ?? "Invalid JSON");
    }
  }, [json, mock]);

  const replay = useCallback(() => {
    if (lastElements) mock.streamElements(lastElements, interval);
  }, [lastElements, interval, mock]);

  // ── Recording (canvas capture → .webm, no screen-share/ffmpeg) ──────────
  const [recording, setRecording] = useState(false);
  const [recordName, setRecordName] = useState("");
  const recorderRef = useRef<RecordHandle | null>(null);

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
  }, []);

  const record = useCallback(() => {
    let els: any[];
    try {
      els = parseElements(json);
      setLastElements(els);
      setError(null);
    } catch (e: any) {
      setError(e.message ?? "Invalid JSON");
      return;
    }
    const container = document.querySelector<HTMLElement>(
      ".excalidraw-container",
    );
    if (!container) {
      setError("No .excalidraw-container to record");
      return;
    }
    setRecording(true);
    // Clear any previously-rendered scene so the recording starts blank and
    // every element fades in fresh. renderSvgPreview([]) early-returns on empty
    // (leaving the old SVG), so wipe the rendered SVG directly. Then stream
    // only once the recorder is actually capturing (onReady).
    container.querySelector(".svg-wrapper svg")?.remove();
    recorderRef.current = recordContainer(container, {
      fps: 30,
      filename: recordName,
      onStop: () => setRecording(false),
      onReady: () => {
        mock.streamElements(els, interval, () => {
          setTimeout(stopRecording, RECORD_TAIL_MS);
        });
      },
    });
  }, [json, interval, mock, stopRecording, recordName]);

  return (
    <div
      style={{
        position: "fixed",
        bottom: 12,
        right: 12,
        zIndex: 10000,
        fontFamily: "system-ui",
        fontSize: 12,
        color: "#fff",
      }}
    >
      {/* Collapsible panel */}
      {open && (
        <div
          style={{
            marginBottom: 6,
            background: "rgba(0,0,0,0.88)",
            borderRadius: 8,
            padding: 10,
            width: 340,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <textarea
            value={json}
            onChange={(e) => handleChange(e.target.value)}
            placeholder='Paste Excalidraw elements JSON here&#10;[{"type":"rectangle","id":"r1",...},...]'
            rows={8}
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.2)",
              borderRadius: 5,
              color: "#fff",
              fontSize: 11,
              fontFamily: "monospace",
              padding: 6,
              resize: "vertical",
            }}
          />
          {error && <div style={{color: "#ff6b6b", fontSize: 11}}>{error}</div>}
          {elementCount !== null && !error && (
            <div style={{color: "#a3e635", fontSize: 11}}>
              {elementCount} element{elementCount !== 1 ? "s" : ""} ready
            </div>
          )}
          <div
            style={{
              display: "flex",
              gap: 6,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <button onClick={stream} style={btnStyle} disabled={!json.trim()}>
              ▶ Stream
            </button>
            {recording ? (
              <button
                onClick={stopRecording}
                style={{...btnStyle, color: "#ff6b6b"}}
              >
                ■ Stop
              </button>
            ) : (
              <button
                onClick={record}
                style={{...btnStyle, color: "#ff6b6b"}}
                disabled={!json.trim()}
              >
                ● Record
              </button>
            )}
            <button onClick={load} style={btnStyle} disabled={!json.trim()}>
              Load (instant)
            </button>
            <button
              onClick={() => {
                setJson("");
                setError(null);
                setElementCount(null);
              }}
              style={btnStyle}
            >
              Clear
            </button>
            <select
              value={interval}
              onChange={(e) =>
                setInterval(Number(e.target.value) as 100 | 300 | 600)
              }
              style={{
                background: "rgba(255,255,255,0.12)",
                border: "1px solid rgba(255,255,255,0.25)",
                borderRadius: 5,
                color: "#fff",
                padding: "3px 6px",
                fontSize: 12,
              }}
            >
              {INTERVALS.map((ms) => (
                <option key={ms} value={ms}>
                  {ms}ms / element
                </option>
              ))}
            </select>
          </div>
          <div style={{display: "flex", gap: 6, alignItems: "center"}}>
            <span style={{color: "rgba(255,255,255,0.45)", fontSize: 11}}>
              Recording name:
            </span>
            <input
              value={recordName}
              onChange={(e) => setRecordName(e.target.value)}
              placeholder="excalidraw"
              disabled={recording}
              style={{
                flex: 1,
                background: "rgba(255,255,255,0.08)",
                border: "1px solid rgba(255,255,255,0.2)",
                borderRadius: 5,
                color: "#fff",
                fontSize: 11,
                padding: "4px 6px",
              }}
            />
            <span style={{color: "rgba(255,255,255,0.35)", fontSize: 11}}>
              .webm
            </span>
          </div>
          <div
            style={{
              borderTop: "1px solid rgba(255,255,255,0.1)",
              paddingTop: 6,
              display: "flex",
              gap: 6,
              alignItems: "center",
            }}
          >
            <span style={{color: "rgba(255,255,255,0.45)", fontSize: 11}}>
              Sample:
            </span>
            <button
              onClick={() => mock.streamElements(SAMPLE_ELEMENTS, interval)}
              style={btnStyle}
            >
              Stream sample
            </button>
            <button
              onClick={() => mock.sendToolInput(SAMPLE_ELEMENTS)}
              style={btnStyle}
            >
              Load sample
            </button>
          </div>
        </div>
      )}
      {/* Bottom bar */}
      <div
        style={{
          display: "flex",
          gap: 6,
          padding: "8px 10px",
          background: "rgba(0,0,0,0.75)",
          borderRadius: 8,
        }}
      >
        <button onClick={() => setOpen((o) => !o)} style={btnStyle}>
          {open ? "▼ Close" : "▲ Paste JSON"}
        </button>
        {lastElements && (
          <button onClick={replay} style={{...btnStyle, color: "#a3e635"}}>
            ↺ Replay
          </button>
        )}
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.15)",
  border: "1px solid rgba(255,255,255,0.25)",
  borderRadius: 5,
  padding: "4px 10px",
  color: "#fff",
  cursor: "pointer",
  fontSize: 12,
};

// ── App ──────────────────────────────────────────────────────────────────

function DevApp() {
  const mock = useMemo(() => createMockApp(), []);
  const initialized = useRef(false);

  // Wait one frame for ExcalidrawAppCore's useEffect to attach handlers,
  // then fire initial tool input with sample data.
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    // Use requestAnimationFrame to ensure handlers are attached
    requestAnimationFrame(() => {
      mock.sendToolInput(SAMPLE_ELEMENTS);
      mock.sendToolResult("dev-checkpoint");
    });
  }, [mock]);

  return (
    <>
      <ExcalidrawAppCore app={mock.app} />
      <DevControls mock={mock} />
    </>
  );
}

createRoot(document.body).render(<DevApp />);
