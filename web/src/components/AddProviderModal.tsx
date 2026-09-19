import { useEffect, useState } from "react";
import { api, type ProviderDefinition, type ProviderFieldDef } from "../api/client.js";
import ProviderCatalogGrid from "./ProviderCatalogGrid.js";
import DynamicProviderForm, { type FieldValues } from "./DynamicProviderForm.js";

function defaultValuesFor(fields: ProviderFieldDef[]): FieldValues {
  const values: FieldValues = {};
  for (const field of fields) {
    if (field.default !== undefined) values[field.key] = field.default;
  }
  return values;
}

interface AddProviderModalProps {
  onClose: () => void;
  onAdded: () => void;
}

type Step = "catalog" | "app-config" | "account";

export default function AddProviderModal({ onClose, onAdded }: AddProviderModalProps) {
  const [catalog, setCatalog] = useState<ProviderDefinition[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("catalog");
  const [selected, setSelected] = useState<ProviderDefinition | null>(null);
  const [appConfigured, setAppConfigured] = useState(false);
  const [appValues, setAppValues] = useState<FieldValues>({});
  const [accountValues, setAccountValues] = useState<FieldValues>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.providers
      .catalog()
      .then(setCatalog)
      .catch((err) => setCatalogError(err instanceof Error ? err.message : "Failed to load catalog"));
  }, []);

  async function handleSelect(def: ProviderDefinition): Promise<void> {
    setSelected(def);
    // Pre-populate defaults into real state, not just the input's displayed
    // placeholder — otherwise a field the user never touches (e.g.
    // OneDrive's Tenant ID, which defaults to "common") looks filled in
    // but is silently absent from what actually gets submitted.
    setAppValues(defaultValuesFor(def.appLevelFields));
    setAccountValues(defaultValuesFor(def.accountLevelFields));
    setError(null);

    if (def.requiresOAuthConnect) {
      const { configured } = await api.providers.getAppConfigStatus(def.providerName);
      setAppConfigured(configured);
      setStep(configured ? "account" : "app-config");
    } else {
      setStep("account");
    }
  }

  async function handleSaveAppConfig(): Promise<void> {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.providers.saveAppConfig(selected.providerName, appValues);
      setAppConfigured(true);
      setStep("account");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save app credentials");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConnectOrCreate(): Promise<void> {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      if (selected.requiresOAuthConnect) {
        const result = await api.providers.connect(selected.providerName, accountValues);
        if (result.consentUrl) {
          // Full-page navigate to Google's consent screen. It redirects
          // back to this server's own callback route (see providers.ts),
          // which then redirects the browser on to the dashboard — so
          // this tab leaves the SPA and comes back on its own; there's
          // nothing further to do here.
          window.location.href = result.consentUrl;
          return;
        }
      } else {
        await api.providers.createAccount(selected.providerName, accountValues);
      }
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add account");
    } finally {
      setSubmitting(false);
    }
  }

  const title =
    step === "catalog"
      ? "Add a provider"
      : step === "app-config"
        ? `Connect ${selected?.displayName} — app credentials`
        : `Connect ${selected?.displayName}`;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center px-4 z-50">
      <div className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-lg border border-base-border bg-base-panel p-5">
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-display text-base">{title}</h3>
          <button onClick={onClose} className="text-ink-faint hover:text-ink-primary text-sm">
            Close
          </button>
        </div>

        {step === "catalog" && (
          <>
            <p className="text-xs text-ink-secondary mb-4">
              Pick a provider to connect. Free-tier size and setup steps are shown on each tile.
            </p>
            {catalogError && <p className="text-xs text-signal-fail mb-3">{catalogError}</p>}
            <ProviderCatalogGrid catalog={catalog} onSelect={handleSelect} />
          </>
        )}

        {step === "app-config" && selected && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-ink-secondary">
              {selected.displayName} needs a developer-console app registered once — every account you
              connect afterward reuses this, including future accounts of the same provider.
            </p>
            <DynamicProviderForm fields={selected.appLevelFields} values={appValues} onChange={(k, v) => setAppValues((s) => ({ ...s, [k]: v }))} />
            {error && <p className="text-xs text-signal-fail">{error}</p>}
            <div className="flex justify-between items-center mt-2">
              <button onClick={() => setStep("catalog")} className="text-xs text-ink-secondary hover:text-ink-primary">
                ← Back
              </button>
              <button
                onClick={handleSaveAppConfig}
                disabled={submitting}
                className="text-sm rounded-md bg-signal-active px-3 py-1.5 text-white hover:brightness-110 transition disabled:opacity-50"
              >
                {submitting ? "Saving…" : "Save app credentials"}
              </button>
            </div>
          </div>
        )}

        {step === "account" && selected && (
          <div className="flex flex-col gap-3">
            {selected.isBilledProvider && (
              <div className="rounded-md border border-signal-warn/40 bg-signal-warn/10 px-3 py-2 text-xs text-signal-warn">
                This provider charges for storage — OmniDisk will route data here only once you
                enable it explicitly. New accounts are added disabled.
              </div>
            )}

            {selected.requiresOAuthConnect && appConfigured && (
              <p className="text-xs text-ink-faint">Using the app credentials already saved for {selected.displayName}.</p>
            )}

            <DynamicProviderForm
              fields={selected.accountLevelFields}
              values={accountValues}
              onChange={(k, v) => setAccountValues((s) => ({ ...s, [k]: v }))}
            />

            {error && <p className="text-xs text-signal-fail">{error}</p>}

            <div className="flex justify-between items-center mt-2">
              <button onClick={() => setStep("catalog")} className="text-xs text-ink-secondary hover:text-ink-primary">
                ← Back
              </button>
              <button
                onClick={handleConnectOrCreate}
                disabled={submitting}
                className="text-sm rounded-md bg-signal-active px-3 py-1.5 text-white hover:brightness-110 transition disabled:opacity-50"
              >
                {submitting
                  ? "Working…"
                  : selected.requiresOAuthConnect
                    ? `Connect with ${selected.displayName}`
                    : "Add account"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
