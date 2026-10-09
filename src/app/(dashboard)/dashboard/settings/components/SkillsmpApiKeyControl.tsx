"use client";

interface SkillsmpApiKeyControlProps {
  value: string;
  configured: boolean;
  saving: boolean;
  label: string;
  configuredLabel: string;
  saveLabel: string;
  clearLabel: string;
  placeholder: string;
  onChange: (value: string) => void;
  onSave: (value: string) => void;
  onClear: () => void;
}

export function SkillsmpApiKeyControl({
  value,
  configured,
  saving,
  label,
  configuredLabel,
  saveLabel,
  clearLabel,
  placeholder,
  onChange,
  onSave,
  onClear,
}: SkillsmpApiKeyControlProps) {
  return (
    <div className="p-4 rounded-lg bg-surface/30 border border-border/30">
      <label htmlFor="skillsmp-api-key-input" className="text-sm font-medium block mb-2">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id="skillsmp-api-key-input"
          type="password"
          autoComplete="new-password"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="flex-1 px-3 py-2 rounded-lg bg-background border border-border text-sm font-mono focus:outline-none focus:ring-1 focus:ring-violet-500"
        />
        <button
          type="button"
          onClick={() => onSave(value)}
          disabled={saving || !value.trim()}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50 transition-colors"
        >
          {saveLabel}
        </button>
        {configured && (
          <button
            type="button"
            onClick={onClear}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-border text-text-main hover:bg-surface/60 disabled:opacity-50 transition-colors"
          >
            {clearLabel}
          </button>
        )}
      </div>
      {configured && <p className="text-xs text-text-muted mt-2">{configuredLabel}</p>}
    </div>
  );
}
