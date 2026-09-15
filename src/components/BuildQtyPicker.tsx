import React from 'react';

// Radio-button-driven quantity picker used by both P&P Kit Booking and
// BOM Manager. Presets cover the common run sizes; Custom hides no
// affordance — it just enables the numeric input so the operator can
// type any value 1..1000. If the parent's initial value doesn't match
// a preset, the picker opens on Custom so the value round-trips
// without surprise.

const PRESETS = [50, 100, 250, 500, 1000] as const;

interface Props {
  value: number;
  onChange: (n: number) => void;
  label?: string;
  min?: number;
  max?: number;
}

export default function BuildQtyPicker({ value, onChange, label = 'Build Quantity', min = 1, max = 1000 }: Props) {
  const isPreset = (PRESETS as readonly number[]).includes(value);
  // Explicit "custom" flag so an operator who deliberately picked a
  // preset can type into the input to fine-tune without the input
  // becoming disabled again. Once they type anything non-preset, we
  // switch to Custom automatically anyway.
  const [customMode, setCustomMode] = React.useState<boolean>(!isPreset);
  React.useEffect(() => {
    if (!isPreset) setCustomMode(true);
  }, [isPreset]);

  const selectPreset = (n: number) => {
    setCustomMode(false);
    onChange(n);
  };
  const enterCustom = () => {
    setCustomMode(true);
    // Leave the value alone — the operator will type their own.
  };

  const showCustom = customMode || !isPreset;

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[10px] text-outline font-black uppercase tracking-wider">{label}</label>
      <div className="flex flex-wrap items-center gap-1">
        {PRESETS.map(n => {
          const active = !customMode && value === n;
          return (
            <button
              key={n}
              type="button"
              onClick={() => selectPreset(n)}
              className={`px-2.5 py-1.5 rounded-md text-xs font-bold font-mono border transition-all ${
                active
                  ? 'bg-primary text-on-primary border-primary'
                  : 'bg-surface-container-high border-outline-variant text-on-surface hover:border-primary/60'
              }`}
            >
              {n}
            </button>
          );
        })}
        <button
          type="button"
          onClick={enterCustom}
          className={`px-2.5 py-1.5 rounded-md text-xs font-bold border transition-all ${
            showCustom
              ? 'bg-primary text-on-primary border-primary'
              : 'bg-surface-container-high border-outline-variant text-on-surface hover:border-primary/60'
          }`}
        >
          Custom
        </button>
        {showCustom && (
          <input
            type="number"
            min={min}
            max={max}
            value={value}
            onChange={(e) => {
              const n = Math.max(min, Math.min(max, parseInt(e.target.value) || 0));
              onChange(n);
            }}
            onFocus={() => setCustomMode(true)}
            className="ml-1 bg-surface-container-high border border-outline-variant rounded px-2 py-1.5 text-xs font-bold text-center text-on-surface outline-none focus:border-primary w-[80px]"
            aria-label="Custom quantity"
          />
        )}
      </div>
    </div>
  );
}
