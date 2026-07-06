import React from 'react';

// Single-color stroke icons. All 16x16, stroke="currentColor", linecap/linejoin round.
// Used across inline-edit toolbar + Inspect toggle.

const wrap = (children) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const IconPointer = () => wrap(
  <path d="M3.5 2.5L3.5 11.5L6 9.5L7.5 13L9.5 12L8 8.5L11 8.5L3.5 2.5Z" />
);

export const IconImage = () => wrap(
  <>
    <rect x="2" y="3" width="12" height="10" rx="1.2" />
    <circle cx="6" cy="6.5" r="1" />
    <path d="M2.5 11L6 8L9.5 11L11.5 9L13.5 11" />
  </>
);

export const IconPencil = () => wrap(
  <>
    <path d="M11 2.5L13.5 5L5 13.5L2 13.5L2 11Z" />
    <path d="M9.5 4L12 6.5" />
  </>
);

export const IconSparkles = () => wrap(
  <>
    <path d="M6 2L7 5L10 6L7 7L6 10L5 7L2 6L5 5Z" />
    <path d="M11.5 9L12 10.5L13.5 11L12 11.5L11.5 13L11 11.5L9.5 11L11 10.5Z" />
  </>
);

export const IconWand = () => wrap(
  <>
    <path d="M3 13L11 5" />
    <path d="M10 4L12 6" />
    <path d="M13 2L13 3.5M14.5 3L13 3M13 3L11.5 3M13 3L13 4.5" />
  </>
);

export const IconInfo = () => wrap(
  <>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 7.5L8 11" />
    <circle cx="8" cy="5.2" r="0.4" fill="currentColor" stroke="none" />
  </>
);

export const IconTrash = () => wrap(
  <>
    <path d="M3 4.5L13 4.5" />
    <path d="M6 4.5L6 3C6 2.5 6.3 2.2 6.8 2.2L9.2 2.2C9.7 2.2 10 2.5 10 3L10 4.5" />
    <path d="M4.2 4.5L5 13C5 13.5 5.4 13.8 5.9 13.8L10.1 13.8C10.6 13.8 11 13.5 11 13L11.8 4.5" />
  </>
);

export const IconMotion = () => wrap(
  <>
    <path d="M2 8H4M6 8H8M10 8H12M14 8H14" />
    <path d="M3 4L13 4" />
    <path d="M5 12L11 12" />
  </>
);

export const IconLink = () => wrap(
  <>
    <path d="M6.5 9.5 A2.5 2.5 0 0 1 6.5 6L8.5 4 A2.5 2.5 0 0 1 12 4 A2.5 2.5 0 0 1 12 7.5L11 8.5" />
    <path d="M9.5 6.5 A2.5 2.5 0 0 1 9.5 10L7.5 12 A2.5 2.5 0 0 1 4 12 A2.5 2.5 0 0 1 4 8.5L5 7.5" />
  </>
);
