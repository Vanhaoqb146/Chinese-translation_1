// mobile/src/theme.js

export const DARK_COLORS = {
  bg: '#060d16',          // Darker background for extra premium OLED feel
  bg2: '#0e1b2b',         // Dark secondary card/background
  card: 'rgba(14, 27, 43, 0.75)',
  glassBg: 'rgba(30, 41, 59, 0.35)',
  border: 'rgba(255, 255, 255, 0.06)',
  glassBorder: 'rgba(255, 255, 255, 0.08)',
  borderActive: '#0ea5e9',
  
  text: '#f8fafc',        // Pure white/slate for high readability
  text2: '#94a3b8',       // Slate gray for secondary details
  muted: '#64748b',       // Deep gray for metadata and placeholders
  
  accent1: '#0ea5e9',     // Ocean Blue
  accent2: '#06b6d4',     // Teal
  accent3: '#0284c7',     // Royal Azure
  
  success: '#10b981',     // Emerald Green
  danger: '#f43f5e',      // Vibrant Rose red for active recording/danger
  warning: '#f59e0b',     // Amber
  
  gradient: ['#0ea5e9', '#06b6d4'],
  accentGradient: ['#0ea5e9', '#0284c7'],
  dangerGradient: ['#f43f5e', '#be123c'],
  successGradient: ['#10b981', '#047857'],
  glow: 'rgba(14, 165, 233, 0.15)',

  surfaceCard: '#0e1b2b',
  surfaceInset: 'rgba(2, 6, 23, 0.38)',
  surfaceItem: 'rgba(15, 23, 42, 0.62)',
  surfaceAction: 'rgba(255, 255, 255, 0.05)',
  surfaceBorder: 'rgba(148, 163, 184, 0.14)',
  selectedBg: 'rgba(245, 158, 11, 0.24)',
  selectedBorder: 'rgba(251, 191, 36, 0.58)',
  selectedText: '#fbbf24',
  selectedSolid: '#f59e0b',
  selectedSolidText: '#111827',
  selectedShadow: 'rgba(245, 158, 11, 0.32)',
};

export const LIGHT_COLORS = {
  bg: '#eef4f8',          // Soft fresh ocean blue background
  bg2: '#ffffff',         // White card/background
  card: 'rgba(255, 255, 255, 0.9)',
  glassBg: 'rgba(255, 255, 255, 0.65)',
  border: 'rgba(14, 165, 233, 0.1)',
  glassBorder: 'rgba(14, 165, 233, 0.06)',
  borderActive: '#0ea5e9',
  
  text: '#0c1a2a',        // Deep navy for high readability
  text2: '#4a5e74',       // Slate blue for secondary details
  muted: '#8fa3b8',       // Light slate gray for metadata
  
  accent1: '#0ea5e9',     // Ocean Blue
  accent2: '#06b6d4',     // Teal
  accent3: '#0284c7',     // Royal Azure
  
  success: '#10b981',     // Emerald Green
  danger: '#ef4444',      // Rose Red
  warning: '#f59e0b',     // Amber
  
  gradient: ['#0ea5e9', '#06b6d4'],
  accentGradient: ['#0ea5e9', '#0284c7'],
  dangerGradient: ['#ef4444', '#991b1b'],
  successGradient: ['#10b981', '#065f46'],
  glow: 'rgba(14, 165, 233, 0.12)',

  surfaceCard: '#fbfdff',
  surfaceInset: '#e8f7fa',
  surfaceItem: '#eefaf9',
  surfaceAction: '#effbfc',
  surfaceBorder: 'rgba(20, 184, 166, 0.18)',
  selectedBg: '#ffefb6',
  selectedBorder: '#f59e0b',
  selectedText: '#92400e',
  selectedSolid: '#f59e0b',
  selectedSolidText: '#111827',
  selectedShadow: 'rgba(245, 158, 11, 0.26)',
};

// Default backward compatibility fallback
export const COLORS = DARK_COLORS;

export const SIZES = {
  radiusSm: 8,
  radiusMd: 12,
  radiusLg: 16,
  radiusRound: 999,
};

export const FONTS = {
  regular: 'System',
  bold: 'System',
};
