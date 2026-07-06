import React from 'react';

// Minimal pill toggle (~28x16). Used by ToolsMenu for the per-effect animation
// rows and by the Select-mode inspector for per-section opt-out. Styling lives
// in styles.css under .toggle / .toggle-knob.
export default function Toggle({ checked, onChange, disabled, label, title }) {
  const handleClick = () => {
    if (disabled) return;
    onChange?.(!checked);
  };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked ? 'true' : 'false'}
      aria-label={label}
      title={title || label}
      disabled={disabled}
      className={`toggle${checked ? ' is-on' : ''}${disabled ? ' is-disabled' : ''}`}
      onClick={handleClick}
    >
      <span className="toggle-knob" />
    </button>
  );
}
