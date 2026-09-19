import { NavLink, Routes, Route } from "react-router-dom";
import Home from "./pages/Home.js";
import FileExplorer from "./pages/FileExplorer.js";
import Settings from "./pages/Settings.js";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/files", label: "File Explorer", end: false },
  { to: "/settings", label: "Settings", end: false },
];

export default function App() {
  return (
    <div className="flex min-h-screen">
      <aside className="w-56 shrink-0 border-r border-base-border bg-base-panel px-4 py-6 flex flex-col">
        <div className="px-2 mb-8">
          <div className="flex items-center gap-2">
            <NodeMark />
            <span className="font-display text-lg tracking-tight">OmniDisk</span>
          </div>
          <p className="text-xs text-ink-faint mt-1 px-0.5">Block-addressed storage router</p>
        </div>

        <nav className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? "bg-base-panelRaised text-ink-primary"
                    : "text-ink-secondary hover:text-ink-primary hover:bg-base-panelRaised/60"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto px-2 text-xs text-ink-faint">
          <p>v0.1.0 &middot; Phase 0 skeleton</p>
        </div>
      </aside>

      <main className="flex-1 min-w-0">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/files" element={<FileExplorer />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}

function NodeMark() {
  // Three small fragments converging into one — the product's core idea,
  // used as a compact wordmark glyph rather than a generic logo shape.
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="7" height="7" rx="1.5" fill="#5B8DEF" />
      <rect x="1" y="14" width="7" height="7" rx="1.5" fill="#3FBF83" />
      <rect x="14" y="7.5" width="7" height="7" rx="1.5" fill="#E8A33D" />
      <path d="M8 4.5H11C12.1046 4.5 13 5.39543 13 6.5V10" stroke="#565D6B" strokeWidth="1.2" />
      <path d="M8 17.5H11C12.1046 17.5 13 16.6046 13 15.5V12" stroke="#565D6B" strokeWidth="1.2" />
    </svg>
  );
}
