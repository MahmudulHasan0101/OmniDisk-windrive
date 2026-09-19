import type { ProviderDefinition } from "../api/client.js";

interface ProviderCatalogGridProps {
  catalog: ProviderDefinition[];
  onSelect: (def: ProviderDefinition) => void;
}

/** Two letters as a placeholder mark until real provider logos are added under /public/logos. */
function initials(displayName: string): string {
  return displayName
    .split(" ")
    .filter((w) => /[a-zA-Z]/.test(w[0] ?? ""))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export default function ProviderCatalogGrid({ catalog, onSelect }: ProviderCatalogGridProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {catalog.map((def) => (
        <button
          key={def.providerName}
          onClick={() => onSelect(def)}
          className="text-left rounded-lg border border-base-border bg-base-panel p-4 hover:border-ink-faint transition-colors flex flex-col gap-3"
        >
          <div className="flex items-start gap-2.5 min-w-0">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-base-panelRaised text-xs font-display text-ink-secondary">
              {initials(def.displayName)}
            </span>
            <div className="min-w-0">
              <p className="text-sm text-ink-primary leading-snug break-words">{def.displayName}</p>
              <p className="text-xs text-ink-faint mt-0.5">
                {def.authType === "oauth2" ? "OAuth sign-in" : def.authType === "basic" ? "Account login" : "API key"}
              </p>
            </div>
          </div>

          <div className="flex flex-col items-start gap-1.5">
            <span
              className={`text-xs rounded px-1.5 py-0.5 leading-snug break-words ${
                def.isBilledProvider
                  ? "bg-signal-warn/15 text-signal-warn"
                  : "bg-signal-stored/15 text-signal-stored"
              }`}
            >
              {def.isBilledProvider ? "Billed" : def.freeTierLabel}
            </span>
            <a
              href={`/docs/provider-setup-guide.md${def.setupGuideAnchor}`}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-xs text-signal-active hover:underline"
            >
              Setup guide
            </a>
          </div>
        </button>
      ))}
    </div>
  );
}
