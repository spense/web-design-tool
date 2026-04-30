import React from 'react';
export default function Spinner({ size = 12 }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}
