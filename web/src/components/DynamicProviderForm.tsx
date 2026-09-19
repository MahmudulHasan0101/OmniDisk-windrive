import type { ProviderFieldDef } from "../api/client.js";

export type FieldValues = Record<string, string | number | boolean>;

interface DynamicProviderFormProps {
  fields: ProviderFieldDef[];
  values: FieldValues;
  onChange: (key: string, value: string | number) => void;
}

/**
 * Renders appLevelFields / accountLevelFields straight from the provider
 * catalog — this is the piece that makes 14 (and counting) provider forms
 * a single component instead of 14 hand-written ones. See
 * OmniDisk_Provider_Registry_UI_Spec.md §2.
 */
export default function DynamicProviderForm({ fields, values, onChange }: DynamicProviderFormProps) {
  if (fields.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {fields.map((field) => (
        <div key={field.key}>
          <label className="text-xs text-ink-secondary block mb-1" htmlFor={`field-${field.key}`}>
            {field.label}
            {field.required && <span className="text-signal-fail ml-0.5">*</span>}
          </label>

          {field.type === "select" ? (
            <select
              id={`field-${field.key}`}
              value={String(values[field.key] ?? field.default ?? "")}
              onChange={(e) => onChange(field.key, e.target.value)}
              className="w-full text-sm bg-base-panelRaised border border-base-border rounded-md px-2 py-1.5 text-ink-primary"
            >
              <option value="" disabled>
                Select…
              </option>
              {field.options?.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={`field-${field.key}`}
              type={
                field.type === "password"
                  ? "password"
                  : field.type === "number"
                    ? "number"
                    : field.type === "url"
                      ? "url"
                      : "text"
              }
              value={String(values[field.key] ?? field.default ?? "")}
              onChange={(e) =>
                onChange(field.key, field.type === "number" ? Number(e.target.value) : e.target.value)
              }
              placeholder={field.placeholder}
              autoComplete={field.secret ? "off" : undefined}
              className="w-full text-sm bg-base-panelRaised border border-base-border rounded-md px-2 py-1.5 text-ink-primary placeholder:text-ink-faint"
            />
          )}

          {field.helpText && <p className="text-xs text-ink-faint mt-1">{field.helpText}</p>}
        </div>
      ))}
    </div>
  );
}
