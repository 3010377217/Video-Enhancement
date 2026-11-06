import { ChevronDownIcon } from '@radix-ui/react-icons';

export function Segments<Value extends string>({ label, value, options, onChange }: {
  label: string; value: Value; options: { value: Value; label: string }[];
  onChange: (value: Value) => void;
}) {
  return <div role="group" aria-label={label} className="segments">
    {options.map(option => <button type="button" key={option.value} aria-pressed={value === option.value}
      className={value === option.value ? 'segment is-active' : 'segment'} onClick={() => onChange(option.value)}>
      {option.label}
    </button>)}
  </div>;
}

export function Select({ label, value, onChange, children }: {
  label: string; value: string; onChange: (value: string) => void; children: React.ReactNode;
}) {
  return <div className="select-wrap">
    <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}>{children}</select>
    <ChevronDownIcon aria-hidden="true" />
  </div>;
}
